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
export interface EventBus<Evt> {
	/**
	 * Publishes events to all subscribed handlers.
	 * All handlers for each event type will be called.
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
	subscribe: <T extends Evt>(
		eventType: string,
		handler: EventHandler<T>,
	) => () => void;
}
export interface Outbox<Evt> {
	add: (events: ReadonlyArray<Evt>) => Promise<void>;
}
export interface Clock {
	now: () => Date;
}
