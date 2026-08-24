import type { AnyDomainEvent } from "../../domain/event/domain-event";
import { abortReason } from "../../internal/async/abort";
import {
	DEFAULT_EXECUTION_TIMEOUT_MS,
	type ExecutionContext,
	runBoundedExecution,
} from "../../internal/async/execution";
import {
	captureObserverFunctions,
	reportToObserver,
} from "../../internal/observer";
import { assertPositiveInteger } from "../../internal/validate";
import { EventBusClosedError, PublishDepthExceededError } from "./errors";
import type {
	EventBus,
	EventHandler,
	OnceOptions,
	PublishOptions,
} from "./ports";
import {
	type PublishChainOrigin,
	type PublishChainState,
	type PublishChainStore,
	PublishChainTracker,
} from "./publish-chain";

/**
 * Wraps a handler rejection as an error without ever throwing itself.
 *
 * A value with a null prototype has no string form, so `String()` on it
 * throws. A throw here would leave the failure recorded in the index list but
 * absent from the error list, and the caller would receive `undefined`.
 */
function toHandlerError(reason: unknown): Error {
	if (reason instanceof Error) return reason;
	let described: string;
	try {
		described = String(reason);
	} catch {
		described = "Event handler rejected with a value that has no string form";
	}
	// Attach the raw reason as cause: a handler rejecting with a structured
	// payload must stay diagnosable, not collapse to '[object Object]'.
	return new Error(described, { cause: reason });
}

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

/** One handler rejected during a publication. */
export interface HandlerFailureReport {
	/** The event the handler received. */
	readonly event: AnyDomainEvent;
	/** Position of the handler in the dispatch batch for this event. */
	readonly index: number;
	/** True when `subscribeAll` registered the handler. */
	readonly catchAll: boolean;
	/** The rejection, wrapped when the handler rejected with a non-error. */
	readonly error: Error;
}

/** A publication ended while handlers were pending. */
export interface PublishAbortedReport {
	/** The event whose dispatch was in flight. */
	readonly event: AnyDomainEvent;
	/** Positions in the batch of the handlers that had not settled. */
	readonly pendingIndices: readonly number[];
	/** Why the publication ended, from the abort reason of the signal. */
	readonly reason: unknown;
}

/** Operational signals from one event bus. */
export interface EventBusObservers {
	/**
	 * A handler rejected.
	 *
	 * A thrown `AggregateError` carries its failures without their
	 * subscription, so it cannot say which handler failed. This report can:
	 * it carries the batch position and the event.
	 *
	 * This reports, it does not handle. The error still reaches the caller of
	 * `publish` under the aggregation contract.
	 */
	readonly onHandlerError: (report: HandlerFailureReport) => void;
	/**
	 * A timeout or an owner abort ended the publication while handlers were
	 * pending. A pending handler continues, and its side effects still land,
	 * because JavaScript cannot stop a running promise.
	 *
	 * The report names them. Without it a timed-out publication says only that
	 * it timed out, never which handler was pending.
	 */
	readonly onPublishAborted: (report: PublishAbortedReport) => void;
	/**
	 * One event type crossed `maxSubscriptionsPerEventType`. Reported at the
	 * crossing and then at each doubling, never once per `subscribe`: a real
	 * leak never drops back, so the trend is the useful part. The report
	 * re-arms only strictly below the threshold: a steady state that sits on
	 * it would otherwise report once per release.
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
 *
 * **What this bus does not promise.** Delivery is at most once and
 * in memory. Nothing is persisted, nothing is retried, and there is
 * no dead-letter path. A process that dies mid-publish loses the
 * remaining work. Anything that must survive a crash belongs behind
 * the `Outbox` port, not here. This bus fits in-process consumers
 * whose work can be rebuilt: projections, caches, metrics.
 *
 * **Handlers must tolerate a second run.** The bus never redelivers. A
 * caller that retries after a timeout does redeliver. The handlers of
 * the first attempt can still run, or they can be finished already.
 * Make a handler idempotent, or do not retry a timed-out publish.
 *
 * **Errors name the failure, not the handler.** A rejected handler
 * reaches the caller unchanged, and an `AggregateError` carries every
 * failure in subscription order. Neither names which subscription
 * failed. `observers.onHandlerError` carries the batch position and the
 * event, so a handler no longer names itself to be identifiable.
 *
 * **A handler that publishes stays inside a bounded chain.** Such a
 * handler re-enters `publish`, and it does so synchronously even when it
 * does not await the result. A cycle in the handler graph overflows
 * the call stack, or it starves the event loop until the process runs
 * out of memory. `timeoutMs` stops neither. A timer is a macrotask, and
 * a starved loop never runs one. Beyond `maxPublishDepth` (default 32)
 * the bus throws `PublishDepthExceededError` and names the event path.
 * The aggregation contract still applies to it. If a second handler of
 * the same event also fails, the caller receives an `AggregateError` that
 * carries the depth error, not the depth error itself.
 *
 * The bound counts one chain, never the bus. Concurrent publications on
 * one shared bus never reach it. A handler links its nested publication
 * to the chain when it passes `context.signal`. That is the same
 * practice that gives the handler cancellation. The link survives the
 * nested operations of the kit, `withCommit` included. It ends at a
 * signal the kit did not derive, for example one from `AbortSignal.any`.
 * A handler that drops the signal leaves no link at all. There, only a
 * synchronous cycle is caught.
 *
 * Pass `chainStore` to follow every chain, whatever a handler does with
 * the signal.
 *
 */
export class EventBusImpl<Evt extends AnyDomainEvent> implements EventBus<Evt> {
	private readonly handlers = new Map<string, EventHandler<Evt>[]>();
	private readonly catchAllHandlers: EventHandler<Evt>[] = [];
	private readonly maxPublishDepth: number;

	private readonly chain: PublishChainTracker;
	private closed = false;
	// How to settle each waiter `once()` created, cleanup included. A callback
	// learns that no event follows by not being called again; a promise cannot,
	// so closing has to settle it or it waits forever. Rejecting alone would
	// leave the timer armed and the abort listener attached, which is the leak
	// close() exists to end.
	private readonly pendingOnce = new Set<(error: Error) => void>();
	private readonly maxSubscriptionsPerEventType: number;
	private readonly observers: Readonly<EventBusObservers> | undefined;
	// The count at which each event type last reported. A real leak never
	// drops back, so reporting only the first crossing would hide the number
	// the operator needs. Reporting again at each doubling shows the trend and
	// stays quiet. Cleared when the count drops back, so a transient spike,
	// for example many in-flight `once` waiters, cannot mute the event type
	// for the rest of the process.
	private readonly reportedAt = new Map<string | symbol, number>();

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
		this.chain = new PublishChainTracker(options.chainStore);
		this.maxPublishDepth = options.maxPublishDepth ?? DEFAULT_MAX_PUBLISH_DEPTH;
		this.maxSubscriptionsPerEventType =
			options.maxSubscriptionsPerEventType ??
			DEFAULT_MAX_SUBSCRIPTIONS_PER_EVENT_TYPE;
		this.observers =
			options.observers === undefined
				? undefined
				: captureObserverFunctions("EventBusImpl", options.observers, [
						"onSubscriptionThresholdExceeded",
						"onHandlerError",
						"onPublishAborted",
					]);
	}

	private rearmSubscriptionReport(
		eventType: string | null,
		subscriptionCount: number,
	): void {
		// Strictly below, never at the threshold. A steady state that sits on
		// it would otherwise re-arm on every release and report once per
		// request.
		if (subscriptionCount >= this.maxSubscriptionsPerEventType) return;
		this.reportedAt.delete(eventType ?? CATCH_ALL);
	}

	private reportSubscriptionCount(
		eventType: string | null,
		subscriptionCount: number,
	): void {
		const observer = this.observers?.onSubscriptionThresholdExceeded;
		if (observer === undefined) return;
		if (subscriptionCount <= this.maxSubscriptionsPerEventType) return;
		const key = eventType ?? CATCH_ALL;
		const lastReportedAt = this.reportedAt.get(key);
		if (
			lastReportedAt !== undefined &&
			subscriptionCount < lastReportedAt * 2
		) {
			return;
		}
		this.reportedAt.set(key, subscriptionCount);
		reportToObserver(() =>
			observer({
				eventType,
				subscriptionCount,
				threshold: this.maxSubscriptionsPerEventType,
			}),
		);
	}

	/** See {@link EventBus.close}. */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.handlers.clear();
		this.catchAllHandlers.length = 0;
		this.reportedAt.clear();
		const waiting = [...this.pendingOnce];
		this.pendingOnce.clear();
		for (const settle of waiting) settle(new EventBusClosedError("once"));
	}

	private assertOpen(operation: string): void {
		if (this.closed) throw new EventBusClosedError(operation);
	}

	subscribe<K extends Evt["type"]>(
		eventType: K,
		handler: EventHandler<Extract<Evt, { type: K }>>,
	): () => void {
		this.assertOpen("subscribe");
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
		this.assertOpen("subscribeAll");
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
			if (this.closed) {
				reject(new EventBusClosedError("once"));
				return;
			}
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

			const settleAsClosed = (error: Error): void => {
				cleanup();
				reject(error);
			};
			this.pendingOnce.add(settleAsClosed);
			const cleanup = () => {
				if (settled) return;
				settled = true;
				this.pendingOnce.delete(settleAsClosed);
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
		this.assertOpen("publish");
		// The errors array lives HERE, outside the bounded execution: the
		// abort/timeout race can reject while handlers already failed, and
		// the port contract promises that collected handler errors are
		// thrown after dispatch. An abort ends the batch but must not
		// swallow the failures that already happened.
		// Depth comes from the chain, never from the instance: one bus is
		// published to concurrently by design. Three windows can see a chain,
		// and a window that cannot see it reports 0, never a wrong depth, so
		// the deepest one is the truth. Depth and path come from that same
		// window, so a reported depth and the path beside it cannot describe
		// different chains. Each window counts only while its own dispatch
		// runs; the fields say why.
		const parent = this.chain.parentOf(options.signal);
		const depth = parent.depth + 1;
		// An empty batch dispatches nothing, so it cannot extend a chain and
		// must not meet the bound. Everything else still runs, so an invalid
		// option is still rejected. Only the first event is about to dispatch,
		// and naming the rest would put events on the chain that never
		// reached it.
		const [first] = events;
		if (first !== undefined && depth > this.maxPublishDepth) {
			throw new PublishDepthExceededError(depth, this.maxPublishDepth, [
				...parent.path,
				first.type,
			]);
		}

		const errors: Error[] = [];
		try {
			await runBoundedExecution(
				"EventBus.publish",
				{
					signal: options.signal,
					timeoutMs: options.timeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS,
				},
				(context) =>
					this.publishWithinContext(events, context, errors, depth, parent),
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
		depth: number,
		parent: PublishChainOrigin,
	): Promise<void> {
		// One abort check for each event, after its dispatch. A check before
		// the dispatch cannot fire: an already aborted signal never reaches
		// here, because the bounded execution returns before it calls this,
		// and the check below ends the loop before the next event starts.
		for (const event of events) {
			// Closing during a batch ends it. Dispatching the rest to the
			// subscriptions that close() released would resolve as if every
			// event had been delivered.
			this.assertOpen("publish");
			// The chain is recorded for the event that dispatches now, never for
			// the whole batch: an event that has not dispatched yet is not on
			// the chain, and naming it in a cycle report is wrong.
			const state: PublishChainState = {
				path: [...parent.path, event.type],
			};
			await this.chain.whileOnEvent(
				context.signal,
				state,
				parent.enclosing,
				() => this.dispatchEvent(event, context, errors, state),
			);
			if (context.signal.aborted) {
				throw abortReason(context.signal, "EventBus.publish aborted");
			}
		}
	}

	private async dispatchEvent(
		event: Evt,
		context: ExecutionContext,
		errors: Error[],
		state: PublishChainState,
	): Promise<void> {
		// Typed and catch-all handlers share ONE allSettled batch, so the
		// contract holds across both kinds: none sees the others' errors,
		// none is skipped when a peer fails. Snapshot so a handler
		// unsubscribing during dispatch doesn't shift indices while we
		// iterate. `typedCount` is part of that snapshot: the typed array is
		// live, and an unsubscribe would otherwise turn a typed handler into a
		// reported catch-all.
		const typed = this.handlers.get(event.type) ?? [];
		const batch = [...typed, ...this.catchAllHandlers];
		const typedCount = typed.length;
		if (batch.length === 0) return;

		// Each failure is recorded the moment it happens, not after the
		// whole batch settles: a hung peer would otherwise trap a
		// settled rejection inside allSettled, invisible to the
		// abort/timeout path that ends the publish.
		const batchStart = errors.length;
		const failedIndices: number[] = [];
		// A handler that never returns stays pending. On abort the bus reports
		// the pending handlers, because the thrown TimeoutError names only the
		// publication, never the handler that did not return.
		const settledIndices = new Set<number>();
		const reportPending = (): void => {
			const observer = this.observers?.onPublishAborted;
			if (observer === undefined) return;
			// One microtask later. A handler that returned an already resolved
			// promise settles in that window, and calling it pending would tell
			// an operator the opposite of the truth.
			queueMicrotask(() => {
				const pendingIndices = batch
					.map((_, index) => index)
					.filter((index) => !settledIndices.has(index));
				if (pendingIndices.length === 0) return;
				reportToObserver(() =>
					observer({ event, pendingIndices, reason: context.signal.reason }),
				);
			});
		};
		context.signal.addEventListener("abort", reportPending, { once: true });
		try {
			await Promise.allSettled(
				batch.map(async (handler, index) => {
					try {
						// `handler(...)` returns at its first `await`, so this
						// window covers exactly the synchronous part of the
						// handler. Splitting the call from the `await` keeps a
						// synchronous throw on the same path as a rejection.
						const running = this.chain.inSyncWindow(state, () =>
							handler(event, context),
						);
						// A handler that returned without a promise is not pending.
						// Mark it here, because a peer that aborts synchronously
						// runs before this wrapper resumes.
						if (typeof (running as { then?: unknown })?.then !== "function") {
							settledIndices.add(index);
						}
						await running;
					} catch (reason) {
						// Wrap first. An index without its error desynchronizes the
						// reorder below and puts `undefined` in front of the caller.
						const error = toHandlerError(reason);
						failedIndices.push(index);
						errors.push(error);
						const observer = this.observers?.onHandlerError;
						if (observer !== undefined) {
							reportToObserver(() =>
								observer({
									event,
									index,
									catchAll: index >= typedCount,
									error,
								}),
							);
						}
					} finally {
						settledIndices.add(index);
					}
				}),
			);
		} finally {
			context.signal.removeEventListener("abort", reportPending);
		}
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
}
