import type { DomainEvent } from "../aggregate/domain-event";
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
	private readonly handlers = new Map<string, EventHandler<any>[]>();

	subscribe<K extends Evt["type"]>(
		eventType: K,
		handler: EventHandler<Extract<Evt, { type: K }>>,
	): () => void {
		const type = eventType;
		if (!this.handlers.has(type)) {
			this.handlers.set(type, []);
		}
		const handlersForType = this.handlers.get(type)!;
		const casted = handler as EventHandler<Evt>;
		handlersForType.push(casted);

		// Return unsubscribe — removes exactly this subscription, even if the
		// same handler reference was subscribed multiple times (each call to
		// subscribe gets its own unsubscribe).
		let removed = false;
		return () => {
			if (removed) return;
			const idx = handlersForType.indexOf(casted);
			if (idx !== -1) {
				handlersForType.splice(idx, 1);
				removed = true;
			}
			if (handlersForType.length === 0) {
				this.handlers.delete(type);
			}
		};
	}

	once<K extends Evt["type"]>(
		eventType: K,
	): Promise<Extract<Evt, { type: K }>> {
		return new Promise<Extract<Evt, { type: K }>>((resolve) => {
			const unsubscribe = this.subscribe(eventType, (event) => {
				unsubscribe();
				resolve(event);
			});
		});
	}

	/**
	 * See {@link EventBus.publish} for the full ordering / parallelism /
	 * error-aggregation contract this implementation realises:
	 *  - events in input order, sequentially;
	 *  - handlers within one event in parallel via `Promise.allSettled`;
	 *  - errors collected and thrown after the batch (single Error, or
	 *    `AggregateError` for multiple failures).
	 */
	async publish(events: ReadonlyArray<Evt>): Promise<void> {
		const errors: Error[] = [];

		for (const event of events) {
			const handlersForType = this.handlers.get(event.type);
			if (handlersForType) {
				// Snapshot so a handler unsubscribing during dispatch doesn't
				// shift indices while we iterate.
				const results = await Promise.allSettled(
					handlersForType.slice().map((handler) => handler(event)),
				);
				for (const result of results) {
					if (result.status === "rejected") {
						errors.push(
							result.reason instanceof Error
								? result.reason
								: new Error(String(result.reason)),
						);
					}
				}
			}
		}

		if (errors.length === 1) {
			throw errors[0];
		}
		if (errors.length > 1) {
			throw new AggregateError(errors, "Multiple event handlers failed");
		}
	}
}

