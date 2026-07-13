import type { AggregateAddress } from "../aggregate/aggregate-address";
import type { AnyDomainEvent } from "../aggregate/domain-event";

/**
 * Event handler function type for subscribing to domain events.
 *
 * @template Evt - The type of domain event
 */
export type EventHandler<Evt> = (event: Evt) => Promise<void> | void;

/**
 * Event Bus interface for publishing and subscribing to domain events.
 * Supports multiple subscribers per event type (pub/sub pattern).
 *
 * @template Evt - The type of domain events
 *
 * @example
 * ```typescript
 * const bus = new EventBus<OrderEvent>();
 *
 * // Subscribe to specific event types
 * bus.subscribe("OrderCreated", async (event) => {
 *   await sendEmail(event.payload.customerId);
 * });
 *
 * bus.subscribe("OrderShipped", async (event) => {
 *   await updateInventory(event.payload.orderId);
 * });
 *
 * // Publish events
 * await bus.publish([orderCreatedEvent, orderShippedEvent]);
 * ```
 */
export interface EventBus<Evt extends AnyDomainEvent> {
	/**
	 * Publishes events to all subscribed handlers.
	 *
	 * **Ordering & parallelism contract:**
	 *
	 *  1. **Events run in input order.** `publish([a, b, c])` dispatches `a`,
	 *     awaits all of its handlers, then dispatches `b`, and so on. The
	 *     library never reorders or parallelises across events.
	 *  2. **Handlers within a single event run in parallel.** All handlers
	 *     subscribed to `event.type` are awaited via `Promise.allSettled`:
	 *     none of them sees the others' errors and none is skipped if a
	 *     peer fails.
	 *  3. **Errors are collected and thrown AFTER everything dispatches.**
	 *     If one handler throws, remaining handlers for that event still
	 *     run, and remaining events in the batch still publish. Once
	 *     `publish` reaches the end of the batch it throws: the single
	 *     error directly if there was one, or an `AggregateError`
	 *     ("Multiple event handlers failed") containing every captured
	 *     error otherwise. Callers that need fail-fast semantics should
	 *     publish events one at a time and not rely on batch atomicity.
	 *
	 * The contract is intentionally simple and in-process. For
	 * cross-process delivery (RabbitMQ, Kafka, etc.), use the `Outbox`
	 * port and a dedicated dispatcher.
	 *
	 * @param events - Array of events to publish
	 */
	publish: (events: ReadonlyArray<Evt>) => Promise<void>;

	/**
	 * Subscribes a handler to a specific event type.
	 * Multiple handlers can subscribe to the same event type.
	 *
	 * @param eventType - The event type to subscribe to
	 * @param handler - The handler function to call when events of this type are published
	 * @returns A function to unsubscribe the handler
	 *
	 * @example
	 * ```typescript
	 * const unsubscribe = bus.subscribe("OrderCreated", async (event) => {
	 *   console.log("Order created:", event.payload.orderId);
	 * });
	 *
	 * // Later: unsubscribe
	 * unsubscribe();
	 * ```
	 */
	subscribe: <K extends Evt["type"]>(
		eventType: K,
		handler: EventHandler<Extract<Evt, { type: K }>>,
	) => () => void;

	/**
	 * Subscribes a handler to EVERY event type: the subscription for
	 * cross-cutting consumers (audit log, metrics, dev logging,
	 * forward-all) that would otherwise have to enumerate the union's
	 * event types and silently miss every type added later.
	 *
	 * Catch-all handlers run in the SAME `Promise.allSettled` batch as
	 * the event's typed handlers, so the publish contract is unchanged:
	 * awaited delivery, no handler skipped when a peer fails, errors
	 * collected and thrown after the batch, events in input order.
	 *
	 * Deliberately minimal: no predicate subscriptions (filter in your
	 * handler; it is one line) and no glob/topic patterns (topic routing
	 * belongs to broker sinks: Kafka topics, JetStream subjects).
	 *
	 * @param handler - Called with every published event, typed as the
	 * full event union; narrow via `event.type` in the handler
	 * @returns A function to unsubscribe the handler
	 *
	 * @example
	 * ```typescript
	 * const unsubscribe = bus.subscribeAll(async (event) => {
	 *   await auditLog.append(event.type, event.eventId, event.payload);
	 * });
	 * ```
	 */
	subscribeAll: (handler: EventHandler<Evt>) => () => void;

	/**
	 * Subscribes to the next occurrence of an event type.
	 * Returns a Promise that resolves with the event data.
	 * Automatically unsubscribes after the first event.
	 *
	 * @param eventType - The event type to wait for
	 * @returns A Promise that resolves with the event
	 *
	 * @example
	 * ```typescript
	 * const event = await bus.once("OrderCreated");
	 * console.log("Order created:", event.payload.orderId);
	 * ```
	 */
	once: <K extends Evt["type"]>(
		eventType: K,
		options?: OnceOptions,
	) => Promise<Extract<Evt, { type: K }>>;
}

/**
 * Options for `EventBus.once()`. Both fields are optional; without them
 * `once()` waits forever (the historical behaviour).
 */
export interface OnceOptions {
	/**
	 * Aborts the wait. When `signal` fires, `once()` rejects with
	 * `signal.reason` (or a generic abort error if none was supplied) and
	 * the internal subscription is removed.
	 */
	signal?: AbortSignal;

	/**
	 * Rejects with a timeout error after this many milliseconds if no event
	 * has arrived. The internal subscription and timer are cleaned up
	 * regardless of which path settles the promise.
	 */
	timeoutMs?: number;
}

/**
 * Gap-proof position finalized by the event source at the persistence
 * boundary. It is deliberately separate from `DomainEvent`: these values
 * describe a stored commit, not the business fact itself.
 */
export interface CommitPosition {
	/** Aggregate OCC version reached by this eventful commit. */
	readonly aggregateVersion: number;
	/** Zero-based event index inside this aggregate commit. */
	readonly commitSequence: number;
	/** Total number of events emitted by this aggregate commit. */
	readonly commitSize: number;
	/**
	 * Aggregate version of the immediately preceding EVENTFUL commit for this
	 * qualified aggregate source, or `null` when this is its first eventful
	 * commit. State-only persistence is intentionally absent from this chain.
	 *
	 * The outbox/event-store adapter owns this value. It must read and advance
	 * the source head atomically with inserting the committed event envelope;
	 * application orchestration cannot derive it from `persistedVersion`.
	 */
	readonly previousEventfulAggregateVersion: number | null;
}

/**
 * Commit information known by the application transaction before the outbox
 * source has linked this eventful commit to its predecessor.
 */
export type EventCommitCandidatePosition = Omit<
	CommitPosition,
	"previousEventfulAggregateVersion"
>;

/**
 * A bare domain event prepared for the transactional outbox. The outbox source
 * owns the predecessor link and turns this candidate into a
 * {@link CommittedDomainEvent} when it persists the record.
 */
export interface EventCommitCandidate<Evt extends AnyDomainEvent> {
	readonly event: Evt;
	readonly source: AggregateAddress;
	readonly position: EventCommitCandidatePosition;
}

/**
 * A domain event enriched after persistence has established its source and
 * commit position. Outboxes and projectors consume this envelope; in-process
 * domain handlers continue to consume the bare {@link DomainEvent} value.
 */
export interface CommittedDomainEvent<Evt extends AnyDomainEvent> {
	readonly event: Evt;
	readonly source: AggregateAddress;
	readonly position: CommitPosition;
}

/**
 * One pending event in the outbox plus the opaque id the implementation
 * needs to ack it via `markDispatched`. The library does not prescribe
 * what `dispatchId` looks like: an implementation can reuse the event's
 * own `eventId`, generate its own UUID, use the row's auto-increment
 * primary key, or whatever the storage layer prefers.
 */
export interface OutboxRecord<Evt extends AnyDomainEvent>
	extends CommittedDomainEvent<Evt> {
	dispatchId: string;

	/**
	 * Failed delivery attempts so far. Populated by implementations that
	 * track dispatch failures (see {@link DispatchTrackingOutbox});
	 * plain `Outbox` implementations may omit it.
	 */
	attempts?: number;
}

/** A record that exhausted its delivery attempts; see {@link DispatchTrackingOutbox.deadLetters}. */
export interface DeadLetterRecord<Evt extends AnyDomainEvent>
	extends CommittedDomainEvent<Evt> {
	dispatchId: string;
	/** Failed delivery attempts when the record was dead-lettered. */
	attempts: number;
	/** Human-readable rendering of the last delivery error, if recorded. */
	lastError?: string;
}

/**
 * Write half of the transactional outbox: the only outbox capability the
 * write side (`withCommit`, `UnitOfWork`) depends on. Persisting the
 * events atomically with the aggregate state is the kit's guarantee;
 * DELIVERY is a separate, replaceable concern.
 *
 * Implement ONLY this interface to plug in an external delivery
 * solution: `add()` writes into that solution's outbox storage inside
 * the ambient transaction, and its own listener (polling or
 * WAL/CDC-based, such as a Debezium-style connector, a delivery
 * library, or a broker-native outbox) owns delivery entirely. The
 * kit-side poll surface ({@link Outbox}) is then never involved. See
 * the outbox guide, "External dispatchers".
 */
export interface OutboxWriter<Evt extends AnyDomainEvent> {
	/**
	 * Finalizes and persists event commit candidates. Called from inside
	 * `withCommit`'s transactional callback, atomically with the aggregate
	 * write.
	 *
	 * For every qualified aggregate source, the adapter must serialize source
	 * advancement, read its last eventful aggregate version, write that value as
	 * `previousEventfulAggregateVersion` on every event in the candidate's
	 * commit, and advance the source head to `aggregateVersion` in the SAME
	 * transaction. A state-only aggregate save does not call `add()` and must
	 * therefore not advance this event-source head.
	 *
	 * **Idempotency:** implementations should dedupe on
	 * `candidate.event.eventId`. `withCommit` itself does not retry, but the
	 * surrounding use case (a queue consumer, an HTTP retry, a transactional
	 * outbox-dispatcher loop) may legitimately invoke the same write more than
	 * once. A unique-key constraint on `(eventId)` in the outbox table is the
	 * standard implementation; the source-head update and dedupe decision must
	 * share the transaction. Idempotency applies only when that id still names
	 * the same qualified aggregate source. Reusing an `eventId` for another
	 * `aggregateType` / `aggregateId` is a caller bug: adapters that retain the
	 * conflicting record should reject it rather than replace or silently
	 * reinterpret it as a retry.
	 */
	add: (events: ReadonlyArray<EventCommitCandidate<Evt>>) => Promise<void>;
}

/**
 * Transactional outbox port: the bridge between the write-side
 * transaction and the (out-of-band) event dispatcher.
 *
 * Lifecycle:
 *  1. `add()` inside the write transaction (`withCommit` calls this) so
 *     events persist atomically with the aggregate state
 *     ({@link OutboxWriter}, the only part the write side needs).
 *  2. An outbox dispatcher (the kit's `OutboxDispatcher` or your own)
 *     polls `getPending()` and forwards the events to subscribers /
 *     external brokers.
 *  3. After successful dispatch, the dispatcher calls `markDispatched()`
 *     with the records' `dispatchId`s so they don't come back next poll.
 *
 * `markDispatched` is required to be idempotent: calling it with an id
 * that's already marked is a no-op, not an error. This lets the
 * dispatcher safely retry on partial-failure.
 *
 * **Competing dispatcher instances** are an adapter contract, not a
 * dispatcher feature: a transactional implementation that should
 * support several concurrent pollers must make `getPending` claim the
 * returned records (`FOR UPDATE SKIP LOCKED` or equivalent). Without
 * claiming, run one logical dispatcher per outbox.
 */
export interface Outbox<Evt extends AnyDomainEvent> extends OutboxWriter<Evt> {
	/**
	 * Returns up to `limit` outbox records that have not yet been
	 * dispatched, **in the order `add()` persisted them** (commit order).
	 * The ordering is part of the port contract: `withCommit` promises
	 * subscribers per-aggregate causal order, and a sequential dispatcher
	 * can only honor that promise when this read is ordered. SQL-backed
	 * implementations need a monotonic position column (an auto-increment
	 * primary key works) and an `ORDER BY` on it; a bare `SELECT` returns
	 * rows in storage order, not insertion order. The dispatcher polls
	 * this on a schedule. When `limit` is omitted, the implementation
	 * decides on a default page size.
	 */
	getPending: (limit?: number) => Promise<ReadonlyArray<OutboxRecord<Evt>>>;

	/**
	 * Marks the given dispatch records as delivered so subsequent
	 * `getPending` calls don't return them. Must be idempotent on
	 * already-marked ids.
	 */
	markDispatched: (dispatchIds: ReadonlyArray<string>) => Promise<void>;
}

/**
 * Optional extension of {@link Outbox} for dispatchers that track
 * delivery failures. Without failure tracking, a poison message (an
 * event whose delivery always throws) is redelivered forever: it comes
 * back from every `getPending` poll, blocks per-aggregate ordering
 * behind it, and burns the dispatcher's cycles. This extension gives
 * the dispatcher a bounded-retry story: report each failed delivery via
 * {@link markFailed}; the implementation moves records past its
 * attempt ceiling to a dead-letter set that `getPending` no longer
 * returns, and {@link deadLetters} exposes them for alerting, manual
 * inspection, and redelivery (deliver by hand, then ack via
 * `markDispatched`, which also clears dead-lettered records).
 *
 * See the outbox guide's dispatcher recipe for the retry-then-dead-letter
 * loop this port shape supports.
 */
export interface DispatchTrackingOutbox<Evt extends AnyDomainEvent>
	extends Outbox<Evt> {
	/**
	 * Records one failed delivery attempt for the given record:
	 * increments its attempt count (surfaced as
	 * {@link OutboxRecord.attempts}) and, once the implementation's
	 * ceiling is reached, moves the record to the dead-letter set.
	 * A no-op for unknown or already-dispatched ids (a late failure
	 * report after a successful retry must not resurrect the record).
	 */
	markFailed: (dispatchId: string, error?: unknown) => Promise<void>;

	/**
	 * Records that exhausted their delivery attempts. They no longer
	 * come back from `getPending`; wire this to alerting so poison
	 * messages surface instead of rotting silently.
	 */
	deadLetters: () => Promise<ReadonlyArray<DeadLetterRecord<Evt>>>;
}

/**
 * Discriminates a {@link DispatchTrackingOutbox} from a plain
 * {@link Outbox} at runtime. The single source of truth for the check;
 * the dispatcher and the contract suite both use it, so what counts as
 * a tracking outbox cannot drift between them. Both tracking methods
 * must be present: a plain adapter that happens to expose an unrelated
 * `markFailed` helper must not be mistaken for one that implements the
 * tracking protocol and then be fed `(dispatchId, error)` arguments it
 * never asked for. Internal plumbing, not exported from the package
 * entries.
 */
export function isDispatchTrackingOutbox<Evt extends AnyDomainEvent>(
	outbox: Outbox<Evt> | DispatchTrackingOutbox<Evt>,
): outbox is DispatchTrackingOutbox<Evt> {
	const candidate = outbox as DispatchTrackingOutbox<Evt>;
	return (
		typeof candidate.markFailed === "function" &&
		typeof candidate.deadLetters === "function"
	);
}
