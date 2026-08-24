import { ownerSignalOf } from "../../internal/async/execution";

/**
 * Hops one ancestor walk inspects at most. A dead ancestor drops out of the
 * chain once it is collected, so a real chain stays short. This only stops a
 * pathological walk from becoming the cost of publishing.
 */
const WALK_LIMIT = 1024;

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
 * Depth is the number of ancestors that are STILL OPEN, never a number copied
 * from the parent. That distinction is the whole guard. A cycle keeps its
 * ancestors open, because each one awaits the next, so the count grows. A
 * relay lets them finish: a handler that starts the next publication without
 * awaiting it ends, its publication ends, and the count stays flat. A copied
 * depth counts both the same way and kills a correct relay at the bound.
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

	// The state one dispatch was nested in, so the store window can count its
	// open ancestors the way the signal window walks its owner chain.
	private readonly enclosingState = new WeakMap<
		PublishChainState,
		PublishChainState
	>();

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
		let deepest: PublishChainState = { depth: 0, path: [] };
		for (const window of [
			this.openAncestorsInStore(),
			this.openAncestorsOnSignal(signal),
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
		const enclosing = this.store.getStore();
		if (enclosing !== undefined) this.enclosingState.set(state, enclosing);
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
	 * Counts the open dispatches on the owner chain of `signal`.
	 *
	 * A caller can wrap one publication in further bounded executions, and
	 * `withCommit` does exactly that. Every hop derives a fresh signal, so an
	 * identity check alone loses the chain at the first hop.
	 *
	 * The path comes from the nearest open ancestor, which already carries the
	 * event chain up to itself.
	 */
	private openAncestorsOnSignal(
		signal: AbortSignal | undefined,
	): PublishChainState {
		let current = signal;
		let depth = 0;
		let path: readonly string[] = [];
		let hops = 0;
		while (current !== undefined && hops < WALK_LIMIT) {
			hops++;
			if (this.liveDispatchSignals.has(current)) {
				depth++;
				if (path.length === 0) path = this.pathBySignal.get(current) ?? [];
			}
			current = ownerSignalOf(current);
		}
		return { depth, path };
	}

	/** Counts the open dispatches that the injected store is nested in. */
	private openAncestorsInStore(): PublishChainState {
		let current = this.store?.getStore();
		let depth = 0;
		let path: readonly string[] = [];
		let hops = 0;
		while (current !== undefined && hops < WALK_LIMIT) {
			hops++;
			if (this.liveChainStates.has(current)) {
				depth++;
				if (path.length === 0) path = current.path;
			}
			current = this.enclosingState.get(current);
		}
		return { depth, path };
	}
}
