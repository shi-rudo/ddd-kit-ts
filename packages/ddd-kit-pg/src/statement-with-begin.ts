import * as driver from "pg";
import { PgTransactionNotOpenError } from "./pg-errors";

type StatementCallback = (
	failure: Error | null | undefined,
	result: driver.QueryResult,
) => void;

/**
 * The members of the `Query` of pg that a statement with a `BEGIN` changes.
 * `@types/pg` declares `submit` as a property, and it does not declare
 * `handleCommandComplete`.
 */
interface QueryOfDriver {
	submit(connection: driver.Connection): Error | null;
	handleCommandComplete(message: unknown, connection: driver.Connection): void;
}

type QueryOfDriverClass = new (
	config: { text: string; values: unknown[] },
	callback: StatementCallback,
) => QueryOfDriver;

/**
 * Defines a statement that carries a `BEGIN` in front of it. PostgreSQL gets
 * both before one `Sync`. After an error, PostgreSQL skips each message until
 * the `Sync`, so it does not run the statement when the `BEGIN` fails.
 *
 * The class extends the `Query` of pg, and does not wrap it, because it then
 * inherits each handler that it does not change.
 */
function defineStatementWithBegin(QueryOfDriver: QueryOfDriverClass) {
	return class StatementWithBegin extends QueryOfDriver {
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

		override submit(connection: driver.Connection): Error | null {
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
			connection: driver.Connection,
		): void {
			if (this.#beginConfirmed) {
				super.handleCommandComplete(message, connection);
				return;
			}
			// The first CommandComplete answers the BEGIN. The result of the statement does not hold it.
			this.#beginConfirmed = true;
		}
	};
}

/** A driver that is not pg, under the name of pg, possibly exports no `Query`. */
function queryOfDriver(): QueryOfDriverClass | undefined {
	return driver.Query as unknown as QueryOfDriverClass | undefined;
}

type StatementWithBeginClass = ReturnType<typeof defineStatementWithBegin>;

// A driver without `Query` can load this module, because the class waits for its first use.
let statementWithBeginClass: StatementWithBeginClass | undefined;

/**
 * What PostgreSQL made of a `BEGIN` and the statement behind it. Without a
 * confirmed `BEGIN`, the state of the transaction is unknown, and the statement
 * did not run in it.
 */
export type StatementWithBeginOutcome =
	| {
			readonly beginConfirmed: true;
			readonly statement:
				| { readonly result: driver.QueryResult }
				| { readonly failure: unknown };
	  }
	| { readonly beginConfirmed: false; readonly failure: unknown };

/**
 * Tells if `client` can send a `BEGIN` and a statement in one round trip. Only
 * the JavaScript client of pg can, and only while its `Query` has the handler
 * that the statement with the `BEGIN` changes.
 */
export function canSendStatementWithBegin(
	client: unknown,
): client is driver.Client {
	return (
		typeof driver.Client === "function" &&
		client instanceof driver.Client &&
		typeof client.getTransactionStatus === "function" &&
		typeof queryOfDriver()?.prototype?.handleCommandComplete === "function"
	);
}

/**
 * Sends `begin` and one statement with values to PostgreSQL in one round trip.
 * The statement needs at least one value, because pg sends only such a
 * statement with the extended protocol.
 */
export function sendStatementWithBegin(
	client: driver.Client,
	begin: string,
	text: string,
	values: unknown[],
): Promise<StatementWithBeginOutcome> {
	statementWithBeginClass ??= defineStatementWithBegin(
		queryOfDriver() as QueryOfDriverClass,
	);
	const StatementWithBegin = statementWithBeginClass;
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
				const transactionStatus = client.getTransactionStatus();
				if (transactionStatus !== "T") {
					resolve({
						beginConfirmed: false,
						failure: new PgTransactionNotOpenError({ transactionStatus }),
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
