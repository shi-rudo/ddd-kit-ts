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
		const stream = this.streams.get(streamId) ?? [];
		if (stream.length !== options.expectedVersion) {
			throw new ConcurrencyConflictError({
				aggregateType: events[0]?.aggregateType ?? "stream",
				aggregateId: streamId,
				expectedVersion: options.expectedVersion,
				actualVersion: stream.length,
			});
		}
		// Atomic by construction: the conflict check above throws before
		// anything is written, and the batch lands in one push.
		this.streams.set(streamId, [...stream, ...events]);
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
