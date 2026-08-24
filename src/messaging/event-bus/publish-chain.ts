import { ownerSignalOf } from "../../internal/async/execution";

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

/**
 * Knows how deep the publish chain of a new publication is.
 *
 * A cycle in a handler graph either overflows the call stack or starves the
 * event loop until the process runs out of memory. Bounding it needs one
 * number: the depth of the chain the caller is already on. Nothing in
 * JavaScript reports that number, so this tracks it.
 *
 * Depth follows the chain, never the bus instance. One bus is shared and
 * published to concurrently by design, so an instance counter would reject
 * correct usage.
 *
 * Three windows can see a chain, and each one is blind in a different way:
 *
 *  - the **store** follows every chain and needs a consumer to inject it;
 *  - the **signal** survives an `await` and needs the handler to pass
 *    `context.signal`, and it ends at a signal the kit did not derive;
 *  - the **synchronous window** needs nothing and ends at the first `await`.
 *
 * A window that cannot see a chain reports 0, never a wrong depth, so the
 * deepest one is the truth.
 *
 * Every window counts only while its own dispatch runs. A store and a context
 * signal both stay readable in deferred work, so a handler that schedules a
 * later publication would otherwise inherit a depth from a chain that already
 * ended, and a correct poll loop would die at the bound.
 */
export class PublishChainTracker {
	private readonly store: PublishChainStore | undefined;

	// Depth and event path of the chain each dispatched context belongs to,
	// keyed by the signal the handlers receive. A nested publication that
	// carries `context.signal` finds its parent here, across `await`. The
	// entries die with the context, so nothing accumulates.
	private readonly depthBySignal = new WeakMap<AbortSignal, number>();
	private readonly pathBySignal = new WeakMap<AbortSignal, readonly string[]>();

	// Membership, not mere presence, says that a chain is still open.
	private readonly liveChainStates = new WeakSet<PublishChainState>();
	private readonly liveDispatchSignals = new WeakSet<AbortSignal>();

	// The chain depth and path of the dispatch whose synchronous window is
	// open. Absolute, never a frame count: a batch dispatches its events one
	// after another, so the frame of event 1 has unwound when event 2 runs and
	// only an absolute value still describes the chain. Swapped, never
	// mutated, so a reader can keep the array it was handed. A synchronous
	// window always runs to completion, so a concurrent publication never
	// observes it open.
	private syncWindowDepth = 0;
	private syncWindowPath: readonly string[] = [];

	constructor(store: PublishChainStore | undefined) {
		if (
			store !== undefined &&
			(typeof store.run !== "function" || typeof store.getStore !== "function")
		) {
			throw new TypeError(
				"EventBusImpl.chainStore must provide run and getStore",
			);
		}
		// Kept as the original object: the methods of AsyncLocalStorage need
		// their receiver, so copying them onto a new object would break it.
		this.store = store;
	}

	/** Depth and path that a publication on `signal` inherits. */
	parentOf(signal: AbortSignal | undefined): PublishChainState {
		const stored = this.store?.getStore();
		const fromStore =
			stored !== undefined && this.liveChainStates.has(stored)
				? stored
				: undefined;
		const fromSignal = this.throughOwnerChain(signal);
		let deepest: PublishChainState = { depth: 0, path: [] };
		for (const window of [
			fromStore ?? { depth: 0, path: [] },
			fromSignal,
			{ depth: this.syncWindowDepth, path: this.syncWindowPath },
		]) {
			// Depth and path come from the same window, so a reported depth and
			// the path beside it cannot describe different chains.
			if (window.depth > deepest.depth) deepest = window;
		}
		return deepest;
	}

	/** Runs `dispatch` with the publication of `signal` marked as open. */
	whileDispatching<R>(
		signal: AbortSignal,
		dispatch: () => Promise<R>,
	): Promise<R> {
		this.liveDispatchSignals.add(signal);
		return dispatch().finally(() => {
			this.liveDispatchSignals.delete(signal);
		});
	}

	/** Records the chain of the event dispatching now and runs `dispatch`. */
	async whileOnEvent(
		signal: AbortSignal,
		state: PublishChainState,
		dispatch: () => Promise<void>,
	): Promise<void> {
		this.depthBySignal.set(signal, state.depth);
		this.pathBySignal.set(signal, state.path);
		if (this.store === undefined) {
			await dispatch();
			return;
		}
		this.liveChainStates.add(state);
		try {
			await this.store.run(state, dispatch);
		} finally {
			this.liveChainStates.delete(state);
		}
	}

	/** Runs one handler call with the synchronous window open. */
	inSyncWindow<R>(state: PublishChainState, call: () => R): R {
		const outerDepth = this.syncWindowDepth;
		const outerPath = this.syncWindowPath;
		this.syncWindowDepth = state.depth;
		this.syncWindowPath = state.path;
		try {
			return call();
		} finally {
			this.syncWindowDepth = outerDepth;
			this.syncWindowPath = outerPath;
		}
	}

	/**
	 * Walks to the nearest open dispatch on the owner chain of `signal`.
	 *
	 * A caller can wrap one publication in further bounded executions, and
	 * `withCommit` does exactly that. Every hop derives a fresh signal, so an
	 * identity check alone loses the chain at the first hop.
	 */
	private throughOwnerChain(
		signal: AbortSignal | undefined,
	): PublishChainState {
		let current = signal;
		while (current !== undefined) {
			const depth = this.depthBySignal.get(current);
			if (depth !== undefined && this.liveDispatchSignals.has(current)) {
				return { depth, path: this.pathBySignal.get(current) ?? [] };
			}
			current = ownerSignalOf(current);
		}
		return { depth: 0, path: [] };
	}
}
