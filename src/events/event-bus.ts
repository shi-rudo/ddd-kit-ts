import type { DomainEvent } from "../aggregate/aggregate";
import type { EventBus, EventHandler } from "./ports";

/**
 * Simple in-memory event bus implementation.
 * Supports multiple subscribers per event type (pub/sub pattern).
 *
 * @template Evt - The type of domain events (must extend DomainEvent)
 *
 * @example
 * ```typescript
 * const bus = new EventBusImpl<OrderEvent>();
 *
 * bus.subscribe("OrderCreated", async (event) => {
 *   await sendEmail(event.payload.customerId);
 * });
 *
 * bus.subscribe("OrderCreated", async (event) => {
 *   await logEvent(event);
 * });
 *
 * await bus.publish([orderCreatedEvent]);
 * // Both handlers will be called
 * ```
 */
export class EventBusImpl<Evt extends DomainEvent<string, unknown>>
	implements EventBus<Evt>
{
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private readonly handlers = new Map<string, Set<EventHandler<any>>>();

	subscribe<T extends Evt>(
		eventType: string,
		handler: EventHandler<T>,
	): () => void {
		const type = eventType;
		if (!this.handlers.has(type)) {
			this.handlers.set(type, new Set());
		}
		const handlersForType = this.handlers.get(type)!;
		handlersForType.add(handler);

		// Return unsubscribe function
		return () => {
			handlersForType.delete(handler);
			if (handlersForType.size === 0) {
				this.handlers.delete(type);
			}
		};
	}

	async publish(events: ReadonlyArray<Evt>): Promise<void> {
		for (const event of events) {
			const handlersForType = this.handlers.get(event.type);
			if (handlersForType) {
				// Call all handlers for this event type
				await Promise.all(
					Array.from(handlersForType).map((handler) => handler(event)),
				);
			}
		}
	}
}

