import { KitWiringError, type TransactionScope } from "@shirudo/ddd-kit";
import type { PoolClient } from "pg";
import {
	classifyTransactionFailure,
	PgCommitRolledBackError,
	PgRollbackFailedError,
} from "./pg-errors";
import { fromPg, type PgQueryExecutor } from "./pg-query-executor";

/** The part of a `pg` `Pool` that the scope uses. */
export interface PgClientPool {
	connect(): Promise<PoolClient>;
}

/**
 * A transaction on one connection of a `pg` pool. The callback receives the
 * executor of that transaction. The scope commits when the callback resolves
 * and rolls back when it rejects.
 *
 * A work failure reaches the caller unchanged, or as a
 * `PgRetryableTransactionFailureError` for a serialization failure or a
 * deadlock. A failed `ROLLBACK` reaches the caller as a
 * `PgRollbackFailedError`, which names both failures. `UnitOfWork` reports it as
 * a `RollbackError`.
 *
 * The scope destroys the connection after a failed `BEGIN`, `ROLLBACK`, or
 * `COMMIT`, because its state is then unknown.
 */
export class PgTransactionScope implements TransactionScope<PgQueryExecutor> {
	constructor(private readonly pool: PgClientPool) {}

	async transactional<T>(fn: (ctx: PgQueryExecutor) => Promise<T>): Promise<T> {
		const client = await this.pool.connect();
		// A checked-out client has no pool listener, and an unhandled "error"
		// event of a lost connection ends the process.
		let connectionLost = false;
		const onConnectionError = () => {
			connectionLost = true;
		};
		client.on("error", onConnectionError);
		const session = openSession(client);
		let transactionEnded = false;
		try {
			await client.query("BEGIN");
			let result: T;
			try {
				result = await fn(session.executor);
			} catch (workFailure) {
				// A statement after this point would run outside the transaction.
				session.close();
				await rollback(client, workFailure);
				transactionEnded = true;
				throw classifyTransactionFailure(workFailure);
			}
			session.close();
			await commit(client);
			transactionEnded = true;
			return result;
		} finally {
			session.close();
			client.off("error", onConnectionError);
			client.release(!transactionEnded || connectionLost);
		}
	}
}

async function rollback(
	client: PoolClient,
	workFailure: unknown,
): Promise<void> {
	try {
		await client.query("ROLLBACK");
	} catch (rollbackFailure) {
		throw new PgRollbackFailedError({ cause: rollbackFailure, workFailure });
	}
}

async function commit(client: PoolClient): Promise<void> {
	let command: string;
	try {
		({ command } = await client.query("COMMIT"));
	} catch (commitFailure) {
		throw classifyTransactionFailure(commitFailure);
	}
	if (command === "ROLLBACK") throw new PgCommitRolledBackError();
}

/**
 * An executor that stops when its transaction ends. The pool can hand the
 * connection to another transaction, and a late statement would then join it.
 */
function openSession(client: PoolClient): {
	readonly executor: PgQueryExecutor;
	close(): void;
} {
	const connection = fromPg(client);
	let open = true;
	return {
		executor: {
			query: async (text, values) => {
				if (!open) {
					throw new KitWiringError({
						code: "TRANSACTION_CLOSED",
						message:
							"A PgQueryExecutor ran a statement after its transaction ended. " +
							"Await all work inside the callback of transactional, and do " +
							"not keep the executor.",
						details: { operation: "PgQueryExecutor.query" },
					});
				}
				return connection.query(text, values);
			},
		},
		close: () => {
			open = false;
		},
	};
}
