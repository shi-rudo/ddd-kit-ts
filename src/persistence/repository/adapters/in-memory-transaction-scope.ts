import { createGlobalCapabilityRegistry } from "../../../domain/aggregate/internal/global-capability-registry";
import {
	abortReason,
	waitRejectingOnAbort,
} from "../../../internal/async/abort";
import type {
	InMemoryTransaction,
	InMemoryTransactionParticipant,
} from "../in-memory-transaction";
import type { TransactionalOptions, TransactionScope } from "../scope";

const ABORT_MESSAGE = "InMemoryTransactionScope aborted";

// The key version stamps the registry shape: participant to the scope that
// registered it. A registry on globalThis lets a scope of another kit copy
// see the registration too.
const { registry: registeredParticipants } =
	createGlobalCapabilityRegistry<InMemoryTransactionScope>(
		Symbol.for("@shirudo/ddd-kit/in-memory-transaction-participants/v1"),
	);

/**
 * A {@link TransactionScope} for tests and demos that gives in-memory stores
 * a rollback. Register every store that the work writes inside the
 * transaction. When the work fails, each registered store undoes the writes
 * of the attempt, so the retry of a `RetryingTransactionScope` does not see
 * them. Each store decides what its rollback undoes, and its documentation
 * says so.
 *
 * **One transaction at a time.** A store cannot tell which of two open
 * transactions a write belongs to. The scope therefore runs its transactions
 * one after the other, in call order. A queued transaction stops its wait
 * when its abort signal fires. Work that waits inside a transaction for
 * another transaction of the same scope never finishes, because the inner
 * transaction waits for the outer one. Only the abort signal of the inner
 * transaction ends that wait. A database with only one connection behaves
 * the same way. Use a database with real isolation to test concurrent
 * transactions.
 *
 * **Code outside a transaction.** A dispatcher, a deadline processor, and a
 * `hasReached` check run outside the transactions. Outbox `getPending`,
 * deadline `due`, and checkpoint `hasReached` read only committed writes.
 * Other reads also see the writes of an open transaction. A store that
 * restores its whole state on rollback also undoes the writes that code
 * outside the transaction made meanwhile. An example is an acknowledgement
 * of an outbox dispatcher. The dispatcher then delivers the record again,
 * which the at-least-once contract allows.
 *
 * **A store belongs to one scope.** A scope works like one in-memory
 * database, so register all stores of a test with one scope. A second scope
 * with a registered store throws at construction, because the rollback of
 * one scope would undo a commit of the other.
 *
 * A store that is not registered keeps its own behavior: it does not roll
 * back.
 */
export class InMemoryTransactionScope implements TransactionScope<undefined> {
	private readonly participants: ReadonlyArray<InMemoryTransactionParticipant>;
	private lastTransaction: Promise<void> = Promise.resolve();

	constructor(participants: ReadonlyArray<InMemoryTransactionParticipant>) {
		const listed = new Map<InMemoryTransactionParticipant, number>();
		for (const [index, participant] of participants.entries()) {
			if (typeof participant?.beginTransaction !== "function") {
				throw new TypeError(
					`InMemoryTransactionScope: participant ${index} has no ` +
						"beginTransaction method.",
				);
			}
			const firstIndex = listed.get(participant);
			if (firstIndex !== undefined) {
				throw new TypeError(
					`InMemoryTransactionScope: participant ${index} repeats ` +
						`participant ${firstIndex}.`,
				);
			}
			if (registeredParticipants.has(participant)) {
				throw new TypeError(
					`InMemoryTransactionScope: participant ${index} already belongs ` +
						"to an InMemoryTransactionScope. Register all in-memory " +
						"stores of a test with one scope.",
				);
			}
			listed.set(participant, index);
		}
		for (const participant of listed.keys()) {
			registeredParticipants.set(participant, this);
		}
		this.participants = [...listed.keys()];
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
		const signal = options?.signal;
		try {
			await waitRejectingOnAbort(previous, signal, ABORT_MESSAGE);
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
			// A transaction that stopped waiting releases its place only after the
			// transaction ahead of it ended, so the queue keeps its order.
			void previous.then(finish);
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
