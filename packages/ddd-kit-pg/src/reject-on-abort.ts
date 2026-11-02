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
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		work
			.then(resolve, reject)
			.finally(() => signal.removeEventListener("abort", onAbort));
	});
}
