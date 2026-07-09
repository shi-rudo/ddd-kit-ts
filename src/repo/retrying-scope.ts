import { someChainRetryable } from "@shirudo/base-error";
import { abortReason } from "../utils/abort";
import { computeBackoffDelay } from "../utils/backoff";
import { reportToObserver } from "../utils/observer";
import { sleepRejectingOnAbort } from "../utils/sleep";
import {
	assertNonNegativeFinite,
	assertPositiveInteger,
} from "../utils/validate";
import type { TransactionalOptions, TransactionScope } from "./scope";

/**
 * Tuning for {@link RetryingTransactionScope}. All fields are optional;
 * the defaults suit optimistic-concurrency retries (a handful of writers
 * racing one aggregate), not high-fan-out hot-row contention.
 */
export interface RetryPolicy {
	/** Total tries, including the first. Default `3` (1 initial + 2 retries). */
	maxAttempts?: number;
	/** First backoff delay; doubles each retry. Default `50`ms. */
	baseDelayMs?: number;
	/** Ceiling for the backoff delay. Default `1000`ms. */
	maxDelayMs?: number;
	/**
	 * Classifier deciding whether an error is worth retrying. Default
	 * {@link someChainRetryable} (walks the cause chain for the loose
	 * `retryable === true` marker, so `ConcurrencyConflictError` matches
	 * even when an adapter wraps it). Override to add driver-specific
	 * serialization codes (Postgres 40001, MySQL 1213, SQLite SQLITE_BUSY)
	 * that your adapter has not mapped to a retryable kit error.
	 *
	 * Guarded like `onRetry`: a THROWING classifier counts as "not
	 * retryable" and the transaction's ORIGINAL error surfaces, never the
	 * classifier's own failure.
	 */
	isRetryable?: (error: unknown) => boolean;
	/**
	 * Observer fired before each backoff wait (logging / metrics).
	 * Neutralised like the `withCommit` observers: a synchronous throw or
	 * an async rejection is swallowed, so a buggy observer can neither
	 * abort the retry loop nor mask the original retryable error.
	 */
	onRetry?: (info: {
		attempt: number;
		error: unknown;
		delayMs: number;
	}) => void;
	/** Backoff wait. Default an abortable `setTimeout`. Injectable for tests. */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	/** Jitter source in `[0, 1)`. Default `Math.random`. Injectable for tests. */
	random?: () => number;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 50;
const DEFAULT_MAX_DELAY_MS = 1000;

const ABORT_MESSAGE = "RetryingTransactionScope aborted";

/** Abortable `setTimeout`; rejects with the signal reason if aborted. */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return sleepRejectingOnAbort(ms, signal, ABORT_MESSAGE);
}

/**
 * A {@link TransactionScope} that retries its inner scope on transient
 * failures with exponential backoff and jitter. Compose it transparently:
 *
 * ```ts
 * const scope = new RetryingTransactionScope(drizzleScope, { maxAttempts: 5 });
 * const uow = new UnitOfWork({ scope, outbox, repositories });
 * ```
 *
 * **Retries the transaction only.** Each attempt re-invokes the inner
 * `transactional` with a fresh transaction, so the work callback must be
 * reload-safe (load aggregates via `findById` inside it, never capture an
 * aggregate from a previous attempt) and free of non-transactional side
 * effects before commit. `withCommit` publishes AFTER the commit, so the
 * in-process publish is outside the retried region and never duplicated;
 * publish failures are handled by `onPublishError`, not retried here.
 *
 * **Classification is by error, not by guesswork.** Only errors the
 * `isRetryable` predicate accepts are retried; everything else (a
 * `DomainError`, `EventHarvestError`, `UnenrolledChangesError`,
 * `DuplicateAggregateError`, a non-Error throw) surfaces immediately.
 * After `maxAttempts` the last error is rethrown unchanged, so a caller
 * can still match `ConcurrencyConflictError` and map it to HTTP 409.
 *
 * **Cancellation.** The `AbortSignal` from `transactional` options is
 * checked before each attempt and aborts the backoff wait, so an
 * `AbortSignal.timeout(ms)` bounds total elapsed time (there is
 * deliberately no separate max-elapsed knob).
 */
export class RetryingTransactionScope<TCtx> implements TransactionScope<TCtx> {
	// Policy resolved and validated once at construction (a misconfigured
	// policy is a wiring bug and fails fast, never at run time).
	private readonly maxAttempts: number;
	private readonly baseDelayMs: number;
	private readonly maxDelayMs: number;
	private readonly isRetryable: (error: unknown) => boolean;
	private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
	private readonly random: () => number;
	private readonly onRetry?: RetryPolicy["onRetry"];

	constructor(
		private readonly inner: TransactionScope<TCtx>,
		policy: RetryPolicy = {},
	) {
		this.maxAttempts = policy.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
		this.baseDelayMs = policy.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
		this.maxDelayMs = policy.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
		assertPositiveInteger(
			"RetryingTransactionScope",
			"maxAttempts",
			this.maxAttempts,
		);
		assertNonNegativeFinite(
			"RetryingTransactionScope",
			"baseDelayMs",
			this.baseDelayMs,
		);
		assertNonNegativeFinite(
			"RetryingTransactionScope",
			"maxDelayMs",
			this.maxDelayMs,
		);
		this.isRetryable = policy.isRetryable ?? someChainRetryable;
		this.sleep = policy.sleep ?? defaultSleep;
		this.random = policy.random ?? Math.random;
		this.onRetry = policy.onRetry;
	}

	async transactional<T>(
		fn: (ctx: TCtx) => Promise<T>,
		options?: TransactionalOptions,
	): Promise<T> {
		const { maxAttempts, isRetryable, sleep } = this;
		const signal = options?.signal;
		const isRetryableSafe = (error: unknown): boolean => {
			try {
				return isRetryable(error);
			} catch {
				return false;
			}
		};

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			if (signal?.aborted) {
				throw abortReason(signal, ABORT_MESSAGE);
			}
			try {
				return await this.inner.transactional(fn, options);
			} catch (error) {
				// Exhausted, or a failure retrying cannot fix: surface it
				// unchanged so the caller keeps the original error type.
				// The classifier itself is guarded like the onRetry observer
				// below: a throwing classifier (a custom predicate bug, or
				// the default someChainRetryable on a circular cause chain)
				// must not replace the transaction's failure, so its throw
				// counts as "not retryable" and the ORIGINAL error surfaces.
				if (attempt === maxAttempts || !isRetryableSafe(error)) {
					throw error;
				}
				const delayMs = computeBackoffDelay(attempt, {
					baseDelayMs: this.baseDelayMs,
					maxDelayMs: this.maxDelayMs,
					random: this.random,
				});
				// Observer only: a throwing or async-rejecting onRetry must
				// neither abort the retry loop nor mask the original error.
				reportToObserver(() => this.onRetry?.({ attempt, error, delayMs }));
				// An abort during the wait rejects out of the loop with the
				// signal reason: cancellation wins over another attempt.
				await sleep(delayMs, signal);
			}
		}
		// Unreachable: the loop either returns or throws on the last attempt.
		throw new Error("RetryingTransactionScope: exhausted without result");
	}
}
