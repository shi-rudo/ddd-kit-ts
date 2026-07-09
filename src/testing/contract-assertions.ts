/**
 * Assertion, error-matching, and suite-runner helpers shared by the
 * repository contract suites (state-stored and event-sourced). Internal
 * to the testing entry: not re-exported from `@shirudo/ddd-kit/testing`.
 */

/**
 * One entry of a contract test suite. Every suite (repository,
 * event-sourced repository, outbox, idempotency store) returns a list
 * of these; bind them with
 * `(test.skipped ? it.skip : it)(test.name, test.run)`.
 */
export interface ContractTest {
	name: string;
	run: () => Promise<void>;
	/** Present when the harness lacks the capability this test needs. */
	skipped?: { capability: string };
}

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

/**
 * Binds a harness's environment factory into the per-test wrapper the
 * suites build their entries from: `inEnv(body)` yields a test `run`
 * that creates a fresh environment, runs the body, and tears down via
 * {@link runInContractEnvironment}.
 */
export function bindContractEnvironment<
	Env extends { teardown?(): Promise<void> },
>(
	createEnvironment: () => Promise<Env>,
): (body: (env: Env) => Promise<void>) => () => Promise<void> {
	return (body) => () => runInContractEnvironment(createEnvironment, body);
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
	repository: { findById(id: TId): Promise<TAgg | null> },
	id: TId,
	suspectHint: string,
): Promise<TAgg> {
	const loaded = await repository.findById(id);
	assert(
		loaded !== null,
		`findById(${String(id)}) returned null for an aggregate that must exist: ${suspectHint}`,
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
): ContractTest & { skipped: { capability: string } } {
	return {
		name,
		skipped: { capability },
		run: async () => {
			throw new Error(
				`Contract test skipped: harness capability '${capability}' is not provided. ` +
					`Bind skipped tests with it.skip ((test.skipped ? it.skip : it)(test.name, test.run)) ` +
					`or provide the capability; each skipped capability is an unproven guarantee.`,
			);
		},
	};
}

/**
 * Capability gate that keeps a test's NAME single-sourced: a harness
 * that satisfies the gate gets the real test, everyone else gets the
 * loud skipped entry under the same name (see
 * {@link skippedContractTest}). Nests for tests behind several gates;
 * the outermost failing gate's capability wins the skip report.
 */
export function gatedContractTest(
	gate: { capability: string; satisfiedBy: boolean },
	test: ContractTest,
): ContractTest {
	return gate.satisfiedBy
		? test
		: skippedContractTest(test.name, gate.capability);
}

export function assert(condition: boolean, message: string): asserts condition {
	if (!condition) {
		throw new Error(`Contract violated: ${message}`);
	}
}

export function assertEqual(
	actual: unknown,
	expected: unknown,
	message: string,
): void {
	if (actual !== expected) {
		throw new Error(
			`Contract violated: ${message} (expected ${String(expected)}, got ${String(actual)})`,
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
	let found = false;
	walkCauseChain(error, (node) => {
		found = errorMatchesName(node, name);
		return found;
	});
	return found;
}

/**
 * The one cause-chain walk every chain-inspecting helper in this file
 * is expressed through (cycle-safe, hostile-cause-getter-safe): visits
 * each object node until `visit` asks to stop by returning `true`, the
 * chain ends, repeats, or advancing turns hostile. Single-sourced on
 * purpose: a hardening fix (a depth cap, a new hostile shape) must land
 * in ALL walkers at once, or the suites judge the same adapter
 * rejection inconsistently. Per-node property reads stay the visitor's
 * responsibility; only the `cause` advance is guarded here.
 */
function walkCauseChain(
	error: unknown,
	visit: (node: object) => boolean,
): void {
	const seen = new Set<unknown>();
	let current: unknown = error;
	while (
		current !== null &&
		current !== undefined &&
		typeof current === "object" &&
		!seen.has(current)
	) {
		seen.add(current);
		if (visit(current)) return;
		try {
			current = (current as { cause?: unknown }).cause;
		} catch {
			return;
		}
	}
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
	throw new Error(`Contract violated: ${message}`);
}

/**
 * Walks the `cause` chain (cycle-safe, hostile-getter-safe) looking for
 * `retryable === true`: the same loose, property-based contract the
 * kit's retry classifier (`someChainRetryable`) applies. Suites assert
 * retryability with this instead of reading the top-level rejection, so
 * an adapter that wraps a kit error in its own error chain, which
 * {@link assertChainContainsKitError} deliberately tolerates, is judged
 * exactly the way a consumer's retry loop will judge it.
 *
 * Deliberately NOT a call to `someChainRetryable` itself: that
 * classifier throws on a circular cause chain (its callers handle
 * that), while a hardened suite must survive whatever error shape an
 * adapter rejects with and answer with a contract diagnostic, never a
 * helper crash. Same hardening discipline as
 * {@link chainContainsErrorNamed}.
 */
export function chainContainsRetryable(error: unknown): boolean {
	let found = false;
	walkCauseChain(error, (node) => {
		try {
			found = (node as { retryable?: unknown }).retryable === true;
		} catch {
			// Hostile `retryable` getter: stop the walk, keep found=false.
			return true;
		}
		return found;
	});
	return found;
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
	walkCauseChain(error, (node) => {
		try {
			const { name } = node as { name?: unknown };
			names.push(typeof name === "string" ? name : "(unnamed)");
		} catch {
			// Hostile `name` getter: stop with the partial chain collected.
			return true;
		}
		return false;
	});
	return names;
}
