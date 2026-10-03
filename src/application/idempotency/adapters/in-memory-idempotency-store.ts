import {
	IdempotencyClaimLostError,
	IdempotencyCompletionWithoutClaimError,
	IdempotencyInFlightError,
	IdempotencyKeyReuseError,
	InMemoryCapacityExceededError,
} from "../../../errors/kit-errors";
import {
	assertPositiveSafeInteger,
	MAX_TIMER_DELAY_MS,
} from "../../../internal/validate";
import type {
	InMemoryTransaction,
	InMemoryTransactionParticipant,
} from "../../../persistence/repository/in-memory-transaction";
import type {
	IdempotencyClaim,
	IdempotencyClaimHandle,
	IdempotencyLease,
	IdempotencyReconciliation,
	IdempotencyReconciliationDecision,
	IdempotencyStore,
} from "../idempotency";

interface PendingEntry {
	readonly fingerprint: string;
	readonly status: "pending";
	readonly token: string;
	readonly expiresAtMs: number;
}

interface StagedEntry {
	readonly fingerprint: string;
	readonly status: "staged";
	readonly token: string;
	readonly expiresAtMs: number;
	readonly outcome: unknown;
}

interface ConfirmedEntry {
	readonly fingerprint: string;
	readonly status: "confirmed";
	readonly token: string;
	readonly outcome: unknown;
}

type IdempotencyEntry = PendingEntry | StagedEntry | ConfirmedEntry;

export interface InMemoryIdempotencyStoreOptions {
	/** Store-local clock. Durable adapters should prefer server/database time. */
	readonly clock?: () => Date;
	/** Token component source; an internal generation keeps ownership unique. */
	readonly claimTokenFactory?: () => string;
	/** Lease lifetime for pending and staged records. Default: 30 seconds. */
	readonly leaseDurationMs?: number;
	/** Heartbeat delay advertised to the wrapper. Default: half the lease. */
	readonly renewAfterMs?: number;
	/** Maximum number of pending, staged, and confirmed records. */
	readonly maxEntries?: number;
}

const DEFAULT_LEASE_DURATION_MS = 30_000;

function positiveSafeInteger(value: number): boolean {
	return Number.isSafeInteger(value) && value > 0;
}

/**
 * In-memory reference implementation of {@link IdempotencyStore} for
 * finite-lifetime tests and demos. Without `maxEntries`, every confirmed
 * receipt remains reachable for the lifetime of the instance. A long-lived
 * process must configure the limit or use a durable adapter; exhaustion
 * rejects new keys before mutation and never forgets an idempotency decision.
 *
 * On its own, the store is the reference for the leased family: it cannot
 * see commits or rollbacks. Claims and staged outcomes carry bounded leases,
 * while every mutation compares the store-minted token. An expired pending
 * claim may be replaced; an expired staged outcome cannot be guessed away and
 * instead returns `reconciliation-required`. Only an authoritative
 * `committed` / `not-committed` decision can settle it.
 *
 * Register the store with an `InMemoryTransactionScope` for tests that roll
 * back or retry. A rollback then undoes the writes of `claim` and `complete`,
 * which the port runs inside the transaction. It returns each key that they
 * wrote to its earlier entry. The lease operations `renew`, `confirm`,
 * `abandon`, and `reconcile` stay out of band, as the port defines them. A
 * rollback keeps their writes on every other key. A confirmation that
 * arrives after the next transaction began therefore survives the rollback
 * of that transaction.
 */
export class InMemoryIdempotencyStore<TCtx = unknown>
	implements IdempotencyStore<TCtx>, InMemoryTransactionParticipant
{
	private readonly entries = new Map<string, IdempotencyEntry>();
	/** The entries that `claim` and `complete` replaced in the open transaction. */
	private replacedInTransaction:
		| Array<readonly [string, IdempotencyEntry | undefined]>
		| undefined;
	private readonly clock: () => Date;
	private readonly claimTokenFactory: () => string;
	private readonly leaseDurationMs: number;
	private readonly renewAfterMs: number;
	private readonly maxEntries: number | undefined;
	private tokenGeneration = 0;

	constructor(options: InMemoryIdempotencyStoreOptions = {}) {
		this.clock = options.clock ?? (() => new Date());
		this.claimTokenFactory =
			options.claimTokenFactory ?? (() => globalThis.crypto.randomUUID());
		this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
		this.renewAfterMs =
			options.renewAfterMs ?? Math.floor(this.leaseDurationMs / 2);
		if (options.maxEntries !== undefined) {
			assertPositiveSafeInteger(
				"InMemoryIdempotencyStore",
				"maxEntries",
				options.maxEntries,
			);
		}
		this.maxEntries = options.maxEntries;
		if (
			!positiveSafeInteger(this.leaseDurationMs) ||
			this.leaseDurationMs > MAX_TIMER_DELAY_MS
		) {
			throw new RangeError(
				`leaseDurationMs must be a positive safe integer no greater than ${MAX_TIMER_DELAY_MS}`,
			);
		}
		if (
			!positiveSafeInteger(this.renewAfterMs) ||
			this.renewAfterMs >= this.leaseDurationMs ||
			this.renewAfterMs > MAX_TIMER_DELAY_MS
		) {
			throw new RangeError(
				`renewAfterMs must be a positive safe integer below leaseDurationMs and no greater than ${MAX_TIMER_DELAY_MS}`,
			);
		}
	}

	/**
	 * Starts to record the entries that `claim` and `complete` replace. The
	 * rollback restores them in reverse order. It keeps the token generation,
	 * so a token from a rolled-back claim never names a later claim.
	 */
	beginTransaction(): InMemoryTransaction {
		const replaced: Array<readonly [string, IdempotencyEntry | undefined]> = [];
		this.replacedInTransaction = replaced;
		const end = () => {
			if (this.replacedInTransaction === replaced) {
				this.replacedInTransaction = undefined;
			}
		};
		return {
			commit: end,
			rollback: () => {
				for (const [key, entry] of [...replaced].reverse()) {
					if (entry === undefined) this.entries.delete(key);
					else this.entries.set(key, entry);
				}
				end();
			},
		};
	}

	async claim(
		_ctx: TCtx,
		key: string,
		fingerprint: string,
	): Promise<IdempotencyClaim> {
		const now = this.nowMs();
		const existing = this.entries.get(key);
		if (existing === undefined) {
			if (
				this.maxEntries !== undefined &&
				this.entries.size >= this.maxEntries
			) {
				throw new InMemoryCapacityExceededError({
					store: "InMemoryIdempotencyStore",
					resource: "entries",
					limit: this.maxEntries,
					current: this.entries.size,
					attempted: 1,
				});
			}
			return this.createPending(key, fingerprint, now);
		}
		if (existing.fingerprint !== fingerprint) {
			throw new IdempotencyKeyReuseError({
				key,
				storedFingerprint: existing.fingerprint,
				receivedFingerprint: fingerprint,
			});
		}
		if (existing.status === "confirmed") {
			return {
				status: "completed",
				outcome: structuredClone(existing.outcome),
			};
		}
		if (now < existing.expiresAtMs) {
			throw new IdempotencyInFlightError({ key });
		}
		if (existing.status === "staged") {
			return {
				status: "reconciliation-required",
				reconciliation: Object.freeze({
					key,
					fingerprint,
					token: existing.token,
					expiredAt: new Date(existing.expiresAtMs).toISOString(),
				}),
			};
		}
		return this.createPending(key, fingerprint, now);
	}

	async complete(
		_ctx: TCtx,
		claim: IdempotencyClaimHandle,
		outcome: unknown,
	): Promise<void> {
		// The caller's claim and outcome are read and copied once, here. The
		// copy can run caller code, for example a getter that abandons the
		// claim, so it comes before every read of the store state.
		const key = claim.key;
		const token = claim.token;
		const owned = structuredClone(outcome);
		const now = this.nowMs();
		const existing = this.entries.get(key);
		if (existing === undefined) {
			throw new IdempotencyCompletionWithoutClaimError(key);
		}
		if (
			existing.status !== "pending" ||
			existing.token !== token ||
			now >= existing.expiresAtMs
		) {
			throw this.claimLost({ key, token });
		}
		const expiresAtMs = now + this.leaseDurationMs;
		this.lease(expiresAtMs);
		this.writeInTransaction(key, {
			fingerprint: existing.fingerprint,
			status: "staged",
			token: existing.token,
			expiresAtMs,
			outcome: owned,
		});
	}

	async renew(
		claim: IdempotencyClaimHandle,
	): Promise<IdempotencyLease | undefined> {
		const now = this.nowMs();
		const existing = this.entries.get(claim.key);
		if (
			existing === undefined ||
			existing.status === "confirmed" ||
			existing.token !== claim.token ||
			now >= existing.expiresAtMs
		) {
			throw this.claimLost(claim);
		}
		const expiresAtMs = now + this.leaseDurationMs;
		const lease = this.lease(expiresAtMs);
		this.entries.set(claim.key, { ...existing, expiresAtMs });
		return lease;
	}

	async confirm(claim: IdempotencyClaimHandle): Promise<void> {
		const existing = this.entries.get(claim.key);
		if (existing?.status === "staged" && existing.token === claim.token) {
			this.entries.set(claim.key, {
				fingerprint: existing.fingerprint,
				status: "confirmed",
				token: existing.token,
				outcome: existing.outcome,
			});
		}
	}

	async abandon(claim: IdempotencyClaimHandle): Promise<void> {
		const existing = this.entries.get(claim.key);
		if (
			existing !== undefined &&
			existing.status !== "confirmed" &&
			existing.token === claim.token
		) {
			this.entries.delete(claim.key);
		}
	}

	async reconcile(
		reconciliation: IdempotencyReconciliation,
		decision: Exclude<IdempotencyReconciliationDecision, "unknown">,
	): Promise<void> {
		if (decision !== "committed" && decision !== "not-committed") {
			throw new TypeError(
				"reconcile decision must be committed or not-committed; uncertainty must leave the record untouched",
			);
		}
		const existing = this.entries.get(reconciliation.key);
		if (
			existing === undefined ||
			existing.status !== "staged" ||
			existing.token !== reconciliation.token ||
			existing.fingerprint !== reconciliation.fingerprint ||
			new Date(existing.expiresAtMs).toISOString() !==
				reconciliation.expiredAt ||
			this.nowMs() < existing.expiresAtMs
		) {
			throw new IdempotencyClaimLostError({
				key: reconciliation.key,
				token: reconciliation.token,
			});
		}
		if (decision === "committed") {
			this.entries.set(reconciliation.key, {
				fingerprint: existing.fingerprint,
				status: "confirmed",
				token: existing.token,
				outcome: existing.outcome,
			});
			return;
		}
		this.entries.delete(reconciliation.key);
	}

	/** Test hook: number of stored records in any state. */
	get size(): number {
		return this.entries.size;
	}

	/** Test hook: drops every record. */
	clear(): void {
		this.entries.clear();
	}

	private createPending(
		key: string,
		fingerprint: string,
		now: number,
	): IdempotencyClaim {
		const tokenPart = this.claimTokenFactory();
		if (typeof tokenPart !== "string" || tokenPart.length === 0) {
			throw new TypeError("claimTokenFactory must return a non-empty string");
		}
		this.tokenGeneration += 1;
		if (!Number.isSafeInteger(this.tokenGeneration)) {
			throw new RangeError("idempotency claim-token generation exhausted");
		}
		const token = `${this.tokenGeneration}:${tokenPart}`;
		const expiresAtMs = now + this.leaseDurationMs;
		const lease = this.lease(expiresAtMs);
		this.writeInTransaction(key, {
			fingerprint,
			status: "pending",
			token,
			expiresAtMs,
		});
		return {
			status: "claimed",
			claim: Object.freeze({ key, token, lease }),
		};
	}

	private writeInTransaction(key: string, entry: IdempotencyEntry): void {
		this.replacedInTransaction?.push([key, this.entries.get(key)]);
		this.entries.set(key, entry);
	}

	private lease(expiresAtMs: number): IdempotencyLease {
		return Object.freeze({
			expiresAt: new Date(expiresAtMs).toISOString(),
			renewAfterMs: this.renewAfterMs,
		});
	}

	private nowMs(): number {
		const now = this.clock();
		const value = now instanceof Date ? now.getTime() : Number.NaN;
		if (!Number.isFinite(value)) {
			throw new TypeError("idempotency clock must return a valid Date");
		}
		return value;
	}

	private claimLost(claim: IdempotencyClaimHandle): IdempotencyClaimLostError {
		return new IdempotencyClaimLostError({
			key: claim.key,
			token: claim.token,
		});
	}
}
