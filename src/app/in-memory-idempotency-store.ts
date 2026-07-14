import {
	IdempotencyClaimLostError,
	IdempotencyCompletionWithoutClaimError,
	IdempotencyInFlightError,
	IdempotencyKeyReuseError,
} from "../core/errors";
import type {
	IdempotencyClaim,
	IdempotencyClaimHandle,
	IdempotencyLease,
	IdempotencyReconciliation,
	IdempotencyReconciliationDecision,
	IdempotencyStore,
} from "./idempotency";

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
}

const DEFAULT_LEASE_DURATION_MS = 30_000;

function positiveSafeInteger(value: number): boolean {
	return Number.isSafeInteger(value) && value > 0;
}

/**
 * In-memory reference implementation of {@link IdempotencyStore} for tests
 * and single-process applications.
 *
 * It is deliberately not transaction-aware. Claims and staged outcomes carry
 * bounded leases, while every mutation compares the store-minted token. An
 * expired pending claim may be replaced; an expired staged outcome cannot be
 * guessed away and instead returns `reconciliation-required`. Only an
 * authoritative `committed` / `not-committed` decision can settle it.
 */
export class InMemoryIdempotencyStore<TCtx = unknown>
	implements IdempotencyStore<TCtx>
{
	private readonly entries = new Map<string, IdempotencyEntry>();
	private readonly clock: () => Date;
	private readonly claimTokenFactory: () => string;
	private readonly leaseDurationMs: number;
	private readonly renewAfterMs: number;
	private tokenGeneration = 0;

	constructor(options: InMemoryIdempotencyStoreOptions = {}) {
		this.clock = options.clock ?? (() => new Date());
		this.claimTokenFactory =
			options.claimTokenFactory ?? (() => globalThis.crypto.randomUUID());
		this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
		this.renewAfterMs =
			options.renewAfterMs ?? Math.floor(this.leaseDurationMs / 2);
		if (
			!positiveSafeInteger(this.leaseDurationMs) ||
			this.leaseDurationMs > 2_147_483_647
		) {
			throw new RangeError(
				"leaseDurationMs must be a positive safe integer no greater than 2147483647",
			);
		}
		if (
			!positiveSafeInteger(this.renewAfterMs) ||
			this.renewAfterMs >= this.leaseDurationMs ||
			this.renewAfterMs > 2_147_483_647
		) {
			throw new RangeError(
				"renewAfterMs must be a positive safe integer below leaseDurationMs and no greater than 2147483647",
			);
		}
	}

	async claim(
		_ctx: TCtx,
		key: string,
		fingerprint: string,
	): Promise<IdempotencyClaim> {
		const now = this.nowMs();
		const existing = this.entries.get(key);
		if (existing === undefined)
			return this.createPending(key, fingerprint, now);
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
		const now = this.nowMs();
		const existing = this.entries.get(claim.key);
		if (existing === undefined) {
			throw new IdempotencyCompletionWithoutClaimError(claim.key);
		}
		if (
			existing.status !== "pending" ||
			existing.token !== claim.token ||
			now >= existing.expiresAtMs
		) {
			throw this.claimLost(claim);
		}
		const expiresAtMs = now + this.leaseDurationMs;
		this.lease(expiresAtMs);
		this.entries.set(claim.key, {
			fingerprint: existing.fingerprint,
			status: "staged",
			token: existing.token,
			expiresAtMs,
			outcome: structuredClone(outcome),
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
		this.entries.set(key, {
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
