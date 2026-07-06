import type { AnyDomainEvent } from "../aggregate/domain-event";
import { ConcurrencyConflictError } from "../core/errors";
import type { Id } from "../core/id";
import type {
	EventStore,
	EventStoreAppendOptions,
	ReadStreamOptions,
} from "./event-store";

/**
 * In-memory reference implementation of `EventStore<Evt>`.
 *
 * Intended for tests, single-process workers, and quick-start demos.
 * Implements the full port contract: expectedVersion-guarded appends
 * (throwing `ConcurrencyConflictError` on mismatch), atomic rejected
 * appends, append-order reads, and `fromVersion` slicing.
 *
 * For production, back the port with a durable store whose append and
 * the aggregate transaction share atomicity (a table with a
 * `(stream_id, position)` unique key inside the same transaction, or a
 * dedicated event store). Same caveat as `InMemoryOutbox`: this class
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
		streamId: Id<string>,
		events: ReadonlyArray<Evt>,
		options: EventStoreAppendOptions,
	): Promise<void> {
		if (events.length === 0) return;
		const existing = this.streams.get(streamId);
		if ((existing?.length ?? 0) !== options.expectedVersion) {
			throw new ConcurrencyConflictError({
				aggregateType: events[0]?.aggregateType ?? "stream",
				aggregateId: streamId,
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
		let stream = existing;
		if (stream === undefined) {
			stream = [];
			this.streams.set(streamId, stream);
		}
		for (const event of events) {
			stream.push(event);
		}
	}

	async readStream(
		streamId: Id<string>,
		options?: ReadStreamOptions,
	): Promise<ReadonlyArray<Evt>> {
		const stream = this.streams.get(streamId) ?? [];
		const fromVersion = options?.fromVersion ?? 0;
		// slice() always copies: callers never see the internal array.
		return stream.slice(Math.max(0, fromVersion));
	}
}
