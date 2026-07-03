/**
 * Invokes a fire-and-forget observer hook (`onPersistError`,
 * `onPublishError`, `onRetry`) and neutralises BOTH failure shapes it can
 * produce. The observers are typed `(...) => void`, but a `void` return
 * type still admits an `async` function, so an observer can fail in two
 * ways: a synchronous throw, or a rejected promise. Either would replace
 * or mask the operation's real outcome (a committed write made to look
 * failed, a retryable error swapped for the observer's own), and the
 * async rejection additionally becomes an `unhandledRejection` that can
 * crash the process under Node's default policy. Both are swallowed
 * here: observers report, they never affect the operation they observe.
 *
 * Internal utility (not exported from the package barrels).
 */
export function reportToObserver(invoke: () => void): void {
	let result: unknown;
	try {
		result = invoke() as unknown;
	} catch {
		return;
	}
	if (
		result !== null &&
		typeof result === "object" &&
		typeof (result as { then?: unknown }).then === "function"
	) {
		(result as Promise<unknown>).then(undefined, () => {});
	}
}
