import type { AnyDomainEvent } from "../aggregate/domain-event";
import { abortReason } from "../utils/abort";
import {
	DEFAULT_EXECUTION_TIMEOUT_MS,
	type ExecutionContext,
	runBoundedExecution,
} from "../utils/execution";
import type {
	EventBus,
	EventHandler,
	OnceOptions,
	PublishOptions,
} from "./ports";

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
export class EventBusImpl<Evt extends AnyDomainEvent> implements EventBus<Evt> {
	private readonly handlers = new Map<string, EventHandler<Evt>[]>();
	private readonly catchAllHandlers: EventHandler<Evt>[] = [];

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

		// Return unsubscribe: removes exactly this subscription, even if the
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

	/**
	 * See {@link EventBus.subscribeAll}: every published event, in the
	 * same dispatch batch as its typed handlers.
	 */
	subscribeAll(handler: EventHandler<Evt>): () => void {
		this.catchAllHandlers.push(handler);

		// Unsubscribe semantics as in subscribe(): removes exactly this
		// subscription, even when the same handler reference was
		// subscribed multiple times.
		let removed = false;
		return () => {
			if (removed) return;
			const idx = this.catchAllHandlers.indexOf(handler);
			if (idx !== -1) {
				this.catchAllHandlers.splice(idx, 1);
				removed = true;
			}
		};
	}

	once<K extends Evt["type"]>(
		eventType: K,
		options?: OnceOptions,
	): Promise<Extract<Evt, { type: K }>> {
		return new Promise<Extract<Evt, { type: K }>>((resolve, reject) => {
			// Reject synchronously if the signal is already aborted; don't
			// even subscribe.
			if (options?.signal?.aborted) {
				reject(abortReason(options.signal, "EventBus.once aborted"));
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
					reject(abortReason(options.signal!, "EventBus.once aborted"));
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
	async publish(
		events: ReadonlyArray<Evt>,
		options: PublishOptions = {},
	): Promise<void> {
		return runBoundedExecution(
			"EventBus.publish",
			{
				signal: options.signal,
				timeoutMs: options.timeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS,
			},
			(context) => this.publishWithinContext(events, context),
		);
	}

	private async publishWithinContext(
		events: ReadonlyArray<Evt>,
		context: ExecutionContext,
	): Promise<void> {
		const errors: Error[] = [];

		for (const event of events) {
			if (context.signal.aborted) {
				throw abortReason(context.signal, "EventBus.publish aborted");
			}
			// Typed and catch-all handlers share ONE allSettled batch, so the
			// contract holds across both kinds: none sees the others' errors,
			// none is skipped when a peer fails. Snapshot so a handler
			// unsubscribing during dispatch doesn't shift indices while we
			// iterate. The async wrapper converts a synchronous throw
			// (EventHandler may return void) into a rejection; otherwise it
			// would escape before allSettled sees the array, skipping peers
			// and orphaning their promises.
			const batch = [
				...(this.handlers.get(event.type) ?? []),
				...this.catchAllHandlers,
			];
			if (batch.length > 0) {
				const results = await Promise.allSettled(
					batch.map(async (handler) => handler(event, context)),
				);
				for (const result of results) {
					if (result.status === "rejected") {
						errors.push(
							result.reason instanceof Error
								? result.reason
								: // Attach the raw reason as cause: a handler
									// rejecting with a structured payload must stay
									// diagnosable, not collapse to '[object Object]'.
									new Error(String(result.reason), {
										cause: result.reason,
									}),
						);
					}
				}
			}
			if (context.signal.aborted) {
				throw abortReason(context.signal, "EventBus.publish aborted");
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
