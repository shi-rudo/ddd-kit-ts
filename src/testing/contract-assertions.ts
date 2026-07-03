/**
 * Assertion and error-matching helpers shared by the repository contract
 * suites (state-stored and event-sourced). Internal to the testing entry:
 * not re-exported from `@shirudo/ddd-kit/testing`.
 */

export function assert(condition: boolean, message: string): asserts condition {
	if (!condition) {
		throw new Error(`Repository contract violated: ${message}`);
	}
}

export function assertEqual(
	actual: unknown,
	expected: unknown,
	message: string,
): void {
	if (actual !== expected) {
		throw new Error(
			`Repository contract violated: ${message} (expected ${String(expected)}, got ${String(actual)})`,
		);
	}
}

/**
 * Walks the standard `cause` chain (cycle-safe, hostile-getter-safe)
 * looking for an Error that matches the given name. Matching is
 * deliberately by NAME, not `instanceof`: the suite ships in its own
 * bundle entry, and the adapter's errors come from the main entry's
 * copy of the kit (or even a second installed kit version) -
 * cross-copy `instanceof` is always false, name identity is the stable
 * contract. The kit's error classes pin their runtime `name` via
 * BaseError's `options.name`, so the match survives consumer-side
 * minification AND subclassing (a `PgConflictError extends
 * ConcurrencyConflictError` inherits the pinned name). For errors from
 * OLDER kit versions (no pinned name), the prototype chain's
 * constructor names are checked as a fallback, so subclasses still
 * match.
 */
export function chainContainsErrorNamed(error: unknown, name: string): boolean {
	const seen = new Set<unknown>();
	let current: unknown = error;
	while (current !== null && current !== undefined && !seen.has(current)) {
		if (typeof current !== "object") {
			return false;
		}
		if (errorMatchesName(current, name)) {
			return true;
		}
		seen.add(current);
		try {
			current = (current as { cause?: unknown }).cause;
		} catch {
			return false;
		}
	}
	return false;
}

/** Like {@link chainContainsErrorNamed}, but accepts any of several names. */
export function chainContainsErrorNamedAnyOf(
	error: unknown,
	names: readonly string[],
): boolean {
	return names.some((name) => chainContainsErrorNamed(error, name));
}

function errorMatchesName(candidate: object, name: string): boolean {
	try {
		if ((candidate as { name?: unknown }).name === name) {
			return true;
		}
	} catch {
		// Hostile `name` getter: treat as non-matching, keep walking.
	}
	// Fallback for errors from kit versions without a pinned runtime
	// name: a subclass instance's own `name` is the subclass name, but
	// its prototype chain still carries the base class's constructor.
	try {
		let proto: object | null = Object.getPrototypeOf(candidate);
		for (let depth = 0; proto !== null && depth < 20; depth++) {
			if (
				(proto.constructor as { name?: unknown } | undefined)?.name === name
			) {
				return true;
			}
			proto = Object.getPrototypeOf(proto);
		}
	} catch {
		// Hostile `constructor` getter on a prototype: non-matching.
	}
	return false;
}

export function describeError(error: unknown): string {
	if (error instanceof Error) {
		return `${error.name}: ${error.message}`;
	}
	return String(error);
}
