import type {
	IdempotencyClaim,
	IdempotencyClaimHandle,
	IdempotencyStore,
} from "../app/idempotency";
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

	/**
	 * For the `"non-transactional"` family: advances or edits adapter test
	 * state so this exact claim's CURRENT lease is expired. Required there;
	 * a fake clock or test-only row update keeps the suite deterministic.
	 */
	expireLease?(claim: IdempotencyClaimHandle): Promise<void>;

	/**
	 * Moves the adapter's test clock to an exact instant. Required by the
	 * non-transactional family so renewal is proved without wall-clock sleeps.
	 */
	advanceTimeTo?(instant: Date): Promise<void>;

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
 *   and `renew`/`confirm`/`abandon`/`reconcile` are no-ops. The family's core proof is the
 *   rollback test, so environments MUST provide `runRolledBack`, and
 *   run against a real database for SQL adapters.
 * - `"non-transactional"` (the leased two-phase pattern, e.g. the
 *   in-memory reference): the store cannot see commits, so `complete` only
 *   STAGES the outcome, `confirm` finalizes it post-commit, `abandon`
 *   compensates failed attempts, and expired staged records require
 *   reconciliation. Environments MUST provide deterministic `expireLease` and
 *   `advanceTimeTo` controls. The rollback test is skipped.
 */
export interface IdempotencyStoreContractHarness<TCtx> {
	createEnvironment(): Promise<IdempotencyStoreContractEnvironment<TCtx>>;

	/** Which lifecycle family the adapter implements; see above. */
	family: "transactional" | "non-transactional";
}

function claimedHandle(
	claim: IdempotencyClaim,
	message: string,
): IdempotencyClaimHandle {
	assert(claim.status === "claimed", message);
	return claim.claim;
}

async function expireLease<TCtx>(
	env: IdempotencyStoreContractEnvironment<TCtx>,
	claim: IdempotencyClaimHandle,
): Promise<void> {
	if (!env.expireLease) {
		throw new Error(
			"Contract violated: the non-transactional family requires expireLease on the environment",
		);
	}
	await env.expireLease(claim);
}

async function advanceTimeTo<TCtx>(
	env: IdempotencyStoreContractEnvironment<TCtx>,
	instant: Date,
): Promise<void> {
	if (!env.advanceTimeTo) {
		throw new Error(
			"Contract violated: the non-transactional family requires advanceTimeTo on the environment",
		);
	}
	await env.advanceTimeTo(instant);
}

/**
 * The idempotency-store contract test suite: the proof that an adapter
 * delivers the claim/renew/complete/confirm/abandon/reconcile lifecycle
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
				const claim = claimedHandle(
					await env.run((ctx) => env.store.claim(ctx, "key-1", "fp-1")),
					"a fresh key must be claimed by this execution",
				);
				await env.run((ctx) => env.store.complete(ctx, claim, { total: 42 }));
				await env.store.confirm(claim);
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
				const first = await env.run(async (ctx) => {
					const claim = claimedHandle(
						await env.store.claim(ctx, "key-1", "fp-1"),
						"a fresh key must be claimed",
					);
					await env.store.complete(ctx, claim, "done");
					return claim;
				});
				await env.store.confirm(first);
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
				const first = await env.run(async (ctx) => {
					const claim = claimedHandle(
						await env.store.claim(ctx, "key-1", "fp-1"),
						"a fresh key must be claimed",
					);
					await env.store.complete(ctx, claim, "done");
					return claim;
				});
				await env.store.confirm(first);
				await env.store.abandon(first);
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
				const first = await env.run(async (ctx) => {
					const claim = claimedHandle(
						await env.store.claim(ctx, "key-1", "fp-1"),
						"a fresh key must be claimed",
					);
					await env.store.complete(ctx, claim, "done");
					return claim;
				});
				await env.store.confirm(first);
				await env.store.confirm(first);
				await env.store.confirm({ key: "never-claimed", token: "missing" });
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
					env.run((ctx) =>
						env.store.complete(ctx, { key: "key-1", token: "missing" }, "x"),
					),
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
					const claim = claimedHandle(
						await env.store.claim(ctx, "key-1", "fp-1"),
						"a fresh key must be claimed",
					);
					await env.store.complete(ctx, claim, "done");
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
		gatedContractTest(
			{
				capability: "family: non-transactional",
				satisfiedBy: nonTransactional,
			},
			{
				name: "renew extends ownership beyond the original lease expiry",
				run: inEnv(async (env) => {
					const claim = claimedHandle(
						await env.run((ctx) => env.store.claim(ctx, "key-renew", "fp")),
						"a fresh key must be claimed",
					);
					assert(
						claim.lease !== undefined,
						"a non-transactional claim must carry lease timing",
					);
					const originalExpiry = new Date(claim.lease.expiresAt).getTime();
					assert(
						Number.isFinite(originalExpiry) &&
							new Date(originalExpiry).toISOString() ===
								claim.lease.expiresAt &&
							Number.isSafeInteger(claim.lease.renewAfterMs) &&
							claim.lease.renewAfterMs > 0,
						"lease timing must carry a valid expiry and positive safe renewal delay",
					);
					await advanceTimeTo(env, new Date(originalExpiry - 1));
					const renewed = await env.store.renew(claim);
					assert(
						renewed !== undefined &&
							new Date(renewed.expiresAt).getTime() > originalExpiry,
						"renew must extend the lease beyond its previous expiry",
					);
					await advanceTimeTo(env, new Date(originalExpiry + 1));
					const rejection = await captureRejection(
						env.run((ctx) => env.store.claim(ctx, "key-renew", "fp")),
					);
					assertChainContainsKitError(
						rejection,
						["IDEMPOTENCY_IN_FLIGHT"],
						"the renewed owner must still hold the key after the original expiry",
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
				name: "an expired pending lease is reclaimed under a new token and fences its stale owner",
				run: inEnv(async (env) => {
					const first = claimedHandle(
						await env.run((ctx) => env.store.claim(ctx, "key-1", "fp-1")),
						"a fresh key must be claimed",
					);
					assert(
						first.lease !== undefined,
						"a non-transactional claim must carry lease timing",
					);
					await expireLease(env, first);
					const successor = claimedHandle(
						await env.run((ctx) => env.store.claim(ctx, "key-1", "fp-1")),
						"an expired pending claim must be reclaimed",
					);
					assert(
						successor.token !== first.token,
						"each ownership generation must have a different token",
					);
					const rejection = await captureRejection(
						env.run((ctx) => env.store.complete(ctx, first, "stale")),
					);
					assertChainContainsKitError(
						rejection,
						["IDEMPOTENCY_CLAIM_LOST"],
						"a stale owner must fail before it can complete after takeover",
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
				name: "an expired staged outcome requires reconciliation and never auto-replays",
				run: inEnv(async (env) => {
					const first = await env.run(async (ctx) => {
						const claim = claimedHandle(
							await env.store.claim(ctx, "key-1", "fp-1"),
							"a fresh key must be claimed",
						);
						await env.store.complete(ctx, claim, "uncertain");
						return claim;
					});
					await expireLease(env, first);
					const claim = await env.run((ctx) =>
						env.store.claim(ctx, "key-1", "fp-1"),
					);
					assert(
						claim.status === "reconciliation-required",
						"an expired staged outcome must require authoritative reconciliation",
					);
					assertEqual(
						claim.reconciliation.token,
						first.token,
						"the reconciliation receipt identifies the staged owner",
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
				name: "reconciliation confirms committed work or releases proven rollback",
				run: inEnv(async (env) => {
					const committedHandle = await env.run(async (ctx) => {
						const claim = claimedHandle(
							await env.store.claim(ctx, "committed", "fp"),
							"a fresh key must be claimed",
						);
						await env.store.complete(ctx, claim, "winner");
						return claim;
					});
					await expireLease(env, committedHandle);
					const committed = await env.run((ctx) =>
						env.store.claim(ctx, "committed", "fp"),
					);
					assert(
						committed.status === "reconciliation-required",
						"the staged outcome must expose its reconciliation receipt",
					);
					await env.store.reconcile(committed.reconciliation, "committed");
					const replay = await env.run((ctx) =>
						env.store.claim(ctx, "committed", "fp"),
					);
					assert(
						replay.status === "completed" && replay.outcome === "winner",
						"committed evidence must make the staged outcome replayable",
					);

					const rolledBackHandle = await env.run(async (ctx) => {
						const claim = claimedHandle(
							await env.store.claim(ctx, "rolled-back", "fp"),
							"a fresh key must be claimed",
						);
						await env.store.complete(ctx, claim, "must disappear");
						return claim;
					});
					await expireLease(env, rolledBackHandle);
					const rolledBack = await env.run((ctx) =>
						env.store.claim(ctx, "rolled-back", "fp"),
					);
					assert(
						rolledBack.status === "reconciliation-required",
						"the staged outcome must expose its reconciliation receipt",
					);
					await env.store.reconcile(rolledBack.reconciliation, "not-committed");
					const fresh = await env.run((ctx) =>
						env.store.claim(ctx, "rolled-back", "fp"),
					);
					assertEqual(
						fresh.status,
						"claimed",
						"not-committed evidence must release the staged outcome",
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
						const claim = claimedHandle(
							await env.store.claim(ctx, "key-1", "fp-1"),
							"a fresh key must be claimed",
						);
						await env.store.complete(ctx, claim, "uncommitted");
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
					const first = claimedHandle(
						await env.run((ctx) => env.store.claim(ctx, "key-1", "fp-1")),
						"a fresh key must be claimed",
					);
					await env.store.abandon(first);
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
					const first = await env.run(async (ctx) => {
						const claim = claimedHandle(
							await env.store.claim(ctx, "key-1", "fp-1"),
							"a fresh key must be claimed",
						);
						await env.store.complete(ctx, claim, "uncommitted");
						return claim;
					});
					await env.store.abandon(first);
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
							const claim = claimedHandle(
								await env.store.claim(ctx, "key-1", "fp-1"),
								"a fresh key must be claimed",
							);
							await env.store.complete(ctx, claim, "rolled back");
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
