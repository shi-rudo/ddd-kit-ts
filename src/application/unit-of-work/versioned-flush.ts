import type { Aggregate, Version } from "../../domain/aggregate/aggregate";
import type { AnyDomainEvent } from "../../domain/event/domain-event";
import type { Id } from "../../domain/identity/id";
import {
	ConcurrencyConflictError,
	DuplicateAggregateError,
} from "../../errors/kit-errors";
import { InvalidFlushStatementError } from "./errors";
import type { AggregatePersistenceWrite } from "./persistence-contract";

/**
 * The count of rows that one compare-and-set statement matched. It is a
 * `number`: a driver that reports a `bigint`, for example better-sqlite3 with
 * safe integers, needs `Number(...)` in the statement.
 */
export type AffectedRows = number;

/**
 * The receipt of an update or a remove. Both come from a loaded aggregate,
 * so `expectedVersion` is the version the compare-and-set predicate uses.
 */
export type VersionedWrite<
	TAggregate extends Aggregate<Id<string>, AnyDomainEvent>,
	TChangeSet,
> = AggregatePersistenceWrite<TAggregate, TChangeSet> & {
	readonly expectedVersion: Version;
};

/**
 * The store statements that {@link versionedFlush} runs. The consumer writes
 * only the statements; the helper owns the error branches of the
 * optimistic-concurrency contract.
 *
 * A definition that updates or removes carries `currentVersion`. A definition
 * that never does, for example an append-only one, carries `insert` and
 * `isDuplicate` only.
 */
export type VersionedFlushStatements<
	TCtx,
	TAggregate extends Aggregate<Id<string>, AnyDomainEvent>,
	TChangeSet,
> = {
	/** The aggregate type that the raised errors name. */
	readonly aggregateType: string;
	/**
	 * Inserts the rows of a new aggregate and stamps `write.version`. The
	 * store's unique constraint on the aggregate id rejects a second insert.
	 */
	readonly insert: (
		transaction: TCtx,
		write: AggregatePersistenceWrite<TAggregate, TChangeSet>,
	) => void | Promise<void>;
	/**
	 * Tells whether an error from `insert` is the store's unique-violation
	 * signal. The helper then raises {@link DuplicateAggregateError} with the
	 * error as cause. Every other error propagates unchanged. It classifies
	 * errors of `insert` only.
	 */
	readonly isDuplicate: (error: unknown) => boolean;
} & (
	| {
			/**
			 * Updates the rows where the stored version equals
			 * `write.expectedVersion` and stamps `write.version`. The version check
			 * and the write run in one statement. It returns the count of rows that
			 * the predicate matched, never the count of rows whose values changed.
			 * It runs for every update, also for an empty change set, because the
			 * new version must reach the store. Absent for an append-only
			 * definition.
			 */
			readonly update?: (
				transaction: TCtx,
				write: VersionedWrite<TAggregate, TChangeSet>,
			) => AffectedRows | Promise<AffectedRows>;
			/**
			 * Deletes the rows where the stored version equals
			 * `write.expectedVersion` and returns the count of rows it deleted.
			 * Present exactly when the definition sets `physicalRemoval: true`.
			 */
			readonly remove?: (
				transaction: TCtx,
				write: VersionedWrite<TAggregate, TChangeSet>,
			) => AffectedRows | Promise<AffectedRows>;
			/**
			 * Reads the stored version of one aggregate. Returns `undefined` when
			 * no row exists. The helper runs it once, after a statement affected no
			 * row, to report `actualVersion`.
			 */
			readonly currentVersion: (
				transaction: TCtx,
				aggregateId: TAggregate["id"],
			) => number | undefined | Promise<number | undefined>;
	  }
	| {
			readonly update?: undefined;
			readonly remove?: undefined;
			readonly currentVersion?: undefined;
	  }
);

/** The statements of a definition that updates or removes. */
type VersionedWriteStatements<
	TCtx,
	TAggregate extends Aggregate<Id<string>, AnyDomainEvent>,
	TChangeSet,
> = Extract<
	VersionedFlushStatements<TCtx, TAggregate, TChangeSet>,
	{ readonly currentVersion: unknown }
>;

/** The `actualVersion` that a conflict reports when no row exists. */
const NO_ROW_VERSION = -1;

/**
 * Builds the `flush` of a repository definition from store statements and
 * owns the error branches of the optimistic-concurrency contract.
 *
 * An `add` runs `insert`; a unique violation becomes
 * {@link DuplicateAggregateError}. An `update` or `remove` runs the matching
 * statement. Zero affected rows becomes {@link ConcurrencyConflictError} with
 * the stored version as `actualVersion`. A stale update never becomes an
 * insert. Every other error propagates to `mapError` unchanged.
 *
 * A defect in the statements becomes {@link InvalidFlushStatementError}: an
 * absent statement, a statement that returns no row count, and an
 * `isDuplicate` that throws. Statements that update or remove without
 * `currentVersion` fail here, when the flush is built.
 */
export function versionedFlush<
	TCtx,
	TAggregate extends Aggregate<Id<string>, AnyDomainEvent>,
	TChangeSet,
>(
	statements: VersionedFlushStatements<TCtx, TAggregate, TChangeSet>,
): (
	transaction: TCtx,
	write: AggregatePersistenceWrite<TAggregate, TChangeSet>,
) => Promise<void> {
	const versionedWrites = versionedWritesOf(statements);
	return async (transaction, write) => {
		switch (write.intent) {
			case "add":
				return insertNew(statements, transaction, write);
			case "update":
				return writeVersioned(
					statements.aggregateType,
					versionedWrites,
					"update",
					transaction,
					write,
				);
			case "remove":
				return writeVersioned(
					statements.aggregateType,
					versionedWrites,
					"remove",
					transaction,
					write,
				);
		}
	};
}

function versionedWritesOf<
	TCtx,
	TAggregate extends Aggregate<Id<string>, AnyDomainEvent>,
	TChangeSet,
>(
	statements: VersionedFlushStatements<TCtx, TAggregate, TChangeSet>,
): VersionedWriteStatements<TCtx, TAggregate, TChangeSet> | undefined {
	if (statements.currentVersion !== undefined) return statements;
	if ((statements.update ?? statements.remove) === undefined) return undefined;
	throw new TypeError(
		"versionedFlush: the statements carry update or remove but no " +
			"currentVersion. A failed version check reports the stored version " +
			"through currentVersion.",
	);
}

async function insertNew<
	TCtx,
	TAggregate extends Aggregate<Id<string>, AnyDomainEvent>,
	TChangeSet,
>(
	statements: VersionedFlushStatements<TCtx, TAggregate, TChangeSet>,
	transaction: TCtx,
	write: AggregatePersistenceWrite<TAggregate, TChangeSet>,
): Promise<void> {
	try {
		await statements.insert(transaction, write);
	} catch (error) {
		let duplicate: boolean;
		try {
			duplicate = statements.isDuplicate(error);
		} catch (classifierCause) {
			throw new InvalidFlushStatementError({
				aggregateType: statements.aggregateType,
				aggregateId: String(write.aggregateId),
				intent: "add",
				reason: "duplicate_check_failed",
				cause: error,
				classifierCause,
			});
		}
		if (!duplicate) throw error;
		throw new DuplicateAggregateError({
			aggregateType: statements.aggregateType,
			aggregateId: write.aggregateId,
			cause: error,
		});
	}
}

async function writeVersioned<
	TCtx,
	TAggregate extends Aggregate<Id<string>, AnyDomainEvent>,
	TChangeSet,
>(
	aggregateType: string,
	versionedWrites:
		| VersionedWriteStatements<TCtx, TAggregate, TChangeSet>
		| undefined,
	intent: "update" | "remove",
	transaction: TCtx,
	write: AggregatePersistenceWrite<TAggregate, TChangeSet>,
): Promise<void> {
	const statement = versionedWrites?.[intent];
	const failure = {
		aggregateType,
		aggregateId: String(write.aggregateId),
		intent,
	};
	if (versionedWrites === undefined || statement === undefined) {
		throw new InvalidFlushStatementError({
			...failure,
			reason: "statement_absent",
		});
	}
	if (write.expectedVersion === undefined) {
		throw new InvalidFlushStatementError({
			...failure,
			reason: "no_expected_version",
		});
	}
	const expectedVersion = write.expectedVersion;
	const affectedRows = await statement(
		transaction,
		write as VersionedWrite<TAggregate, TChangeSet>,
	);
	if (!Number.isInteger(affectedRows) || affectedRows < 0) {
		throw new InvalidFlushStatementError({
			...failure,
			reason: "no_row_count",
			received: describeRowCount(affectedRows),
		});
	}
	if (affectedRows > 0) return;

	const storedVersion = await readStoredVersion(
		versionedWrites,
		transaction,
		write.aggregateId,
	);
	throw new ConcurrencyConflictError({
		aggregateType,
		aggregateId: write.aggregateId,
		expectedVersion,
		actualVersion: storedVersion.version ?? NO_ROW_VERSION,
		cause: storedVersion.readFailure,
	});
}

/** Names what a statement returned instead of a row count. */
function describeRowCount(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	return typeof value === "number"
		? String(value)
		: `${String(value)} (${typeof value})`;
}

/**
 * Reads the stored version for the `actualVersion` of a conflict. The zero
 * row count already proves the conflict, so a failed read must not replace
 * it. Such a read reports no version and travels as the conflict's cause.
 */
async function readStoredVersion<
	TCtx,
	TAggregate extends Aggregate<Id<string>, AnyDomainEvent>,
	TChangeSet,
>(
	versionedWrites: VersionedWriteStatements<TCtx, TAggregate, TChangeSet>,
	transaction: TCtx,
	aggregateId: TAggregate["id"],
): Promise<{ version: number | undefined; readFailure?: unknown }> {
	try {
		return {
			version: await versionedWrites.currentVersion(transaction, aggregateId),
		};
	} catch (readFailure) {
		return { version: undefined, readFailure };
	}
}
