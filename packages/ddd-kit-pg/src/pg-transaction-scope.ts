import { findInCauseChain } from "@shirudo/base-error";
import { KitWiringError, type TransactionScope } from "@shirudo/ddd-kit";
import type { PoolClient, QueryResult } from "pg";
import {
	classifyTransactionFailure,
	PgCommitRolledBackError,
	PgRollbackFailedError,
} from "./pg-errors";
import type { PgQueryExecutor } from "./pg-query-executor";
import {
	canSendStatementWithBegin,
	sendStatementWithBegin,
} from "./statement-with-begin";

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
 * The scope sends the `BEGIN` when the callback runs its first statement. If
 * that statement has values and the client is the JavaScript client of pg, the
 * `BEGIN` and the statement go to PostgreSQL in one round trip. For a callback
 * that runs no statement, the scope takes a connection and sends no statement.
 *
 * The scope destroys the connection after a `BEGIN` that PostgreSQL did not
 * confirm, after a failed `ROLLBACK`, and after a `COMMIT` that PostgreSQL did
 * not answer, because its state is then unknown. An answered `COMMIT` ends the
 * transaction, also with an error. After a `BEGIN` without confirmation, each
 * statement of the callback rejects with the failure of the `BEGIN`. A callback
 * that caught that failure and resolves makes the scope reject with it.
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
		const session = openSession(client, this.beginStatement);
		// No transaction is open on the connection, and its state is known.
		let connectionClean = false;
		try {
			let result: T;
			try {
				result = await fn(session.executor);
			} catch (workFailure) {
				// A statement after this point would run outside the transaction.
				session.close();
				const begin = await session.settledBegin();
				if (begin.status === "confirmed") await rollback(session, workFailure);
				connectionClean = begin.status !== "not confirmed";
				throw classifyTransactionFailure(workFailure);
			}
			session.close();
			const begin = await session.settledBegin();
			// The callback caught the failure of the BEGIN, and nothing can commit.
			if (begin.status === "not confirmed") throw begin.failure;
			if (begin.status === "confirmed") {
				try {
					await commit(session);
				} catch (commitFailure) {
					connectionClean = answeredByServer(commitFailure);
					throw commitFailure;
				}
			}
			connectionClean = true;
			return result;
		} finally {
			session.close();
			client.off("error", onConnectionError);
			client.release(!connectionClean || connectionLost);
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
	/**
	 * Waits for the statements that the callback started, then tells what became
	 * of the `BEGIN`. No `BEGIN` goes to PostgreSQL without a statement.
	 */
	settledBegin(): Promise<Begin>;
	/** Runs a statement after the statements before it, also after `close`. */
	queryInTurn(text: string): Promise<QueryResult>;
	close(): void;
}

type Begin =
	| { readonly status: "not sent" }
	| { readonly status: "confirmed" }
	| { readonly status: "not confirmed"; readonly failure: unknown };

/**
 * Opens the statements of one transaction. The executor stops when the
 * transaction ends, because the pool can hand the connection to another
 * transaction, and a late statement would then join it.
 *
 * A client runs one statement at a time, and pg deprecates starting a statement
 * while another one runs. So each statement waits for the statement before it.
 * Only the scope has the client, so no other statement can go first.
 *
 * The `BEGIN` goes to PostgreSQL with the first statement, or before it.
 */
function openSession(
	client: PoolClient,
	beginStatement: string,
): TransactionSession {
	let open = true;
	let begin: Begin = { status: "not sent" };
	let lastStatement: Promise<unknown> = Promise.resolve();

	const inTurn = <R>(send: () => Promise<R>): Promise<R> => {
		const statement = lastStatement.then(send);
		// The next statement also waits for a failed statement. It keeps no rows.
		lastStatement = statement.then(
			() => undefined,
			() => undefined,
		);
		return statement;
	};

	const failBegin = (failure: unknown): never => {
		begin = { status: "not confirmed", failure };
		throw failure;
	};

	const sendWithBegin = async (
		text: string,
		values: unknown[] | undefined,
	): Promise<QueryResult> => {
		if (values?.length && canSendStatementWithBegin(client)) {
			const outcome = await sendStatementWithBegin(
				client,
				beginStatement,
				text,
				values,
			);
			if (!outcome.beginConfirmed) return failBegin(outcome.failure);
			begin = { status: "confirmed" };
			if ("failure" in outcome.statement) throw outcome.statement.failure;
			return outcome.statement.result;
		}
		await client.query(beginStatement).catch(failBegin);
		begin = { status: "confirmed" };
		return client.query(text, values);
	};

	const send = async (
		text: string,
		values: unknown[] | undefined,
	): Promise<QueryResult> => {
		// A statement after a BEGIN without confirmation would commit at once.
		if (begin.status === "not confirmed") throw begin.failure;
		if (begin.status === "not sent") return sendWithBegin(text, values);
		return client.query(text, values);
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
				const { rows } = await inTurn(() => send(text, values && [...values]));
				return { rows };
			},
		},
		settledBegin: async () => {
			await lastStatement;
			return begin;
		},
		queryInTurn: (text) => inTurn(() => client.query(text)),
		close: () => {
			open = false;
		},
	};
}
