import { findInCauseChain } from "@shirudo/base-error";
import { KitWiringError, type TransactionScope } from "@shirudo/ddd-kit";
import type { PoolClient, QueryResult } from "pg";
import {
	classifyTransactionFailure,
	PgCommitRolledBackError,
	PgRollbackFailedError,
} from "./pg-errors";
import type { PgQueryExecutor } from "./pg-query-executor";

/** The part of a `pg` `Pool` that the scope uses. */
export interface PgClientPool {
	connect(): Promise<PoolClient>;
}

/** A transaction isolation level of PostgreSQL. */
export type PgIsolationLevel =
	| "read committed"
	| "repeatable read"
	| "serializable";

const BEGIN_STATEMENTS: Readonly<Record<PgIsolationLevel, string>> = {
	"read committed": "BEGIN ISOLATION LEVEL READ COMMITTED",
	"repeatable read": "BEGIN ISOLATION LEVEL REPEATABLE READ",
	serializable: "BEGIN ISOLATION LEVEL SERIALIZABLE",
};

export interface PgTransactionScopeOptions {
	/**
	 * The isolation level of each transaction. Without it, a transaction runs at
	 * the default of the database, `default_transaction_isolation`.
	 */
	readonly isolationLevel?: PgIsolationLevel | undefined;
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
 * The scope destroys the connection after a failed `BEGIN` or `ROLLBACK`, and
 * after a `COMMIT` that PostgreSQL did not answer, because its state is then
 * unknown. An answered `COMMIT` ends the transaction, also with an error.
 *
 * The executor runs statements that start together, for example from
 * `Promise.all`, one after another, in call order. `COMMIT` and `ROLLBACK` wait
 * for the statements that the callback started.
 */
export class PgTransactionScope implements TransactionScope<PgQueryExecutor> {
	private readonly beginStatement: string;

	constructor(
		private readonly pool: PgClientPool,
		options: PgTransactionScopeOptions = {},
	) {
		const { isolationLevel } = options;
		if (isolationLevel === undefined) {
			this.beginStatement = "BEGIN";
		} else if (Object.hasOwn(BEGIN_STATEMENTS, isolationLevel)) {
			this.beginStatement = BEGIN_STATEMENTS[isolationLevel];
		} else {
			throw new RangeError(
				`PgTransactionScope: isolationLevel must be one of ` +
					`${Object.keys(BEGIN_STATEMENTS).join(", ")}, got ${String(isolationLevel)}`,
			);
		}
	}

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
			await session.queryInTurn(this.beginStatement);
			let result: T;
			try {
				result = await fn(session.executor);
			} catch (workFailure) {
				// A statement after this point would run outside the transaction.
				session.close();
				await rollback(session, workFailure);
				transactionEnded = true;
				throw classifyTransactionFailure(workFailure);
			}
			session.close();
			try {
				await commit(session);
			} catch (commitFailure) {
				transactionEnded = answeredByServer(commitFailure);
				throw commitFailure;
			}
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
	session: TransactionSession,
	workFailure: unknown,
): Promise<void> {
	try {
		await session.queryInTurn("ROLLBACK");
	} catch (rollbackFailure) {
		throw new PgRollbackFailedError({ cause: rollbackFailure, workFailure });
	}
}

async function commit(session: TransactionSession): Promise<void> {
	let command: string;
	try {
		({ command } = await session.queryInTurn("COMMIT"));
	} catch (commitFailure) {
		throw classifyTransactionFailure(commitFailure);
	}
	if (command === "ROLLBACK") throw new PgCommitRolledBackError();
}

/** PostgreSQL answered the `COMMIT` with an error, or with the tag `ROLLBACK`. */
function answeredByServer(commitFailure: unknown): boolean {
	return (
		commitFailure instanceof PgCommitRolledBackError ||
		findInCauseChain(commitFailure, isErrorResponse) !== undefined
	);
}

/** An error response of PostgreSQL. A failure of the socket has no severity. */
function isErrorResponse(
	error: unknown,
): error is { readonly code: string; readonly severity: string } {
	const fields = error as
		| { readonly code?: unknown; readonly severity?: unknown }
		| null
		| undefined;
	return (
		typeof fields?.code === "string" && typeof fields.severity === "string"
	);
}

/** The statements of one transaction on its connection. */
interface TransactionSession {
	/** Stops when the transaction ends. */
	readonly executor: PgQueryExecutor;
	/** Runs a statement after the statements before it, also after `close`. */
	queryInTurn(text: string): Promise<QueryResult>;
	close(): void;
}

/**
 * Opens the statements of one transaction. The executor stops when the
 * transaction ends, because the pool can hand the connection to another
 * transaction, and a late statement would then join it.
 *
 * A client runs one statement at a time, and pg deprecates starting a statement
 * while another one runs. So each statement waits for the statement before it.
 * Only the scope has the client, so no other statement can go first.
 */
function openSession(client: PoolClient): TransactionSession {
	let open = true;
	let lastStatement: Promise<unknown> = Promise.resolve();
	const queryInTurn = (text: string, values?: ReadonlyArray<unknown>) => {
		const statement = lastStatement.then(() =>
			client.query(text, values && [...values]),
		);
		// The next statement also waits for a failed statement. It keeps no rows.
		lastStatement = statement.then(
			() => undefined,
			() => undefined,
		);
		return statement;
	};
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
				const { rows } = await queryInTurn(text, values);
				return { rows };
			},
		},
		queryInTurn: (text) => queryInTurn(text),
		close: () => {
			open = false;
		},
	};
}
