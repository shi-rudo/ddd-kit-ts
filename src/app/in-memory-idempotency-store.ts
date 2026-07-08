import {
	IdempotencyCompletionWithoutClaimError,
	IdempotencyInFlightError,
	IdempotencyKeyReuseError,
} from "../core/errors";
import type { IdempotencyClaim, IdempotencyStore } from "./idempotency";

type IdempotencyEntry =
	| { readonly fingerprint: string; readonly status: "pending" }
	| {
			readonly fingerprint: string;
			readonly status: "staged";
			readonly outcome: unknown;
	  }
	| {
			readonly fingerprint: string;
			readonly status: "confirmed";
			readonly outcome: unknown;
	  };

/**
 * In-memory reference implementation of {@link IdempotencyStore} for
 * tests and single-process applications. Same role as `InMemoryOutbox`
 * and `InMemoryEventStore`: it defines the observable behavior a real
 * adapter must reproduce, not a production store.
 *
 * **Not transaction-aware**, so it leans on the two lifecycle hooks a
 * transactional adapter implements as no-ops: `complete()` only STAGES
 * the outcome, `confirm()` (called by `withIdempotentCommit` after the
 * commit) finalizes it, and `abandon()` (called once per failed
 * attempt) releases a pending or staged entry. Only a confirmed outcome
 * is ever replayed; a claim that meets a staged entry reports in-flight
 * (retryable) rather than replaying an outcome whose transaction never
 * committed.
 *
 * Outcomes are `structuredClone`d on the way in and out, so callers
 * cannot mutate stored state and replayed outcomes never alias each
 * other. Class instances in an outcome are rejected by the clone
 * discipline (plain-data contract, see the port docs).
 */
export class InMemoryIdempotencyStore<TCtx = unknown>
	implements IdempotencyStore<TCtx>
{
	private readonly entries = new Map<string, IdempotencyEntry>();

	async claim(
		_ctx: TCtx,
		key: string,
		fingerprint: string,
	): Promise<IdempotencyClaim> {
		const existing = this.entries.get(key);
		if (existing === undefined) {
			this.entries.set(key, { fingerprint, status: "pending" });
			return { status: "claimed" };
		}
		if (existing.fingerprint !== fingerprint) {
			throw new IdempotencyKeyReuseError({
				key,
				storedFingerprint: existing.fingerprint,
				receivedFingerprint: fingerprint,
			});
		}
		if (existing.status !== "confirmed") {
			// pending: the first execution is still running. staged: an
			// outcome exists but its transaction never confirmed; replaying
			// it would report success for a write that may have rolled
			// back. Both are in-flight for callers; retryable.
			throw new IdempotencyInFlightError({ key });
		}
		return { status: "completed", outcome: structuredClone(existing.outcome) };
	}

	async complete(_ctx: TCtx, key: string, outcome: unknown): Promise<void> {
		const existing = this.entries.get(key);
		if (existing === undefined || existing.status !== "pending") {
			throw new IdempotencyCompletionWithoutClaimError(key);
		}
		this.entries.set(key, {
			fingerprint: existing.fingerprint,
			status: "staged",
			outcome: structuredClone(outcome),
		});
	}

	async confirm(key: string): Promise<void> {
		const existing = this.entries.get(key);
		if (existing?.status === "staged") {
			this.entries.set(key, { ...existing, status: "confirmed" });
		}
		// confirmed: idempotent re-confirm, no-op. pending or missing:
		// no-op as well; the wrapper never produces it, and a hand-rolled
		// orchestration that skipped complete() surfaces at the next
		// claim as in-flight.
	}

	async abandon(key: string): Promise<void> {
		const existing = this.entries.get(key);
		if (existing !== undefined && existing.status !== "confirmed") {
			this.entries.delete(key);
		}
	}

	/** Test hook: number of stored records in any state. */
	get size(): number {
		return this.entries.size;
	}

	/** Test hook: drops every record. */
	clear(): void {
		this.entries.clear();
	}
}
