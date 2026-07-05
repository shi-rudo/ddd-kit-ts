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
 * match ONLY the v3 codes. Failure diagnostics render the rejection's
 * cause-chain names ({@link describeError}), so an unexpected error,
 * including one from a different kit copy in the dependency graph, is
 * identifiable from the message without version-specific knowledge in
 * the suite.
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

/**
 * Asserts that the cause chain carries a kit error with one of the given
 * codes (since v3, `error.name === error.code`; the codes are the ONLY
 * accepted identity). Failure messages built with {@link describeError}
 * render the rejection's cause-chain names, so an unexpected error, e.g.
 * one from a different `@shirudo/ddd-kit` copy in the dependency graph,
 * is identifiable from the diagnostic without the suite carrying any
 * version-specific knowledge.
 */
export function assertChainContainsKitError(
	rejection: unknown,
	codes: readonly string[],
	message: string,
): void {
	if (codes.some((code) => chainContainsErrorNamed(rejection, code))) {
		return;
	}
	throw new Error(`Repository contract violated: ${message}`);
}

function errorMatchesName(candidate: object, name: string): boolean {
	try {
		if ((candidate as { name?: unknown }).name === name) {
			return true;
		}
	} catch {
		// Hostile `name` getter: treat as non-matching, keep walking.
	}
	// Fallback for errors whose own `name` was overridden (a subclass
	// that re-assigns `this.name` after super): the prototype chain
	// still carries the base class's constructor name.
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
		const chain = causeChainNames(error);
		const suffix =
			chain.length > 1 ? ` (cause chain: ${chain.join(" -> ")})` : "";
		return `${error.name}: ${error.message}${suffix}`;
	}
	return String(error);
}

/**
 * Names along the `cause` chain (cycle-safe, hostile-getter-safe), for
 * failure diagnostics: a wrapped rejection shows WHAT it wraps, so an
 * unexpected error deep in the chain (a raw driver error, or an error
 * from a different kit copy) is identifiable from the message alone.
 */
function causeChainNames(error: Error): string[] {
	const names: string[] = [];
	const seen = new Set<unknown>();
	let current: unknown = error;
	while (
		current !== null &&
		current !== undefined &&
		typeof current === "object" &&
		!seen.has(current)
	) {
		seen.add(current);
		try {
			const { name } = current as { name?: unknown };
			names.push(typeof name === "string" ? name : "(unnamed)");
			current = (current as { cause?: unknown }).cause;
		} catch {
			break;
		}
	}
	return names;
}
