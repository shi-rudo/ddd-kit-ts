import type { AnyDomainEvent } from "../../domain/event/domain-event";
import { abortReason } from "../../internal/async/abort";
import {
	DEFAULT_EXECUTION_TIMEOUT_MS,
	type ExecutionContext,
	ownerSignalOf,
	runBoundedExecution,
} from "../../internal/async/execution";
import {
	captureObserverFunctions,
	reportToObserver,
} from "../../internal/observer";
import { assertPositiveInteger } from "../../internal/validate";
import { PublishDepthExceededError } from "./errors";
import type {
	EventBus,
	EventHandler,
	OnceOptions,
	PublishOptions,
} from "./ports";

/** Bound for one publish chain. Real nesting stays far below this. */
const DEFAULT_MAX_PUBLISH_DEPTH = 32;

/**
 * Subscriptions held for one event type when the count crossed the threshold.
 */
export interface SubscriptionThresholdReport {
	/** The event type, or `null` when the subscriptions are catch-all. */
	readonly eventType: string | null;
	/** Subscriptions held at the moment of the crossing. */
	readonly subscriptionCount: number;
	/** The threshold that was crossed. */
	readonly threshold: number;
}

/** Operational signals from one event bus. */
export interface EventBusObservers {
	/**
	 * One event type crossed `maxSubscriptionsPerEventType`. Reported once for
	 * each crossing, never once per `subscribe`. When the count drops back to
	 * the threshold, the next crossing reports again.
	 *
	 * A subscription that a request path opens without the matching
	 * unsubscribe leaks. The symptom is memory growth, and the bus is the only
	 * place that can name the event type. The hook is best-effort: a throw or
	 * a rejected promise cannot affect the subscription.
	 */
	readonly onSubscriptionThresholdExceeded: (
		report: SubscriptionThresholdReport,
	) => void;
}

/** Marks the catch-all subscriptions in the reported-once set. */
const CATCH_ALL = Symbol("EventBusImpl.subscribeAll");

/**
 * Subscriptions for one event type above which the bus reports a leak. A
 * fan-out of projections stays far below this.
 */
const DEFAULT_MAX_SUBSCRIPTIONS_PER_EVENT_TYPE = 32;

/** Depth and event path of one publish chain. */
export interface PublishChainState {
	/** Nested publications, the outermost counting as 1. */
	readonly depth: number;
	/** Event types along the chain, oldest first. */
	readonly path: readonly string[];
}

/**
 * Carries a publish chain across an `await` when the signal cannot.
 *
 * The shape is that of `AsyncLocalStorage`. The kit does not import
 * `node:async_hooks` itself: that specifier does not resolve under the browser
 * conditions an edge bundle uses, and the kit ships one build. A consumer on
 * Node passes the platform class, and a consumer on an edge runtime passes
 * nothing.
 *
 * ```ts
 * import { AsyncLocalStorage } from "node:async_hooks";
 *
 * const bus = new EventBusImpl<OrderEvent>({
 *   chainStore: new AsyncLocalStorage<PublishChainState>(),
 * });
 * ```
 */
export interface PublishChainStore {
	run<R>(state: PublishChainState, callback: () => R): R;
	getStore(): PublishChainState | undefined;
}

/** Construction options for {@link EventBusImpl}. */
export interface EventBusOptions {
	/**
	 * Subscriptions for one event type above which the bus reports through
	 * `observers.onSubscriptionThresholdExceeded`. Default `32`.
	 *
	 * This reports, it never throws. A legitimate fan-out of many projections
	 * on one event type stays possible.
	 */
	readonly maxSubscriptionsPerEventType?: number;
	/**
	 * Where operational signals go. Without this the bus reports nothing, and
	 * a subscription leak stays invisible.
	 */
	readonly observers?: EventBusObservers;
	/**
	 * Maximum depth of one publish chain. Default `32`.
	 *
	 * A handler that publishes re-enters `publish`. An unbounded chain either
	 * overflows the call stack or starves the event loop until the process runs
	 * out of memory, and the publish timeout stops neither. Beyond this depth
	 * the bus throws {@link PublishDepthExceededError}.
	 *
	 * The bound counts one publish CHAIN, never the bus instance. Concurrent
	 * publications on one shared bus never reach it.
	 */
	readonly maxPublishDepth?: number;
	/**
	 * Where the publish chain is kept across an `await`.
	 *
	 * Without this the bus follows the chain through the signal, which holds
	 * across its own nested operations but ends at a signal the kit did not
	 * derive, for example one from `AbortSignal.any`. A store follows every
	 * chain, whatever the handler does with the signal.
	 */
	readonly chainStore?: PublishChainStore;
}

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
	private readonly maxPublishDepth: number;

	// Depth and event path of the chain each dispatched context belongs to,
	// keyed by the signal the handlers receive. A nested publish that carries
	// `context.signal` finds its parent here, across `await`. The entries die
	// with the context, so nothing accumulates.
	private readonly chainDepth = new WeakMap<AbortSignal, number>();
	private readonly chainPath = new WeakMap<AbortSignal, readonly string[]>();

	// Depth of the SYNCHRONOUS part of the current dispatch. A synchronous
	// window always runs to completion, so a concurrent publication never
	// observes this raised. It catches the cycle that a handler hides by
	// dropping `context.signal`.
	private syncDepth = 0;
	private readonly syncPath: string[] = [];

	private readonly chainStore: PublishChainStore | undefined;
	private readonly maxSubscriptionsPerEventType: number;
	private readonly observers: Readonly<EventBusObservers> | undefined;
	// Event types that already reported their current crossing. Cleared when
	// the count drops back, so a transient spike, for example many in-flight
	// `once` waiters, cannot mute the event type for the rest of the process.
	private readonly reportedThresholds = new Set<string | symbol>();

	constructor(options: EventBusOptions = {}) {
		if (options.maxPublishDepth !== undefined) {
			assertPositiveInteger(
				"EventBusImpl",
				"maxPublishDepth",
				options.maxPublishDepth,
			);
		}
		if (options.maxSubscriptionsPerEventType !== undefined) {
			assertPositiveInteger(
				"EventBusImpl",
				"maxSubscriptionsPerEventType",
				options.maxSubscriptionsPerEventType,
			);
		}
		if (
			options.chainStore !== undefined &&
			(typeof options.chainStore.run !== "function" ||
				typeof options.chainStore.getStore !== "function")
		) {
			throw new TypeError(
				"EventBusImpl.chainStore must provide run and getStore",
			);
		}
		// Kept as the original object: the methods of AsyncLocalStorage need
		// their receiver, so copying them onto a new object would break it.
		this.chainStore = options.chainStore;
		this.maxPublishDepth = options.maxPublishDepth ?? DEFAULT_MAX_PUBLISH_DEPTH;
		this.maxSubscriptionsPerEventType =
			options.maxSubscriptionsPerEventType ??
			DEFAULT_MAX_SUBSCRIPTIONS_PER_EVENT_TYPE;
		this.observers =
			options.observers === undefined
				? undefined
				: captureObserverFunctions("EventBusImpl", options.observers, [
						"onSubscriptionThresholdExceeded",
					]);
	}

	/**
	 * Depth and path of the chain the given signal belongs to.
	 *
	 * A caller can wrap one publication in further bounded executions, and
	 * `withCommit` does exactly that. Every hop derives a fresh signal, so an
	 * identity check alone loses the chain at the first hop. Walking the owner
	 * chain finds the nearest execution this bus dispatched.
	 */
	private chainStateFor(signal: AbortSignal | undefined): {
		readonly depth: number;
		readonly path: readonly string[] | undefined;
	} {
		let current = signal;
		while (current !== undefined) {
			const depth = this.chainDepth.get(current);
			if (depth !== undefined) {
				return { depth, path: this.chainPath.get(current) };
			}
			current = ownerSignalOf(current);
		}
		return { depth: 0, path: undefined };
	}

	private rearmSubscriptionReport(
		eventType: string | null,
		subscriptionCount: number,
	): void {
		if (subscriptionCount > this.maxSubscriptionsPerEventType) return;
		this.reportedThresholds.delete(eventType ?? CATCH_ALL);
	}

	private reportSubscriptionCount(
		eventType: string | null,
		subscriptionCount: number,
	): void {
		const observer = this.observers?.onSubscriptionThresholdExceeded;
		if (observer === undefined) return;
		if (subscriptionCount <= this.maxSubscriptionsPerEventType) return;
		const key = eventType ?? CATCH_ALL;
		if (this.reportedThresholds.has(key)) return;
		this.reportedThresholds.add(key);
		reportToObserver(() =>
			observer({
				eventType,
				subscriptionCount,
				threshold: this.maxSubscriptionsPerEventType,
			}),
		);
	}

	subscribe<K extends Evt["type"]>(
		eventType: K,
		handler: EventHandler<Extract<Evt, { type: K }>>,
	): () => void {
		const type = eventType;
		let handlersForType = this.handlers.get(type);
		if (handlersForType === undefined) {
			handlersForType = [];
			this.handlers.set(type, handlersForType);
		}
		const casted = handler as EventHandler<Evt>;
		handlersForType.push(casted);
		this.reportSubscriptionCount(type, handlersForType.length);

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
			this.rearmSubscriptionReport(type, handlersForType.length);
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
		this.reportSubscriptionCount(null, this.catchAllHandlers.length);

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
			this.rearmSubscriptionReport(null, this.catchAllHandlers.length);
		};
	}

	once<K extends Evt["type"]>(
		eventType: K,
		options?: OnceOptions,
	): Promise<Extract<Evt, { type: K }>> {
		return new Promise<Extract<Evt, { type: K }>>((resolve, reject) => {
			const signal = options?.signal;

			// Reject synchronously if the signal is already aborted; don't
			// even subscribe.
			if (signal?.aborted) {
				reject(abortReason(signal, "EventBus.once aborted"));
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
				if (abortListener && signal) {
					signal.removeEventListener("abort", abortListener);
				}
			};

			const unsubscribe = this.subscribe(eventType, (event) => {
				cleanup();
				resolve(event);
			});

			if (signal) {
				abortListener = () => {
					cleanup();
					reject(abortReason(signal, "EventBus.once aborted"));
				};
				signal.addEventListener("abort", abortListener);
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
	 * error-aggregation contract this implementation realizes:
	 *  - events in input order, sequentially;
	 *  - handlers within one event in parallel via `Promise.allSettled`;
	 *  - errors collected and thrown after the batch (single Error, or
	 *    `AggregateError` for multiple failures).
	 */
	async publish(
		events: ReadonlyArray<Evt>,
		options: PublishOptions = {},
	): Promise<void> {
		// The errors array lives HERE, outside the bounded execution: the
		// abort/timeout race can reject while handlers already failed, and
		// the port contract promises that collected handler errors are
		// thrown after dispatch. An abort ends the batch but must not
		// swallow the failures that already happened.
		// Depth comes from the chain, never from the instance. Two sources see
		// it: the parent signal (survives `await`, needs the handler to pass
		// `context.signal`) and the synchronous window (needs nothing). Take
		// whichever is higher.
		// Up to three windows can see the chain: an injected store, the owner
		// chain of the signal, and the synchronous window. A window that cannot
		// see it reports 0, never a wrong depth, so the deepest one is the
		// truth. Depth and path come from that same window, so a reported depth
		// and the path beside it cannot describe different chains.
		const lineage = this.chainStateFor(options.signal);
		const stored = this.chainStore?.getStore();
		let parent: { depth: number; path: readonly string[] } = {
			depth: 0,
			path: [],
		};
		for (const window of [
			{ depth: stored?.depth ?? 0, path: stored?.path ?? [] },
			{ depth: lineage.depth, path: lineage.path ?? [] },
			{ depth: this.syncDepth, path: this.syncPath as readonly string[] },
		]) {
			if (window.depth > parent.depth) parent = window;
		}
		const depth = parent.depth + 1;
		const path = [...parent.path, ...events.map((event) => event.type)];
		if (depth > this.maxPublishDepth) {
			throw new PublishDepthExceededError(depth, this.maxPublishDepth, path);
		}

		const errors: Error[] = [];
		try {
			await runBoundedExecution(
				"EventBus.publish",
				{
					signal: options.signal,
					timeoutMs: options.timeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS,
				},
				(context) => {
					this.chainDepth.set(context.signal, depth);
					this.chainPath.set(context.signal, path);
					const dispatch = () =>
						this.publishWithinContext(events, context, errors);
					return this.chainStore === undefined
						? dispatch()
						: this.chainStore.run({ depth, path }, dispatch);
				},
			);
		} catch (boundedError) {
			if (errors.length === 0) throw boundedError;
			throw new AggregateError(
				[
					boundedError instanceof Error
						? boundedError
						: new Error(String(boundedError), { cause: boundedError }),
					...errors,
				],
				"EventBus.publish aborted after handler failures",
			);
		}
		if (errors.length === 1) {
			throw errors[0];
		}
		if (errors.length > 1) {
			throw new AggregateError(errors, "Multiple event handlers failed");
		}
	}

	private async publishWithinContext(
		events: ReadonlyArray<Evt>,
		context: ExecutionContext,
		errors: Error[],
	): Promise<void> {
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
				// Each failure is recorded the moment it happens, not after the
				// whole batch settles: a hung peer would otherwise trap a
				// settled rejection inside allSettled, invisible to the
				// abort/timeout path that ends the publish.
				const batchStart = errors.length;
				const failedIndices: number[] = [];
				await Promise.allSettled(
					batch.map(async (handler, index) => {
						try {
							// `handler(...)` returns at its first `await`, so this
							// window is exactly the synchronous nesting. Splitting the
							// call from the `await` keeps a synchronous throw on the
							// same path as a rejection.
							this.syncDepth++;
							this.syncPath.push(event.type);
							let running: Promise<void> | void;
							try {
								running = handler(event, context);
							} finally {
								this.syncDepth--;
								this.syncPath.pop();
							}
							await running;
						} catch (reason) {
							failedIndices.push(index);
							errors.push(
								reason instanceof Error
									? reason
									: // Attach the raw reason as cause: a handler
										// rejecting with a structured payload must stay
										// diagnosable, not collapse to '[object Object]'.
										new Error(String(reason), { cause: reason }),
							);
						}
					}),
				);
				// A settled batch reports its failures in subscription order
				// (the aggregation contract); recording order above is
				// settlement order so an abort mid-batch already sees them.
				const settled = errors.splice(batchStart);
				errors.push(
					...failedIndices
						.map((index, i) => ({ index, error: settled[i] as Error }))
						.sort((a, b) => a.index - b.index)
						.map((entry) => entry.error),
				);
			}
			if (context.signal.aborted) {
				throw abortReason(context.signal, "EventBus.publish aborted");
			}
		}
	}
}
