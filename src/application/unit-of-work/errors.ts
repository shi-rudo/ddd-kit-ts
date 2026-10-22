import { findInCauseChain } from "@shirudo/base-error";
import type { AggregateIdentity } from "../../domain/aggregate/aggregate-identity";
import {
	copyAggregateIdentity,
	describeAggregateIdentity,
	InfrastructureError,
	isWiringErrorLike,
	KitWiringError,
	rewriteErrorMessage,
} from "../../errors/kit-errors";
import type { AggregateWriteIntent } from "./persistence-contract";

/**
 * Thrown when `UnitOfWork.run()` is called while the same instance is
 * already executing a unit of work: either a genuinely nested `run()`
 * inside the work callback, or two concurrent operations sharing one
 * instance.
 *
 * Both are contract violations, not recoverable infrastructure
 * failures, so this carries the `WIRING` category (same reasoning as
 * `MISSING_HANDLER`): a generic `catch (e instanceof
 * InfrastructureError)` handler must not mask it.
 *
 * A nested `run()` would NOT join the outer transaction; it would open
 * an independent one, silently breaking the all-or-nothing guarantee.
 * If two operations must commit together, they are ONE unit of work:
 * merge them into a single `run()` callback. For concurrent requests,
 * construct one `UnitOfWork` per operation (construction is trivially
 * cheap; the dependency object is the thing you share).
 */
export function nestedUnitOfWorkError(): KitWiringError<"NESTED_UNIT_OF_WORK"> {
	return new KitWiringError({
		code: "NESTED_UNIT_OF_WORK",
		message:
			"UnitOfWork.run() was called while this instance is already running. " +
			"A nested run() would open an independent transaction, not join the " +
			"outer one - merge the work into a single run() callback. For " +
			"concurrent operations, construct one UnitOfWork per operation.",
	});
}

/**
 * Thrown when the unit-of-work context is used after the unit of work closed
 * it: reading `context.repositories`, calling an adapter-held
 * `tracking.trackLoaded`, or using a repository facade after the flush of its
 * attempt, while the transaction commits, or after it committed or rolled
 * back. An `add`, `update`, or `remove` between the start of the flush and the
 * last check before the commit fails the attempt with `AGGREGATE_TRACKING`
 * instead.
 *
 * Use-after-close is a programming bug (typically a leaked context
 * reference or a fire-and-forget promise outliving the callback), so
 * this carries the `WIRING` category and should crash loud.
 *
 * **Honest scope of this guard:** the kit can only invalidate what it
 * controls: context getters, repository-facade operations, and the tracking
 * capability. An adapter that captures its raw transaction handle can still call
 * it as far as the kit can see;
 * whether the driver rejects after close is ORM-specific. Adapter factories
 * must not let that handle escape into application code.
 */
export function transactionClosedError(
	operation: string,
): KitWiringError<"TRANSACTION_CLOSED"> {
	return new KitWiringError({
		code: "TRANSACTION_CLOSED",
		message:
			`Unit of work is closed: ${operation} was called after its attempt ` +
			"ended. Do not use the context, the repository facade, or the " +
			"tracking capability outside the run() callback, and await all " +
			"work inside it.",
		details: { operation },
	});
}

/** Why a repository factory result cannot become a facade. */
export type InvalidRepositoryAdapterReason =
	| "not_an_object"
	| "defines_lifecycle_operation";

/** Options of the `INVALID_REPOSITORY_ADAPTER` error. */
export type InvalidRepositoryAdapterErrorOptions =
	| {
			readonly repository: string;
			readonly reason: "not_an_object";
			/** The `typeof` of the value that the factory returned, or `null`. */
			readonly receivedType: string;
	  }
	| {
			readonly repository: string;
			readonly reason: "defines_lifecycle_operation";
			/** The lifecycle member that the adapter defines. */
			readonly operation: AggregateWriteIntent;
	  };

/** A repository factory returned a value that cannot be wrapped as a facade. */
export function invalidRepositoryAdapterError(
	options: InvalidRepositoryAdapterErrorOptions,
): KitWiringError<"INVALID_REPOSITORY_ADAPTER"> {
	return new KitWiringError({
		code: "INVALID_REPOSITORY_ADAPTER",
		message:
			options.reason === "not_an_object"
				? `Repository factory "${options.repository}" returned ` +
					`${options.receivedType}; it must return an adapter object.`
				: `Repository factory "${options.repository}" returned an adapter ` +
					`that defines ${options.operation}. The unit of work installs ` +
					"add, update, and remove on the facade, so an adapter must not " +
					`define them. Remove ${options.operation} from the adapter.`,
		details:
			options.reason === "not_an_object"
				? {
						repository: options.repository,
						reason: options.reason,
						receivedType: options.receivedType,
					}
				: {
						repository: options.repository,
						reason: options.reason,
						operation: options.operation,
					},
	});
}

/** A Unit of Work received repository wiring that bypassed {@link defineRepository}. */
export function invalidRepositoryDefinitionError(
	repository: string,
): KitWiringError<"INVALID_REPOSITORY_DEFINITION"> {
	return new KitWiringError({
		code: "INVALID_REPOSITORY_DEFINITION",
		message:
			`Repository "${repository}" was not created by defineRepository. ` +
			"Declare the application port explicitly and pass the helper-created " +
			"definition to UnitOfWork.",
		details: { repository },
	});
}

/** A repository's persistence-error policy threw or returned a non-kit error. */
export function repositoryErrorMappingFailedError(
	options: RepositoryErrorMappingFailedErrorOptions,
): KitWiringError<"REPOSITORY_ERROR_MAPPING_FAILED"> {
	return new KitWiringError({
		code: "REPOSITORY_ERROR_MAPPING_FAILED",
		message:
			`The repository error mapper failed for ${options.intent} of aggregate ` +
			`${describeAggregateIdentity(options.identity)}. The original persistence ` +
			"failure is preserved as cause; the mapper failure is available as " +
			"secondaryCause.",
		details: {
			identity: copyAggregateIdentity(options.identity),
			intent: options.intent,
		},
		cause: options.persistenceError,
		secondaryCause: options.mapperError,
	});
}

/** Options of the `REPOSITORY_ERROR_MAPPING_FAILED` error. */
export interface RepositoryErrorMappingFailedErrorOptions {
	/** The aggregate the error names. */
	readonly identity: AggregateIdentity;
	readonly intent: AggregateWriteIntent;
	/** The store failure the mapper was translating. */
	readonly persistenceError: unknown;
	/** The failure of the mapper itself. */
	readonly mapperError: unknown;
}

/** What is wrong with the store statements that build a flush. */
export type FlushStatementReason =
	| "statement_absent"
	| "no_row_count"
	| "no_expected_version"
	| "no_version"
	| "duplicate_check_failed";

/**
 * A deterministic defect in the store statements that build a flush.
 *
 * This is a wiring error, not a persistence failure: the statements cannot
 * run the write the Unit of Work registered, and a retry repeats the same
 * outcome. The commit phase hands it to the caller unchanged, never to the
 * repository's `mapError`, because a mapper returns an `InfrastructureError`
 * and would relabel the defect as a store failure.
 */
export function invalidFlushStatementError(
	options: InvalidFlushStatementErrorOptions,
): KitWiringError<"INVALID_FLUSH_STATEMENT"> {
	return new KitWiringError({
		code: "INVALID_FLUSH_STATEMENT",
		message: flushStatementReasonMessage(options),
		details: flushStatementDetails(options),
		cause: options.cause,
		secondaryCause: options.classifierCause,
	});
}

/** The details of an `INVALID_FLUSH_STATEMENT` error. */
type FlushStatementDetails = {
	readonly identity: AggregateIdentity;
	readonly intent: AggregateWriteIntent | null;
	readonly reason: FlushStatementReason;
	readonly received?: string;
};

function flushStatementDetails(
	options: InvalidFlushStatementErrorOptions,
): FlushStatementDetails {
	return {
		identity: copyAggregateIdentity(options.identity),
		intent: options.intent ?? null,
		reason: options.reason,
		received: options.received,
	};
}

/** The fields that describe one defect of the flush statements. */
export interface InvalidFlushStatementErrorOptions {
	/** The aggregate the error names. */
	readonly identity: AggregateIdentity;
	readonly intent?: AggregateWriteIntent | null;
	readonly reason: FlushStatementReason;
	readonly received?: string;
	/** The store failure that the flush was handling, kept for diagnosis. */
	readonly cause?: unknown;
	readonly classifierCause?: unknown;
}

/**
 * Sets the write intent on a statement defect that its raising code could not
 * name, and renders the message again.
 */
export function attributeFlushStatementIntent(
	defect: KitWiringError<"INVALID_FLUSH_STATEMENT">,
	intent: AggregateWriteIntent,
): void {
	const details = defect.details as FlushStatementDetails;
	if (details.intent === intent) return;
	Reflect.set(defect, "details", Object.freeze({ ...details, intent }));
	rewriteErrorMessage(
		defect,
		flushStatementReasonMessage({ ...details, intent }),
	);
}

function flushStatementReasonMessage(
	options: InvalidFlushStatementErrorOptions,
): string {
	const aggregate = describeAggregateIdentity(options.identity);
	const site =
		options.intent == null ? aggregate : `${options.intent} of ${aggregate}`;
	const statement = options.intent ?? "write";
	switch (options.reason) {
		case "statement_absent":
			return (
				`The Unit of Work registered the ${site}, but the statements carry ` +
				`no ${statement} statement. ` +
				(options.intent === "remove"
					? "A definition with physicalRemoval: true needs a remove statement."
					: "A definition without appendOnly: true needs an update statement.")
			);
		case "no_row_count":
			return (
				`The ${statement} statement of the ${site} returned ` +
				`${options.received ?? "no value"}. It must return the count of rows ` +
				"its predicate matched, so the flush can tell a conflict from a write."
			);
		case "no_expected_version":
			return (
				`The ${site} carries no valid expectedVersion` +
				(options.received === undefined ? "" : ` (${options.received})`) +
				". The Unit of Work captures it when the aggregate is loaded, so " +
				"this write did not come from a loaded aggregate."
			);
		case "no_version":
			return (
				`The currentVersion statement of ${site} returned ` +
				`${options.received ?? "no value"}. It must return the stored ` +
				"version, a safe integer of at least 0, or undefined when the " +
				"aggregate does not exist. Convert a bigint or a numeric string " +
				"with Number()."
			);
		case "duplicate_check_failed":
			return (
				`The isDuplicate check of the ${site} threw. It must classify the ` +
				"error of insert, never fail. The insert failure is the cause; the " +
				"failure of the check is the secondaryCause."
			);
	}
}

/** Why an aggregate lifecycle registration was rejected. */
export type AggregateTrackingReason =
	| "not_loaded"
	| "loaded_as_new"
	| "different_repository"
	| "conflicting_intent"
	| "mutated_after_registration"
	| "registered_during_flush"
	| "identity_already_tracked";

/**
 * A deterministic violation of the Unit of Work's aggregate lifecycle.
 *
 * This is a wiring error rather than a domain or infrastructure failure: the
 * application registered persistence intent in an order the Unit of Work
 * cannot execute truthfully. Retrying the same callback cannot repair it.
 */
export function aggregateTrackingError(
	options: AggregateTrackingErrorOptions,
): KitWiringError<"AGGREGATE_TRACKING"> {
	return new KitWiringError({
		code: "AGGREGATE_TRACKING",
		message: trackingReasonMessage(options),
		details: {
			identity: copyAggregateIdentity(options.identity),
			operation: options.operation,
			reason: options.reason,
			...(options.registeredIntent === undefined
				? {}
				: { registeredIntent: options.registeredIntent }),
		},
	});
}

/** Options of the `AGGREGATE_TRACKING` error. */
export interface AggregateTrackingErrorOptions {
	/** The aggregate the error names. */
	readonly identity: AggregateIdentity;
	/** The registration or phase that failed. */
	readonly operation: AggregateWriteIntent | "load" | "commit";
	readonly reason: AggregateTrackingReason;
	/** The intent registered before, for the reasons that name one. */
	readonly registeredIntent?: AggregateWriteIntent;
	/** Whether the repository of the aggregate is append-only. */
	readonly appendOnly?: boolean;
}

function trackingReasonMessage(options: AggregateTrackingErrorOptions): string {
	const { operation, registeredIntent } = options;
	const aggregate = describeAggregateIdentity(options.identity);
	switch (options.reason) {
		case "not_loaded":
			return (
				`Aggregate ${aggregate} cannot be registered for ${operation}: ` +
				"it was not loaded into this unit of work. Load it through the " +
				"repository before updating or removing it."
			);
		case "loaded_as_new":
			return (
				`Aggregate ${aggregate} cannot be added as new because it was ` +
				"loaded by this unit of work. " +
				(options.appendOnly
					? "Its repository is append-only, so a loaded aggregate is already " +
						"persisted and must not change."
					: "Use update for a loaded aggregate.")
			);
		case "different_repository":
			return (
				`Aggregate ${aggregate} cannot be registered for ${operation} through ` +
				"a different repository in the same unit of work. One aggregate instance " +
				"must remain owned by the repository definition that first tracked it."
			);
		case "conflicting_intent":
			return (
				`Aggregate ${aggregate} is already registered for ` +
				`${registeredIntent ?? "another write"}; ${operation} would create ` +
				"conflicting persistence intent in one unit of work. Decide the final " +
				"lifecycle outcome before registering it."
			);
		case "mutated_after_registration":
			return (
				`Aggregate ${aggregate} changed after ${registeredIntent ?? "write"} ` +
				"was registered. Make domain decisions first and call add, update, or " +
				"remove last so persisted state and recorded events cannot diverge."
			);
		case "registered_during_flush":
			return (
				`Aggregate ${aggregate} cannot be registered for ${operation}: the ` +
				"unit of work already flushes its writes, so this write cannot join " +
				"the transaction. Await every repository call inside the run() callback."
			);
		case "identity_already_tracked":
			return (
				`Aggregate ${aggregate} cannot be registered for ${operation}: this ` +
				"unit of work already tracks another instance with the same identity. " +
				"Change the tracked instance, or give the new aggregate a new id."
			);
	}
}

/**
 * The unit of work failed AFTER the work callback completed
 * successfully, at the persistence boundary: the outbox write or the
 * transaction commit itself rejected. The kit cannot see inside
 * `TransactionScope.transactional`, so these are deliberately one error
 * class; the underlying failure is attached as `cause`.
 *
 * `InfrastructureError`: the business logic ran to completion; the
 * persistence boundary failed. The transaction rolled back (or never
 * committed), no aggregate was marked persisted, and pending events
 * survive on the aggregates; the operation left no partial state behind.
 * A `CommitError` is the **potentially transient** post-completion
 * failure (a commit-time serialization failure is the classic case), so
 * it is the one a retrying caller should consider re-running. The
 * deterministic post-completion failure, a collection-guard violation (an
 * event missing `aggregateId` / `aggregateType`, or an eventful persisted
 * aggregate that did not advance its version), is a programming bug and surfaces as
 * a `KitWiringError` with the code `EVENT_COLLECTION_FAILED` instead. That
 * class does NOT extend `InfrastructureError`, so it stays out of retry paths by construction.
 */
export class CommitError extends InfrastructureError<"COMMIT_FAILED"> {
	constructor(cause: unknown) {
		super({
			code: "COMMIT_FAILED",
			message:
				"Unit of work failed after the work callback completed: the outbox " +
				"write or the transaction commit rejected. The transaction did " +
				"not commit; this failure may be transient, inspect the cause " +
				"(e.g. someChainRetryable) before retrying.",
			cause,
		});
	}
}

/**
 * A step inside the transaction threw, and the transaction scope rejected
 * with a different error that does not wrap that failure in its cause chain.
 * This is the strongest available signal that the rollback itself failed.
 * The step is the work callback, or a step after it and before the commit,
 * for example the outbox write. The failure inside the transaction is the
 * `cause`, so cause-chain helpers (`someChainRetryable`, `findInCauseChain`)
 * still see a wrapped `ConcurrencyConflictError` & co. The scope's error is
 * in {@link rollbackCause}. A wiring error as that failure is the cause too,
 * so both facts stay visible.
 *
 * A scope that rethrows the failure (Drizzle and Prisma do) never produces
 * this. A scope that wraps the failure is detected through the cause chain.
 * A wrapped failure of the work passes through unchanged. A wrapped failure
 * after the work becomes a `CommitError`, or passes through when it is a
 * wiring error.
 */
export class RollbackError extends InfrastructureError<"ROLLBACK_FAILED"> {
	constructor(
		cause: unknown,
		public readonly rollbackCause: unknown,
	) {
		super({
			code: "ROLLBACK_FAILED",
			message:
				"A step inside the transaction failed and the transaction scope " +
				"rejected with a different error (possible rollback failure). The " +
				"failure inside the transaction is the cause; the scope's error is " +
				"in rollbackCause.",
			cause,
		});
	}
}

/**
 * The first kit wiring error in the cause chain of `error`, matched by its
 * category. A wiring error states a defect of the wiring, so the unit
 * of work passes it to the caller and never lets a mapper or a retry
 * relabel it, even when an adapter or a scope wrapped it. If the rollback
 * failed as well, the wiring error becomes the cause of a `RollbackError`,
 * so the rollback failure stays visible.
 */
export function wiringErrorInCauseChain(error: unknown): object | undefined {
	return findInCauseChain(error, isWiringErrorLike);
}
