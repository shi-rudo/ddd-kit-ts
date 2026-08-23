import type { AnyDomainEvent } from "../../domain/event/domain-event";
import type { ExecutionContext } from "../../utils/execution";

/**
 * Event handler function type for subscribing to domain events. The execution
 * context carries the publication's cooperative cancellation and deadline;
 * those runtime controls belong to the imperative shell, never to the domain
 * event itself.
 *
 * @template Evt - The type of domain event
 */
export type EventHandler<Evt> = (
	event: Evt,
	context: ExecutionContext,
) => Promise<void> | void;

/** Controls one bounded in-process event publication. */
export interface PublishOptions {
	/** Owner/request cancellation propagated to every event handler. */
	readonly signal?: AbortSignal;
	/** Maximum time to await the complete publication. Default `30000`ms. */
	readonly timeoutMs?: number;
}

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
	 * @param options - Owner cancellation and publication timeout
	 */
	publish: (
		events: ReadonlyArray<Evt>,
		options?: PublishOptions,
	) => Promise<void>;

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
