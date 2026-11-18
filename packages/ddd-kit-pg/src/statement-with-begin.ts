import { Client, type Connection, Query, type QueryResult } from "pg";

type StatementCallback = (
	failure: Error | null | undefined,
	result: QueryResult,
) => void;

/**
 * The members of the `Query` of pg that {@link StatementWithBegin} changes.
 * `@types/pg` declares `submit` as a property, and it does not declare
 * `handleCommandComplete`.
 */
interface QueryOfDriver {
	submit(connection: Connection): Error | null;
	handleCommandComplete(message: unknown, connection: Connection): void;
}

const QueryOfDriver = Query as unknown as new (
	config: { text: string; values: unknown[] },
	callback: StatementCallback,
) => QueryOfDriver;

/**
 * A statement that carries a `BEGIN` in front of it. PostgreSQL gets both
 * before one `Sync`. After an error, PostgreSQL skips each message until the
 * `Sync`, so it does not run the statement when the `BEGIN` fails.
 *
 * It extends the `Query` of pg, and does not wrap it, because it then inherits
 * each handler that it does not change.
 */
class StatementWithBegin extends QueryOfDriver {
	readonly #begin: string;
	#beginConfirmed = false;

	constructor(
		begin: string,
		text: string,
		values: unknown[],
		callback: StatementCallback,
	) {
		super({ text, values }, callback);
		this.#begin = begin;
	}

	get beginConfirmed(): boolean {
		return this.#beginConfirmed;
	}

	override submit(connection: Connection): Error | null {
		// Not each stream of the driver has `cork`. With it, all messages go out in one write.
		connection.stream.cork?.();
		try {
			// `@types/pg` declares a second parameter that the driver does not read.
			connection.parse({ name: "", text: this.#begin, types: [] }, false);
			connection.bind({}, false);
			connection.execute({}, false);
			return super.submit(connection);
		} finally {
			connection.stream.uncork?.();
		}
	}

	override handleCommandComplete(
		message: unknown,
		connection: Connection,
	): void {
		if (this.#beginConfirmed) {
			super.handleCommandComplete(message, connection);
			return;
		}
		// The first CommandComplete answers the BEGIN. The result of the statement does not hold it.
		this.#beginConfirmed = true;
	}
}

/**
 * What PostgreSQL made of a `BEGIN` and the statement behind it. Without a
 * confirmed `BEGIN`, the state of the transaction is unknown, and the statement
 * did not run in it.
 */
export type StatementWithBeginOutcome =
	| {
			readonly beginConfirmed: true;
			readonly statement:
				| { readonly result: QueryResult }
				| { readonly failure: unknown };
	  }
	| { readonly beginConfirmed: false; readonly failure: unknown };

/**
 * Tells if `client` can send a `BEGIN` and a statement in one round trip. Only
 * the JavaScript client of pg can, and only while its `Query` has the handler
 * that {@link StatementWithBegin} changes.
 */
export function canSendStatementWithBegin(client: unknown): client is Client {
	return (
		client instanceof Client &&
		typeof client.getTransactionStatus === "function" &&
		typeof QueryOfDriver.prototype.handleCommandComplete === "function"
	);
}

/**
 * Sends `begin` and one statement with values to PostgreSQL in one round trip.
 * The statement needs at least one value, because pg sends only such a
 * statement with the extended protocol.
 */
export function sendStatementWithBegin(
	client: Client,
	begin: string,
	text: string,
	values: unknown[],
): Promise<StatementWithBeginOutcome> {
	return new Promise((resolve) => {
		const statement = new StatementWithBegin(
			begin,
			text,
			values,
			(failure, result) => {
				if (failure) {
					resolve(
						statement.beginConfirmed
							? { beginConfirmed: true, statement: { failure } }
							: { beginConfirmed: false, failure },
					);
					return;
				}
				const status = client.getTransactionStatus();
				if (status !== "T") {
					resolve({
						beginConfirmed: false,
						failure: new Error(
							`A BEGIN went to PostgreSQL in front of a statement, and the statement succeeded. ` +
								`The client then reported the transaction status ${JSON.stringify(status)}, and "T" was expected. ` +
								`The statement possibly ran outside of a transaction. ` +
								`The installed version of pg is possibly not compatible with @shirudo/ddd-kit-pg.`,
						),
					});
					return;
				}
				resolve({ beginConfirmed: true, statement: { result } });
			},
		);
		try {
			client.query(statement);
		} catch (failure) {
			resolve({ beginConfirmed: false, failure });
		}
	});
}
