import type {
	IdempotencyClaim,
	IdempotencyClaimHandle,
	IdempotencyStore,
} from "../application/idempotency/idempotency";
import { deepEqual } from "../internal/structural/deep-equal";
import {
	assert,
	assertChainContainsKitError,
	assertEqual,
	bindContractEnvironment,
	type ContractTest,
	captureRejection,
} from "./contract-assertions";

/** One contract test; bind with `(test.skipped ? it.skip : it)(test.name, test.run)`. */
export type IdempotencyStoreContractTest = ContractTest;

/**
 * One isolated test environment: a fresh transactional idempotency store.
 * The suite creates one per test and tears it down afterwards.
 */
export interface IdempotencyStoreContractEnvironment<TCtx> {
	/** The adapter under test. */
	store: IdempotencyStore<TCtx>;

	/**
	 * Runs `work` inside a transaction that COMMITS, handing it the
	 * transaction context the store methods expect, the way
	 * `withIdempotentCommit` calls them in production.
	 */
	run<R>(work: (ctx: TCtx) => Promise<R>): Promise<R>;

	/**
	 * Runs `work` inside a transaction that ROLLS BACK. It may reject; the
	 * suite checks the store state afterwards. Run SQL adapters against a real
	 * database: the rollback test is the core proof of the family.
	 */
	runRolledBack<R>(work: (ctx: TCtx) => Promise<R>): Promise<R>;

	/** Release connections, drop schemas, etc. Called in a finally. */
	teardown?(): Promise<void>;
}

/** What a transactional adapter supplies to run the contract suite. */
export interface IdempotencyStoreContractHarness<TCtx> {
	createEnvironment(): Promise<IdempotencyStoreContractEnvironment<TCtx>>;
}

function claimedHandle(
	claim: IdempotencyClaim,
	message: string,
): IdempotencyClaimHandle {
	assert(claim.status === "claimed", message);
	return claim.claim;
}

/**
 * The contract test suite of the transactional {@link IdempotencyStore}: the
 * proof that an adapter writes its record in the command's transaction. A
 * committed `complete` replays, and a rollback releases the claim. Store
 * semantics are an **adapter contract, not a kit guarantee**; this suite is
 * how an adapter demonstrates them. A leased adapter runs
 * `createLeasedIdempotencyStoreContractTests` instead.
 *
 * Framework-agnostic: bind with
 * `(test.skipped ? it.skip : it)(test.name, test.run)`.
 */
export function createIdempotencyStoreContractTests<TCtx>(
	harness: IdempotencyStoreContractHarness<TCtx>,
): IdempotencyStoreContractTest[] {
	const inEnv = bindContractEnvironment(() => harness.createEnvironment());

	return [
		{
			name: "a fresh key is claimed, and a committed complete replays the outcome",
			run: inEnv(async (env) => {
				await env.run(async (ctx) => {
					const claim = claimedHandle(
						await env.store.claim(ctx, "key-1", "fp-1"),
						"a fresh key must be claimed by this execution",
					);
					await env.store.complete(ctx, claim, { total: 42 });
				});
				const replay = await env.run((ctx) =>
					env.store.claim(ctx, "key-1", "fp-1"),
				);
				assert(
					replay.status === "completed",
					"a committed complete must replay as completed",
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
				await env.run(async (ctx) => {
					const claim = claimedHandle(
						await env.store.claim(ctx, "key-1", "fp-1"),
						"a fresh key must be claimed",
					);
					await env.store.complete(ctx, claim, "done");
				});
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
					"complete() without claim() must throw IDEMPOTENCY_COMPLETED_WITHOUT_CLAIM",
				);
			}),
		},
		{
			name: "a rolled-back transaction releases the claim",
			run: inEnv(async (env) => {
				// The rejection of the rolled-back transaction is the mechanism,
				// not the subject: the contract under test is the store state.
				let completed = false;
				await captureRejection(
					env.runRolledBack(async (ctx) => {
						const claim = claimedHandle(
							await env.store.claim(ctx, "key-1", "fp-1"),
							"a fresh key must be claimed",
						);
						await env.store.complete(ctx, claim, "rolled back");
						completed = true;
					}),
				);
				assert(
					completed,
					"claim and complete must succeed inside the rolled-back transaction",
				);
				const claim = await env.run((ctx) =>
					env.store.claim(ctx, "key-1", "fp-1"),
				);
				assertEqual(
					claim.status,
					"claimed",
					"a rolled-back claim and complete must leave the key claimable",
				);
			}),
		},
	];
}
