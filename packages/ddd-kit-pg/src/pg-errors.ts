import { findInCauseChain } from "@shirudo/base-error";
import { InfrastructureError } from "@shirudo/ddd-kit";

/** PostgreSQL ended the transaction, and a new transaction can succeed. */
const RETRYABLE_SQLSTATES: ReadonlySet<string> = new Set([
	"40001", // serialization_failure
	"40P01", // deadlock_detected
]);

/**
 * PostgreSQL rolled back the transaction because of a serialization failure or
 * a deadlock. `RetryingTransactionScope` retries this error by default. The
 * driver error is the `cause`.
 */
export class PgRetryableTransactionFailureError extends InfrastructureError<"PG_RETRYABLE_TRANSACTION_FAILURE"> {
	readonly sqlState: string;

	constructor(options: { readonly sqlState: string; readonly cause: unknown }) {
		super({
			code: "PG_RETRYABLE_TRANSACTION_FAILURE",
			message:
				`PostgreSQL rolled back the transaction with SQLSTATE ` +
				`${options.sqlState}. Run the work again in a new transaction.`,
			cause: options.cause,
			retryable: true,
		});
		this.sqlState = options.sqlState;
	}
}

/**
 * The `COMMIT` of a transaction reported `ROLLBACK`, so nothing committed.
 * PostgreSQL does this without an error when a statement failed before it. The
 * callback caught the failure of that statement and resolved.
 */
export class PgCommitRolledBackError extends InfrastructureError<"PG_COMMIT_ROLLED_BACK"> {
	constructor() {
		super({
			code: "PG_COMMIT_ROLLED_BACK",
			message:
				"The COMMIT rolled back the transaction, so nothing committed. A " +
				"statement failed inside the transaction, and the callback resolved. " +
				"Rethrow the failure of a statement, or run the statement in a " +
				"savepoint.",
		});
	}
}

function hasRetryableSqlState(error: unknown): error is { code: string } {
	const code = (error as { code?: unknown } | null | undefined)?.code;
	return typeof code === "string" && RETRYABLE_SQLSTATES.has(code);
}

/**
 * The retryable error for a serialization failure or a deadlock anywhere in the
 * cause chain, and the same `error` otherwise. A new error keeps `error` as its
 * `cause`, so `UnitOfWork` still recognizes the failure of its work.
 */
export function classifyTransactionFailure(error: unknown): unknown {
	const driverError = findInCauseChain(error, hasRetryableSqlState);
	return driverError === undefined
		? error
		: new PgRetryableTransactionFailureError({
				sqlState: driverError.code,
				cause: error,
			});
}
