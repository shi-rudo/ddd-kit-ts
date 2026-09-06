/**
 * Assertion, error-matching, and suite-runner helpers shared by the
 * repository contract suites (state-stored and event-sourced). Internal
 * to the testing entry: not re-exported from `@shirudo/ddd-kit/testing`.
 */
import { isRecordedDomainEvent } from "../domain/event/domain-event";
import { runBoundedExecution } from "../internal/async/execution";

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
 * Default bound for {@link assertRunPermitsOverlappingCalls}. On an
 * environment that gives each `run` call its own connection, the second call
 * completes in milliseconds. The bound stays below the default test timeout
 * of common runners (5000 ms). So the named failure reaches the report before
 * the runner's own timeout replaces it. Environment creation and teardown
 * must fit into the rest of that timeout.
 */
export const OVERLAPPING_CALLS_BOUND_MS = 2_000;

const overlappingCallsViolation = (boundMs: number): string =>
	`run must permit overlapping calls: a second run call did not complete within ${boundMs} ms while the first call stayed open. ` +
	"Either run serializes its calls, or the second connection took longer than the bound. " +
	"Give each call its own transaction and connection, or raise overlappingCallsBoundMs on the harness";

function isTimeoutError(error: unknown): boolean {
	return error instanceof DOMException && error.name === "TimeoutError";
}

/** Outcomes of every promise, or `undefined` when one is still open after `boundMs`. */
function settledWithin(
	promises: ReadonlyArray<Promise<unknown>>,
	boundMs: number,
): Promise<PromiseSettledResult<unknown>[] | undefined> {
	return runBoundedExecution(
		"release of the overlapping calls",
		{ timeoutMs: boundMs },
		() => Promise.allSettled(promises),
	).catch(() => undefined);
}

/**
 * Awaits `call`, a `run` call that must complete while `parked`, another
 * `run` call, stays open. On an environment that serializes `run`, `call`
 * never completes. This bounds the wait: after `boundMs` it releases the
 * parked call, waits up to `boundMs` for both calls to settle, and fails
 * with the requirement. A rejection of `call` releases the parked call the
 * same way and then propagates. On success the parked call stays parked;
 * the proof releases it when it is ready.
 */
export async function awaitOverlappingCall<T>(
	call: Promise<T>,
	parked: { readonly call: Promise<unknown>; readonly release: () => void },
	boundMs: number,
): Promise<T> {
	try {
		return await runBoundedExecution(
			"overlapping run call",
			{ timeoutMs: boundMs },
			() => call,
		);
	} catch (error) {
		parked.release();
		await settledWithin([parked.call, call], boundMs);
		assert(!isTimeoutError(error), overlappingCallsViolation(boundMs));
		throw error;
	}
}

/**
 * Proves that the environment lets two `run` calls stay open at once.
 *
 * The stale-writer proofs hold one transaction open while a second one
 * commits. An environment that serializes `run` (one connection, a mutex)
 * blocks the second call behind the first. The suite then hangs at the test
 * timeout with no cause. This proof turns that hang into a named failure
 * within `boundMs`. It releases the first call before it returns and waits
 * up to `boundMs` for both calls to complete. A second call that is still
 * blocked after that stays in flight, observed, while the failure reports.
 */
export async function assertRunPermitsOverlappingCalls(
	run: (work: () => Promise<void>) => Promise<unknown>,
	boundMs: number,
): Promise<void> {
	let releaseFirst!: () => void;
	const firstMayFinish = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	let firstIsOpen!: () => void;
	const firstOpened = new Promise<void>((resolve) => {
		firstIsOpen = resolve;
	});
	const first = run(async () => {
		firstIsOpen();
		await firstMayFinish;
	});
	await Promise.race([firstOpened, first]);

	await awaitOverlappingCall(
		run(async () => {}),
		{ call: first, release: releaseFirst },
		boundMs,
	);

	releaseFirst();
	const firstOutcome = (await settledWithin([first], boundMs))?.[0];
	assert(
		firstOutcome !== undefined,
		`the first run call did not complete within ${boundMs} ms after the proof released it`,
	);
	if (firstOutcome.status === "rejected") throw firstOutcome.reason;
}

/**
 * The preflight entry both repository suites put first: it names a
 * serializing environment before the stale-writer proofs can hang on it.
 * `openCall` runs `work` inside one `run` call of the environment. It should
 * issue one real read before `work`. Then an adapter that reserves its
 * connection on the first statement holds it while `work` holds the call.
 */
export function overlappingCallsPreflight<Env>(
	inEnvironment: (body: (env: Env) => Promise<void>) => () => Promise<void>,
	openCall: (env: Env, work: () => Promise<void>) => Promise<unknown>,
	boundMs: number,
): ContractTest {
	return {
		name: "environment preflight: a second run call completes while the first call stays open",
		run: inEnvironment((env) =>
			assertRunPermitsOverlappingCalls((work) => openCall(env, work), boundMs),
		),
	};
}

/**
 * Load with a contract diagnostic instead of a bare TypeError downstream.
 * `suspectHint` names the suite-specific likely cause (broken hydration
 * vs broken replay read).
 */
export async function loadAggregateOrFail<TAgg, TId>(
	repository: { findById(id: TId): Promise<TAgg | null | undefined> },
	id: TId,
	suspectHint: string,
): Promise<TAgg> {
	const loaded = await repository.findById(id);
	assert(
		loaded !== null && loaded !== undefined,
		`findById(${String(id)}) returned no aggregate for an identity that must exist: ${suspectHint}`,
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

/**
 * Identities of an in-memory pending batch, with the shared precondition
 * that every event carries the recorded brand. The `requirement` names
 * the suite-specific rule the harness violated when an event is not
 * recorded.
 */
export function recordedPendingEventIds(
	events: ReadonlyArray<unknown>,
	requirement: string,
): string[] {
	return events.map((event) => {
		assert(
			typeof event === "object" &&
				event !== null &&
				isRecordedDomainEvent(event),
			requirement,
		);
		return (event as { readonly eventId: string }).eventId;
	});
}

/**
 * Sorted identities of committed outbox envelopes. Shared by both
 * repository suites so the projection cannot drift between them.
 */
export function sortedCommittedEventIds(
	committed: ReadonlyArray<{ readonly event: { readonly eventId: string } }>,
): string[] {
	return committed.map(({ event }) => event.eventId).sort();
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
