/**
 * Stops the wait for `work` when the signal aborts. The statement stays on its
 * connection, because `pg` cannot cancel it through a signal. Set
 * `statement_timeout` to bound a statement that hangs.
 */
export function rejectOnAbort<T>(
	work: Promise<T>,
	signal: AbortSignal | undefined,
): Promise<T> {
	if (signal === undefined) return work;
	if (signal.aborted) {
		// As after an abort during the wait, a later failure of the work does not
		// reach the caller, and it must not become an unhandled rejection.
		work.catch(() => {});
		return Promise.reject(signal.reason);
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		work
			.then(resolve, reject)
			.finally(() => signal.removeEventListener("abort", onAbort));
	});
}
