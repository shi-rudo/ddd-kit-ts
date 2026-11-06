import type { ExecutionContext } from "@shirudo/ddd-kit";
import type { ClientBase } from "pg";

/** The result of one statement. Use `RETURNING` to count the changed rows. */
export interface PgQueryResult<Row> {
	readonly rows: ReadonlyArray<Row>;
}

/**
 * The seam between an adapter and its connection. An adapter owns no
 * connection: it runs every statement on the executor of the caller, so the
 * statement joins the transaction of the caller.
 *
 * If a port requires a transactional write, the caller must pass an executor of
 * an open transaction. An executor must reject with the original driver error,
 * because an adapter reads the SQLSTATE of that error.
 *
 * `context` bounds a statement of the poll side. `fromPgPool` cancels the
 * statement in the database at the deadline. `fromPg` ignores `context`, because
 * its statement belongs to the transaction of the caller.
 */
export interface PgQueryExecutor {
	query<Row = Record<string, unknown>>(
		text: string,
		values?: ReadonlyArray<unknown>,
		context?: ExecutionContext,
	): Promise<PgQueryResult<Row>>;
}

/**
 * Makes a `pg` client an executor. The parameter excludes a `Pool`, because a
 * pool runs each statement on any free connection and cannot hold a transaction.
 */
export function fromPg(client: ClientBase): PgQueryExecutor {
	return {
		query: async (text, values) => {
			const { rows } = await client.query(text, values && [...values]);
			return { rows };
		},
	};
}
