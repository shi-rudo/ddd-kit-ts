import { ownerSignalOf } from "../../internal/async/execution";

/**
 * Hops one ancestor walk inspects at most. A dead ancestor drops out of the
 * chain once it is collected, so a real chain stays short. This only stops a
 * pathological walk from becoming the cost of publishing.
 */
const WALK_LIMIT = 1024;

/** Where a new publication sits on its chain. */
export interface PublishChainOrigin {
	/** Ancestors whose dispatch is still open. */
	readonly depth: number;
	/** Event types along the chain, oldest first. */
	readonly path: readonly string[];
	/** The nearest open ancestor, which the new state records as enclosing. */
	readonly enclosing?: PublishChainState;
}

/**
 * The event path of one publish chain.
 *
 * It carries no depth. Depth is counted from the states that are still open at
 * the moment a publication starts, so a number stored here would be the count
 * from an earlier moment and could disagree with it.
 */
export interface PublishChainState {
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
 *
 * One graph of states carries that. Each publication records the state it was
 * created inside, and a walk of that graph counts the states whose dispatch is
 * still open. The three windows differ only in how they find the state to
 * start the walk from.
 */
export class PublishChainTracker {
	private readonly store: PublishChainStore | undefined;

	// The state each publication was created inside, and the states whose
	// dispatch has not ended. Depth is a walk of the first, counting the
	// second. Weak throughout, so a chain that ends is collectable.
	private readonly enclosingState = new WeakMap<
		PublishChainState,
		PublishChainState
	>();
	private readonly openStates = new WeakSet<PublishChainState>();

	// The state a dispatched context belongs to. A nested publication that
	// carries `context.signal` finds it here, across `await`.
	private readonly stateBySignal = new WeakMap<
		AbortSignal,
		PublishChainState
	>();

	// The state whose synchronous window is open. A synchronous window always
	// runs to completion, so a concurrent publication never observes it open.
	private syncWindowState: PublishChainState | undefined;

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

	/** Depth, path and enclosing state that a publication on `signal` inherits. */
	parentOf(signal: AbortSignal | undefined): PublishChainOrigin {
		let deepest: PublishChainOrigin = { depth: 0, path: [] };
		for (const start of [
			this.store?.getStore(),
			this.syncWindowState,
			this.stateOn(signal),
		]) {
			const window = this.openAncestorsFrom(start);
			if (window.depth > deepest.depth) deepest = window;
		}
		return deepest;
	}

	/** Records the chain of the event dispatching now and runs `dispatch`. */
	async whileOnEvent(
		signal: AbortSignal,
		state: PublishChainState,
		enclosing: PublishChainState | undefined,
		dispatch: () => Promise<void>,
	): Promise<void> {
		if (enclosing !== undefined) this.enclosingState.set(state, enclosing);
		this.stateBySignal.set(signal, state);
		this.openStates.add(state);
		try {
			await (this.store === undefined
				? dispatch()
				: this.store.run(state, dispatch));
		} finally {
			this.openStates.delete(state);
			// The link dies with the dispatch. A relay keeps the signal of each
			// generation reachable, so without this the chain grows by one
			// ancestor per hop and every later publication walks all of them.
			this.enclosingState.delete(state);
		}
	}

	/** Runs one handler call with the synchronous window open. */
	inSyncWindow<R>(state: PublishChainState, call: () => R): R {
		const outer = this.syncWindowState;
		this.syncWindowState = state;
		try {
			return call();
		} finally {
			this.syncWindowState = outer;
		}
	}

	/**
	 * Counts the still-open states above `start`, itself included.
	 *
	 * The path comes from the nearest open one, which already carries the
	 * event chain up to itself.
	 */
	private openAncestorsFrom(
		start: PublishChainState | undefined,
	): PublishChainOrigin {
		let current = start;
		let depth = 0;
		let path: readonly string[] = [];
		let nearest: PublishChainState | undefined;
		let hops = 0;
		while (current !== undefined && hops < WALK_LIMIT) {
			hops++;
			if (this.openStates.has(current)) {
				depth++;
				if (nearest === undefined) {
					nearest = current;
					path = current.path;
				}
			}
			current = this.enclosingState.get(current);
		}
		return { depth, path, enclosing: nearest };
	}

	/**
	 * The state of the nearest dispatch on the owner chain of `signal`.
	 *
	 * A caller can wrap one publication in further bounded executions, and
	 * `withCommit` does exactly that. Every hop derives a fresh signal, so an
	 * identity check alone loses the chain at the first hop.
	 */
	private stateOn(
		signal: AbortSignal | undefined,
	): PublishChainState | undefined {
		let current = signal;
		let hops = 0;
		while (current !== undefined && hops < WALK_LIMIT) {
			hops++;
			const state = this.stateBySignal.get(current);
			if (state !== undefined) return state;
			current = ownerSignalOf(current);
		}
		return undefined;
	}
}
