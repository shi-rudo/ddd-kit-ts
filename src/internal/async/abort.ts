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
