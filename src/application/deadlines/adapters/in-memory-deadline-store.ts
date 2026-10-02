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
 * deadline as it was at the first write of the transaction. A failure report
 * against that deadline counts its attempts. At the ceiling, `due` stops
 * returning it until the transaction ends. A rollback also undoes an acknowledgement or a failure report
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
	/**
	 * The committed deadline of each address that the open transaction wrote,
	 * captured at its first write. `undefined` marks an address without one.
	 */
	private committedVersions:
		| Map<string, StoredDeadline<TPayload> | undefined>
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
	 * delivery id stays unique. Until the transaction ends, `due` returns the
	 * committed deadline of each address that the transaction writes.
	 */
	beginTransaction(): InMemoryTransaction {
		const pending = [...this.pending].map(
			([key, deadline]) => [key, { ...deadline }] as const,
		);
		const dead = [...this.dead].map(
			([deliveryId, deadline]) => [deliveryId, { ...deadline }] as const,
		);
		const versions = new Map<string, StoredDeadline<TPayload> | undefined>();
		this.committedVersions = versions;
		const end = () => {
			if (this.committedVersions === versions) {
				this.committedVersions = undefined;
			}
		};
		return {
			commit: end,
			rollback: () => {
				this.pending.clear();
				for (const [key, deadline] of pending) {
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
		this.recordCommittedVersion(deadlineAddress);
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
		this.recordCommittedVersion(deadlineAddress);
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

	private recordCommittedVersion(deadlineAddress: string): void {
		const versions = this.committedVersions;
		if (versions === undefined || versions.has(deadlineAddress)) return;
		const committed = this.pending.get(deadlineAddress);
		versions.set(
			deadlineAddress,
			committed === undefined ? undefined : { ...committed },
		);
	}

	/**
	 * The pending deadlines that a processor may see: the live records, except
	 * that an address which the open transaction wrote shows its committed
	 * deadline, if any.
	 */
	private committedPending(): StoredDeadline<TPayload>[] {
		const versions = this.committedVersions;
		if (versions === undefined) return [...this.pending.values()];
		const deadlines = [...this.pending]
			.filter(([deadlineAddress]) => !versions.has(deadlineAddress))
			.map(([, deadline]) => deadline);
		for (const committed of versions.values()) {
			if (committed !== undefined) deadlines.push(committed);
		}
		return deadlines;
	}

	/** The address of the committed deadline with this delivery id, if any. */
	private committedVersionAddress(deliveryId: string): string | undefined {
		for (const [deadlineAddress, committed] of this.committedVersions ?? []) {
			if (committed?.deliveryId === deliveryId) return deadlineAddress;
		}
		return undefined;
	}

	async markDelivered(deliveryIds: ReadonlyArray<string>): Promise<void> {
		for (const deliveryId of deliveryIds) {
			const committedAddress = this.committedVersionAddress(deliveryId);
			if (committedAddress !== undefined) {
				this.committedVersions?.set(committedAddress, undefined);
			}
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
		const committedAddress = this.committedVersionAddress(deliveryId);
		const committed =
			committedAddress === undefined
				? undefined
				: this.committedVersions?.get(committedAddress);
		if (committedAddress !== undefined && committed !== undefined) {
			// The open transaction decides whether this deadline still exists,
			// so the report only counts. At the ceiling, `due` stops returning
			// it until the transaction ends.
			committed.attempts += 1;
			if (error !== undefined) committed.lastError = String(error);
			if (committed.attempts >= this.maxDeliveryAttempts) {
				this.committedVersions?.set(committedAddress, undefined);
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
