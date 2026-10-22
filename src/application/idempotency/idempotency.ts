import type { AnyDomainEvent } from "../../domain/event/domain-event";
import {
	EventCollectionError,
	IdempotencyReconciliationRequiredError,
} from "../../errors/kit-errors";
import { reportToObserver } from "../../internal/observer";
import { MAX_TIMER_DELAY_MS } from "../../internal/validate";
import type { TransactionScope } from "../../persistence/repository/scope";
import {
	type CommitRegistration,
	type WithCommitDeps,
	withCommit,
} from "../cqrs/handler";

/** Store-issued ownership receipt for one successful claim. */
export interface IdempotencyClaimHandle {
	readonly key: string;
	/** Unique across ownership generations for this key; treat as opaque. */
	readonly token: string;
}

/** Lease timing of a claim of a {@link LeasedIdempotencyStore}. */
export interface IdempotencyLease {
	/** Adapter-clock expiry as a canonical ISO-8601 timestamp. */
	readonly expiresAt: string;
	/** Delay after which the wrapper should renew this lease. */
	readonly renewAfterMs: number;
}

/** Ownership receipt of a {@link LeasedIdempotencyStore}: a claim with a lease. */
export interface LeasedIdempotencyClaimHandle extends IdempotencyClaimHandle {
	readonly lease: IdempotencyLease;
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

/**
 * Result of `IdempotencyStore.claim()`: this execution owns the key and must
 * run the command (`claimed`), or a previous execution completed and its
 * outcome is replayed (`completed`).
 *
 * The two FAILURE answers are thrown, not returned, following the kit's
 * error posture: a concurrent unfinished execution throws
 * `IdempotencyInFlightError` (retryable), and the same key arriving
 * with a different fingerprint throws `IdempotencyKeyReuseError`
 * (not retryable).
 */
export type IdempotencyClaim =
	| { readonly status: "claimed"; readonly claim: IdempotencyClaimHandle }
	| { readonly status: "completed"; readonly outcome: unknown };

/**
 * Result of `LeasedIdempotencyStore.claim()`: the answers of
 * {@link IdempotencyClaim}, with a leased receipt, plus
 * `reconciliation-required` for an expired staged outcome that needs evidence
 * from the authoritative write model.
 */
export type LeasedIdempotencyClaim =
	| { readonly status: "claimed"; readonly claim: LeasedIdempotencyClaimHandle }
	| { readonly status: "completed"; readonly outcome: unknown }
	| {
			readonly status: "reconciliation-required";
			readonly reconciliation: IdempotencyReconciliation;
	  };

/**
 * Driven port for command idempotency and message-inbox deduplication, in
 * the transactional family: the record lives in the same database as the
 * aggregate and the outbox, and {@link withIdempotentCommit} writes it in
 * the same transaction. A rollback releases the claim, and the commit makes
 * the outcome replayable, so there is no crash window between claim and
 * commit. This is the recommended production pattern.
 *
 * The store keeps one record per idempotency key: the key, a fingerprint of
 * the command that first claimed it, and, once the execution completed, the
 * stored outcome. The adapter maps the native signals of its store onto the
 * kit's errors instead of leaking driver errors:
 *
 * - unique-constraint conflict from a CONCURRENT uncommitted claim ->
 *   `IdempotencyInFlightError` (retryable; a retry replays the outcome
 *   or claims fresh),
 * - existing COMPLETED record with the same fingerprint -> return
 *   `{ status: "completed", outcome }`,
 * - existing record with a DIFFERENT fingerprint ->
 *   `IdempotencyKeyReuseError`.
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
 * A store whose record cannot join the transaction implements
 * {@link LeasedIdempotencyStore} instead.
 *
 * @template TCtx - The transaction context the surrounding scope
 *   exposes (Drizzle `tx`, Prisma `tx`, `undefined` for context-free
 *   scopes). `claim` and `complete` run inside that transaction.
 */
export interface IdempotencyStore<TCtx = unknown> {
	readonly family: "transactional";

	/**
	 * Claims the key for this execution, atomically with respect to
	 * concurrent claimers (`INSERT ... ON CONFLICT` or equivalent).
	 * Returns `claimed` when this execution owns the key, or `completed`
	 * with the stored outcome when a previous execution already finished
	 * under the same key and fingerprint. Throws `IdempotencyInFlightError`
	 * / `IdempotencyKeyReuseError` for the failure answers.
	 */
	claim(ctx: TCtx, key: string, fingerprint: string): Promise<IdempotencyClaim>;

	/**
	 * Stores the outcome for a key this execution claimed, in the same
	 * transaction as the command's writes. The commit makes it durable and
	 * replayable. Throws `IdempotencyCompletionWithoutClaimError` when no
	 * claim exists.
	 */
	complete(
		ctx: TCtx,
		claim: IdempotencyClaimHandle,
		outcome: unknown,
	): Promise<void>;
}

/**
 * Driven port for command idempotency in the leased family: the record lives
 * outside the transaction of the command, for example in a separate store,
 * so the store cannot see commits or rollbacks. Use it only when one
 * transaction is impossible; it makes a second store recoverable, not
 * atomic.
 *
 * Every fresh claim returns a store-issued token and a bounded lease. The
 * wrapper renews the lease while the transaction runs. `complete` only
 * stages the outcome, and `confirm` makes it replayable after the commit.
 * `complete`, `renew`, `confirm`, `abandon`, and `reconcile` compare the
 * token, so a stale owner cannot change a successor claim. An expired
 * pending claim may be replaced. An expired staged outcome is never
 * replayed or released automatically: `claim` returns
 * `reconciliation-required`, and the application must consult the source
 * of truth.
 *
 * A lease is coordination, not a security or exactly-once boundary. To
 * return `not-committed` safely, the source transaction must persist an
 * idempotency key or claim token (available as the callback's `execution`
 * argument), or offer equivalent durable fencing proving the old transaction
 * cannot still commit. Without that evidence, return `unknown`. A database
 * row merely being absent while an old transaction may still be in flight is
 * not proof. A takeover can overlap briefly with the stale worker, so `fn`
 * must keep irreversible external side effects out of the transaction.
 * Persist an outbox record and deliver after commit; token fencing can stop
 * the stale database commit, but it cannot undo an HTTP call already sent.
 *
 * The stored outcome must be plain, serialisable data, as for
 * {@link IdempotencyStore}.
 */
export interface LeasedIdempotencyStore<TCtx = unknown> {
	readonly family: "leased";

	/**
	 * Claims the key like {@link IdempotencyStore.claim}, with a leased
	 * receipt. A live staged outcome is in flight; after its lease expires,
	 * the claim returns `reconciliation-required`, never a replay or a fresh
	 * claim.
	 */
	claim(
		ctx: TCtx,
		key: string,
		fingerprint: string,
	): Promise<LeasedIdempotencyClaim>;

	/**
	 * Stages the outcome for a key this execution claimed; {@link confirm}
	 * makes it replayable. Throws `IdempotencyCompletionWithoutClaimError`
	 * when no claim exists, and `IdempotencyClaimLostError` when the receipt
	 * is stale, already settled, or expired. A stale completion must fail
	 * before the source transaction can commit.
	 */
	complete(
		ctx: TCtx,
		claim: LeasedIdempotencyClaimHandle,
		outcome: unknown,
	): Promise<void>;

	/**
	 * Extends the lease of a claim and returns its new timing. The update is
	 * compare-and-set on key + token, and a lost token rejects with
	 * `IdempotencyClaimLostError`.
	 */
	renew(claim: LeasedIdempotencyClaimHandle): Promise<IdempotencyLease>;

	/**
	 * Finalizes a staged outcome AFTER the surrounding transaction committed.
	 * Idempotent: confirming an already-confirmed receipt is a no-op. A
	 * missing or stale receipt is also a no-op and must never confirm its
	 * successor.
	 */
	confirm(claim: LeasedIdempotencyClaimHandle): Promise<void>;

	/**
	 * Releases a claim whose attempt failed before its commit: a pending
	 * claim or a staged, unconfirmed outcome. A failure at commit time has an
	 * unknown outcome, so the wrapper does not call it then. It never
	 * releases a confirmed record. A stale receipt is a no-op and must never
	 * release its successor.
	 */
	abandon(claim: LeasedIdempotencyClaimHandle): Promise<void>;

	/**
	 * Resolves an EXPIRED staged outcome after the application consulted its
	 * authoritative write model. `committed` makes the staged result replayable;
	 * `not-committed` releases it for a fresh execution. `unknown` is
	 * intentionally not accepted here: uncertainty must preserve the record.
	 * The receipt is compare-and-set so a stale reconciler cannot settle a newer
	 * owner.
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

/** Dependencies of {@link withIdempotentCommit} with a transactional store. */
export interface WithIdempotentCommitDeps<Evt extends AnyDomainEvent, TCtx>
	extends WithCommitDeps<Evt, TCtx> {
	idempotency: IdempotencyStore<TCtx>;
}

/** Dependencies of {@link withIdempotentCommit} with a leased store. */
export interface WithLeasedIdempotentCommitDeps<
	Evt extends AnyDomainEvent,
	TCtx,
> extends WithCommitDeps<Evt, TCtx> {
	idempotency: LeasedIdempotencyStore<TCtx>;
	/**
	 * Source-of-truth decision for an expired staged outcome. The callback must
	 * return `committed` only when the command effect is durably visible, and
	 * `not-committed` only when a durable marker proves the attempt cannot still
	 * commit. `unknown` keeps the key blocked. A leased store needs it: without
	 * a decision, an expired staged outcome stays blocked, also after a commit
	 * that surely failed.
	 */
	reconcileIdempotency: (
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
	return (
		Number.isSafeInteger(value) && value > 0 && value <= MAX_TIMER_DELAY_MS
	);
}

function startLeaseHeartbeat<TCtx>(
	store: LeasedIdempotencyStore<TCtx>,
	claim: LeasedIdempotencyClaimHandle,
): LeaseHeartbeat {
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let inFlight: Promise<void> = Promise.resolve();
	let heartbeatFailure: unknown | undefined;

	const schedule = (delayMs: number): void => {
		if (!validRenewAfterMs(delayMs)) {
			heartbeatFailure = new TypeError(
				`LeasedIdempotencyStore returned an invalid lease renewAfterMs; expected a positive safe integer no greater than ${MAX_TIMER_DELAY_MS}`,
			);
			return;
		}
		timer = setTimeout(() => {
			inFlight = store
				.renew(claim)
				.then((lease) => {
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

function scopeWorkRegistration<Evt extends AnyDomainEvent>(
	parent: CommitRegistration<Evt>,
): { readonly registration: CommitRegistration<Evt>; close(): void } {
	let open = true;
	const assertOpen = (): void => {
		if (!open) {
			throw new EventCollectionError(
				"withIdempotentCommit: commit registration was used after the " +
					"user work callback settled. Await every repository write before " +
					"returning from the callback.",
			);
		}
	};

	return {
		registration: Object.freeze({
			registerSaved: (
				...args: Parameters<CommitRegistration<Evt>["registerSaved"]>
			) => {
				assertOpen();
				parent.registerSaved(...args);
			},
			registerRemoved: (
				...args: Parameters<CommitRegistration<Evt>["registerRemoved"]>
			) => {
				assertOpen();
				parent.registerRemoved(...args);
			},
		}),
		close: () => {
			open = false;
		},
	};
}

/** Runs the work with a registration that is sealed once the work settles. */
async function runSealedWork<Evt extends AnyDomainEvent, R, TCtx>(
	ctx: TCtx,
	registration: CommitRegistration<Evt>,
	execution: IdempotentExecution,
	fn: (
		ctx: TCtx,
		registration: CommitRegistration<Evt>,
		execution: IdempotentExecution,
	) => Promise<R>,
): Promise<R> {
	const workRegistration = scopeWorkRegistration(registration);
	try {
		return await fn(ctx, workRegistration.registration, execution);
	} finally {
		workRegistration.close();
	}
}

/**
 * {@link withCommit} with command idempotency: the duplicate-safe write
 * path for retryable deliveries (client retries, at-least-once
 * messages, scheduler re-runs).
 *
 * **Transactional store.** Inside the transaction, `store.claim(ctx, key,
 * fingerprint)` runs FIRST. A completed execution short-circuits without
 * touching the domain. A fresh claim runs `fn(ctx, registration,
 * execution)`, and `store.complete(ctx, claim, result)` stores its result in
 * the same transaction as the aggregate writes and the outbox. A rollback
 * releases the claim, and the commit makes the outcome replayable.
 *
 * **Leased store.** The order is the same, with these additions:
 *  1. An expired staged outcome invokes `reconcileIdempotency`; `committed`
 *     replays it, `not-committed` releases and claims fresh, and `unknown`
 *     throws `IdempotencyReconciliationRequiredError` without changing the
 *     store.
 *  2. The wrapper renews the lease at `renewAfterMs` until the transaction
 *     callback is ready to commit. A renewal failure rejects before commit
 *     and releases the claim.
 *  3. `store.complete` stages the outcome, and after the commit
 *     `store.confirm(claim)` finalizes it. A confirm failure cannot reject
 *     an already committed write, so it is sent to `onIdempotencyError`, and
 *     the record later enters reconciliation after lease expiry.
 *  4. Any failure before the commit releases that exact token through
 *     `store.abandon(claim)` before leaving the transactional region. A stale
 *     abandon cannot release a successor. Secondary abandon/renew failures
 *     are observable but never mask the primary error.
 *  5. A failure at commit time has an unknown outcome. The wrapper does not
 *     release the staged outcome, so a retry cannot run the command a second
 *     time. The key answers `IdempotencyInFlightError` until the lease
 *     expires, and then `reconciliation-required`.
 *
 * In both families the registration capability is sealed when `fn` settles,
 * so a late registration fails loudly. `fn` receives the claim token, so a
 * source-side marker can make a later reconciliation conclusive.
 *
 * Composes with `RetryingTransactionScope`: a retryable failure inside one
 * attempt releases that attempt's claim, and the retry either executes fresh
 * or, when a concurrent execution completed meanwhile, replays its outcome. A
 * concurrent duplicate while the first execution is still running surfaces as
 * `IdempotencyInFlightError` (retryable); unwrapped, map it to a
 * conflict/retry-later application outcome.
 *
 * The stored outcome is the value that `fn` returns; it must be plain,
 * serialisable data (see {@link IdempotencyStore}).
 */
export async function withIdempotentCommit<Evt extends AnyDomainEvent, R, TCtx>(
	deps:
		| WithIdempotentCommitDeps<Evt, TCtx>
		| WithLeasedIdempotentCommitDeps<Evt, TCtx>,
	request: IdempotentCommitRequest,
	fn: (
		ctx: TCtx,
		registration: CommitRegistration<Evt>,
		execution: IdempotentExecution,
	) => Promise<R>,
): Promise<IdempotentCommitResult<R>> {
	if (isLeasedDeps(deps)) return withLeasedIdempotentCommit(deps, request, fn);
	const store = deps.idempotency;
	return withCommit<Evt, IdempotentCommitResult<R>, TCtx>(
		deps,
		async (ctx, registration) => {
			const claim = await store.claim(ctx, request.key, request.fingerprint);
			if (claim.status === "completed") {
				return { replayed: true, result: claim.outcome as R };
			}
			const result = await runSealedWork(
				ctx,
				registration,
				{ ...request, claimToken: claim.claim.token },
				fn,
			);
			await store.complete(ctx, claim.claim, result);
			return { replayed: false, result };
		},
	);
}

function isLeasedDeps<Evt extends AnyDomainEvent, TCtx>(
	deps:
		| WithIdempotentCommitDeps<Evt, TCtx>
		| WithLeasedIdempotentCommitDeps<Evt, TCtx>,
): deps is WithLeasedIdempotentCommitDeps<Evt, TCtx> {
	return deps.idempotency.family === "leased";
}

async function withLeasedIdempotentCommit<Evt extends AnyDomainEvent, R, TCtx>(
	deps: WithLeasedIdempotentCommitDeps<Evt, TCtx>,
	request: IdempotentCommitRequest,
	fn: (
		ctx: TCtx,
		registration: CommitRegistration<Evt>,
		execution: IdempotentExecution,
	) => Promise<R>,
): Promise<IdempotentCommitResult<R>> {
	const store = deps.idempotency;
	const attempt: {
		claim: LeasedIdempotencyClaimHandle | undefined;
		heartbeat: LeaseHeartbeat | undefined;
	} = { claim: undefined, heartbeat: undefined };

	// Decorator around the caller's scope: releases the current
	// attempt's claim before an error leaves the transactional region.
	// This is the only place that sees EVERY failure point of one
	// attempt (the work, withCommit's collection guards, the outbox write),
	// including the ones outside this module's own callback, and it runs
	// INSIDE a retrying scope's loop, so the next attempt starts clean.
	//
	// A failure after the callback resolved is a failure at commit time,
	// and its outcome is unknown: the effect can exist. Such a claim is not
	// released. Its staged outcome stays, so a retry cannot run the command
	// a second time. The heartbeat stopped when the callback resolved, so
	// the lease expires and the claim returns reconciliation-required.
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
						| LeasedIdempotencyClaimHandle
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
					if (currentClaim) {
						attempt.claim = undefined;
						try {
							await store.abandon(currentClaim);
						} catch (abandonError) {
							// Best-effort release: the abandon failure must not
							// mask the attempt's error. The lease lets the store
							// recover after expiry, and the observer keeps the
							// secondary operational failure visible.
							reportToObserver(() =>
								deps.onIdempotencyError?.(abandonError, {
									operation: "abandon",
									key: currentClaim.key,
									token: currentClaim.token,
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
		async (ctx, registration) => {
			let claim = await store.claim(ctx, request.key, request.fingerprint);
			if (claim.status === "reconciliation-required") {
				const decision = await deps.reconcileIdempotency(
					claim.reconciliation,
					ctx,
				);
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
				return { replayed: true, result: claim.outcome as R };
			}
			attempt.claim = claim.claim;
			attempt.heartbeat = startLeaseHeartbeat(store, claim.claim);
			const result = await runSealedWork(
				ctx,
				registration,
				{ ...request, claimToken: claim.claim.token },
				fn,
			);
			await store.complete(ctx, claim.claim, result);
			return { replayed: false, result };
		},
	);

	if (!outcome.replayed) {
		// Post-commit finalize: flips the staged outcome to confirmed so only
		// committed outcomes ever replay. Runs after the commit, so a throw
		// here must not reject the committed write. The staged record remains
		// in flight until lease expiry and then requires an authoritative
		// reconciliation decision.
		const committedClaim = attempt.claim as
			| LeasedIdempotencyClaimHandle
			| undefined;
		if (!committedClaim) {
			throw new EventCollectionError(
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
