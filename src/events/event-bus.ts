import type { AnyDomainEvent } from "../aggregate/domain-event";
import type { EventBus, EventHandler, OnceOptions } from "./ports";

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
export class EventBusImpl<Evt extends AnyDomainEvent>
	implements EventBus<Evt>
{
	private readonly handlers = new Map<string, EventHandler<Evt>[]>();

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
		options?: OnceOptions,
	): Promise<Extract<Evt, { type: K }>> {
		return new Promise<Extract<Evt, { type: K }>>((resolve, reject) => {
			// Reject synchronously if the signal is already aborted — don't
			// even subscribe.
			if (options?.signal?.aborted) {
				reject(options.signal.reason ?? new Error("EventBus.once aborted"));
				return;
			}

			let timer: ReturnType<typeof setTimeout> | undefined;
			let settled = false;
			let abortListener: (() => void) | undefined;

			const cleanup = () => {
				if (settled) return;
				settled = true;
				unsubscribe();
				if (timer !== undefined) clearTimeout(timer);
				if (abortListener && options?.signal) {
					options.signal.removeEventListener("abort", abortListener);
				}
			};

			const unsubscribe = this.subscribe(eventType, (event) => {
				cleanup();
				resolve(event);
			});

			if (options?.signal) {
				abortListener = () => {
					cleanup();
					reject(
						options.signal!.reason ?? new Error("EventBus.once aborted"),
					);
				};
				options.signal.addEventListener("abort", abortListener);
			}

			if (typeof options?.timeoutMs === "number") {
				timer = setTimeout(() => {
					cleanup();
					reject(
						new Error(
							`EventBus.once timed out after ${options.timeoutMs}ms waiting for "${eventType}"`,
						),
					);
				}, options.timeoutMs);
			}
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

