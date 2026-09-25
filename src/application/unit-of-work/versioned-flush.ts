import type { Aggregate, Version } from "../../domain/aggregate/aggregate";
import type { AggregateIdentity } from "../../domain/aggregate/aggregate-identity";
import type { AnyDomainEvent } from "../../domain/event/domain-event";
import type { Id } from "../../domain/identity/id";
import {
	ConcurrencyConflictError,
	DuplicateAggregateError,
} from "../../errors/kit-errors";
import {
	type FlushStatementReason,
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
	const runInsert = insertWriter(statements);
	const { update: runUpdate, remove: runRemove } =
		versionedWriters(versionedWrites);
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
	const { insert, isDuplicate } = statements;

	return async (transaction, write) => {
		try {
			await insert(transaction, write);
		} catch (error) {
			let duplicate: boolean;
			try {
				duplicate = isDuplicate(error);
			} catch (classifierCause) {
				throw new InvalidFlushStatementError({
					identity: write.aggregateIdentity,
					intent: "add",
					reason: "duplicate_check_failed",
					cause: error,
					classifierCause,
				});
			}
			if (!duplicate) throw error;
			throw new DuplicateAggregateError({
				identity: write.aggregateIdentity,
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
	versionedWrites:
		| VersionedWriteStatements<TCtx, TAggregate, TChangeSet>
		| undefined,
): Record<"update" | "remove", IntentWriter<TAggregate, TChangeSet, TCtx>> {
	return {
		update: versionedWriter(versionedWrites, "update"),
		remove: versionedWriter(versionedWrites, "remove"),
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
	versionedWrites:
		| VersionedWriteStatements<TCtx, TAggregate, TChangeSet>
		| undefined,
	intent: "update" | "remove",
): IntentWriter<TAggregate, TChangeSet, TCtx> {
	const statement = versionedWrites?.[intent];
	const statementDefect = (
		write: AggregatePersistenceWrite<TAggregate, TChangeSet>,
		reason: FlushStatementReason,
		received?: string,
	) =>
		new InvalidFlushStatementError({
			identity: write.aggregateIdentity,
			intent,
			reason,
			received,
		});

	return async (transaction, write) => {
		if (versionedWrites === undefined || statement === undefined) {
			throw statementDefect(write, "statement_absent");
		}
		if (!isStoredVersion(write.expectedVersion)) {
			throw statementDefect(
				write,
				"no_expected_version",
				describeReceived(write.expectedVersion),
			);
		}
		const matchedRows = await statement(
			transaction,
			write as VersionedWrite<TAggregate, TChangeSet>,
		);
		if (!Number.isInteger(matchedRows) || matchedRows < 0) {
			throw statementDefect(
				write,
				"no_row_count",
				describeReceived(matchedRows),
			);
		}
		if (matchedRows > 0) return;

		throw await classifyConcurrencyConflict({
			identity: write.aggregateIdentity,
			expectedVersion: write.expectedVersion,
			transaction,
			currentVersion: versionedWrites.currentVersion,
		});
	};
}

/** Options of {@link classifyConcurrencyConflict}. */
export interface ClassifyConcurrencyConflictOptions<
	TCtx,
	TAggregateId extends string,
> {
	/** The aggregate of the write whose compare-and-set matched no row. */
	readonly identity: AggregateIdentity<TAggregateId>;
	/** The version that the compare-and-set predicate used. */
	readonly expectedVersion: number;
	readonly transaction: TCtx;
	/**
	 * Reads the version that the store holds now, or `undefined` when the
	 * aggregate no longer exists. It is the same statement as the
	 * `currentVersion` of {@link VersionedFlushStatements}.
	 */
	readonly currentVersion: (
		transaction: TCtx,
		aggregateId: TAggregateId,
	) => number | undefined | Promise<number | undefined>;
}

/**
 * Builds the conflict of a compare-and-set that matched no row. It reads the
 * stored version and names the reason of the conflict. The zero row count
 * already proves the conflict, so the read is diagnostic: a read that fails
 * becomes `version_unknown`, with the failure as the cause.
 *
 * A version read that returns neither a stored version nor `undefined`, and
 * an expected version that is no version, are defects of the statements. They
 * throw {@link InvalidFlushStatementError}.
 */
export async function classifyConcurrencyConflict<
	TCtx,
	TAggregateId extends string,
>(
	options: ClassifyConcurrencyConflictOptions<TCtx, TAggregateId>,
): Promise<ConcurrencyConflictError> {
	const { identity, expectedVersion } = options;
	if (!isStoredVersion(expectedVersion)) {
		throw new InvalidFlushStatementError({
			identity,
			reason: "no_expected_version",
			received: describeReceived(expectedVersion),
		});
	}
	const stored = await readStoredVersion(() =>
		options.currentVersion(options.transaction, identity.aggregateId),
	);
	if (
		stored.read &&
		stored.currentVersion !== undefined &&
		!isStoredVersion(stored.currentVersion)
	) {
		throw new InvalidFlushStatementError({
			identity,
			reason: "no_version",
			received: describeReceived(stored.currentVersion),
		});
	}
	return new ConcurrencyConflictError({
		identity,
		expectedVersion,
		cause: stored.read ? undefined : stored.readFailure,
		...storedVersionOf(stored, expectedVersion),
	});
}

function isStoredVersion(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
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

/** Names a value that the flush received in place of a valid one. */
function describeReceived(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number") return String(value);
	let text: string;
	try {
		text = String(value);
	} catch {
		// An object without a prototype has no toString.
		text = Object.prototype.toString.call(value);
	}
	return `${text} (${typeof value})`;
}

async function readStoredVersion(
	currentVersion: () => number | undefined | Promise<number | undefined>,
): Promise<VersionRead> {
	try {
		return { read: true, currentVersion: await currentVersion() };
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
