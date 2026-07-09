import type { IdempotencyStore } from "../app/idempotency";
import { deepEqual } from "../utils/array/deep-equal";
import {
	assert,
	assertChainContainsKitError,
	assertEqual,
	bindContractEnvironment,
	type ContractTest,
	captureRejection,
	chainContainsRetryable,
	gatedContractTest,
} from "./contract-assertions";

/** One contract test; bind with `(test.skipped ? it.skip : it)(test.name, test.run)`. */
export type IdempotencyStoreContractTest = ContractTest;

/**
 * One isolated test environment: a fresh idempotency store. The suite
 * creates one per test and tears it down afterwards.
 */
export interface IdempotencyStoreContractEnvironment<TCtx> {
	/** The adapter under test. */
	store: IdempotencyStore<TCtx>;

	/**
	 * Runs `work` inside a transaction that COMMITS, handing it the
	 * transaction context the store methods expect, the way
	 * `withIdempotentCommit` calls them in production. For a
	 * non-transactional store this simply invokes `work` with a dummy
	 * context.
	 */
	run<R>(work: (ctx: TCtx) => Promise<R>): Promise<R>;

	/**
	 * For the `"transactional"` family: runs `work` inside a transaction
	 * that ROLLS BACK. Required there; the rollback-releases-the-claim
	 * test is that family's core proof. Irrelevant for the
	 * `"non-transactional"` family.
	 */
	runRolledBack?<R>(work: (ctx: TCtx) => Promise<R>): Promise<R>;

	/** Release connections, drop schemas, etc. Called in a finally. */
	teardown?(): Promise<void>;
}

/**
 * What an adapter supplies to run the idempotency-store contract suite.
 *
 * The port (`IdempotencyStore`) deliberately supports two adapter
 * families with different lifecycle semantics, and the suite follows
 * the declared family instead of forcing one onto the other:
 *
 * - `"transactional"` (the single-transaction pattern): the record
 *   lives in the same database as the aggregates; a committed
 *   `complete` is final and replayable, a rollback releases everything,
 *   and `confirm`/`abandon` are no-ops. The family's core proof is the
 *   rollback test, so environments MUST provide `runRolledBack`, and
 *   run against a real database for SQL adapters.
 * - `"non-transactional"` (the two-phase-hooks pattern, e.g. the
 *   in-memory reference): the store cannot see commits, so `complete`
 *   only STAGES the outcome, `confirm` finalizes it post-commit, and
 *   `abandon` compensates failed attempts. The family's core proofs are
 *   the staged/abandon tests; the rollback test is skipped.
 */
export interface IdempotencyStoreContractHarness<TCtx> {
	createEnvironment(): Promise<IdempotencyStoreContractEnvironment<TCtx>>;

	/** Which lifecycle family the adapter implements; see above. */
	family: "transactional" | "non-transactional";
}

/**
 * The idempotency-store contract test suite: the proof that an adapter
 * delivers the claim/complete/confirm/abandon lifecycle
 * `withIdempotentCommit` documents, for its declared family. Store
 * semantics are an **adapter contract, not a kit guarantee**; this
 * suite is how an adapter demonstrates them.
 *
 * Framework-agnostic: bind with
 * `(test.skipped ? it.skip : it)(test.name, test.run)`.
 */
export function createIdempotencyStoreContractTests<TCtx>(
	harness: IdempotencyStoreContractHarness<TCtx>,
): IdempotencyStoreContractTest[] {
	const inEnv = bindContractEnvironment(() => harness.createEnvironment());

	// Shared tests: hold for BOTH families (confirm/abandon are no-ops in
	// the transactional family, which these tests tolerate by design).
	const tests: IdempotencyStoreContractTest[] = [
		{
			name: "a fresh key is claimed; the full lifecycle replays the outcome",
			run: inEnv(async (env) => {
				const claim = await env.run((ctx) =>
					env.store.claim(ctx, "key-1", "fp-1"),
				);
				assertEqual(
					claim.status,
					"claimed",
					"a fresh key must be claimed by this execution",
				);
				await env.run((ctx) => env.store.complete(ctx, "key-1", { total: 42 }));
				await env.store.confirm("key-1");
				const replay = await env.run((ctx) =>
					env.store.claim(ctx, "key-1", "fp-1"),
				);
				assert(
					replay.status === "completed",
					"a completed and confirmed key must replay as completed",
				);
				assert(
					deepEqual(replay.outcome, { total: 42 }),
					"the replayed outcome must round-trip the stored value",
				);
			}),
		},
		{
			name: "the same key with a different fingerprint throws IdempotencyKeyReuseError",
			run: inEnv(async (env) => {
				// Built on a COMPLETED record: the one same-key/other-command
				// state both families can actually reach in production (a
				// transactional store never commits a bare pending claim).
				await env.run(async (ctx) => {
					await env.store.claim(ctx, "key-1", "fp-1");
					await env.store.complete(ctx, "key-1", "done");
				});
				await env.store.confirm("key-1");
				const rejection = await captureRejection(
					env.run((ctx) => env.store.claim(ctx, "key-1", "fp-OTHER")),
				);
				assertChainContainsKitError(
					rejection,
					["IDEMPOTENCY_KEY_REUSE"],
					"a different fingerprint must throw IdempotencyKeyReuseError, never replay another command's outcome",
				);
			}),
		},
		{
			name: "abandon never destroys a completed, confirmed outcome",
			run: inEnv(async (env) => {
				await env.run(async (ctx) => {
					await env.store.claim(ctx, "key-1", "fp-1");
					await env.store.complete(ctx, "key-1", "done");
				});
				await env.store.confirm("key-1");
				await env.store.abandon("key-1");
				const claim = await env.run((ctx) =>
					env.store.claim(ctx, "key-1", "fp-1"),
				);
				assert(
					claim.status === "completed",
					"abandon must not release a completed, confirmed record",
				);
				assertEqual(claim.outcome, "done", "the outcome survives");
			}),
		},
		{
			name: "confirm is idempotent, and confirming a missing key is a no-op",
			run: inEnv(async (env) => {
				await env.run(async (ctx) => {
					await env.store.claim(ctx, "key-1", "fp-1");
					await env.store.complete(ctx, "key-1", "done");
				});
				await env.store.confirm("key-1");
				await env.store.confirm("key-1");
				await env.store.confirm("never-claimed");
				const claim = await env.run((ctx) =>
					env.store.claim(ctx, "key-1", "fp-1"),
				);
				assert(
					claim.status === "completed" && claim.outcome === "done",
					"re-confirms and unknown-key confirms must change nothing",
				);
			}),
		},
		{
			name: "complete without a pending claim throws the wiring error",
			run: inEnv(async (env) => {
				const rejection = await captureRejection(
					env.run((ctx) => env.store.complete(ctx, "key-1", "x")),
				);
				assertChainContainsKitError(
					rejection,
					["IDEMPOTENCY_COMPLETED_WITHOUT_CLAIM"],
					"complete() without claim() must throw IdempotencyCompletionWithoutClaimError",
				);
			}),
		},
	];

	const nonTransactional = harness.family === "non-transactional";

	// The commit-is-the-finalize proof only EXISTS for the transactional
	// family; a two-phase store must do the OPPOSITE (an unconfirmed
	// staged outcome stays in-flight), so there is no skip twin for it.
	if (!nonTransactional) {
		tests.push({
			name: "a committed complete replays even without confirm (commit is the finalize)",
			run: inEnv(async (env) => {
				await env.run(async (ctx) => {
					await env.store.claim(ctx, "key-1", "fp-1");
					await env.store.complete(ctx, "key-1", "done");
				});
				// No confirm: for a transactional store the commit already
				// finalized the record.
				const claim = await env.run((ctx) =>
					env.store.claim(ctx, "key-1", "fp-1"),
				);
				assert(
					claim.status === "completed" && claim.outcome === "done",
					"a committed complete must replay without a confirm call",
				);
			}),
		});
	}

	tests.push(
		// A committed-yet-pending claim is a state only the two-phase family
		// can reach (its claims commit immediately). In the
		// single-transaction pattern, concurrent claimers collide on the row
		// lock of an UNCOMMITTED insert, which a sequential suite cannot
		// portably provoke, and a committed bare claim is legitimately
		// treated as a stale crash leftover an adapter may reclaim.
		gatedContractTest(
			{
				capability: "family: non-transactional",
				satisfiedBy: nonTransactional,
			},
			{
				name: "a pending claim is in-flight for concurrent claimers, and the error is retryable",
				run: inEnv(async (env) => {
					await env.run((ctx) => env.store.claim(ctx, "key-1", "fp-1"));
					const rejection = await captureRejection(
						env.run((ctx) => env.store.claim(ctx, "key-1", "fp-1")),
					);
					assertChainContainsKitError(
						rejection,
						["IDEMPOTENCY_IN_FLIGHT"],
						"claiming a pending key must throw IdempotencyInFlightError",
					);
					// Chain-walked like the kit's retry classifier: an adapter may
					// wrap the kit error, exactly as the code-based check above
					// tolerates, and a consumer's retry loop still sees retryable.
					assert(
						chainContainsRetryable(rejection),
						"the in-flight error must be retryable (on the rejection or its cause chain)",
					);
				}),
			},
		),
		// Two-phase-hooks family: staged semantics and real abandon are the
		// core proofs; the transactional family's hooks are no-ops instead.
		gatedContractTest(
			{
				capability: "family: non-transactional",
				satisfiedBy: nonTransactional,
			},
			{
				name: "a staged, unconfirmed outcome is in-flight, never replayed",
				run: inEnv(async (env) => {
					await env.run(async (ctx) => {
						await env.store.claim(ctx, "key-1", "fp-1");
						await env.store.complete(ctx, "key-1", "uncommitted");
					});
					const rejection = await captureRejection(
						env.run((ctx) => env.store.claim(ctx, "key-1", "fp-1")),
					);
					assertChainContainsKitError(
						rejection,
						["IDEMPOTENCY_IN_FLIGHT"],
						"a staged outcome must never replay; it is in-flight until confirmed",
					);
				}),
			},
		),
		gatedContractTest(
			{
				capability: "family: non-transactional",
				satisfiedBy: nonTransactional,
			},
			{
				name: "abandon releases a pending claim so the next attempt claims fresh",
				run: inEnv(async (env) => {
					await env.run((ctx) => env.store.claim(ctx, "key-1", "fp-1"));
					await env.store.abandon("key-1");
					const claim = await env.run((ctx) =>
						env.store.claim(ctx, "key-1", "fp-1"),
					);
					assertEqual(
						claim.status,
						"claimed",
						"an abandoned pending claim must be claimable again",
					);
				}),
			},
		),
		gatedContractTest(
			{
				capability: "family: non-transactional",
				satisfiedBy: nonTransactional,
			},
			{
				name: "abandon releases a staged outcome so the next attempt claims fresh",
				run: inEnv(async (env) => {
					await env.run(async (ctx) => {
						await env.store.claim(ctx, "key-1", "fp-1");
						await env.store.complete(ctx, "key-1", "uncommitted");
					});
					await env.store.abandon("key-1");
					const claim = await env.run((ctx) =>
						env.store.claim(ctx, "key-1", "fp-1"),
					);
					assertEqual(
						claim.status,
						"claimed",
						"an abandoned staged outcome must be claimable again",
					);
				}),
			},
		),
		// Single-transaction family: committed state is final, hooks are
		// no-ops, and the rollback proof is mandatory.
		gatedContractTest(
			{ capability: "family: transactional", satisfiedBy: !nonTransactional },
			{
				name: "a rolled-back transaction releases the claim (single-transaction pattern)",
				run: inEnv(async (env) => {
					if (!env.runRolledBack) {
						throw new Error(
							"Contract violated: the transactional family requires runRolledBack on the environment",
						);
					}
					await env
						.runRolledBack(async (ctx) => {
							await env.store.claim(ctx, "key-1", "fp-1");
							await env.store.complete(ctx, "key-1", "rolled back");
						})
						.catch(() => {
							// The rollback mechanism may surface as a rejection; the
							// contract under test is the store state afterwards.
						});
					const claim = await env.run((ctx) =>
						env.store.claim(ctx, "key-1", "fp-1"),
					);
					assertEqual(
						claim.status,
						"claimed",
						"a rolled-back claim/complete must leave the key claimable",
					);
				}),
			},
		),
	);

	return tests;
}
