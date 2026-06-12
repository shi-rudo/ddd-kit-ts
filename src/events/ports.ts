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
 * One pending event in the outbox plus the opaque id the implementation
 * needs to ack it via `markDispatched`. The library does not prescribe
 * what `dispatchId` looks like: an implementation can reuse the event's
 * own `eventId`, generate its own UUID, use the row's auto-increment
 * primary key, or whatever the storage layer prefers.
 */
export interface OutboxRecord<Evt extends AnyDomainEvent> {
	dispatchId: string;
	event: Evt;
}

/**
 * Transactional outbox port: the bridge between the write-side
 * transaction and the (out-of-band) event dispatcher.
 *
 * Lifecycle:
 *  1. `add()` inside the write transaction (`withCommit` calls this) so
 *     events persist atomically with the aggregate state.
 *  2. A separate outbox dispatcher polls `getPending()` and forwards the
 *     events to subscribers / external brokers.
 *  3. After successful dispatch, the dispatcher calls `markDispatched()`
 *     with the records' `dispatchId`s so they don't come back next poll.
 *
 * `markDispatched` is required to be idempotent: calling it with an id
 * that's already marked is a no-op, not an error. This lets the
 * dispatcher safely retry on partial-failure.
 */
export interface Outbox<Evt extends AnyDomainEvent> {
	/**
	 * Persists events. Called from inside `withCommit`'s transactional
	 * callback, atomically with the aggregate write.
	 *
	 * **Idempotency:** implementations should dedupe on the event's
	 * `eventId`. `withCommit` itself does not retry, but the surrounding
	 * use case (a queue consumer, an HTTP retry, a transactional
	 * outbox-dispatcher loop) may legitimately invoke the same write more
	 * than once. A unique-key constraint on `(eventId)` in the outbox
	 * table is the standard implementation.
	 */
	add: (events: ReadonlyArray<Evt>) => Promise<void>;

	/**
	 * Returns up to `limit` outbox records that have not yet been
	 * dispatched. The dispatcher polls this on a schedule. When `limit`
	 * is omitted, the implementation decides on a default page size.
	 */
	getPending: (limit?: number) => Promise<ReadonlyArray<OutboxRecord<Evt>>>;

	/**
	 * Marks the given dispatch records as delivered so subsequent
	 * `getPending` calls don't return them. Must be idempotent on
	 * already-marked ids.
	 */
	markDispatched: (dispatchIds: ReadonlyArray<string>) => Promise<void>;
}
