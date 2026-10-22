import {
	IdempotencyInFlightError,
	IdempotencyKeyReuseError,
	InMemoryCapacityExceededError,
	idempotencyCompletionWithoutClaimError,
} from "../../../errors/kit-errors";
import { assertPositiveSafeInteger } from "../../../internal/validate";
import type {
	InMemoryTransaction,
	InMemoryTransactionParticipant,
} from "../../../persistence/repository/in-memory-transaction";
import type {
	IdempotencyClaim,
	IdempotencyClaimHandle,
	IdempotencyStore,
} from "../idempotency";

interface PendingEntry {
	readonly fingerprint: string;
	readonly status: "pending";
	readonly token: string;
}

interface CompletedEntry {
	readonly fingerprint: string;
	readonly status: "completed";
	readonly token: string;
	readonly outcome: unknown;
}

type IdempotencyEntry = PendingEntry | CompletedEntry;

export interface InMemoryIdempotencyStoreOptions {
	/** Maximum number of pending and completed records. */
	readonly maxEntries?: number;
}

/**
 * In-memory reference implementation of {@link IdempotencyStore} for
 * finite-lifetime tests and demos. Without `maxEntries`, every completed
 * record remains reachable for the lifetime of the instance. Exhaustion
 * rejects new keys before mutation and never forgets an idempotency decision.
 *
 * The store belongs to the transactional family, so it needs a rollback.
 * Register it with an `InMemoryTransactionScope`, and run `claim` and
 * `complete` inside a transaction of that scope. A rollback then releases
 * the claim, and the commit makes the outcome replayable. A `claim` or
 * `complete` outside such a transaction throws a `TypeError`, because a
 * failed attempt would otherwise block its key.
 *
 * The scope runs one transaction at a time. A duplicate request therefore
 * waits for the first execution and then replays its outcome. A second claim
 * of a pending key inside the same transaction throws
 * `IdempotencyInFlightError`.
 */
export class InMemoryIdempotencyStore<TCtx = unknown>
	implements IdempotencyStore<TCtx>, InMemoryTransactionParticipant
{
	readonly family = "transactional";
	private readonly entries = new Map<string, IdempotencyEntry>();
	/** The entries that `claim` and `complete` replaced in the open transaction. */
	private replacedInTransaction:
		| Array<readonly [string, IdempotencyEntry | undefined]>
		| undefined;
	private readonly maxEntries: number | undefined;
	private tokenGeneration = 0;

	constructor(options: InMemoryIdempotencyStoreOptions = {}) {
		if (options.maxEntries !== undefined) {
			assertPositiveSafeInteger(
				"InMemoryIdempotencyStore",
				"maxEntries",
				options.maxEntries,
			);
		}
		this.maxEntries = options.maxEntries;
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
		this.assertInTransaction("claim");
		const existing = this.entries.get(key);
		if (existing === undefined) return this.createPending(key, fingerprint);
		if (existing.fingerprint !== fingerprint) {
			throw new IdempotencyKeyReuseError({
				key,
				storedFingerprint: existing.fingerprint,
				receivedFingerprint: fingerprint,
			});
		}
		if (existing.status === "pending") {
			throw new IdempotencyInFlightError({ key });
		}
		return {
			status: "completed",
			outcome: structuredClone(existing.outcome),
		};
	}

	async complete(
		_ctx: TCtx,
		claim: IdempotencyClaimHandle,
		outcome: unknown,
	): Promise<void> {
		this.assertInTransaction("complete");
		const { key, token } = claim;
		const existing = this.entries.get(key);
		if (existing?.status !== "pending" || existing.token !== token) {
			throw idempotencyCompletionWithoutClaimError(key);
		}
		this.writeInTransaction(key, {
			fingerprint: existing.fingerprint,
			status: "completed",
			token,
			outcome: structuredClone(outcome),
		});
	}

	/** Test hook: number of stored records in any state. */
	get size(): number {
		return this.entries.size;
	}

	/** Test hook: drops every record. */
	clear(): void {
		this.entries.clear();
	}

	private createPending(key: string, fingerprint: string): IdempotencyClaim {
		if (this.maxEntries !== undefined && this.entries.size >= this.maxEntries) {
			throw new InMemoryCapacityExceededError({
				store: "InMemoryIdempotencyStore",
				resource: "entries",
				limit: this.maxEntries,
				current: this.entries.size,
				attempted: 1,
			});
		}
		this.tokenGeneration += 1;
		const token = `${this.tokenGeneration}:${globalThis.crypto.randomUUID()}`;
		this.writeInTransaction(key, { fingerprint, status: "pending", token });
		return { status: "claimed", claim: Object.freeze({ key, token }) };
	}

	private writeInTransaction(key: string, entry: IdempotencyEntry): void {
		this.replacedInTransaction?.push([key, this.entries.get(key)]);
		this.entries.set(key, entry);
	}

	private assertInTransaction(operation: "claim" | "complete"): void {
		if (this.replacedInTransaction === undefined) {
			throw new TypeError(
				`InMemoryIdempotencyStore.${operation}() ran outside a transaction. ` +
					"Register the store with an InMemoryTransactionScope and run the " +
					"command through that scope, or use InMemoryLeasedIdempotencyStore.",
			);
		}
	}
}
