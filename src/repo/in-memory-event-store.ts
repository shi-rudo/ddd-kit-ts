import {
	type AggregateAddress,
	encodeAggregateAddress,
} from "../aggregate/aggregate-address";
import type { AnyDomainEvent } from "../aggregate/domain-event";
import {
	ConcurrencyConflictError,
	InMemoryCapacityExceededError,
} from "../core/errors";
import { assertPositiveSafeInteger } from "../utils/validate";
import type {
	EventStore,
	EventStoreAppendOptions,
	ReadStreamOptions,
	StreamReadResult,
} from "./event-store";

/** Optional fail-loud capacities for the finite-lifetime reference store. */
export interface InMemoryEventStoreOptions {
	/** Maximum aggregate streams retained by this instance. */
	readonly maxStreams?: number;
	/** Maximum events retained across every stream in this instance. */
	readonly maxEvents?: number;
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
 * appends, explicit missing/existing stream state with the actual head,
 * append-order reads, mandatory page bounds, and `(fromVersion, toVersion]`
 * slicing. Invalid limits or positions reject with `RangeError`.
 *
 * For production, back the port with a durable store whose append and
 * the aggregate transaction share atomicity (a table with a
 * `(aggregate_type, aggregate_id, position)` unique key inside the same
 * transaction, or a dedicated event store). Same caveat as
 * `InMemoryOutbox`: this class
 * lives in memory only and knows nothing about your `TransactionScope`
 * rollbacks; events appended inside a transaction that later rolls back
 * are NOT removed. The event-sourced repository contract suite's
 * reference environment shows the snapshot/restore pattern for
 * rollback-pure in-memory testing.
 */
export class InMemoryEventStore<Evt extends AnyDomainEvent>
	implements EventStore<Evt>
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

	async append(
		stream: AggregateAddress,
		events: ReadonlyArray<Evt>,
		options: EventStoreAppendOptions,
	): Promise<void> {
		if (events.length === 0) return;
		const key = encodeAggregateAddress(stream);
		const existing = this.streams.get(key);
		if ((existing?.length ?? 0) !== options.expectedVersion) {
			throw new ConcurrencyConflictError({
				aggregateType: stream.aggregateType,
				aggregateId: stream.aggregateId,
				expectedVersion: options.expectedVersion,
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
			this.totalEvents + events.length > this.maxEvents
		) {
			throw new InMemoryCapacityExceededError({
				store: "InMemoryEventStore",
				resource: "events",
				limit: this.maxEvents,
				current: this.totalEvents,
				attempted: events.length,
			});
		}
		// Atomic by construction: the conflict check above throws before
		// anything is written (including the get-or-create, so a rejected
		// append on a nonexistent stream leaves no empty entry behind).
		// Pushing in place keeps append O(batch) instead of O(stream) per
		// call; no caller ever holds the internal array (readStream
		// slices). Element-wise, not push(...events): a spread into
		// arguments overflows the engine's argument limit on huge batches.
		let storedEvents = existing;
		if (storedEvents === undefined) {
			storedEvents = [];
			this.streams.set(key, storedEvents);
		}
		for (const event of events) {
			storedEvents.push(event);
		}
		this.totalEvents += events.length;
	}

	async readStream(
		stream: AggregateAddress,
		options: ReadStreamOptions,
	): Promise<StreamReadResult<Evt>> {
		if (!Number.isSafeInteger(options?.limit) || options.limit < 1) {
			throw new RangeError(
				`InMemoryEventStore: limit must be a positive safe integer, got ${String(options?.limit)}`,
			);
		}
		assertStreamPosition("fromVersion", options.fromVersion);
		assertStreamPosition("toVersion", options.toVersion);
		const events = this.streams.get(encodeAggregateAddress(stream));
		if (events === undefined) {
			return { exists: false, lastVersion: 0, events: [] };
		}
		const fromVersion = options.fromVersion ?? 0;
		const toVersion = options.toVersion;
		const pageEnd = Math.min(
			toVersion ?? events.length,
			fromVersion + options.limit,
		);
		// slice() always copies: callers never see the internal array.
		return {
			exists: true,
			lastVersion: events.length,
			events: events.slice(fromVersion, pageEnd),
		};
	}
}
