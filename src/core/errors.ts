import { BaseError } from "@shirudo/base-error";

/**
 * Abstract base for **domain-invariant violations**. Domain methods
 * (aggregates, entity validation hooks, value-object constructors)
 * throw `DomainError`-derived exceptions when a business rule is
 * violated. Consumers derive their own concrete errors (e.g.
 * `class OrderAlreadyShippedError extends DomainError<"OrderAlreadyShippedError"> {}`)
 * for `instanceof`-style catching at the App-Service boundary, where
 * they typically map to HTTP 400 / business-rule responses.
 *
 * The library itself does **not** ship any concrete `DomainError`
 * subclass: the kit can't know your invariants.
 *
 * Extends `BaseError<Name>`; see `@shirudo/base-error` for the inherited
 * surface (timestamps, cause chains, `toJSON()`, `isRetryable`, …). For
 * client-safe / localized messages, project errors through the opt-in
 * `@shirudo/base-error/public-error` subpath at the boundary; the technical
 * core deliberately carries no user-facing message.
 */
export abstract class DomainError<
	Name extends string = string,
> extends BaseError<Name> {}

/**
 * Abstract base for **infrastructure / persistence failures** that the
 * App-Service can recover from: typically by retrying, by returning
 * HTTP 404 / 409, or by surfacing a "please try again" UX. These are
 * not domain-invariant violations (the business rules were not
 * broken); they describe race conditions and missing rows at the
 * storage boundary.
 *
 * Library-internal concrete subclasses: {@link AggregateNotFoundError},
 * {@link ConcurrencyConflictError}, {@link DuplicateAggregateError},
 * plus the unit-of-work lifecycle wrappers `CommitError` and
 * `RollbackError` (in `src/app/unit-of-work.ts`).
 */
export abstract class InfrastructureError<
	Name extends string = string,
> extends BaseError<Name> {}

/**
 * Thrown by `EventSourcedAggregate.apply()` when no handler is
 * registered for the event's type. This means the aggregate's subclass
 * forgot to add an entry to its `handlers` map: a programming /
 * configuration bug, not a domain or infrastructure failure.
 *
 * Deliberately **not** on `DomainError` or `InfrastructureError`:
 * a generic `catch (e instanceof DomainError)` handler at the App
 * layer must not mask a forgotten handler; this should crash loud and
 * fail the calling Use Case so the bug surfaces in development. The
 * replay methods (`loadFromHistory`, `restoreFromSnapshotWithEvents`)
 * also let it propagate uncaught instead of wrapping it in `Result.Err`.
 *
 * Use `isBaseError(e)` from `@shirudo/base-error` to detect
 * "any structured error from the kit or any other BaseError-using
 * library" at the App boundary.
 */
export class MissingHandlerError extends BaseError<"MissingHandlerError"> {
	constructor(
		public readonly eventType: string,
		cause?: unknown,
	) {
		super(`Missing handler for event type: ${eventType}`, cause, {
			name: "MissingHandlerError",
		});
	}
}

/**
 * Thrown by `Entity` (constructor and `setState`) when a plain-object,
 * null-prototype, or array state carries an own `"__proto__"` data key:
 * the shape `JSON.parse` produces for hostile DB rows or request bodies
 * handed to reconstitute factories. Such a key can never be legitimate
 * domain state; accepting it would hand a prototype-pollution payload to
 * every downstream consumer that copies the state through `[[Set]]`
 * (`Object.assign`, for-in assignment loops), and dropping it would be
 * silent data mutation.
 *
 * Deliberately **not** a `DomainError` or `InfrastructureError` (same
 * posture as {@link MissingHandlerError}): untrusted input reaching the
 * domain layer unvalidated is a boundary bug, and a generic
 * business-rule handler must not absorb it. Validate and strip untrusted
 * input at the application edge; model genuinely arbitrary keys with a
 * `Map`, not a plain object.
 */
export class HostileStateKeyError extends BaseError<"HostileStateKeyError"> {
	constructor(public readonly key: string) {
		super(
			`Entity state carries a hostile own "${key}" key, which can never ` +
				"be legitimate domain state. Validate and strip untrusted input " +
				"at the boundary, or model arbitrary keys with a Map.",
			undefined,
			{ name: "HostileStateKeyError" },
		);
	}
}

/**
 * Thrown by `EventSourcedAggregate.loadFromHistory`,
 * `restoreFromSnapshotWithEvents`, and `AggregateRoot.restoreFromSnapshot`
 * when the restore/replay target is not fresh: the aggregate carries
 * unflushed `pendingEvents`, or (for `loadFromHistory`) an in-memory
 * version that was never persisted. Restoring onto such an instance
 * would `markRestored` a version baseline the unflushed events were
 * never part of: repository routing flips from INSERT to UPDATE (or
 * appends with a wrong expected version) and harvested events would
 * claim history the stream does not carry.
 *
 * Deliberately **not** a `DomainError` or `InfrastructureError` (same
 * posture as {@link MissingHandlerError}): a deterministic programming
 * bug in how the aggregate was constructed before the restore. It
 * propagates as a throw instead of riding the replay methods' `Result`
 * channel, so a generic corrupted-stream handler cannot absorb it.
 * Reconstitution belongs on a bare instance: construct the aggregate
 * without factory-recorded events or prior mutations, then restore.
 *
 * The safe remedy differs per guard, so each throw site carries its own
 * in the `reason` it passes: `clearPendingEvents()` when deliberately
 * discarding unflushed events (an in-memory undo), `markPersisted()`
 * only for a catch-up replay after the state was actually saved. The
 * class message itself stays remediation-neutral.
 */
export class UnreplayableAggregateError extends BaseError<"UnreplayableAggregateError"> {
	constructor(
		public readonly aggregateId: string,
		reason: string,
	) {
		super(
			`Cannot restore or replay onto aggregate ${aggregateId}: ${reason}. ` +
				"Reconstitute on a fresh instance (no factory-recorded events, " +
				"no unpersisted mutations).",
			undefined,
			{ name: "UnreplayableAggregateError" },
		);
	}
}

/**
 * Thrown by `withCommit` when an event harvested from an aggregate cannot
 * be safely committed: it is missing `aggregateId` / `aggregateType`
 * (downstream routing would break), or it carries a pre-set
 * `aggregateVersion` AHEAD of the aggregate's commit version (a leaked or
 * copied fixture that would advance consumer idempotency watermarks past
 * real history). Both are programming bugs in how the aggregate recorded
 * the event, deterministic, and fail identically on every retry.
 *
 * Deliberately **not** an {@link InfrastructureError} (same reasoning as
 * {@link MissingHandlerError}): the failure happens after the work
 * callback completed, but it is NOT transient. A `catch (e instanceof
 * InfrastructureError)` retry handler, or a retrying `TransactionScope`,
 * must NOT mask it or loop on it forever; it should crash loud so the
 * recordEvent / createDomainEvent misuse surfaces in development. This is
 * why `withCommit` throws it directly and `UnitOfWork.run` passes it
 * through unchanged instead of wrapping it in `CommitError`.
 */
export class EventHarvestError extends BaseError<"EventHarvestError"> {
	constructor(
		message: string,
		/** The `type` of the offending event, for programmatic routing. */
		public readonly eventType?: string,
	) {
		super(message, undefined, { name: "EventHarvestError" });
	}
}

/** Constructor options for {@link UnregisteredHandlerError}. */
export interface UnregisteredHandlerErrorOptions {
	/** Which bus rejected the dispatch. */
	readonly busKind: "command" | "query";
	/** The message type no handler was registered for. */
	readonly messageType: string;
}

/**
 * Produced by the in-memory `CommandBus` / `QueryBus` when a message is
 * dispatched for a type no handler was registered under: a wiring bug
 * (typo in the type string, missing `register` call at bootstrap), not
 * a domain or infrastructure failure.
 *
 * Extends `BaseError` directly (same crash-loud family as
 * {@link MissingHandlerError}), and since v3 it is THROWN by `execute`
 * and `executeUnsafe` alike, never delivered through the error channel:
 * the channel carries expected failures a registered handler produced,
 * and a generic err-branch must not absorb a mis-wired bus. Catch it
 * only at a boundary that turns bugs into 500s.
 */
export class UnregisteredHandlerError extends BaseError<"UnregisteredHandlerError"> {
	readonly busKind: "command" | "query";
	readonly messageType: string;

	constructor(options: UnregisteredHandlerErrorOptions) {
		super(
			`No handler registered for ${options.busKind} type: ${options.messageType}`,
			undefined,
			{ name: "UnregisteredHandlerError" },
		);
		this.busKind = options.busKind;
		this.messageType = options.messageType;
	}
}

/** Constructor options for {@link ErrorMapperFailedError}. */
export interface ErrorMapperFailedErrorOptions {
	/** Which bus was mapping the failure. */
	readonly busKind: "command" | "query";
	/** The registered handler's ORIGINAL failure (also set as `cause`). */
	readonly handlerError: unknown;
	/** The value the errorMapper itself threw. */
	readonly mapperError: unknown;
}

/**
 * Produced by the in-memory `CommandBus` / `QueryBus` when the configured
 * `errorMapper` THROWS while mapping a registered handler's failure. A
 * broken mapper is a wiring bug: letting its throw propagate bare would
 * replace the handler's original failure entirely, and the rest of the
 * kit is fastidious about never letting a secondary failure mask the
 * primary one (`RollbackError.rollbackCause`, the neutralized observers).
 *
 * The handler's original failure is preserved as `cause` (so cause-chain
 * walks, retryability checks, and error-type mapping keep working) and
 * the mapper's own failure rides along as {@link mapperCause}.
 *
 * Extends `BaseError` directly (same crash-loud family as
 * {@link MissingHandlerError} and {@link UnregisteredHandlerError}): it is
 * thrown, never delivered through the error channel.
 */
export class ErrorMapperFailedError extends BaseError<"ErrorMapperFailedError"> {
	readonly busKind: "command" | "query";
	/** The value the errorMapper itself threw. */
	readonly mapperCause: unknown;

	constructor(options: ErrorMapperFailedErrorOptions) {
		super(
			`The ${options.busKind} bus errorMapper threw while mapping a ` +
				"handler failure. The original handler error is preserved as " +
				"cause; the mapper's own failure as mapperCause.",
			options.handlerError,
			{ name: "ErrorMapperFailedError" },
		);
		this.busKind = options.busKind;
		this.mapperCause = options.mapperError;
	}
}

/**
 * Thrown at the end of a `UnitOfWork.run` when an aggregate that was
 * loaded into the identity map during the operation carries unflushed
 * `pendingEvents` but was never enrolled (no `session.enrollSaved`, and
 * not deleted). The almost-certain cause is a repository `save()` that
 * forgot to call `enrollSaved`, or a use case that recorded events on a
 * loaded aggregate and never saved it. Without this guard those events
 * would be silently dropped: never harvested into the outbox, never
 * published.
 *
 * Deliberately **not** an `InfrastructureError` (same posture as
 * {@link MissingHandlerError}): a programming bug that must crash loud,
 * not be absorbed by a generic infrastructure-error handler. The throw
 * happens inside the transaction, so the unit of work rolls back and
 * leaves no partial state.
 *
 * **Scope of the guard.** A best-effort runtime safety net, not a proof.
 * It only sees aggregates the identity map knows about (those loaded via
 * `getById`), and detects new events by comparing the pending-event COUNT
 * at load against commit, which assumes the kit's append-only event model
 * (so it cannot see events that were recorded and then cleared within the
 * same run). A freshly *created* aggregate that was never enrolled is
 * invisible to the kit. The repository contract test suite remains the
 * full mitigation. See the Unit of Work guide.
 */
export class UnenrolledChangesError extends BaseError<"UnenrolledChangesError"> {
	constructor(public readonly aggregateId: string) {
		super(
			`Aggregate ${aggregateId} was loaded in this unit of work and has ` +
				"pending events, but was never enrolled (no save), so its events " +
				"would be silently dropped. Call repository.save(aggregate), and " +
				"ensure save() calls session.enrollSaved before the row write.",
			undefined,
			{ name: "UnenrolledChangesError" },
		);
	}
}

/**
 * Thrown when an aggregate that was deleted within the current unit of
 * work is saved or re-registered again in the same operation: by
 * `UnitOfWorkSession.enrollSaved` after `enrollDeleted` of the same
 * instance, and by `IdentityMap.set` for a type+id that was deleted.
 * Deletion is final within an operation; saving afterwards would write
 * a row the delete just removed (or resurrect it), which is always a
 * use-case bug.
 *
 * Extends `BaseError` directly (same reasoning as
 * {@link MissingHandlerError}): a programming bug that should crash
 * loud, not be absorbed by a generic infrastructure-error handler.
 */
export class AggregateDeletedError extends BaseError<"AggregateDeletedError"> {
	constructor(public readonly aggregateId: string) {
		super(
			`Aggregate ${aggregateId} was deleted in this unit of work and ` +
				"cannot be saved or registered again. Deletion is final within an " +
				"operation; if the aggregate must live, do not delete it.",
			undefined,
			{ name: "AggregateDeletedError" },
		);
	}
}

/**
 * Thrown by `IRepository.getByIdOrFail()` when an aggregate with the
 * given id does not exist. `InfrastructureError` because the storage
 * boundary, not a business rule, decided the row is absent. Use the
 * nullable variant `getById()` if "not found" is a valid outcome.
 *
 * Accepts an optional `cause` so a `Repository.save()` implementation
 * can wrap a lower-level "row not found" / driver-level error without
 * losing context. Cause-chain helpers (`getRootCause`,
 * `findInCauseChain`) from `@shirudo/base-error` traverse the chain.
 *
 * Not retryable: retrying won't make the row appear.
 */
export interface AggregateNotFoundErrorOptions {
	readonly aggregateType: string;
	readonly id: string;
	/** Optional lower-level error to preserve in the cause chain. */
	readonly cause?: unknown;
}

export class AggregateNotFoundError extends InfrastructureError<"AggregateNotFoundError"> {
	readonly aggregateType: string;
	readonly id: string;

	constructor(options: AggregateNotFoundErrorOptions) {
		super(
			`Aggregate not found: ${options.aggregateType}(${options.id})`,
			options.cause,
			{ name: "AggregateNotFoundError" },
		);
		this.aggregateType = options.aggregateType;
		this.id = options.id;
	}
}

/**
 * Thrown by a repository's `save()` INSERT path when a row with the
 * aggregate's id already exists (unique-constraint violation): two
 * concurrent creators raced on the same business-derived id, or the
 * id generator collided. Same delegation model as
 * {@link ConcurrencyConflictError}: the kit ships the class, the
 * consumer repository maps its driver's unique-violation signal to it
 * instead of letting a raw driver error escape -
 *
 * - Postgres: SQLSTATE `23505` (`unique_violation`)
 * - MySQL/MariaDB: errno `1062` (`ER_DUP_ENTRY`)
 * - SQLite: `SQLITE_CONSTRAINT_UNIQUE` (extended code 2067)
 *
 * `InfrastructureError` because the storage boundary detects the
 * collision. NOT retryable: re-running the same INSERT cannot succeed.
 * The right reactions are domain decisions - map to HTTP 409, or for
 * idempotency-key flows load the existing aggregate and treat the
 * request as already-applied.
 */
export interface DuplicateAggregateErrorOptions {
	readonly aggregateType: string;
	readonly aggregateId: string;
	/** Optional driver-level error to preserve in the cause chain. */
	readonly cause?: unknown;
}

export class DuplicateAggregateError extends InfrastructureError<"DuplicateAggregateError"> {
	readonly aggregateType: string;
	readonly aggregateId: string;

	constructor(options: DuplicateAggregateErrorOptions) {
		super(
			`Duplicate aggregate: ${options.aggregateType}(${options.aggregateId}) already exists`,
			options.cause,
			{ name: "DuplicateAggregateError" },
		);
		this.aggregateType = options.aggregateType;
		this.aggregateId = options.aggregateId;
	}
}

/**
 * Thrown on snapshot restore (`restoreFromSnapshot`,
 * `restoreFromSnapshotWithEvents`) when the stored snapshot carries a
 * different schema version than the aggregate's declared
 * `snapshotSchemaVersion` and no `migrateSnapshotState` override handles
 * the upgrade. Without the check, a snapshot written against an older
 * `TSnapshotState` shape would surface as an undefined-field crash on
 * the first method call after a much later restore.
 *
 * `InfrastructureError` because the storage boundary served outdated
 * data; the schema evolving past stored snapshots is an expected
 * lifecycle event, not a programming bug. NOT retryable: the recovery
 * is a code path, not a repeat. Either override `migrateSnapshotState`
 * on the aggregate (upgrade old shapes in place), or catch this error
 * in the repository, discard the snapshot, and refold from the full
 * event stream / reload from the source of truth.
 */
export interface SnapshotSchemaMismatchErrorOptions {
	readonly aggregateType: string;
	readonly aggregateId: string;
	readonly expectedSchemaVersion: number;
	readonly actualSchemaVersion: number;
}

export class SnapshotSchemaMismatchError extends InfrastructureError<"SnapshotSchemaMismatchError"> {
	readonly aggregateType: string;
	readonly aggregateId: string;
	readonly expectedSchemaVersion: number;
	readonly actualSchemaVersion: number;

	constructor(options: SnapshotSchemaMismatchErrorOptions) {
		super(
			`Snapshot schema mismatch on ${options.aggregateType}(${options.aggregateId}): ` +
				`the aggregate expects snapshot schema ${options.expectedSchemaVersion}, ` +
				`the stored snapshot carries ${options.actualSchemaVersion}. Override ` +
				`migrateSnapshotState to upgrade old snapshots, or discard the snapshot ` +
				`and refold from the full event stream.`,
			undefined,
			{ name: "SnapshotSchemaMismatchError" },
		);
		this.aggregateType = options.aggregateType;
		this.aggregateId = options.aggregateId;
		this.expectedSchemaVersion = options.expectedSchemaVersion;
		this.actualSchemaVersion = options.actualSchemaVersion;
	}
}

/**
 * Thrown by `IRepository.save()` when the aggregate's expected version
 * does not match the version currently persisted: i.e. another writer
 * updated the aggregate concurrently. The canonical optimistic-
 * concurrency signal; the App-Service typically reloads, re-applies
 * the use case, and retries, or surfaces HTTP 409 to the caller.
 *
 * **Retry means a FRESH unit of work** (a new `UnitOfWork.run()` /
 * `withCommit` invocation): reload, re-apply, save. Do NOT catch this
 * inside the same `run()` callback and continue: the failed aggregate
 * is already enrolled (its events would be committed for a write that
 * never happened) and the identity map still serves the same stale
 * instance to any in-place "reload".
 *
 * `InfrastructureError` because the persistence layer (not a domain
 * rule) detects the race. Marks itself as `retryable: true` so the
 * `isRetryable` predicate from `@shirudo/base-error` picks it up.
 */
export interface ConcurrencyConflictErrorOptions {
	readonly aggregateType: string;
	readonly aggregateId: string;
	readonly expectedVersion: number;
	readonly actualVersion: number;
	/** Optional driver-level error to preserve in the cause chain. */
	readonly cause?: unknown;
}

export class ConcurrencyConflictError extends InfrastructureError<"ConcurrencyConflictError"> {
	/**
	 * Marks this error as retryable so `isRetryable(err)` returns
	 * true. The canonical OCC pattern is to reload the aggregate, re-apply
	 * the use case, and retry on this exception.
	 */
	readonly retryable = true as const;

	readonly aggregateType: string;
	readonly aggregateId: string;
	readonly expectedVersion: number;
	readonly actualVersion: number;

	constructor(options: ConcurrencyConflictErrorOptions) {
		super(
			`Concurrency conflict on ${options.aggregateType}(${options.aggregateId}): expected version ${options.expectedVersion}, actual ${options.actualVersion}`,
			options.cause,
			{ name: "ConcurrencyConflictError" },
		);
		this.aggregateType = options.aggregateType;
		this.aggregateId = options.aggregateId;
		this.expectedVersion = options.expectedVersion;
		this.actualVersion = options.actualVersion;
	}
}
