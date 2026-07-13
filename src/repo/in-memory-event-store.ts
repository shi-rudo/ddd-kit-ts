import {
	type AggregateAddress,
	encodeAggregateAddress,
} from "../aggregate/aggregate-address";
import type { AnyDomainEvent } from "../aggregate/domain-event";
import { ConcurrencyConflictError } from "../core/errors";
import type {
	EventStore,
	EventStoreAppendOptions,
	ReadStreamOptions,
	StreamReadResult,
} from "./event-store";

/**
 * In-memory reference implementation of `EventStore<Evt>`.
 *
 * Intended for tests, single-process workers, and quick-start demos.
 * Implements the full port contract: expectedVersion-guarded appends
 * (throwing `ConcurrencyConflictError` on mismatch), atomic rejected
 * appends, explicit missing/existing stream state with the actual head,
 * append-order reads, and `fromVersion` slicing.
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
	}

	async readStream(
		stream: AggregateAddress,
		options?: ReadStreamOptions,
	): Promise<StreamReadResult<Evt>> {
		const events = this.streams.get(encodeAggregateAddress(stream));
		if (events === undefined) {
			return { exists: false, lastVersion: 0, events: [] };
		}
		const fromVersion = options?.fromVersion ?? 0;
		// slice() always copies: callers never see the internal array.
		return {
			exists: true,
			lastVersion: events.length,
			events: events.slice(Math.max(0, fromVersion)),
		};
	}
}
