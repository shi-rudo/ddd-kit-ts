import type { Aggregate, Version } from "../../domain/aggregate/aggregate";
import type { AnyDomainEvent } from "../../domain/event/domain-event";
import type { Id } from "../../domain/identity/id";
import {
	ConcurrencyConflictError,
	DuplicateAggregateError,
} from "../../errors/kit-errors";
import {
	type FlushStatementDefect,
	InvalidFlushStatementError,
} from "./errors";
import type { AggregatePersistenceWrite } from "./persistence-contract";

/**
 * The count of rows that one compare-and-set statement matched. It counts the
 * rows the predicate matched, never the rows whose values changed. It is a
 * `number`: a driver that reports a `bigint`, for example better-sqlite3 with
 * safe integers, needs `Number(...)` in the statement.
 */
export type MatchedRows = number;

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
 *
 * {@link versionedFlush} reads every statement once, when it builds the flush.
 * A statements object that changes later has no effect.
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
			) => MatchedRows | Promise<MatchedRows>;
			/**
			 * Deletes the rows where the stored version equals
			 * `write.expectedVersion` and returns the count of rows it deleted.
			 * Present exactly when the definition sets `physicalRemoval: true`.
			 */
			readonly remove?: (
				transaction: TCtx,
				write: VersionedWrite<TAggregate, TChangeSet>,
			) => MatchedRows | Promise<MatchedRows>;
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

/**
 * Builds the `flush` of a repository definition from store statements and
 * owns the error branches of the optimistic-concurrency contract.
 *
 * An `add` runs `insert`; a unique violation becomes
 * {@link DuplicateAggregateError}. An `update` or `remove` runs the matching
 * statement. Zero matched rows becomes {@link ConcurrencyConflictError}, whose
 * reason names what the version read found. A stale update never becomes an
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
	const aggregateType = statements.aggregateType;
	const runInsert = insertWriter(statements);
	const { update: runUpdate, remove: runRemove } = versionedWriters(
		aggregateType,
		versionedWrites,
	);
	return async (transaction, write) => {
		switch (write.intent) {
			case "add":
				return runInsert(transaction, write);
			case "update":
				return runUpdate(transaction, write);
			case "remove":
				return runRemove(transaction, write);
			default: {
				const unknownIntent: never = write.intent;
				throw new TypeError(
					`versionedFlush: the Unit of Work registered the intent ` +
						`${String(unknownIntent)}, which the statements cannot run.`,
				);
			}
		}
	};
}

/** Reads its statements here, like its versioned peers. */
function insertWriter<
	TCtx,
	TAggregate extends Aggregate<Id<string>, AnyDomainEvent>,
	TChangeSet,
>(
	statements: VersionedFlushStatements<TCtx, TAggregate, TChangeSet>,
): IntentWriter<TAggregate, TChangeSet, TCtx> {
	const { aggregateType, insert, isDuplicate } = statements;

	return async (transaction, write) => {
		try {
			await insert(transaction, write);
		} catch (error) {
			let duplicate: boolean;
			try {
				duplicate = isDuplicate(error);
			} catch (classifierCause) {
				throw new InvalidFlushStatementError({
					aggregateType,
					aggregateId: write.aggregateId,
					intent: "add",
					reason: "duplicate_check_failed",
					cause: error,
					classifierCause,
				});
			}
			if (!duplicate) throw error;
			throw new DuplicateAggregateError({
				aggregateType,
				aggregateId: write.aggregateId,
				cause: error,
			});
		}
	};
}

/**
 * Narrows the statements to the versioned half, and rejects the pairing that
 * the type system cannot: `update` or `remove` without `currentVersion`.
 */
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

/** Runs the write of one intent against the store. */
type IntentWriter<
	TAggregate extends Aggregate<Id<string>, AnyDomainEvent>,
	TChangeSet,
	TCtx,
> = (
	transaction: TCtx,
	write: AggregatePersistenceWrite<TAggregate, TChangeSet>,
) => Promise<void>;

function versionedWriters<
	TCtx,
	TAggregate extends Aggregate<Id<string>, AnyDomainEvent>,
	TChangeSet,
>(
	aggregateType: string,
	versionedWrites:
		| VersionedWriteStatements<TCtx, TAggregate, TChangeSet>
		| undefined,
): Record<"update" | "remove", IntentWriter<TAggregate, TChangeSet, TCtx>> {
	return {
		update: versionedWriter(aggregateType, versionedWrites, "update"),
		remove: versionedWriter(aggregateType, versionedWrites, "remove"),
	};
}

/**
 * Resolves the statement of one intent here, so a statements object that
 * changes after the flush is built has no effect.
 */
function versionedWriter<
	TCtx,
	TAggregate extends Aggregate<Id<string>, AnyDomainEvent>,
	TChangeSet,
>(
	aggregateType: string,
	versionedWrites:
		| VersionedWriteStatements<TCtx, TAggregate, TChangeSet>
		| undefined,
	intent: "update" | "remove",
): IntentWriter<TAggregate, TChangeSet, TCtx> {
	const statement = versionedWrites?.[intent];
	const statementDefect = (
		write: AggregatePersistenceWrite<TAggregate, TChangeSet>,
		reason: FlushStatementDefect,
		received?: string,
	) =>
		new InvalidFlushStatementError({
			aggregateType,
			aggregateId: write.aggregateId,
			intent,
			reason,
			received,
		});

	return async (transaction, write) => {
		if (versionedWrites === undefined || statement === undefined) {
			throw statementDefect(write, "statement_absent");
		}
		if (write.expectedVersion === undefined) {
			throw statementDefect(write, "no_expected_version");
		}
		const matchedRows = await statement(
			transaction,
			write as VersionedWrite<TAggregate, TChangeSet>,
		);
		if (!Number.isInteger(matchedRows) || matchedRows < 0) {
			throw statementDefect(
				write,
				"no_row_count",
				describeMatchedRows(matchedRows),
			);
		}
		if (matchedRows > 0) return;

		const stored = await readCurrentVersion(
			versionedWrites,
			transaction,
			write.aggregateId,
		);
		throw new ConcurrencyConflictError({
			aggregateType,
			aggregateId: write.aggregateId,
			expectedVersion: write.expectedVersion,
			cause: stored.read ? undefined : stored.readFailure,
			...storedVersionOf(stored, write.expectedVersion),
		});
	};
}

/**
 * Names which version the conflict reports, and why. A read that failed leaves
 * the stored version unknown; a store that lost the aggregate has none to
 * name; a version that still equals the expected one means the statement
 * matched nothing for a reason beyond the version.
 */
function storedVersionOf(
	stored: VersionRead,
	expectedVersion: number,
):
	| { reason: "stale_version" | "version_unchanged"; actualVersion: number }
	| { reason: "aggregate_absent" | "version_unknown" } {
	if (!stored.read) return { reason: "version_unknown" };
	if (stored.currentVersion === undefined) {
		return { reason: "aggregate_absent" };
	}
	return stored.currentVersion === expectedVersion
		? { reason: "version_unchanged", actualVersion: stored.currentVersion }
		: { reason: "stale_version", actualVersion: stored.currentVersion };
}

/** Names what a statement returned instead of a row count. */
function describeMatchedRows(value: unknown): string | undefined {
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
async function readCurrentVersion<
	TCtx,
	TAggregate extends Aggregate<Id<string>, AnyDomainEvent>,
	TChangeSet,
>(
	versionedWrites: VersionedWriteStatements<TCtx, TAggregate, TChangeSet>,
	transaction: TCtx,
	aggregateId: TAggregate["id"],
): Promise<VersionRead> {
	try {
		return {
			read: true,
			currentVersion: await versionedWrites.currentVersion(
				transaction,
				aggregateId,
			),
		};
	} catch (readFailure) {
		return { read: false, readFailure };
	}
}

/**
 * The outcome of one version read. `read` states whether the read answered at
 * all, because a statement can reject with `undefined`, and a failed read is
 * not an absent aggregate.
 */
type VersionRead =
	| { readonly read: true; readonly currentVersion: number | undefined }
	| { readonly read: false; readonly readFailure: unknown };
