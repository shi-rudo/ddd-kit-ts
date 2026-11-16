import type { ClientBase, QueryResult } from "pg";

/** The last statement of each client that went through `queryInTurn`. */
const lastStatements = new WeakMap<ClientBase, Promise<unknown>>();

/**
 * Runs a statement on `client` after the statements that went through this
 * function before it. A client runs one statement at a time. pg 8 queues a
 * statement that starts while another one runs, and pg 9 removes that queue. A
 * statement that a caller runs on the client directly does not wait.
 */
export function queryInTurn(
	client: ClientBase,
	text: string,
	values?: ReadonlyArray<unknown>,
): Promise<QueryResult> {
	const previous = lastStatements.get(client) ?? Promise.resolve();
	const statement = previous.then(() =>
		client.query(text, values && [...values]),
	);
	// The next statement also waits for a statement that fails.
	lastStatements.set(
		client,
		statement.catch(() => undefined),
	);
	return statement;
}
