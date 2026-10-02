/**
 * The value to reject with when an `AbortSignal` has fired.
 *
 * Returns the signal's `reason` (a `DOMException` `AbortError` for
 * `controller.abort()`, `TimeoutError` for `AbortSignal.timeout`), falling
 * back to a plain `Error` with `fallbackMessage` when `reason` is nullish.
 * A spec-compliant signal always populates `reason` when aborted, so the
 * fallback only fires for a non-spec polyfill; without it, a bare
 * `throw undefined` would surface, breaking `instanceof Error` handling.
 *
 * Centralizes the `signal.reason ?? new Error(...)` idiom used at every
 * abort site (event bus, `withCommit`, `UnitOfWork.run`, the retrying
 * scope) so a single fix covers all of them.
 */
export function abortReason(
	signal: AbortSignal,
	fallbackMessage: string,
): unknown {
	return signal.reason ?? new Error(fallbackMessage);
}

/**
 * Waits for `promise`, but REJECTS with the signal's reason as soon as the
 * signal fires. The promise keeps running; only the wait ends. The abort
 * listener goes away when the promise settles.
 */
export function waitRejectingOnAbort<T>(
	promise: Promise<T>,
	signal: AbortSignal | undefined,
	abortMessage: string,
): Promise<T> {
	if (signal === undefined) return promise;
	return new Promise<T>((resolve, reject) => {
		if (signal.aborted) {
			reject(abortReason(signal, abortMessage));
			return;
		}
		const onAbort = (): void => reject(abortReason(signal, abortMessage));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}
