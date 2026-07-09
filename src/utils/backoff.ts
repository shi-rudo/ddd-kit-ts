/**
 * Exponential backoff with jitter, shared by every retry loop in the
 * kit (`RetryingTransactionScope` attempt delays, `OutboxDispatcher`
 * failure backoff).
 *
 * `attempt` is 1-based. The exponential value
 * (`baseDelayMs * 2^(attempt-1)`) is capped at `maxDelayMs`, then a
 * jitter band (`* random(0.8, 1.2)`) is applied and re-clamped to the
 * cap. Pure and deterministic given `random`. Result is never
 * negative.
 *
 * Deliberately not exported from the package entries: it is shared
 * kit plumbing, not public API.
 */
export function computeBackoffDelay(
	attempt: number,
	opts: { baseDelayMs: number; maxDelayMs: number; random: () => number },
): number {
	const exponential = opts.baseDelayMs * 2 ** (attempt - 1);
	const capped = Math.min(opts.maxDelayMs, exponential);
	const jitter = 0.8 + opts.random() * 0.4; // [0.8, 1.2)
	return Math.max(0, Math.min(opts.maxDelayMs, Math.round(capped * jitter)));
}
