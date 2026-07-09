import { assertPositiveInteger } from "../utils/validate";
import type {
	DeadLetterDeadline,
	DeadlineStore,
	DueDeadline,
} from "./deadline-store";

/** Construction options for {@link InMemoryDeadlineStore}. */
export interface InMemoryDeadlineStoreOptions {
	/**
	 * How many failed delivery attempts move a deadline to the
	 * dead-letter set. Default `5`.
	 */
	maxDeliveryAttempts?: number;
}

interface StoredDeadline<TPayload> {
	deliveryId: string;
	scope: string;
	key: string;
	dueAt: Date;
	payload: TPayload;
	attempts: number;
	/** Monotonic tie-breaker: scheduling order for equal due times. */
	sequence: number;
	lastError?: string;
}

/**
 * In-memory reference implementation of {@link DeadlineStore}: defines
 * the port's semantics and serves tests and single-process demos.
 *
 * **Not transaction-aware**, the same documented limitation as the
 * other in-memory references: a rolled-back `schedule` or `cancel`
 * stays applied here. The transactional half of the contract is the
 * SQL adapter's job; prove it with `createDeadlineStoreContractTests`
 * and its rollback capability.
 *
 * Payloads are deep-copied on schedule and on delivery
 * (`structuredClone`), so neither side can mutate the other's copy.
 */
export class InMemoryDeadlineStore<TPayload = unknown>
	implements DeadlineStore<TPayload>
{
	private readonly pending = new Map<string, StoredDeadline<TPayload>>();
	/** Keyed by deliveryId: several incarnations of one address can be dead. */
	private readonly dead = new Map<string, StoredDeadline<TPayload>>();
	private readonly maxDeliveryAttempts: number;
	private nextSequence = 0;

	constructor(options: InMemoryDeadlineStoreOptions = {}) {
		const max = options.maxDeliveryAttempts ?? 5;
		assertPositiveInteger("InMemoryDeadlineStore", "maxDeliveryAttempts", max);
		this.maxDeliveryAttempts = max;
	}

	async schedule(deadline: {
		scope: string;
		key: string;
		dueAt: Date;
		payload: TPayload;
	}): Promise<void> {
		const sequence = this.nextSequence++;
		// Replacing an occupied address gets a FRESH incarnation: a late
		// ack or failure report against the old deliveryId must not touch
		// the successor.
		this.pending.set(address(deadline.scope, deadline.key), {
			deliveryId: `deadline-${sequence}`,
			scope: deadline.scope,
			key: deadline.key,
			dueAt: new Date(deadline.dueAt),
			payload: structuredClone(deadline.payload),
			attempts: 0,
			sequence,
		});
	}

	async cancel(scope: string, key: string): Promise<void> {
		this.pending.delete(address(scope, key));
	}

	async due(
		now: Date,
		limit: number,
	): Promise<ReadonlyArray<DueDeadline<TPayload>>> {
		if (!Number.isInteger(limit) || limit < 0) {
			throw new Error(
				`InMemoryDeadlineStore: limit must be an integer >= 0, got ${limit}`,
			);
		}
		// "Up to limit": zero is a legal page size and yields an empty page
		// (a loop computing capacity - inFlight may legitimately pass it).
		if (limit === 0) return [];
		return [...this.pending.values()]
			.filter((deadline) => deadline.dueAt.getTime() <= now.getTime())
			.sort(
				(a, b) =>
					a.dueAt.getTime() - b.dueAt.getTime() || a.sequence - b.sequence,
			)
			.slice(0, limit)
			.map((deadline) => toRecord(deadline));
	}

	async markDelivered(deliveryIds: ReadonlyArray<string>): Promise<void> {
		for (const deliveryId of deliveryIds) {
			this.dead.delete(deliveryId);
			for (const [key, deadline] of this.pending) {
				if (deadline.deliveryId === deliveryId) {
					this.pending.delete(key);
					break; // deliveryIds are unique; nothing more to find
				}
			}
		}
	}

	async markFailed(deliveryId: string, error?: unknown): Promise<void> {
		for (const [key, deadline] of this.pending) {
			if (deadline.deliveryId !== deliveryId) continue;
			deadline.attempts += 1;
			// An errorless report must not erase an earlier recorded reason.
			if (error !== undefined) deadline.lastError = String(error);
			if (deadline.attempts >= this.maxDeliveryAttempts) {
				this.pending.delete(key);
				this.dead.set(deadline.deliveryId, deadline);
			}
			return;
		}
		// Unknown, delivered, replaced, or already dead-lettered: a late
		// report must not resurrect or advance anything.
	}

	async deadLetters(): Promise<ReadonlyArray<DeadLetterDeadline<TPayload>>> {
		return [...this.dead.values()]
			.sort((a, b) => a.sequence - b.sequence)
			.map((deadline) => ({
				...toRecord(deadline),
				...(deadline.lastError === undefined
					? {}
					: { lastError: deadline.lastError }),
			}));
	}
}

function toRecord<TPayload>(
	deadline: StoredDeadline<TPayload>,
): DueDeadline<TPayload> {
	return {
		deliveryId: deadline.deliveryId,
		scope: deadline.scope,
		key: deadline.key,
		dueAt: new Date(deadline.dueAt),
		payload: structuredClone(deadline.payload),
		attempts: deadline.attempts,
	};
}

/** NUL-separated so no scope/key concatenation can collide. */
function address(scope: string, key: string): string {
	return `${scope}\u0000${key}`;
}
