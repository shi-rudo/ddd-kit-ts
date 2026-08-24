import { abortReason } from "./abort";

/**
 * Abortable `setTimeout` that RESOLVES early when the signal fires.
 * The graceful-stop variant: callers that treat an abort as "stop
 * sleeping and wind down" (a worker loop's idle or backoff sleep) use
 * this so the loop can observe `signal.aborted` and return cleanly.
 */
export function sleepResolvingOnAbort(
	ms: number,
	signal: AbortSignal,
): Promise<void> {
	if (ms <= 0 || signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const done = (): void => {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal.addEventListener("abort", done, { once: true });
	});
}

/**
 * Abortable `setTimeout` that REJECTS with the signal's reason when it
 * fires. The cancellation variant: callers that treat an abort as "this
 * operation failed, propagate it" (a retry loop whose caller awaits the
 * result) use this so the rejection carries through.
 */
export function sleepRejectingOnAbort(
	ms: number,
	signal: AbortSignal | undefined,
	abortMessage: string,
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortReason(signal, abortMessage));
			return;
		}
		let onAbort: (() => void) | undefined;
		const timer = setTimeout(() => {
			if (onAbort && signal) signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		if (signal) {
			onAbort = () => {
				clearTimeout(timer);
				reject(abortReason(signal, abortMessage));
			};
			signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}
