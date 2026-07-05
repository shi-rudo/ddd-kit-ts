/**
 * Assertion, error-matching, and suite-runner helpers shared by the
 * repository contract suites (state-stored and event-sourced). Internal
 * to the testing entry: not re-exported from `@shirudo/ddd-kit/testing`.
 */

/**
 * Runs one contract-test body against a fresh environment and tears it
 * down in a finally-like discipline with one subtle, load-bearing rule:
 * a teardown failure (dropping a schema on an aborted pool) must never
 * REPLACE the contract-violation diagnostic that is the suite's entire
 * value. It only surfaces when the body itself succeeded.
 */
export async function runInContractEnvironment<
	Env extends { teardown?(): Promise<void> },
>(
	createEnvironment: () => Promise<Env>,
	body: (env: Env) => Promise<void>,
): Promise<void> {
	const env = await createEnvironment();
	let bodyFailed = false;
	let bodyError: unknown;
	try {
		await body(env);
	} catch (error) {
		bodyFailed = true;
		bodyError = error;
	}
	try {
		await env.teardown?.();
	} catch (teardownError) {
		if (!bodyFailed) {
			throw teardownError;
		}
	}
	if (bodyFailed) {
		throw bodyError;
	}
}

/** Resolves to the rejection reason, or `undefined` when the promise resolved. */
export function captureRejection(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => undefined,
		(error: unknown) => error,
	);
}

/**
 * Load with a contract diagnostic instead of a bare TypeError downstream.
 * `suspectHint` names the suite-specific likely cause (broken hydration
 * vs broken replay read).
 */
export async function loadAggregateOrFail<TAgg, TId>(
	repository: { getById(id: TId): Promise<TAgg | null> },
	id: TId,
	suspectHint: string,
): Promise<TAgg> {
	const loaded = await repository.getById(id);
	assert(
		loaded !== null,
		`getById(${String(id)}) returned null for an aggregate that must exist: ${suspectHint}`,
	);
	return loaded;
}

/**
 * A capability-gated test entry whose `run()` rejects loudly, so a naive
 * binding that ignores `skipped` fails instead of green-no-op'ing.
 * Structurally assignable to both suites' test-entry types.
 */
export function skippedContractTest(
	name: string,
	capability: string,
): {
	name: string;
	run: () => Promise<void>;
	skipped: { capability: string };
} {
	return {
		name,
		skipped: { capability },
		run: async () => {
			throw new Error(
				`Repository contract test skipped: harness capability '${capability}' is not provided. ` +
					`Bind skipped tests with it.skip ((test.skipped ? it.skip : it)(test.name, test.run)) ` +
					`or provide the capability; each one closes a real OCC hole.`,
			);
		},
	};
}

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
 * contract. Since v3 the kit's errors are StructuredErrors whose
 * runtime `name` IS their SCREAMING_SNAKE code, minification-stable by
 * construction and inherited by subclasses (a `PgConflictError extends
 * ConcurrencyConflictError` keeps the code as its name). The suites
 * additionally pass the pre-v3 PascalCase names as aliases (via
 * {@link chainContainsErrorNamedAnyOf}), and the prototype chain's
 * constructor names are checked as a fallback, so errors from OLDER
 * kit copies in the same process still match.
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
