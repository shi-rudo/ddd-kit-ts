import {
	type AggregateIdentity,
	encodeAggregateIdentity,
} from "../../../domain/aggregate/aggregate-identity";
import type { AnyDomainEvent } from "../../../domain/event/domain-event";
import {
	ConcurrencyConflictError,
	describeAggregateIdentity,
	detachAggregateIdentity,
	InMemoryCapacityExceededError,
} from "../../../errors/kit-errors";
import { abortReason } from "../../../internal/async/abort";
import { detachState } from "../../../internal/structural/detach-state";
import { assertPositiveSafeInteger } from "../../../internal/validate";
import type {
	InMemoryTransaction,
	InMemoryTransactionParticipant,
} from "../../repository/in-memory-transaction";
import type {
	EventStore,
	EventStoreAppendOptions,
	ReadStreamOptions,
	StreamReadResult,
} from "../event-store";

/** Optional fail-loud capacities for the finite-lifetime reference store. */
export interface InMemoryEventStoreOptions {
	/** Maximum aggregate streams retained by this instance. */
	readonly maxStreams?: number;
	/** Maximum events retained across every stream in this instance. */
	readonly maxEvents?: number;
}

/**
 * A copy of `event` that shares nothing with the caller. `detachState`
 * rejects a value that a copy would lose or change, for example a function,
 * a class instance, or an accessor, and it never runs an accessor.
 */
function copyForStorage<Evt>(
	event: Evt,
	index: number,
	stream: AggregateIdentity,
): Evt {
	try {
		return detachState(event);
	} catch (error) {
		// Only the rejection of `detachState` gets the event context. An error
		// from caller code, for example a Proxy trap, passes unchanged.
		if (!(error instanceof TypeError)) throw error;
		throw new TypeError(
			`InMemoryEventStore.append: the event at index ${index} of stream ` +
				`${describeAggregateIdentity(stream)} is not plain data`,
			{ cause: error },
		);
	}
}

function assertStreamPosition(
	name: "fromVersion" | "toVersion",
	value: number | undefined,
): void {
	if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
		throw new RangeError(
			`InMemoryEventStore: ${name} must be a non-negative safe integer, got ${String(value)}`,
		);
	}
}

/**
 * In-memory reference implementation of `EventStore<Evt>`.
 *
 * Intended for finite-lifetime tests and quick-start demos. With no capacity
 * options, streams and events are unbounded for the lifetime of the instance.
 * Long-lived processes must configure `maxStreams` and `maxEvents` or use a
 * durable adapter. Capacity exhaustion rejects before mutation with
 * `InMemoryCapacityExceededError`; histories are never silently evicted.
 * Implements the full port contract: expectedVersion-guarded appends
 * (throwing `ConcurrencyConflictError` on mismatch), atomic rejected
 * appends, explicit absent/existing stream state with the actual head,
 * append-order reads, mandatory page bounds, and `(fromVersion, toVersion]`
 * slicing. Invalid limits or positions reject with `RangeError`. A read
 * with an aborted `signal` rejects with its `reason`.
 *
 * For production, back the port with a durable store whose append and
 * the aggregate transaction share atomicity (a table with a
 * `(aggregate_type, aggregate_id, position)` unique key inside the same
 * transaction, or a dedicated event store). Same caveat as
 * `InMemoryOutbox`: this class lives in memory only. On its own, it knows
 * nothing about your `TransactionScope` rollbacks, so events appended inside
 * a transaction that later rolls back stay. Register the store with an
 * `InMemoryTransactionScope` for tests that roll back or retry.
 */
export class InMemoryEventStore<Evt extends AnyDomainEvent>
	implements EventStore<Evt>, InMemoryTransactionParticipant
{
	private readonly streams = new Map<string, Evt[]>();
	private readonly maxStreams: number | undefined;
	private readonly maxEvents: number | undefined;
	private totalEvents = 0;

	constructor(options: InMemoryEventStoreOptions = {}) {
		if (options.maxStreams !== undefined) {
			assertPositiveSafeInteger(
				"InMemoryEventStore",
				"maxStreams",
				options.maxStreams,
			);
		}
		if (options.maxEvents !== undefined) {
			assertPositiveSafeInteger(
				"InMemoryEventStore",
				"maxEvents",
				options.maxEvents,
			);
		}
		this.maxStreams = options.maxStreams;
		this.maxEvents = options.maxEvents;
	}

	/**
	 * Records the state that a rollback of an `InMemoryTransactionScope`
	 * returns to: every stream and the event count.
	 */
	beginTransaction(): InMemoryTransaction {
		const streams = [...this.streams].map(
			([key, events]) => [key, [...events]] as const,
		);
		const totalEvents = this.totalEvents;
		return {
			commit: () => {},
			rollback: () => {
				this.streams.clear();
				for (const [key, events] of streams) this.streams.set(key, [...events]);
				this.totalEvents = totalEvents;
			},
		};
	}

	async append(
		stream: AggregateIdentity,
		events: ReadonlyArray<Evt>,
		options: EventStoreAppendOptions,
	): Promise<void> {
		if (events.length === 0) return;
		// The arguments are read once, here. A getter on them runs before the
		// first check, and a later change of the caller's objects does not
		// reach the checks, the write, or an error.
		const identity = detachAggregateIdentity(stream);
		const expectedVersion = options.expectedVersion;
		const batch = Array.from(events);
		const key = encodeAggregateIdentity(identity);
		// A stale or oversized batch fails before the copy, without its cost.
		this.existingStreamForAppend(identity, key, expectedVersion, batch.length);
		// The copy runs no accessor, but a Proxy event runs its traps. The
		// checks therefore run again after the copy, against the state that
		// the write changes.
		const owned = batch.map((event, index) =>
			copyForStorage(event, index, identity),
		);
		const existing = this.existingStreamForAppend(
			identity,
			key,
			expectedVersion,
			owned.length,
		);
		// The checks above throw before the get-or-create, so a rejected
		// append to a new stream leaves no empty stream behind. Pushing in
		// place keeps append O(batch); no caller holds the internal array,
		// because readStream returns copies. The push is element-wise: a
		// spread into arguments overflows the argument limit on huge batches.
		let storedEvents = existing;
		if (storedEvents === undefined) {
			storedEvents = [];
			this.streams.set(key, storedEvents);
		}
		for (const event of owned) storedEvents.push(event);
		this.totalEvents += owned.length;
	}

	/**
	 * The stream that an append of `count` events at `expectedVersion`
	 * writes to, or `undefined` for a new stream. Throws when the version
	 * is stale or a capacity would overflow.
	 */
	private existingStreamForAppend(
		stream: AggregateIdentity,
		key: string,
		expectedVersion: number,
		count: number,
	): Evt[] | undefined {
		const existing = this.streams.get(key);
		if ((existing?.length ?? 0) !== expectedVersion) {
			throw new ConcurrencyConflictError({
				identity: stream,
				expectedVersion,
				// A stream that was never created is at version 0, so the stored
				// version is always a number on this path.
				reason: "stale_version",
				actualVersion: existing?.length ?? 0,
			});
		}
		if (
			existing === undefined &&
			this.maxStreams !== undefined &&
			this.streams.size >= this.maxStreams
		) {
			throw new InMemoryCapacityExceededError({
				store: "InMemoryEventStore",
				resource: "streams",
				limit: this.maxStreams,
				current: this.streams.size,
				attempted: 1,
			});
		}
		if (
			this.maxEvents !== undefined &&
			this.totalEvents + count > this.maxEvents
		) {
			throw new InMemoryCapacityExceededError({
				store: "InMemoryEventStore",
				resource: "events",
				limit: this.maxEvents,
				current: this.totalEvents,
				attempted: count,
			});
		}
		return existing;
	}

	async readStream(
		stream: AggregateIdentity,
		options: ReadStreamOptions,
	): Promise<StreamReadResult<Evt>> {
		if (!Number.isSafeInteger(options?.limit) || options.limit < 1) {
			throw new RangeError(
				`InMemoryEventStore: limit must be a positive safe integer, got ${String(options?.limit)}`,
			);
		}
		assertStreamPosition("fromVersion", options.fromVersion);
		assertStreamPosition("toVersion", options.toVersion);
		if (options.signal?.aborted) {
			throw abortReason(
				options.signal,
				"InMemoryEventStore.readStream aborted",
			);
		}
		const events = this.streams.get(encodeAggregateIdentity(stream));
		if (events === undefined) {
			return { exists: false, lastVersion: 0, events: [] };
		}
		const fromVersion = options.fromVersion ?? 0;
		const toVersion = options.toVersion;
		const pageEnd = Math.min(
			toVersion ?? events.length,
			fromVersion + options.limit,
		);
		// Cloned, not sliced: slice() copies the ARRAY but hands out live
		// references to the stored elements, and a caller mutating one would
		// silently corrupt every later replay.
		return {
			exists: true,
			lastVersion: events.length,
			events: structuredClone(events.slice(fromVersion, pageEnd)),
		};
	}
}
