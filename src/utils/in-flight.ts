/**
 * Awaits an in-flight pass on behalf of a joining caller without
 * letting a signal-less pass hold the joiner hostage: on the joiner's
 * abort this resolves `"stopped"` and leaves the pass running for its
 * owner. The pass promise must never reject (the pollers' documented
 * contract), so a plain `then` suffices; the abort listener is removed
 * once the pass settles.
 */
export function joinWithoutBlockingOnAbort(
	pass: Promise<"drained" | "stopped">,
	signal: AbortSignal | undefined,
): Promise<"drained" | "stopped"> {
	if (signal === undefined) return pass;
	if (signal.aborted) return Promise.resolve("stopped");
	return new Promise((resolve) => {
		const onAbort = (): void => resolve("stopped");
		signal.addEventListener("abort", onAbort, { once: true });
		void pass.then((outcome) => {
			signal.removeEventListener("abort", onAbort);
			resolve(outcome);
		});
	});
}
