import type { ClientBase, QueryResult } from "pg";

/** The last statement that each client received. */
const lastStatements = new WeakMap<ClientBase, Promise<unknown>>();

/**
 * Runs a statement on `client` after the statements that the client received
 * before it. A client runs one statement at a time. pg 8 queues a statement that
 * starts while another one runs, and pg 9 removes that queue.
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
