import type {
	LeasedIdempotencyClaim,
	LeasedIdempotencyClaimHandle,
	LeasedIdempotencyStore,
} from "../application/idempotency/idempotency";
import { deepEqual } from "../internal/structural/deep-equal";
import {
	assert,
	assertChainContainsKitError,
	assertEqual,
	bindContractEnvironment,
	type ContractTest,
	captureRejection,
	chainContainsRetryable,
} from "./contract-assertions";

/** One contract test; bind with `(test.skipped ? it.skip : it)(test.name, test.run)`. */
export type LeasedIdempotencyStoreContractTest = ContractTest;

/**
 * One isolated test environment: a fresh leased idempotency store. The suite
 * creates one per test and tears it down afterwards.
 */
export interface LeasedIdempotencyStoreContractEnvironment<TCtx> {
	/** The adapter under test. */
	store: LeasedIdempotencyStore<TCtx>;

	/**
	 * Runs `work` with the context that `claim` and `complete` expect, the way
	 * `withIdempotentCommit` calls them in production. The store cannot see
	 * the transaction, so a context-free store invokes `work` directly.
	 */
	run<R>(work: (ctx: TCtx) => Promise<R>): Promise<R>;

	/**
	 * Advances or edits adapter test state so that the CURRENT lease of this
	 * exact claim is expired. A fake clock or a test-only row update keeps the
	 * suite deterministic.
	 */
	expireLease(claim: LeasedIdempotencyClaimHandle): Promise<void>;

	/**
	 * Moves the adapter's test clock to an exact instant, so the suite proves
	 * renewal without wall-clock sleeps.
	 */
	advanceTimeTo(instant: Date): Promise<void>;

	/** Release connections, drop schemas, etc. Called in a finally. */
	teardown?(): Promise<void>;
}

/** What a leased adapter supplies to run the contract suite. */
export interface LeasedIdempotencyStoreContractHarness<TCtx> {
	createEnvironment(): Promise<LeasedIdempotencyStoreContractEnvironment<TCtx>>;
}

function claimedHandle(
	claim: LeasedIdempotencyClaim,
	message: string,
): LeasedIdempotencyClaimHandle {
	assert(claim.status === "claimed", message);
	return claim.claim;
}

const UNCLAIMED_LEASE = Object.freeze({
	expiresAt: "1970-01-01T00:00:00.000Z",
	renewAfterMs: 1,
});

/**
 * The contract test suite of the {@link LeasedIdempotencyStore}: the proof
 * that an adapter delivers the claim, renew, complete, confirm, abandon, and
 * reconcile lifecycle that `withIdempotentCommit` documents. The store cannot
 * see commits, so `complete` only stages the outcome, `confirm` finalizes it,
 * `abandon` releases a failed attempt, and an expired staged outcome requires
 * reconciliation. Store semantics are an **adapter contract, not a kit
 * guarantee**; this suite is how an adapter demonstrates them.
 *
 * Framework-agnostic: bind with
 * `(test.skipped ? it.skip : it)(test.name, test.run)`.
 */
export function createLeasedIdempotencyStoreContractTests<TCtx>(
	harness: LeasedIdempotencyStoreContractHarness<TCtx>,
): LeasedIdempotencyStoreContractTest[] {
	const inEnv = bindContractEnvironment(() => harness.createEnvironment());

	const stage = (
		env: LeasedIdempotencyStoreContractEnvironment<TCtx>,
		key: string,
		outcome: unknown,
	): Promise<LeasedIdempotencyClaimHandle> =>
		env.run(async (ctx) => {
			const claim = claimedHandle(
				await env.store.claim(ctx, key, "fp-1"),
				"a fresh key must be claimed",
			);
			await env.store.complete(ctx, claim, outcome);
			return claim;
		});

	const completeAndConfirm = async (
		env: LeasedIdempotencyStoreContractEnvironment<TCtx>,
		key: string,
		outcome: unknown,
	): Promise<LeasedIdempotencyClaimHandle> => {
		const claim = await stage(env, key, outcome);
		await env.store.confirm(claim);
		return claim;
	};

	return [
		{
			name: "a fresh key is claimed; the full lifecycle replays the outcome",
			run: inEnv(async (env) => {
				await completeAndConfirm(env, "key-1", { total: 42 });
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
				await completeAndConfirm(env, "key-1", "done");
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
				const first = await completeAndConfirm(env, "key-1", "done");
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
				const first = await completeAndConfirm(env, "key-1", "done");
				await env.store.confirm(first);
				await env.store.confirm({
					key: "never-claimed",
					token: "missing",
					lease: UNCLAIMED_LEASE,
				});
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
						env.store.complete(
							ctx,
							{ key: "key-1", token: "missing", lease: UNCLAIMED_LEASE },
							"x",
						),
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
				// wrap the kit error, and a consumer's retry loop still sees
				// retryable.
				assert(
					chainContainsRetryable(rejection),
					"the in-flight error must be retryable (on the rejection or its cause chain)",
				);
			}),
		},
		{
			name: "renew extends ownership beyond the original lease expiry",
			run: inEnv(async (env) => {
				const claim = claimedHandle(
					await env.run((ctx) => env.store.claim(ctx, "key-renew", "fp")),
					"a fresh key must be claimed",
				);
				const originalExpiry = new Date(claim.lease.expiresAt).getTime();
				assert(
					Number.isFinite(originalExpiry) &&
						new Date(originalExpiry).toISOString() === claim.lease.expiresAt &&
						Number.isSafeInteger(claim.lease.renewAfterMs) &&
						claim.lease.renewAfterMs > 0,
					"lease timing must carry a valid expiry and positive safe renewal delay",
				);
				await env.advanceTimeTo(new Date(originalExpiry - 1));
				const renewed = await env.store.renew(claim);
				assert(
					new Date(renewed.expiresAt).getTime() > originalExpiry,
					"renew must extend the lease beyond its previous expiry",
				);
				await env.advanceTimeTo(new Date(originalExpiry + 1));
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
		{
			name: "an expired pending lease is reclaimed under a new token and fences its stale owner",
			run: inEnv(async (env) => {
				const first = claimedHandle(
					await env.run((ctx) => env.store.claim(ctx, "key-1", "fp-1")),
					"a fresh key must be claimed",
				);
				await env.expireLease(first);
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
		{
			name: "an expired staged outcome requires reconciliation and never auto-replays",
			run: inEnv(async (env) => {
				const first = await stage(env, "key-1", "uncertain");
				await env.expireLease(first);
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
		{
			name: "reconciliation confirms committed work or releases proven rollback",
			run: inEnv(async (env) => {
				await env.expireLease(await stage(env, "committed", "winner"));
				const committed = await env.run((ctx) =>
					env.store.claim(ctx, "committed", "fp-1"),
				);
				assert(
					committed.status === "reconciliation-required",
					"the staged outcome must expose its reconciliation receipt",
				);
				await env.store.reconcile(committed.reconciliation, "committed");
				const replay = await env.run((ctx) =>
					env.store.claim(ctx, "committed", "fp-1"),
				);
				assert(
					replay.status === "completed" && replay.outcome === "winner",
					"committed evidence must make the staged outcome replayable",
				);

				await env.expireLease(
					await stage(env, "rolled-back", "must disappear"),
				);
				const rolledBack = await env.run((ctx) =>
					env.store.claim(ctx, "rolled-back", "fp-1"),
				);
				assert(
					rolledBack.status === "reconciliation-required",
					"the staged outcome must expose its reconciliation receipt",
				);
				await env.store.reconcile(rolledBack.reconciliation, "not-committed");
				const fresh = await env.run((ctx) =>
					env.store.claim(ctx, "rolled-back", "fp-1"),
				);
				assertEqual(
					fresh.status,
					"claimed",
					"not-committed evidence must release the staged outcome",
				);
			}),
		},
		{
			name: "a staged, unconfirmed outcome is in-flight, never replayed",
			run: inEnv(async (env) => {
				await stage(env, "key-1", "uncommitted");
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
		{
			name: "abandon releases a staged outcome so the next attempt claims fresh",
			run: inEnv(async (env) => {
				await env.store.abandon(await stage(env, "key-1", "uncommitted"));
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
	];
}
