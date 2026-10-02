import { InMemoryCapacityExceededError } from "../../../errors/kit-errors";
import {
	assertPositiveInteger,
	assertPositiveSafeInteger,
} from "../../../internal/validate";
import type {
	InMemoryTransaction,
	InMemoryTransactionParticipant,
} from "../../../persistence/repository/in-memory-transaction";
import type {
	DeadLetterDeadline,
	DeadlineStore,
	DueDeadline,
} from "../deadline-store";

/** Construction options for {@link InMemoryDeadlineStore}. */
export interface InMemoryDeadlineStoreOptions {
	/** Maximum records retained across pending and dead-letter states. */
	readonly maxRecords?: number;

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
 * the port's semantics and serves finite-lifetime tests and demos. Without
 * `maxRecords`, pending and dead-letter records are unbounded. A configured
 * limit rejects a new address before mutation; delivery state is never
 * silently evicted.
 *
 * On its own, the store knows nothing about your `TransactionScope`
 * rollbacks: a rolled-back `schedule` or `cancel` stays applied. Register
 * the store with an `InMemoryTransactionScope` for tests that roll back or
 * retry.
 *
 * A processor reads only committed deadlines. While a transaction is open,
 * `due` skips a deadline that the transaction scheduled. For an address that
 * the transaction rescheduled or cancelled, it returns the committed
 * deadline. A rollback also undoes an acknowledgement or a failure report
 * that a processor made while the transaction was open. The processor then
 * delivers that deadline again. For production, prove the transactional half
 * of the contract with `createDeadlineStoreContractTests` and its rollback
 * capability.
 *
 * Payloads are deep-copied on schedule and on delivery
 * (`structuredClone`), so neither side can mutate the other's copy.
 */
export class InMemoryDeadlineStore<TPayload = unknown>
	implements DeadlineStore<TPayload>, InMemoryTransactionParticipant
{
	private readonly pending = new Map<string, StoredDeadline<TPayload>>();
	/** Keyed by deliveryId: several incarnations of one address can be dead. */
	private readonly dead = new Map<string, StoredDeadline<TPayload>>();
	private readonly maxDeliveryAttempts: number;
	private readonly maxRecords: number | undefined;
	private nextSequence = 0;
	/** The pending deadlines at the start of the open transaction, and the addresses it wrote. */
	private openTransaction:
		| {
				readonly committed: ReadonlyMap<string, StoredDeadline<TPayload>>;
				readonly written: Set<string>;
		  }
		| undefined;

	constructor(options: InMemoryDeadlineStoreOptions = {}) {
		const max = options.maxDeliveryAttempts ?? 5;
		assertPositiveInteger("InMemoryDeadlineStore", "maxDeliveryAttempts", max);
		this.maxDeliveryAttempts = max;
		if (options.maxRecords !== undefined) {
			assertPositiveSafeInteger(
				"InMemoryDeadlineStore",
				"maxRecords",
				options.maxRecords,
			);
		}
		this.maxRecords = options.maxRecords;
	}

	/**
	 * Records the state that a rollback of an `InMemoryTransactionScope`
	 * returns to: the pending and the dead-letter records. The rollback
	 * keeps the sequence counter, as a database sequence does, so a
	 * delivery id stays unique. Until the transaction ends, `due` reads the
	 * recorded deadline of each address that the transaction writes. Only an
	 * `InMemoryTransactionScope` calls this method.
	 */
	beginTransaction(): InMemoryTransaction {
		const committed = new Map(
			[...this.pending].map(
				([key, deadline]) => [key, { ...deadline }] as const,
			),
		);
		const dead = [...this.dead].map(
			([deliveryId, deadline]) => [deliveryId, { ...deadline }] as const,
		);
		const transaction = { committed, written: new Set<string>() };
		this.openTransaction = transaction;
		const end = () => {
			if (this.openTransaction === transaction) {
				this.openTransaction = undefined;
			}
		};
		return {
			commit: end,
			rollback: () => {
				this.pending.clear();
				for (const [key, deadline] of committed) {
					this.pending.set(key, { ...deadline });
				}
				this.dead.clear();
				for (const [deliveryId, deadline] of dead) {
					this.dead.set(deliveryId, { ...deadline });
				}
				end();
			},
		};
	}

	async schedule(deadline: {
		scope: string;
		key: string;
		dueAt: Date;
		payload: TPayload;
	}): Promise<void> {
		const deadlineAddress = address(deadline.scope, deadline.key);
		if (
			!this.pending.has(deadlineAddress) &&
			this.maxRecords !== undefined &&
			this.pending.size + this.dead.size >= this.maxRecords
		) {
			throw new InMemoryCapacityExceededError({
				store: "InMemoryDeadlineStore",
				resource: "records",
				limit: this.maxRecords,
				current: this.pending.size + this.dead.size,
				attempted: 1,
			});
		}
		const sequence = this.nextSequence++;
		const deliveryId = `deadline-${sequence}`;
		this.openTransaction?.written.add(deadlineAddress);
		// Replacing an occupied address gets a FRESH incarnation: a late
		// ack or failure report against the old deliveryId must not touch
		// the successor.
		this.pending.set(deadlineAddress, {
			deliveryId,
			scope: deadline.scope,
			key: deadline.key,
			dueAt: new Date(deadline.dueAt),
			payload: structuredClone(deadline.payload),
			attempts: 0,
			sequence,
		});
	}

	async cancel(scope: string, key: string): Promise<void> {
		const deadlineAddress = address(scope, key);
		this.openTransaction?.written.add(deadlineAddress);
		this.pending.delete(deadlineAddress);
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
		return this.committedPending()
			.filter((deadline) => deadline.dueAt.getTime() <= now.getTime())
			.sort(
				(a, b) =>
					a.dueAt.getTime() - b.dueAt.getTime() || a.sequence - b.sequence,
			)
			.slice(0, limit)
			.map((deadline) => toRecord(deadline));
	}

	/**
	 * The pending deadlines that a processor may see: the live records, except
	 * that an address which the open transaction wrote shows its committed
	 * record, if any.
	 */
	private committedPending(): StoredDeadline<TPayload>[] {
		const transaction = this.openTransaction;
		if (transaction === undefined) return [...this.pending.values()];
		const deadlines = [...this.pending]
			.filter(([deadlineAddress]) => !transaction.written.has(deadlineAddress))
			.map(([, deadline]) => deadline);
		for (const deadlineAddress of transaction.written) {
			const committed = transaction.committed.get(deadlineAddress);
			if (committed !== undefined) deadlines.push(committed);
		}
		return deadlines;
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

	async markFailed(
		deliveryId: string,
		error?: unknown,
	): Promise<DeadLetterDeadline<TPayload> | undefined> {
		for (const [key, deadline] of this.pending) {
			if (deadline.deliveryId !== deliveryId) continue;
			deadline.attempts += 1;
			// An errorless report must not erase an earlier recorded reason.
			if (error !== undefined) deadline.lastError = String(error);
			if (deadline.attempts >= this.maxDeliveryAttempts) {
				this.pending.delete(key);
				this.dead.set(deadline.deliveryId, deadline);
				return toDeadLetter(deadline);
			}
			return undefined;
		}
		// Unknown, delivered, replaced, or already dead-lettered: a late
		// report must not resurrect or advance anything.
		return undefined;
	}

	async deadLetters(): Promise<ReadonlyArray<DeadLetterDeadline<TPayload>>> {
		return [...this.dead.values()]
			.sort((a, b) => a.sequence - b.sequence)
			.map(toDeadLetter);
	}
}

function toDeadLetter<TPayload>(
	deadline: StoredDeadline<TPayload>,
): DeadLetterDeadline<TPayload> {
	return {
		...toRecord(deadline),
		...(deadline.lastError === undefined
			? {}
			: { lastError: deadline.lastError }),
	};
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
