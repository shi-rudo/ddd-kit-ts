/**
 * Cycle-safe, getter-throw-safe walk over `error`'s standard `cause`
 * chain. `visit` runs for every object link (the top error included) and
 * receives the link plus its lazily read `cause`; a non-undefined return
 * stops the walk. A throwing `cause` getter (lazy deserialization, revoked
 * Proxy) ends the walk as no-match instead of replacing the real failure
 * with the getter's exception.
 */
export function findInCauseChain<T>(
	error: unknown,
	visit: (link: object, cause: unknown) => T | undefined,
): T | undefined {
	const seen = new Set<unknown>();
	let current: unknown = error;
	while (
		current !== null &&
		typeof current === "object" &&
		!seen.has(current)
	) {
		seen.add(current);
		let cause: unknown;
		try {
			cause = (current as { cause?: unknown }).cause;
		} catch {
			return undefined;
		}
		const found = visit(current, cause);
		if (found !== undefined) return found;
		current = cause;
	}
	return undefined;
}
