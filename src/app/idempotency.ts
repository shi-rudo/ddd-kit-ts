import type { AnyDomainEvent } from "../aggregate/domain-event";
import {
	EventHarvestError,
	IdempotencyReconciliationRequiredError,
} from "../core/errors";
import type { TransactionScope } from "../repo/scope";
import { reportToObserver } from "../utils/observer";
import {
	type CommitEnrollment,
	type WithCommitDeps,
	type WithCommitWorkResult,
	withCommit,
} from "./handler";

/**
 * Result of `IdempotencyStore.claim()`: this execution owns the key and must
 * run the command (`claimed`), a previous execution completed and its outcome
 * is replayed (`completed`), or an expired staged outcome needs evidence from
 * the authoritative write model (`reconciliation-required`).
 *
 * The two FAILURE answers are thrown, not returned, following the kit's
 * error posture: a concurrent unfinished execution throws
 * `IdempotencyInFlightError` (retryable), and the same key arriving
 * with a different fingerprint throws `IdempotencyKeyReuseError`
 * (not retryable).
 */
export interface IdempotencyLease {
	/** Adapter-clock expiry as a canonical ISO-8601 timestamp. */
	readonly expiresAt: string;
	/** Delay after which the wrapper should renew this lease. */
	readonly renewAfterMs: number;
}

/** Store-minted ownership receipt for one successful claim. */
export interface IdempotencyClaimHandle {
	readonly key: string;
	/** Unique across ownership generations for this key; treat as opaque. */
	readonly token: string;
	/** Absent for a transactional store; required for a leased store. */
	readonly lease?: IdempotencyLease;
}

/** Receipt for an expired staged outcome that needs authoritative evidence. */
export interface IdempotencyReconciliation {
	readonly key: string;
	readonly fingerprint: string;
	readonly token: string;
	readonly expiredAt: string;
}

export type IdempotencyReconciliationDecision =
	| "committed"
	| "not-committed"
	| "unknown";

export type IdempotencyClaim =
	| { readonly status: "claimed"; readonly claim: IdempotencyClaimHandle }
	| { readonly status: "completed"; readonly outcome: unknown }
	| {
			readonly status: "reconciliation-required";
			readonly reconciliation: IdempotencyReconciliation;
	  };

/**
 * Driven port for command idempotency and message-inbox deduplication.
 *
 * The store keeps one record per idempotency key: the key, a
 * fingerprint of the command that first claimed it, and, once the
 * execution completed, the stored outcome. The intended integration is
 * the SINGLE-TRANSACTION pattern via {@link withIdempotentCommit}: the
 * record is written in the same transaction as the aggregate and the
 * outbox, so a rollback releases the claim and there is no crash window
 * between claim and commit.
 *
 * Adapter contract (mirror of the repository/event-store delegation
 * model): the adapter maps its store's native signals onto the kit's
 * errors instead of leaking driver errors:
 *
 * - unique-constraint conflict from a CONCURRENT uncommitted claim ->
 *   `IdempotencyInFlightError` (retryable; a retry replays the outcome
 *   or claims fresh),
 * - existing COMPLETED record with the same fingerprint -> return
 *   `{ status: "completed", outcome }`,
 * - existing record with a DIFFERENT fingerprint ->
 *   `IdempotencyKeyReuseError`.
 *
 * **Transactional vs leased non-transactional stores.** A transactional
 * adapter (the record lives in the same database as the aggregate)
 * gets the commit boundary for free: `complete` is atomic with the
 * command's commit, a rollback releases everything, and `confirm` /
 * `abandon` / `renew` / `reconcile` are no-ops. This remains the recommended
 * production pattern and the only family that proves atomic command effect +
 * idempotency completion without reconciliation.
 *
 * A NON-transactional store (the in-memory reference, a separate durable
 * store) cannot see commits or rollbacks. Every fresh claim therefore returns
 * a store-minted token and bounded lease. The wrapper renews it while the
 * transaction runs; `complete`, `renew`, `confirm`, `abandon`, and `reconcile`
 * compare the token so a stale owner cannot mutate a successor claim. An
 * expired PENDING claim may be replaced. An expired STAGED outcome is never
 * replayed or released automatically: `claim` returns
 * `reconciliation-required`, and the application must consult the source of
 * truth. `unknown` keeps it blocked.
 *
 * A lease is coordination, not a security or exactly-once boundary. To return
 * `not-committed` safely, the source transaction must persist an idempotency
 * key or claim token (available as the callback's `execution` argument), or
 * offer equivalent durable fencing proving the old transaction cannot still
 * commit. Without that evidence, return `unknown`. A database row merely being
 * absent while an old transaction may still be in flight is not proof.
 * A takeover can overlap briefly with the stale worker, so `fn` must keep
 * irreversible external side effects out of the transaction. Persist an
 * outbox record and deliver after commit; token fencing can stop the stale
 * database commit, but it cannot undo an HTTP call already sent.
 *
 * The same store doubles as a message INBOX: use the message id as the
 * key and a constant fingerprint; a duplicate delivery replays the
 * stored (possibly `undefined`) outcome instead of re-running the
 * handler.
 *
 * The stored outcome must be PLAIN, serialisable data (the same
 * discipline as snapshots and event payloads): the record round-trips
 * through the adapter's storage, so class instances would silently lose
 * their prototype.
 *
 * @template TCtx - The transaction context the surrounding scope
 *   exposes (Drizzle `tx`, Prisma `tx`, `undefined` for context-free
 *   scopes). `claim` and `complete` run inside that transaction.
 */
export interface IdempotencyStore<TCtx = unknown> {
	/**
	 * Claims the key for this execution, atomically with respect to
	 * concurrent claimers (`INSERT ... ON CONFLICT` or equivalent).
	 * Returns `claimed` when this execution owns the key, or
	 * `completed` with the stored outcome when a previous execution
	 * already finished under the same key and fingerprint. Throws
	 * `IdempotencyInFlightError` / `IdempotencyKeyReuseError` for the
	 * failure answers (see the port docs). A live staged outcome is in-flight;
	 * after its lease expires it returns `reconciliation-required`, never a
	 * replay or fresh claim.
	 */
	claim(ctx: TCtx, key: string, fingerprint: string): Promise<IdempotencyClaim>;

	/**
	 * Stores the outcome for a key this execution claimed, in the same
	 * transaction as the command's writes. On a transactional store the
	 * commit makes it durable and replayable; on a non-transactional
	 * store the outcome is only STAGED until {@link confirm} runs.
	 * Throws `IdempotencyCompletionWithoutClaimError` when no claim exists, and
	 * `IdempotencyClaimLostError` when the receipt is stale, already settled, or
	 * expired. A stale completion must fail before the source transaction can
	 * commit.
	 */
	complete(
		ctx: TCtx,
		claim: IdempotencyClaimHandle,
		outcome: unknown,
	): Promise<void>;

	/**
	 * Extends a non-transactional claim's lease and returns its new timing.
	 * The update is compare-and-set on key + token. A transactional adapter
	 * implements this as a no-op returning `undefined`; the wrapper never calls
	 * it for a claim without a lease.
	 */
	renew(claim: IdempotencyClaimHandle): Promise<IdempotencyLease | undefined>;

	/**
	 * Finalizes a staged outcome AFTER the surrounding transaction
	 * committed. Called by {@link withIdempotentCommit} post-commit on
	 * every fresh execution. A transactional adapter implements this as
	 * a no-op (the commit already finalized the record). Idempotent:
	 * confirming an already-confirmed receipt is a no-op. A missing or stale
	 * receipt is also a no-op and must never confirm its successor.
	 */
	confirm(claim: IdempotencyClaimHandle): Promise<void>;

	/**
	 * Releases a claim whose attempt did not commit: a pending claim or
	 * a staged, unconfirmed outcome. Called by
	 * {@link withIdempotentCommit} once per failed attempt, best-effort.
	 * A transactional adapter implements this as a no-op: the rollback
	 * already removed the row, and the method must be SAFE to call when
	 * the commit outcome is unknown; it never releases a confirmed
	 * record. A stale receipt is a no-op and must never release its successor.
	 */
	abandon(claim: IdempotencyClaimHandle): Promise<void>;

	/**
	 * Resolves an EXPIRED staged outcome after the application consulted its
	 * authoritative write model. `committed` makes the staged result replayable;
	 * `not-committed` releases it for a fresh execution. `unknown` is
	 * intentionally not accepted here: uncertainty must preserve the record.
	 * The receipt is compare-and-set so a stale reconciler cannot settle a newer
	 * owner. Transactional adapters implement this as a no-op because they never
	 * return `reconciliation-required`.
	 */
	reconcile(
		reconciliation: IdempotencyReconciliation,
		decision: Exclude<IdempotencyReconciliationDecision, "unknown">,
	): Promise<void>;
}

/** Identifies one logical command execution for {@link withIdempotentCommit}. */
export interface IdempotentCommitRequest {
	/**
	 * The idempotency key: client-supplied header, message id, or a key
	 * derived from actor + intention. One key names one logical command.
	 */
	readonly key: string;
	/**
	 * Fingerprint of the command's content (a hash or canonical string
	 * of the request payload). Detects the same key being reused for a
	 * DIFFERENT command, which is rejected instead of replayed.
	 */
	readonly fingerprint: string;
}

/**
 * Outcome of {@link withIdempotentCommit}: `replayed: false` carries the
 * fresh result of this execution; `replayed: true` carries the stored
 * outcome of the previous execution with the same key and fingerprint.
 * The replayed value is typed `R` on the strength of the fingerprint
 * match: the same command was executed, so the stored outcome has the
 * shape this command produces, provided the adapter round-trips plain
 * data faithfully.
 */
export interface IdempotentCommitResult<R> {
	readonly replayed: boolean;
	readonly result: R;
}

/** Claim identity visible to work that persists a source-of-truth marker. */
export interface IdempotentExecution extends IdempotentCommitRequest {
	readonly claimToken: string;
}

export interface IdempotencyOperationErrorContext {
	readonly operation: "abandon" | "confirm" | "renew";
	readonly key: string;
	readonly token: string;
}

export interface WithIdempotentCommitDeps<Evt extends AnyDomainEvent, TCtx>
	extends WithCommitDeps<Evt, TCtx> {
	idempotency: IdempotencyStore<TCtx>;
	/**
	 * Source-of-truth decision for an expired staged outcome. The callback must
	 * return `committed` only when the command effect is durably visible, and
	 * `not-committed` only when a durable marker proves the attempt cannot still
	 * commit. `unknown` keeps the key blocked.
	 */
	reconcileIdempotency?: (
		reconciliation: IdempotencyReconciliation,
		ctx: TCtx,
	) => Promise<IdempotencyReconciliationDecision>;
	/**
	 * Observer for best-effort post-commit confirm, rollback abandon, and a
	 * secondary heartbeat failure masked by the primary work error.
	 */
	onIdempotencyError?: (
		error: unknown,
		context: IdempotencyOperationErrorContext,
	) => void;
}

interface LeaseHeartbeat {
	stop(): Promise<void>;
	failure(): unknown | undefined;
}

function validRenewAfterMs(value: number): boolean {
	return Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
}

function startLeaseHeartbeat<TCtx>(
	store: IdempotencyStore<TCtx>,
	claim: IdempotencyClaimHandle,
): LeaseHeartbeat | undefined {
	if (!claim.lease) return undefined;
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let inFlight: Promise<void> = Promise.resolve();
	let heartbeatFailure: unknown | undefined;

	const schedule = (delayMs: number): void => {
		if (!validRenewAfterMs(delayMs)) {
			heartbeatFailure = new TypeError(
				"IdempotencyStore returned an invalid lease renewAfterMs; expected a positive safe integer no greater than 2147483647",
			);
			return;
		}
		timer = setTimeout(() => {
			inFlight = store
				.renew(claim)
				.then((lease) => {
					if (!lease) {
						throw new TypeError(
							"IdempotencyStore returned no lease while renewing a leased claim",
						);
					}
					if (stopped) return;
					schedule(lease.renewAfterMs);
				})
				.catch((error: unknown) => {
					heartbeatFailure = error;
				});
		}, delayMs);
	};

	schedule(claim.lease.renewAfterMs);
	return {
		stop: async () => {
			stopped = true;
			if (timer !== undefined) clearTimeout(timer);
			await inFlight;
		},
		failure: () => heartbeatFailure,
	};
}

function scopeWorkEnrollment<Evt extends AnyDomainEvent>(
	parent: CommitEnrollment<Evt>,
): { readonly enrollment: CommitEnrollment<Evt>; close(): void } {
	let open = true;
	const assertOpen = (): void => {
		if (!open) {
			throw new EventHarvestError(
				"withIdempotentCommit: commit enrollment was used after the " +
					"user work callback settled. Await every repository write before " +
					"returning from the callback.",
			);
		}
	};

	return {
		enrollment: Object.freeze({
			enrollSaved: (
				aggregate: Parameters<CommitEnrollment<Evt>["enrollSaved"]>[0],
			) => {
				assertOpen();
				return parent.enrollSaved(aggregate);
			},
			enrollDeleted: (
				aggregate: Parameters<CommitEnrollment<Evt>["enrollDeleted"]>[0],
			) => {
				assertOpen();
				return parent.enrollDeleted(aggregate);
			},
		}),
		close: () => {
			open = false;
		},
	};
}

/**
 * {@link withCommit} with command idempotency: the duplicate-safe write
 * path for retryable deliveries (client retries, at-least-once
 * messages, scheduler re-runs).
 *
 * Order of operations:
 *  1. Inside the transaction, `store.claim(ctx, key, fingerprint)` runs
 *     FIRST. A completed execution short-circuits without touching the domain.
 *     An expired staged outcome invokes `reconcileIdempotency`; `committed`
 *     replays it, `not-committed` releases and claims fresh, and `unknown` (or
 *     no callback) throws `IdempotencyReconciliationRequiredError` without
 *     changing the store.
 *  2. A fresh claim carries an opaque ownership token. For a leased store the
 *     wrapper renews it at `renewAfterMs` until the transaction callback is
 *     ready to commit. A renewal failure rejects before commit and releases
 *     the claim. `fn(ctx, enrollment, execution)` receives the same token so a
 *     source-side marker can make later reconciliation conclusive.
 *  3. `store.complete(ctx, claim, fn's result)` stages or completes the outcome
 *     in the same transaction as aggregate writes and outbox. The enrollment
 *     capability is sealed and its token array copied before `complete` can
 *     yield, so leaked callback state cannot change the harvest receipt.
 *  4. After commit, `store.confirm(claim)` finalizes a leased store's staged
 *     outcome; it is a no-op for transactional stores. A failure cannot reject
 *     an already committed write, so it is sent to `onIdempotencyError` and the
 *     record later enters reconciliation after lease expiry.
 *  5. Any pre-commit failure releases that exact token through
 *     `store.abandon(claim)` before leaving the transactional region. A stale
 *     abandon cannot release a successor. Secondary abandon/renew failures are
 *     observable but never mask the primary error.
 *
 * Composes with `RetryingTransactionScope`: a retryable failure inside
 * one attempt releases that attempt's claim, and the retry either
 * executes fresh or, when a concurrent execution completed meanwhile,
 * replays its confirmed outcome. A concurrent duplicate while the first
 * execution is still running surfaces as `IdempotencyInFlightError`
 * (retryable); unwrapped, map it to a conflict/retry-later application
 * outcome.
 *
 * The stored outcome is `fn`'s `result` value; it must be plain, serialisable
 * data (see {@link IdempotencyStore}). Transactional storage remains the
 * production default. Leases make the non-transactional family recoverable;
 * they do not manufacture an atomic exactly-once boundary across two stores.
 */
export async function withIdempotentCommit<Evt extends AnyDomainEvent, R, TCtx>(
	deps: WithIdempotentCommitDeps<Evt, TCtx>,
	request: IdempotentCommitRequest,
	fn: (
		ctx: TCtx,
		enrollment: CommitEnrollment<Evt>,
		execution: IdempotentExecution,
	) => Promise<WithCommitWorkResult<Evt, R>>,
): Promise<IdempotentCommitResult<R>> {
	const store = deps.idempotency;
	const attempt: {
		claim: IdempotencyClaimHandle | undefined;
		heartbeat: LeaseHeartbeat | undefined;
	} = { claim: undefined, heartbeat: undefined };

	// Decorator around the caller's scope: releases the current
	// attempt's claim before an error leaves the transactional region.
	// This is the only place that sees EVERY failure point of one
	// attempt (the work, withCommit's harvest guards, the outbox write),
	// including the ones outside this module's own callback, and it runs
	// INSIDE a retrying scope's loop, so the next attempt starts clean.
	const scope: TransactionScope<TCtx> = {
		transactional: (work, options) =>
			deps.scope.transactional(async (ctx) => {
				attempt.claim = undefined;
				attempt.heartbeat = undefined;
				try {
					const result = await work(ctx);
					const currentHeartbeat = attempt.heartbeat as
						| LeaseHeartbeat
						| undefined;
					await currentHeartbeat?.stop();
					const heartbeatFailure = currentHeartbeat?.failure();
					if (heartbeatFailure !== undefined) throw heartbeatFailure;
					return result;
				} catch (error) {
					const currentHeartbeat = attempt.heartbeat as
						| LeaseHeartbeat
						| undefined;
					await currentHeartbeat?.stop();
					const heartbeatFailure = currentHeartbeat?.failure();
					const currentClaim = attempt.claim as
						| IdempotencyClaimHandle
						| undefined;
					if (
						heartbeatFailure !== undefined &&
						heartbeatFailure !== error &&
						currentClaim
					) {
						reportToObserver(() =>
							deps.onIdempotencyError?.(heartbeatFailure, {
								operation: "renew",
								key: currentClaim.key,
								token: currentClaim.token,
							}),
						);
					}
					const abandoned = attempt.claim as IdempotencyClaimHandle | undefined;
					if (abandoned) {
						attempt.claim = undefined;
						try {
							await store.abandon(abandoned);
						} catch (abandonError) {
							// Best-effort release: the abandon failure must not
							// mask the attempt's error. Transactional stores
							// release via rollback anyway; a leased store can
							// recover after expiry. The observer keeps the
							// secondary operational failure visible.
							reportToObserver(() =>
								deps.onIdempotencyError?.(abandonError, {
									operation: "abandon",
									key: abandoned.key,
									token: abandoned.token,
								}),
							);
						}
					}
					throw error;
				}
			}, options),
	};

	const outcome = await withCommit<Evt, IdempotentCommitResult<R>, TCtx>(
		{ ...deps, scope },
		async (ctx, enrollment) => {
			let claim = await store.claim(ctx, request.key, request.fingerprint);
			if (claim.status === "reconciliation-required") {
				const decision = deps.reconcileIdempotency
					? await deps.reconcileIdempotency(claim.reconciliation, ctx)
					: "unknown";
				if (decision === "unknown") {
					throw new IdempotencyReconciliationRequiredError(
						claim.reconciliation,
					);
				}
				if (decision !== "committed" && decision !== "not-committed") {
					throw new TypeError(
						"reconcileIdempotency must return committed, not-committed, or unknown",
					);
				}
				await store.reconcile(claim.reconciliation, decision);
				claim = await store.claim(ctx, request.key, request.fingerprint);
				if (claim.status === "reconciliation-required") {
					throw new IdempotencyReconciliationRequiredError(
						claim.reconciliation,
					);
				}
			}
			if (claim.status === "completed") {
				return {
					result: { replayed: true, result: claim.outcome as R },
					commits: [],
				};
			}
			attempt.claim = claim.claim;
			attempt.heartbeat = startLeaseHeartbeat(store, claim.claim);
			const workEnrollment = scopeWorkEnrollment(enrollment);
			let work: WithCommitWorkResult<Evt, R>;
			try {
				work = await fn(ctx, workEnrollment.enrollment, {
					key: request.key,
					fingerprint: request.fingerprint,
					claimToken: claim.claim.token,
				});
			} finally {
				workEnrollment.close();
			}
			// Snapshot the user-controlled receipt before complete() yields. A
			// leaked mutable array must not be able to add or remove aggregate
			// commits while the idempotency adapter is persisting the outcome.
			const result = work.result;
			const commits = Array.isArray(work.commits)
				? Object.freeze([...work.commits])
				: work.commits;
			await store.complete(ctx, claim.claim, result);
			return {
				result: { replayed: false, result },
				commits,
			};
		},
	);

	if (!outcome.replayed) {
		// Post-commit finalize: flips a leased store's staged
		// outcome to confirmed so only committed outcomes ever replay.
		// No-op for transactional stores. Runs after the commit, so a
		// throw here must not reject the committed write. The staged record
		// remains in-flight until lease expiry and then requires an
		// authoritative reconciliation decision.
		const committedClaim = attempt.claim as IdempotencyClaimHandle | undefined;
		if (!committedClaim) {
			throw new EventHarvestError(
				"withIdempotentCommit: a fresh result committed without its claim receipt.",
			);
		}
		try {
			await store.confirm(committedClaim);
		} catch (confirmError) {
			// Swallowed by the post-commit invariant: the write has committed.
			// Report it so the staged record enters the reconciliation path
			// visibly instead of becoming a silent permanent blockage.
			reportToObserver(() =>
				deps.onIdempotencyError?.(confirmError, {
					operation: "confirm",
					key: committedClaim.key,
					token: committedClaim.token,
				}),
			);
		}
	}
	return outcome;
}
