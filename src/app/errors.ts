import { InfrastructureError, KitWiringError } from "../core/errors";
import type { AggregateWriteIntent } from "./persistence-contract";

/**
 * Thrown when `UnitOfWork.run()` is called while the same instance is
 * already executing a unit of work: either a genuinely nested `run()`
 * inside the work callback, or two concurrent operations sharing one
 * instance.
 *
 * Both are contract violations, not recoverable infrastructure
 * failures, so this carries the `WIRING` category (same reasoning as
 * `MissingHandlerError`): a generic `catch (e instanceof
 * InfrastructureError)` handler must not mask it.
 *
 * A nested `run()` would NOT join the outer transaction; it would open
 * an independent one, silently breaking the all-or-nothing guarantee.
 * If two operations must commit together, they are ONE unit of work:
 * merge them into a single `run()` callback. For concurrent requests,
 * construct one `UnitOfWork` per operation (construction is trivially
 * cheap; the dependency object is the thing you share).
 */
export class NestedUnitOfWorkError extends KitWiringError<"NESTED_UNIT_OF_WORK"> {
	constructor() {
		super(
			"NESTED_UNIT_OF_WORK",
			"UnitOfWork.run() was called while this instance is already running. " +
				"A nested run() would open an independent transaction, not join the " +
				"outer one - merge the work into a single run() callback. For " +
				"concurrent operations, construct one UnitOfWork per operation.",
		);
	}
}

/**
 * Thrown when the unit-of-work context is used after `run()` has
 * settled: reading `context.repositories`, calling an adapter-held
 * `tracking.trackLoaded`, or using a repository facade after the transaction
 * has committed or rolled back.
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
export class TransactionClosedError extends KitWiringError<"TRANSACTION_CLOSED"> {
	constructor(public readonly operation: string) {
		super(
			"TRANSACTION_CLOSED",
			`Unit of work is closed: ${operation} was called after the ` +
				"transaction committed or rolled back. Do not use the context or " +
				"repository facade or tracking capability outside the run() callback.",
		);
	}
}

/** A repository factory returned a value that cannot be wrapped as a facade. */
export class InvalidRepositoryAdapterError extends KitWiringError<"INVALID_REPOSITORY_ADAPTER"> {
	constructor(
		public readonly repository: string,
		public readonly receivedType: string,
	) {
		super(
			"INVALID_REPOSITORY_ADAPTER",
			`Repository factory "${repository}" returned ${receivedType}; ` +
				"it must return an adapter object.",
		);
	}
}

/** A Unit of Work received repository wiring that bypassed {@link defineRepository}. */
export class InvalidRepositoryDefinitionError extends KitWiringError<"INVALID_REPOSITORY_DEFINITION"> {
	constructor(public readonly repository: string) {
		super(
			"INVALID_REPOSITORY_DEFINITION",
			`Repository "${repository}" was not created by defineRepository. ` +
				"Declare the application port explicitly and pass the helper-created " +
				"definition to UnitOfWork.",
		);
	}
}

/** A repository's persistence-error policy threw or returned a non-kit error. */
export class RepositoryErrorMappingFailedError extends KitWiringError<"REPOSITORY_ERROR_MAPPING_FAILED"> {
	readonly aggregateId: string;
	readonly intent: AggregateWriteIntent;
	readonly mapperCause: unknown;

	constructor(options: {
		readonly aggregateId: string;
		readonly intent: AggregateWriteIntent;
		readonly persistenceError: unknown;
		readonly mapperError: unknown;
	}) {
		super(
			"REPOSITORY_ERROR_MAPPING_FAILED",
			`The repository error mapper failed for ${options.intent} of aggregate ` +
				`${options.aggregateId}. The original persistence failure is preserved ` +
				"as cause; the mapper failure is available as mapperCause.",
			options.persistenceError,
		);
		this.aggregateId = options.aggregateId;
		this.intent = options.intent;
		this.mapperCause = options.mapperError;
	}
}

/** Why an aggregate lifecycle registration was rejected. */
export type AggregateTrackingFailure =
	| "not_loaded"
	| "loaded_as_new"
	| "different_repository"
	| "conflicting_intent"
	| "mutated_after_registration";

/**
 * A deterministic violation of the Unit of Work's aggregate lifecycle.
 *
 * This is a wiring error rather than a domain or infrastructure failure: the
 * application registered persistence intent in an order the Unit of Work
 * cannot execute truthfully. Retrying the same callback cannot repair it.
 */
export class AggregateTrackingError extends KitWiringError<"AGGREGATE_TRACKING"> {
	constructor(
		public readonly aggregateId: string,
		public readonly operation: AggregateWriteIntent | "load" | "commit",
		public readonly reason: AggregateTrackingFailure,
		public readonly registeredIntent?: AggregateWriteIntent,
	) {
		super(
			"AGGREGATE_TRACKING",
			trackingFailureMessage(aggregateId, operation, reason, registeredIntent),
		);
	}
}

function trackingFailureMessage(
	aggregateId: string,
	operation: AggregateWriteIntent | "load" | "commit",
	reason: AggregateTrackingFailure,
	registeredIntent: AggregateWriteIntent | undefined,
): string {
	switch (reason) {
		case "not_loaded":
			return (
				`Aggregate ${aggregateId} cannot be registered for ${operation}: ` +
				"it was not loaded into this unit of work. Load it through the " +
				"repository before updating or removing it."
			);
		case "loaded_as_new":
			return (
				`Aggregate ${aggregateId} cannot be added as new because it was ` +
				"loaded by this unit of work. Use update for a loaded aggregate."
			);
		case "different_repository":
			return (
				`Aggregate ${aggregateId} cannot be registered for ${operation} through ` +
				"a different repository in the same unit of work. One aggregate instance " +
				"must remain owned by the repository definition that first tracked it."
			);
		case "conflicting_intent":
			return (
				`Aggregate ${aggregateId} is already registered for ` +
				`${registeredIntent ?? "another write"}; ${operation} would create ` +
				"conflicting persistence intent in one unit of work. Decide the final " +
				"lifecycle outcome before registering it."
			);
		case "mutated_after_registration":
			return (
				`Aggregate ${aggregateId} changed after ${registeredIntent ?? "write"} ` +
				"was registered. Make domain decisions first and call add, update, or " +
				"remove last so persisted state and recorded events cannot diverge."
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
 * deterministic post-completion failure, a harvest-guard violation (an
 * event missing `aggregateId` / `aggregateType`, or an eventful persisted
 * aggregate that did not advance its version), is a programming bug and surfaces as
 * {@link EventHarvestError} instead, which does NOT extend
 * `InfrastructureError`, so it stays out of retry paths by construction.
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
 * The work callback threw AND the transaction scope rejected with a
 * DIFFERENT error that does not wrap the callback's error in its cause
 * chain - the strongest available signal that the rollback itself
 * failed. The callback's (primary) error is preserved as `cause`, so
 * cause-chain helpers (`someChainRetryable`, `findInCauseChain`) still
 * see a wrapped `ConcurrencyConflictError` & co.; the scope's error is
 * carried in {@link rollbackCause}.
 *
 * Scopes that rethrow the original error (Drizzle, Prisma do) never
 * produce this; scopes that WRAP the original are detected via the
 * cause chain and passed through unchanged instead.
 */
export class RollbackError extends InfrastructureError<"ROLLBACK_FAILED"> {
	constructor(
		cause: unknown,
		public readonly rollbackCause: unknown,
	) {
		super({
			code: "ROLLBACK_FAILED",
			message:
				"The work callback failed and the transaction scope rejected with a " +
				"different error (possible rollback failure). The callback's error " +
				"is the cause; the scope's error is in rollbackCause.",
			cause,
		});
	}
}
