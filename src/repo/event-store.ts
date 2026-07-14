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
	 * Maximum number of events returned by this page. Required so callers
	 * cannot accidentally materialize an unbounded stream. Must be a positive
	 * safe integer. An adapter may return fewer events, but must return at least
	 * one while unread events remain inside the requested window.
	 */
	readonly limit: number;

	/**
	 * Return only events AFTER this stream position (1-based event count),
	 * the snapshot catch-up read: `readStream(stream, { fromVersion:
	 * snapshot.version, limit: 256 })` yields the next page of events
	 * `restoreFromSnapshotWithEvents` needs. Defaults to `0` (the first
	 * stream page).
	 * Must be a non-negative safe integer when present.
	 */
	readonly fromVersion?: number;

	/**
	 * Return events only THROUGH this stream position (inclusive, 1-based
	 * event count). Together with `fromVersion`, this describes the interval
	 * `(fromVersion, toVersion]`. Defaults to the actual stream head.
	 * `0` therefore returns an empty window; a value beyond the head clamps
	 * to the head; and `fromVersion >= toVersion` is an empty interval, not
	 * an error.
	 * Must be a non-negative safe integer when present.
	 */
	readonly toVersion?: number;
}

/**
 * State returned by {@link EventStore.readStream}.
 *
 * `lastVersion` is always the actual stream head (the event count), independent
 * of the requested read window and page limit. `exists: true` implies
 * `lastVersion >= 1`: an
 * existing stream has at least one event, while metadata or tombstones without
 * events must be reported as `exists: false`. A missing stream is therefore
 * distinguishable from an existing stream whose requested window is empty.
 * Snapshot-backed repositories use that distinction to reject a snapshot whose
 * version lies beyond the current authoritative stream head.
 */
export type StreamReadResult<Evt extends AnyDomainEvent> =
	| {
			readonly exists: false;
			readonly lastVersion: 0;
			readonly events: readonly [];
	  }
	| {
			readonly exists: true;
			readonly lastVersion: number;
			readonly events: ReadonlyArray<Evt>;
	  };

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
 *   const address = this.stream(id);
 *   const order = Order.reconstitute(id); // bare instance, no events
 *   let fromVersion = 0;
 *   let targetVersion: number | undefined;
 *   for (;;) {
 *     const page = await this.eventStore.readStream(address, {
 *       fromVersion,
 *       toVersion: targetVersion,
 *       limit: 256,
 *     });
 *     if (!page.exists) return null;
 *     targetVersion ??= page.lastVersion; // pin the first observed head
 *     if (fromVersion === targetVersion) break;
 *     if (page.events.length === 0) throw new Error("non-progressing stream page");
 *     const result = order.loadFromHistory(page.events);
 *     if (result.isErr()) throw result.error; // corrupt stream
 *     fromVersion += page.events.length;
 *   }
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
	 * Reads one bounded page of the qualified stream in append order. An unknown stream returns
	 * `{ exists: false, lastVersion: 0, events: [] }`; an existing stream keeps
	 * `exists: true` even when its requested window is empty. An existing stream
	 * has at least one event, so `exists: true` implies `lastVersion >= 1`;
	 * metadata or tombstones without events must be reported as absent.
	 * `lastVersion` is always the actual stream head. `options.limit` is
	 * mandatory and caps the returned array. An adapter may return fewer than
	 * the requested limit, but if the requested window still contains unread
	 * events it must return a non-empty contiguous prefix so callers can make
	 * progress. `options.fromVersion`
	 * excludes positions at or below its 1-based event count;
	 * `options.toVersion` includes positions through its count, so both bounds
	 * describe `(fromVersion, toVersion]`. `toVersion: 0` and inverted ranges
	 * return an empty existing window, while a bound beyond the head clamps to
	 * the head. This distinction is load-bearing for snapshot catch-up and
	 * point-in-time reconstruction: a repository can verify the requested
	 * historical window against the authoritative head. `limit` must be a
	 * positive safe integer; present bounds must be non-negative safe integers.
	 * Invalid options reject with `RangeError` before querying storage.
	 *
	 * Each page's `exists`, `lastVersion`, and `events` must describe one
	 * consistent view of the stream. Multiple page reads are not one database
	 * snapshot: pin the first page's `lastVersion` as `toVersion` on every
	 * continuation, then advance `fromVersion` by the number of events actually
	 * returned. Because streams are append-only, that yields a stable prefix
	 * even if new events arrive while replay is in progress. The returned
	 * event array is owned by the caller; implementations must not hand out
	 * mutable live internal state.
	 */
	readStream(
		stream: AggregateAddress,
		options: ReadStreamOptions,
	): Promise<StreamReadResult<Evt>>;
}
