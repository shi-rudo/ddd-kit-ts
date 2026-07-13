import type { AggregateAddress } from "../aggregate/aggregate-address";
import type { AnyDomainEvent } from "../aggregate/domain-event";

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
	 * the snapshot catch-up read: `readStream(stream, { fromVersion:
	 * snapshot.version })` yields exactly the events
	 * `restoreFromSnapshotWithEvents` needs. Defaults to `0` (the whole
	 * stream).
	 */
	readonly fromVersion?: number;
}

/**
 * Driven port for event-sourced aggregate persistence: an append-only
 * store with one stream per aggregate. Each stream is addressed by the
 * qualified tuple `(aggregateType, aggregateId)`, because aggregate ids
 * are type-scoped rather than globally unique.
 *
 * The kit ships the port, the OCC error contract, `InMemoryEventStore`
 * as the reference implementation, and the event-sourced repository
 * contract suites (`createEventStoreContractTests` and
 * `createEsRepositoryContractTests` from `@shirudo/ddd-kit/testing`).
 * Your adapter implements this port against a real store and must pass
 * those suites. Like the state-stored `IRepository`, its optimistic
 * concurrency and key isolation are testable adapter contracts, not kit
 * guarantees.
 *
 * Repository usage (see the event-sourcing guide):
 *
 * ```ts
 * private stream(id: OrderId): AggregateAddress<OrderId> {
 *   return { aggregateType: "Order", aggregateId: id };
 * }
 *
 * async findById(id: OrderId): Promise<Order | null> {
 *   const cached = this.session.identityMap.get(Order, id);
 *   if (cached) return cached;
 *   const history = await this.eventStore.readStream(this.stream(id));
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
 *   await this.eventStore.append(this.stream(order.id), order.pendingEvents, {
 *     expectedVersion: order.persistedVersion ?? 0,
 *   });
 * }
 * ```
 *
 * `save` appends the bare `pendingEvents` originals; `withCommit`
 * separately composes them into outbox envelopes. The event store's own
 * stream position remains the ordering authority for replay.
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
	 *  3. **Qualified identity:** `(aggregateType, aggregateId)` is the
	 *     storage key. Equal raw ids under different aggregate types are
	 *     independent streams. Use both columns in every primary/unique
	 *     key, OCC predicate, and read predicate.
	 *  4. **Order:** events are stored in the given array order, appended
	 *     after the existing stream tail.
	 *  5. **Append-only:** stored events are never edited or deleted;
	 *     corrections are new (compensating) events.
	 *  6. **Replay integrity:** reads order by the persisted stream position
	 *     and reject duplicate or non-contiguous positions where the backing
	 *     store exposes them. The portable contract suite proves observable
	 *     append order and slicing; because the port cannot inject malformed
	 *     physical rows, adapters add a store-specific corruption fixture that
	 *     proves the duplicate/gap rejection. The repository then calls
	 *     `loadFromHistory`, whose replay guard rejects any event carrying an
	 *     aggregate type or id that contradicts this stream key.
	 *
	 * An empty `events` array is a no-op; implementations resolve without
	 * touching the store (an ES repository skips `save` for aggregates
	 * without pending events anyway).
	 *
	 * Treat `aggregateType` as a stable technical stream category. If two
	 * bounded contexts share one physical store and reuse a domain name,
	 * qualify it at the source (`sales.order`, `fulfillment.order`). Renaming
	 * it changes the stream key and therefore requires a data migration.
	 */
	append(
		stream: AggregateAddress,
		events: ReadonlyArray<Evt>,
		options: EventStoreAppendOptions,
	): Promise<void>;

	/**
	 * Reads the qualified stream in append order. Returns an empty array for an
	 * unknown stream (the repository maps that to `null`). With
	 * `options.fromVersion`, returns only the events after that stream
	 * position (snapshot catch-up). The returned array is owned by the
	 * caller; implementations must not hand out live internal state.
	 */
	readStream(
		stream: AggregateAddress,
		options?: ReadStreamOptions,
	): Promise<ReadonlyArray<Evt>>;
}
