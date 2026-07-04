import type { AnyDomainEvent } from "../aggregate/domain-event";
import type { Id } from "../core/id";

/** Options for {@link EventStore.append}. */
export interface EventStoreAppendOptions {
	/**
	 * The stream version the writer loaded (its optimistic-concurrency
	 * baseline): the number of events the stream held when the aggregate
	 * was reconstituted. `0` for a brand-new stream. For kit aggregates
	 * this is `aggregate.persistedVersion ?? 0`; the aggregate version IS
	 * the event count, so stream version and aggregate version align.
	 */
	readonly expectedVersion: number;
}

/** Options for {@link EventStore.readStream}. */
export interface ReadStreamOptions {
	/**
	 * Return only events AFTER this stream position (1-based event count),
	 * the snapshot catch-up read: `readStream(id, { fromVersion:
	 * snapshot.version })` yields exactly the events
	 * `restoreFromSnapshotWithEvents` needs. Defaults to `0` (the whole
	 * stream).
	 */
	readonly fromVersion?: number;
}

/**
 * Driven port for event-sourced aggregate persistence: an append-only
 * store with one stream per aggregate (the stream id IS the aggregate
 * id, Greg Young's stream-per-aggregate default).
 *
 * The kit ships the port, the OCC error contract, `InMemoryEventStore`
 * as the reference implementation, and the event-sourced repository
 * contract suite (`@shirudo/ddd-kit/testing`). Your adapter implements
 * this port against a real store and must pass that suite: like the
 * state-stored `IRepository`, optimistic concurrency is a testable
 * adapter contract, not a kit guarantee.
 *
 * Repository usage (see the event-sourcing guide):
 *
 * ```ts
 * async getById(id: OrderId): Promise<Order | null> {
 *   const cached = this.session.identityMap.get(Order, id);
 *   if (cached) return cached;
 *   const history = await this.eventStore.readStream(id);
 *   if (history.length === 0) return null;
 *   const order = Order.reconstitute(id); // bare instance, no events
 *   const result = order.loadFromHistory(history);
 *   if (result.isErr()) throw result.error; // corrupt stream
 *   this.session.identityMap.set(Order, id, order);
 *   return order;
 * }
 *
 * async save(order: Order): Promise<void> {
 *   if (order.pendingEvents.length === 0) return;
 *   this.session.enrollSaved(order);
 *   await this.eventStore.append(order.id, order.pendingEvents, {
 *     expectedVersion: order.persistedVersion ?? 0,
 *   });
 * }
 * ```
 *
 * `save` appends the UNSTAMPED `pendingEvents` originals; `withCommit`
 * separately hands the outbox stamped copies. The store's own position
 * is the ordering authority for replay (see the event-sourcing guide's
 * note on `aggregateVersion`).
 *
 * **One save per aggregate per unit of work, after all mutations.**
 * `pendingEvents` are cleared and `persistedVersion` advances only AFTER
 * the commit (`markPersisted`), so a second `save` of the same instance
 * inside one unit of work would re-append the already-appended events
 * with a stale `expectedVersion` and deterministically conflict, with no
 * concurrent writer in sight. This is the same rule the state-stored
 * path documents as "mutate first, save last" on `withCommit`; it is
 * not specific to event sourcing.
 */
export interface EventStore<Evt extends AnyDomainEvent> {
	/**
	 * Atomically appends `events` to the stream, guarded by optimistic
	 * concurrency: the append succeeds only when the stream currently
	 * holds exactly `options.expectedVersion` events.
	 *
	 * Contract for implementations:
	 *
	 *  1. **OCC:** on a version mismatch (stale writer, duplicate create
	 *     racing on `expectedVersion: 0`, or an expectedVersion ahead of
	 *     the stream), throw `ConcurrencyConflictError` from
	 *     `@shirudo/ddd-kit` carrying the expected and actual stream
	 *     versions; map your store's native conflict signal to it instead
	 *     of letting a raw driver error escape. One sanctioned exception:
	 *     an adapter that can DISTINGUISH the duplicate-create race
	 *     (`expectedVersion: 0` against a stream that already exists,
	 *     typically a unique violation on the first position) may throw
	 *     `DuplicateAggregateError` for that case instead, matching the
	 *     state-stored insert path. It is deliberately NOT retryable:
	 *     replaying the same append cannot succeed; the use case resolves
	 *     the create race (load the existing aggregate, or surface HTTP
	 *     409). The contract suite accepts both errors for this race.
	 *  2. **Atomicity:** all events land or none do; a rejected append
	 *     leaves the stream untouched.
	 *  3. **Order:** events are stored in the given array order, appended
	 *     after the existing stream tail.
	 *  4. **Append-only:** stored events are never edited or deleted;
	 *     corrections are new (compensating) events.
	 *
	 * An empty `events` array is a no-op; implementations resolve without
	 * touching the store (an ES repository skips `save` for aggregates
	 * without pending events anyway).
	 */
	append(
		streamId: Id<string>,
		events: ReadonlyArray<Evt>,
		options: EventStoreAppendOptions,
	): Promise<void>;

	/**
	 * Reads the stream in append order. Returns an empty array for an
	 * unknown stream (the repository maps that to `null`). With
	 * `options.fromVersion`, returns only the events after that stream
	 * position (snapshot catch-up). The returned array is owned by the
	 * caller; implementations must not hand out live internal state.
	 */
	readStream(
		streamId: Id<string>,
		options?: ReadStreamOptions,
	): Promise<ReadonlyArray<Evt>>;
}
