/**
 * Test support for the contract suite tests. Internal to the testing entry:
 * not re-exported from `@shirudo/ddd-kit/testing`.
 */

/**
 * A queue that starts each call after the previous call settled, like a
 * pool of one connection. A rejected call does not block the calls after
 * it. The contract suite tests use it to model an environment that
 * serializes `run`.
 */
export function serializedCalls(): <R>(start: () => Promise<R>) => Promise<R> {
	let tail: Promise<unknown> = Promise.resolve();
	return (start) => {
		const call = tail.then(start);
		tail = call.catch(() => undefined);
		return call;
	};
}
