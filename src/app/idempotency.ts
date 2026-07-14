import type { AnyDomainEvent } from "../aggregate/domain-event";
import { EventHarvestError } from "../core/errors";
import type { TransactionScope } from "../repo/scope";
import {
	type CommitEnrollment,
	type WithCommitDeps,
	type WithCommitWorkResult,
	withCommit,
} from "./handler";

/**
 * Result of `IdempotencyStore.claim()`: either this execution owns the
 * key and must run the command (`claimed`), or a previous execution
 * already completed under the same key and fingerprint and its stored
 * outcome is replayed (`completed`).
 *
 * The two FAILURE answers are thrown, not returned, following the kit's
 * error posture: a concurrent unfinished execution throws
 * `IdempotencyInFlightError` (retryable), and the same key arriving
 * with a different fingerprint throws `IdempotencyKeyReuseError`
 * (not retryable).
 */
export type IdempotencyClaim =
	| { readonly status: "claimed" }
	| { readonly status: "completed"; readonly outcome: unknown };

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
 * **Transactional vs non-transactional stores.** A transactional
 * adapter (the record lives in the same database as the aggregate)
 * gets the commit boundary for free: `complete` is atomic with the
 * command's commit, a rollback releases everything, and `confirm` /
 * `abandon` are no-ops. A NON-transactional store (the in-memory
 * reference, a separate cache) cannot see commits or rollbacks, so the
 * wrapper drives it through the two hooks: `abandon` releases a claim
 * whose attempt failed, and `confirm` finalizes the staged outcome
 * after the transaction actually committed. Only a confirmed outcome
 * is ever replayed.
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
	 * failure answers (see the port docs). An outcome that was stored
	 * but never confirmed (non-transactional store, transaction did not
	 * commit) is in-flight, never replayed.
	 */
	claim(ctx: TCtx, key: string, fingerprint: string): Promise<IdempotencyClaim>;

	/**
	 * Stores the outcome for a key this execution claimed, in the same
	 * transaction as the command's writes. On a transactional store the
	 * commit makes it durable and replayable; on a non-transactional
	 * store the outcome is only STAGED until {@link confirm} runs.
	 * Throws `IdempotencyCompletionWithoutClaimError` when no pending
	 * claim exists for the key (a wiring bug in hand-rolled
	 * orchestration).
	 */
	complete(ctx: TCtx, key: string, outcome: unknown): Promise<void>;

	/**
	 * Finalizes a staged outcome AFTER the surrounding transaction
	 * committed. Called by {@link withIdempotentCommit} post-commit on
	 * every fresh execution. A transactional adapter implements this as
	 * a no-op (the commit already finalized the record). Idempotent:
	 * confirming an already-confirmed key is a no-op.
	 */
	confirm(key: string): Promise<void>;

	/**
	 * Releases a claim whose attempt did not commit: a pending claim or
	 * a staged, unconfirmed outcome. Called by
	 * {@link withIdempotentCommit} once per failed attempt, best-effort.
	 * A transactional adapter implements this as a no-op: the rollback
	 * already removed the row, and the method must be SAFE to call when
	 * the commit outcome is unknown; it never releases a confirmed
	 * record.
	 */
	abandon(key: string): Promise<void>;
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
 *     FIRST. A completed previous execution short-circuits: the stored
 *     outcome is returned with `replayed: true`, `fn` never runs, no
 *     aggregate is touched, and no event is re-emitted.
 *  2. On a fresh claim, `fn(ctx, enrollment)` runs as in `withCommit`, then
 *     `store.complete(ctx, key, fn's result)` stores the outcome IN THE
 *     SAME transaction as the aggregate writes and the outbox. Commit
 *     makes command effect, events, and idempotency record durable
 *     atomically. The user-facing enrollment capability is sealed and its
 *     commit-token array is copied before `complete` can yield, so leaked
 *     callback state cannot change the later harvest receipt.
 *  3. After the commit, `store.confirm(key)` finalizes the outcome (a
 *     no-op for transactional stores; the finalize step a
 *     non-transactional store needs to distinguish a committed outcome
 *     from a staged one).
 *  4. When an ATTEMPT fails anywhere inside the transaction (the work,
 *     the harvest guards, the outbox write), the claim taken by that
 *     attempt is released via `store.abandon(key)` BEFORE the error
 *     leaves the transactional region. The release is per attempt, so a
 *     retrying scope's next attempt claims fresh instead of colliding
 *     with the previous attempt's leftover claim.
 *
 * Composes with `RetryingTransactionScope`: a retryable failure inside
 * one attempt releases that attempt's claim, and the retry either
 * executes fresh or, when a concurrent execution completed meanwhile,
 * replays its confirmed outcome. A concurrent duplicate while the first
 * execution is still running surfaces as `IdempotencyInFlightError`
 * (retryable); unwrapped, map it to a conflict/retry-later application
 * outcome.
 *
 * The stored outcome is `fn`'s `result` value; it must be plain,
 * serialisable data (see {@link IdempotencyStore}).
 */
export async function withIdempotentCommit<Evt extends AnyDomainEvent, R, TCtx>(
	deps: WithCommitDeps<Evt, TCtx> & { idempotency: IdempotencyStore<TCtx> },
	request: IdempotentCommitRequest,
	fn: (
		ctx: TCtx,
		enrollment: CommitEnrollment<Evt>,
	) => Promise<WithCommitWorkResult<Evt, R>>,
): Promise<IdempotentCommitResult<R>> {
	const store = deps.idempotency;
	// Per-attempt claim marker. Set by the claim step inside the
	// transactional callback, cleared by the per-attempt release below.
	// A retrying scope re-runs the whole callback, so each attempt gets
	// its own claim/release cycle.
	let attemptClaimed = false;

	// Decorator around the caller's scope: releases the current
	// attempt's claim before an error leaves the transactional region.
	// This is the only place that sees EVERY failure point of one
	// attempt (the work, withCommit's harvest guards, the outbox write),
	// including the ones outside this module's own callback, and it runs
	// INSIDE a retrying scope's loop, so the next attempt starts clean.
	const scope: TransactionScope<TCtx> = {
		transactional: (work, options) =>
			deps.scope.transactional(async (ctx) => {
				try {
					return await work(ctx);
				} catch (error) {
					if (attemptClaimed) {
						attemptClaimed = false;
						try {
							await store.abandon(request.key);
						} catch {
							// Best-effort release: the abandon failure must not
							// mask the attempt's error. Transactional stores
							// release via rollback anyway; a non-transactional
							// store that fails here leaves a claim that the next
							// attempt surfaces as IdempotencyInFlightError.
						}
					}
					throw error;
				}
			}, options),
	};

	const outcome = await withCommit<Evt, IdempotentCommitResult<R>, TCtx>(
		{ ...deps, scope },
		async (ctx, enrollment) => {
			const claim = await store.claim(ctx, request.key, request.fingerprint);
			if (claim.status === "completed") {
				return {
					result: { replayed: true, result: claim.outcome as R },
					commits: [],
				};
			}
			attemptClaimed = true;
			const workEnrollment = scopeWorkEnrollment(enrollment);
			let work: WithCommitWorkResult<Evt, R>;
			try {
				work = await fn(ctx, workEnrollment.enrollment);
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
			await store.complete(ctx, request.key, result);
			return {
				result: { replayed: false, result },
				commits,
			};
		},
	);

	if (!outcome.replayed) {
		// Post-commit finalize: flips a non-transactional store's staged
		// outcome to confirmed so only committed outcomes ever replay.
		// No-op for transactional stores. Runs after the commit, so a
		// throw here must not reject the committed write; the next claim
		// on this key self-heals by treating the stale staged entry as
		// in-flight (retryable) rather than replaying it.
		try {
			await store.confirm(request.key);
		} catch {
			// Swallowed by the same post-commit invariant as withCommit's
			// markPersisted/publish observers: the write has committed.
		}
	}
	return outcome;
}
