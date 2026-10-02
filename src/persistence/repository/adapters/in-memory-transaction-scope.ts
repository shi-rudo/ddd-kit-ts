import { abortReason } from "../../../internal/async/abort";
import type { TransactionalOptions, TransactionScope } from "../scope";

/** The transaction of one in-memory store inside an {@link InMemoryTransactionScope}. */
export interface InMemoryTransaction {
	/** Ends the transaction and keeps its writes. */
	commit(): void;
	/** Ends the transaction and undoes its writes. */
	rollback(): void;
}

/**
 * An in-memory store that can join an {@link InMemoryTransactionScope}. The
 * store records its state when a transaction begins. The transaction that it
 * returns keeps the writes on commit and undoes them on rollback. The store
 * keeps the form of its state to itself.
 */
export interface InMemoryTransactionParticipant {
	beginTransaction(): InMemoryTransaction;
}

const ABORT_MESSAGE = "InMemoryTransactionScope aborted";

const heldParticipants = new WeakSet<InMemoryTransactionParticipant>();

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
 * **Code outside a transaction.** A dispatcher, a deadline processor, and a
 * `hasReached` check run outside the transactions. Outbox `getPending`,
 * deadline `due`, and checkpoint `hasReached` read only committed writes.
 * Other reads also see the writes of an open transaction. Each store decides
 * what its rollback restores, and its documentation says so. A store that
 * restores its whole state also undoes a write that code outside the
 * transaction made while the transaction was open, for example an
 * acknowledgement of an outbox dispatcher. The record is then delivered
 * again, which the at-least-once contract allows.
 *
 * **A store belongs to one scope.** A scope works like one in-memory
 * database, so share one scope for all stores of a test. A second scope with
 * a store that a scope holds already throws at construction: the rollback of
 * one scope would undo a commit of the other.
 *
 * A store that is not registered keeps its own behavior: it does not roll
 * back.
 */
export class InMemoryTransactionScope implements TransactionScope<undefined> {
	private readonly participants: ReadonlyArray<InMemoryTransactionParticipant>;
	private lastTransaction: Promise<void> = Promise.resolve();

	constructor(participants: ReadonlyArray<InMemoryTransactionParticipant>) {
		const listed = new Set<InMemoryTransactionParticipant>();
		for (const [index, participant] of participants.entries()) {
			if (typeof participant?.beginTransaction !== "function") {
				throw new TypeError(
					`InMemoryTransactionScope: participant ${index} has no ` +
						"beginTransaction method.",
				);
			}
			if (heldParticipants.has(participant) || listed.has(participant)) {
				throw new TypeError(
					`InMemoryTransactionScope: participant ${index} already belongs ` +
						"to an InMemoryTransactionScope. Share one scope for all " +
						"in-memory stores.",
				);
			}
			listed.add(participant);
		}
		for (const participant of listed) heldParticipants.add(participant);
		this.participants = [...listed];
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
			const transactions: InMemoryTransaction[] = [];
			let result: T;
			try {
				for (const participant of this.participants) {
					transactions.push(participant.beginTransaction());
				}
				result = await fn(undefined);
			} catch (error) {
				const rollback = endAll([...transactions].reverse(), (transaction) =>
					transaction.rollback(),
				);
				throw rollback.failed ? rollback.failure : error;
			}
			const commit = endAll(transactions, (transaction) =>
				transaction.commit(),
			);
			if (commit.failed) throw commit.failure;
			return result;
		} finally {
			finish();
		}
	}
}

/**
 * Ends every transaction, also after a failed end, and returns the first
 * failure. For a rollback, a scope that rejects with a different error than
 * the work tells `UnitOfWork.run` that the rollback failed.
 */
function endAll(
	transactions: ReadonlyArray<InMemoryTransaction>,
	end: (transaction: InMemoryTransaction) => void,
): {
	readonly failed: boolean;
	readonly failure: unknown;
} {
	let failure: unknown;
	let failed = false;
	for (const transaction of transactions) {
		try {
			end(transaction);
		} catch (error) {
			if (!failed) {
				failure = error;
				failed = true;
			}
		}
	}
	return { failed, failure };
}
