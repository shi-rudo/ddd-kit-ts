import type { AnyDomainEvent } from "../../domain/event/domain-event";
import type { ExecutionContext } from "../../internal/async/execution";

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
	/**
	 * Maximum time to await the complete publication. Default `30000`ms.
	 *
	 * This bounds the WAIT, not the handler. JavaScript cannot terminate a
	 * running promise, so a handler that ignores `context.signal` keeps
	 * running after `publish` rejects, and its side effects still land.
	 * Pass `context.signal` into every I/O call a handler makes.
	 */
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
	 *  1. **Events run in input order.** `publish([a, b, c])` dispatches `a`
	 *     and awaits every handler of `a`. Then it dispatches `b`, and so
	 *     on. The bus never changes that order. It never dispatches two
	 *     events at the same time.
	 *  2. **The handlers of one event run in parallel.** The bus awaits
	 *     every handler of `event.type` through `Promise.allSettled`. One
	 *     handler never sees the error of another handler. The bus skips no
	 *     handler when a peer fails. The bus applies no limit here: twenty
	 *     handlers that each open a connection open twenty connections.
	 *     Backpressure belongs to the client that the handler calls.
	 *  3. **The bus collects the errors and throws them after the batch.**
	 *     If one handler throws, the other handlers of that event still
	 *     run, and the remaining events still publish. At the end of the
	 *     batch `publish` throws. One failure throws that error directly.
	 *     Two or more failures throw an `AggregateError` with the message
	 *     "Multiple event handlers failed", which carries every collected
	 *     error. For fail-fast behavior, publish one event for each call.
	 *     A batch is not atomic.
	 *
	 * The contract is intentionally simple and in-process. For delivery
	 * across processes, for example through RabbitMQ or Kafka, use the
	 * `Outbox` port and a dedicated dispatcher.
	 *
	 * **Delivery guarantee.** The port does not promise persistence, retry, or
	 * a dead-letter path. Each implementation states its own guarantee. Work
	 * that must survive a crash belongs behind the `Outbox` port.
	 *
	 * **Handlers must tolerate a second run.** The port never redelivers. A
	 * caller that retries does redeliver, and the handlers of the first
	 * attempt can still run. Make a handler idempotent, or do not retry.
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
	/**
	 * Releases every subscription and settles every waiter.
	 *
	 * A bus that outlives its scope keeps its handlers alive with it. A
	 * worker that shuts down, a test that tears down, and a request scope
	 * that ends all need one call that leaves the bus holding nothing.
	 *
	 * After this call, `publish`, `subscribe`, `subscribeAll` and `once`
	 * throw. Use after close is a programming bug, and a silent no-op would
	 * look like a delivery that did not happen. A pending `once()` rejects
	 * rather than waiting forever, which is the only waiter the port can
	 * settle: a handler is a callback and learns that no event follows by
	 * not being called again.
	 *
	 * Calling it again does nothing.
	 *
	 * This releases the subscriptions. It does not stop a handler that is
	 * already running, because JavaScript cannot terminate a running
	 * promise. Pass `context.signal` into every call a handler makes, and a
	 * publication in flight ends with the handler that honours it.
	 */
	close: () => void;

	once: <K extends Evt["type"]>(
		eventType: K,
		options?: OnceOptions,
	) => Promise<Extract<Evt, { type: K }>>;
}

/**
 * Options for `EventBus.once()`. Both fields are optional; without them
 * `once()` waits forever.
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
