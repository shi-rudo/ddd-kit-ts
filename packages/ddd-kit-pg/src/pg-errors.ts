import { findInCauseChain } from "@shirudo/base-error";
import { type AggregateIdentity, InfrastructureError } from "@shirudo/ddd-kit";

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

/**
 * The `ROLLBACK` after a failed callback failed too, so the state of the
 * connection is unknown. The rollback failure is the `cause`. `workFailure` is a
 * field and not in the cause chain, because `UnitOfWork` reads a chain that
 * holds the work failure as a successful rollback.
 */
export class PgRollbackFailedError extends InfrastructureError<"PG_ROLLBACK_FAILED"> {
	readonly workFailure: unknown;

	constructor(options: {
		readonly cause: unknown;
		readonly workFailure: unknown;
	}) {
		super({
			code: "PG_ROLLBACK_FAILED",
			message:
				"The ROLLBACK after a failed callback failed too. The cause is the " +
				"rollback failure, and workFailure is the failure of the callback. " +
				"PostgreSQL ends the transaction when the connection closes.",
			cause: options.cause,
		});
		this.workFailure = options.workFailure;
	}
}

/**
 * A stream has a gap at a position. An event store must reject this, because a
 * replay would otherwise fold a truncated stream without an error. Only a
 * change outside `PgEventStore` causes it, for example a manual `DELETE` or a
 * partial restore.
 */
export class PgEventStreamCorruptError extends InfrastructureError<"PG_EVENT_STREAM_CORRUPT"> {
	readonly identity: AggregateIdentity;
	readonly expectedPosition: number;
	readonly actualPosition: number;

	constructor(options: {
		readonly identity: AggregateIdentity;
		readonly expectedPosition: number;
		readonly actualPosition: number;
	}) {
		super({
			code: "PG_EVENT_STREAM_CORRUPT",
			message:
				`The stream ${options.identity.aggregateType}/` +
				`${options.identity.aggregateId} has a gap: the read expected position ` +
				`${options.expectedPosition} and found ${options.actualPosition}. ` +
				"A change outside PgEventStore removed events. Restore the stream.",
		});
		this.identity = options.identity;
		this.expectedPosition = options.expectedPosition;
		this.actualPosition = options.actualPosition;
	}
}

/**
 * The codec threw for a stored event. A read of its stream and a poll of the
 * outbox stop at this event until a codec decodes it, for example after the
 * deploy of a new event type reaches every process. The codec failure is the
 * `cause`.
 */
export class PgEventDecodeError extends InfrastructureError<"PG_EVENT_DECODE_FAILED"> {
	readonly eventId: string;
	readonly eventType: string;
	readonly schemaVersion: number;
	readonly identity: AggregateIdentity;

	constructor(options: {
		readonly eventId: string;
		readonly eventType: string;
		readonly schemaVersion: number;
		readonly identity: AggregateIdentity;
		readonly cause: unknown;
	}) {
		super({
			code: "PG_EVENT_DECODE_FAILED",
			message:
				`The codec could not decode the stored event ${options.eventId} ` +
				`(${options.eventType}, schema version ${options.schemaVersion}) of ` +
				`${options.identity.aggregateType}/${options.identity.aggregateId}. ` +
				"Deploy a codec that decodes it. A read of the stream and a poll of " +
				"the outbox stop at this event until then.",
			cause: options.cause,
		});
		this.eventId = options.eventId;
		this.eventType = options.eventType;
		this.schemaVersion = options.schemaVersion;
		this.identity = options.identity;
	}
}

/**
 * `PgEventStore.removeStream` ran at an isolation level with one snapshot for the
 * whole transaction. A retry does not help: begin the transaction at READ
 * COMMITTED.
 */
export class PgUnsupportedIsolationLevelError extends InfrastructureError<"PG_UNSUPPORTED_ISOLATION_LEVEL"> {
	readonly isolationLevel: string;
	readonly identity: AggregateIdentity;

	constructor(options: {
		readonly isolationLevel: string;
		readonly identity: AggregateIdentity;
	}) {
		super({
			code: "PG_UNSUPPORTED_ISOLATION_LEVEL",
			message:
				`PgEventStore.removeStream ran at ${options.isolationLevel.toUpperCase()} ` +
				`on ${options.identity.aggregateType}/${options.identity.aggregateId}. ` +
				"A removal needs READ COMMITTED. A snapshot for the whole transaction " +
				"misses an append that commits while the removal waits for the lock, " +
				"and that event would survive the removal. Begin the transaction at READ " +
				"COMMITTED, for example with the isolationLevel option of " +
				"PgTransactionScope.",
		});
		this.isolationLevel = options.isolationLevel;
		this.identity = options.identity;
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
