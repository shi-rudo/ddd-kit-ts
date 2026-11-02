import type { ExecutionContext } from "@shirudo/ddd-kit";
import type { Pool } from "pg";
import type { PgQueryExecutor } from "./pg-query-executor";
import { PgTransactionScope } from "./pg-transaction-scope";
import { rejectOnAbort } from "./reject-on-abort";

/** The parts of a `pg` `Pool` that the poll side uses. */
export type PgPollPool = Pick<Pool, "query" | "connect">;

/**
 * Makes a `pg` pool an executor for statements that need no transaction of the
 * caller, for example the polls of an outbox. Each statement runs on any free
 * connection. A statement with a `context` runs in a short transaction of its
 * own, because a statement timeout needs one: the database cancels the statement
 * at the deadline, so that it cannot hold a connection of the pool.
 */
export function fromPgPool(pool: PgPollPool): PgQueryExecutor {
	return {
		query: async (text, values, context) => {
			if (context === undefined) {
				const { rows } = await pool.query(text, values && [...values]);
				return { rows };
			}
			return inBoundedTransaction(pool, context, async (tx) =>
				tx.query(text, values),
			);
		},
	};
}

/**
 * Runs `work` in a transaction that the deadline of `context` bounds in the
 * database. An abort stops the wait of the caller at once, and the transaction
 * then rolls back at its next step, so that aborted work does not commit.
 */
export function inBoundedTransaction<T>(
	pool: PgPollPool,
	context: ExecutionContext,
	work: (tx: PgQueryExecutor) => Promise<T>,
): Promise<T> {
	context.signal.throwIfAborted();
	return rejectOnAbort(
		new PgTransactionScope(pool).transactional(async (tx) => {
			await setStatementDeadline(tx, context);
			const result = await work(tx);
			context.signal.throwIfAborted();
			return result;
		}),
		context.signal,
	);
}

/** Lets the next statements of the transaction run until the deadline at most. */
export async function setStatementDeadline(
	tx: PgQueryExecutor,
	context: ExecutionContext,
): Promise<void> {
	const remainingMs = Math.max(1, Math.ceil(context.deadlineAt - Date.now()));
	await tx.query("SELECT set_config('statement_timeout', $1, true)", [
		String(remainingMs),
	]);
}
