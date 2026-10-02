import { abortReason } from "../../../internal/async/abort";
import type { TransactionalOptions, TransactionScope } from "../scope";

/** The transaction of one in-memory store inside an {@link InMemoryTransactionScope}. */
export interface InMemoryTransaction {
	/** Returns the store to its state at the start of the transaction. */
	rollback(): void;
}

/**
 * An in-memory store that can join an {@link InMemoryTransactionScope}. The
 * store records its state when a transaction begins, and the transaction it
 * returns restores that state on rollback. The store keeps the form of its
 * state to itself.
 */
export interface InMemoryTransactionParticipant {
	beginTransaction(): InMemoryTransaction;
}

const ABORT_MESSAGE = "InMemoryTransactionScope aborted";

/**
 * A {@link TransactionScope} for tests and demos that gives in-memory stores
 * a rollback. Register every store that the work writes inside the
 * transaction. When the work fails, each registered store returns to its state
 * at the start of the attempt, so a rolled-back write leaves nothing behind,
 * also on the retry of a `RetryingTransactionScope`.
 *
 * **One transaction at a time.** A store cannot tell which of two open
 * transactions a write belongs to, so the scope runs its transactions one
 * after the other, in call order. A transaction that waits inside for another
 * transaction of the same scope to commit therefore never finishes, as with a
 * database that has only one connection. Use a database with real isolation
 * to test concurrent transactions.
 *
 * **The rollback restores the whole store.** A write that the store took
 * outside the transaction while it was open, for example an acknowledgement
 * of an outbox dispatcher, is undone too.
 *
 * A store that is not registered keeps its own behavior: it does not roll
 * back.
 */
export class InMemoryTransactionScope implements TransactionScope<undefined> {
	private readonly participants: ReadonlyArray<InMemoryTransactionParticipant>;
	private lastTransaction: Promise<void> = Promise.resolve();

	constructor(participants: ReadonlyArray<InMemoryTransactionParticipant>) {
		for (const [index, participant] of participants.entries()) {
			if (typeof participant?.beginTransaction !== "function") {
				throw new TypeError(
					`InMemoryTransactionScope: participant ${index} has no ` +
						"beginTransaction method.",
				);
			}
		}
		this.participants = [...participants];
	}

	async transactional<T>(
		fn: (ctx: undefined) => Promise<T>,
		options?: TransactionalOptions,
	): Promise<T> {
		const previous = this.lastTransaction;
		let finish!: () => void;
		this.lastTransaction = new Promise<void>((resolve) => {
			finish = resolve;
		});
		try {
			await previous;
			const signal = options?.signal;
			if (signal?.aborted) throw abortReason(signal, ABORT_MESSAGE);
			const transactions = this.participants.map((participant) =>
				participant.beginTransaction(),
			);
			try {
				return await fn(undefined);
			} catch (error) {
				const rollback = rollBackAll(transactions);
				throw rollback.failed ? rollback.failure : error;
			}
		} finally {
			finish();
		}
	}
}

/**
 * Rolls back every transaction in reverse order, also after a failed
 * rollback, and returns the first failure. A scope that rejects with a
 * different error than the work tells `UnitOfWork.run` that the rollback
 * failed.
 */
function rollBackAll(transactions: ReadonlyArray<InMemoryTransaction>): {
	readonly failed: boolean;
	readonly failure: unknown;
} {
	let failure: unknown;
	let failed = false;
	for (const transaction of [...transactions].reverse()) {
		try {
			transaction.rollback();
		} catch (error) {
			if (!failed) {
				failure = error;
				failed = true;
			}
		}
	}
	return { failed, failure };
}
