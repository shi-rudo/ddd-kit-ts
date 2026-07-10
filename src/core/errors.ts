import { StructuredError } from "@shirudo/base-error";

/**
 * **The kit's error identity model (since v3).** Every kit error is a
 * structured error carrying exactly ONE identifier: `code`, a stable
 * SCREAMING_SNAKE string, and `error.name === error.code` by design, so
 * there is no name/code drift and nothing to keep in sync. `category`
 * follows the class hierarchy mechanically (`"DOMAIN"`,
 * `"INFRASTRUCTURE"`, or `"WIRING"` for the crash-loud family) and
 * `retryable` is a plain boolean field.
 *
 * **No base-error adoption required.** Consumers branch with a plain
 * `switch (error.code)`, catch via `instanceof DomainError` /
 * `instanceof InfrastructureError` (exported from this kit), and read
 * `retryable` / `cause` as ordinary properties. base-error's toolbox
 * (`matchError` exhaustive dispatch, `isStructuredError`, the
 * public-error catalog and `toProblem`) works on every kit error as an
 * OPT-IN benefit on top, never as a prerequisite.
 */

/**
 * Options for consumer subclasses of {@link DomainError} and
 * {@link InfrastructureError}: the `code` (which also becomes
 * `error.name`) and the technical `message` are the only obligations;
 * `retryable` defaults to `false` and the category is fixed by the base.
 */
export interface KitErrorOptions<TCode extends string> {
	/** Stable SCREAMING_SNAKE identifier; also becomes `error.name`. */
	code: TCode;
	/** Technical message for logs and debugging, never for clients. */
	message: string;
	/** Optional underlying error preserved in the cause chain. */
	cause?: unknown;
	/** Whether retrying the failed operation can succeed. Default `false`. */
	retryable?: boolean;
}

/**
 * Abstract base for **domain-invariant violations**. Domain methods
 * (aggregates, entity validation hooks, value-object constructors)
 * throw `DomainError`-derived exceptions when a business rule is
 * violated. Consumers derive their own concrete errors (e.g.
 * `class OrderAlreadyShippedError extends DomainError<"ORDER_ALREADY_SHIPPED">`)
 * for `instanceof`-style catching at the App-Service boundary, where
 * they typically map to HTTP 400 / business-rule responses.
 *
 * The library itself ships no business-rule `DomainError` subclass: the
 * kit can't know your invariants. (The domain-state-machine module's
 * transition errors are the structural exception.)
 *
 * The `category` is fixed to `"DOMAIN"` and `retryable` defaults to
 * `false`, so a subclass supplies only its `code` and `message`:
 *
 * ```ts
 * class OrderAlreadyShippedError extends DomainError<"ORDER_ALREADY_SHIPPED"> {
 *   constructor(orderId: string) {
 *     super({
 *       code: "ORDER_ALREADY_SHIPPED",
 *       message: `Order ${orderId} has already been shipped`,
 *     });
 *   }
 * }
 * ```
 */
export abstract class DomainError<
	TCode extends string = string,
> extends StructuredError<TCode, "DOMAIN"> {
	protected constructor(options: KitErrorOptions<TCode>) {
		super({
			code: options.code,
			category: "DOMAIN",
			retryable: options.retryable ?? false,
			message: options.message,
			cause: options.cause,
		});
	}
}

/**
 * Internal base for the kit's crash-loud **WIRING** family: deterministic
 * programming/configuration bugs that must fail the operation loudly and
 * never be absorbed by generic domain or infrastructure handlers. One
 * implementation of the `{ category: "WIRING", retryable: false }` shape
 * so the family cannot drift. Exported for the kit's own modules only;
 * not part of the package entries.
 */
export abstract class KitWiringError<
	TCode extends string,
> extends StructuredError<TCode, "WIRING"> {
	protected constructor(code: TCode, message: string, cause?: unknown) {
		super({ code, category: "WIRING", retryable: false, message, cause });
	}
}

/**
 * Abstract base for **infrastructure / persistence failures** that the
 * App-Service can recover from: typically by retrying, by returning
 * HTTP 404 / 409, or by surfacing a "please try again" UX. These are
 * not domain-invariant violations (the business rules were not
 * broken); they describe race conditions and missing rows at the
 * storage boundary.
 *
 * The `category` is fixed to `"INFRASTRUCTURE"`; `retryable` defaults
 * to `false` (opt in per subclass, see {@link ConcurrencyConflictError}).
 *
 * Library-internal concrete subclasses: {@link AggregateNotFoundError},
 * {@link ConcurrencyConflictError}, {@link DuplicateAggregateError},
 * plus the unit-of-work lifecycle wrappers `CommitError` and
 * `RollbackError` (in `src/app/unit-of-work.ts`).
 */
export abstract class InfrastructureError<
	TCode extends string = string,
> extends StructuredError<TCode, "INFRASTRUCTURE"> {
	protected constructor(options: KitErrorOptions<TCode>) {
		super({
			code: options.code,
			category: "INFRASTRUCTURE",
			retryable: options.retryable ?? false,
			message: options.message,
			cause: options.cause,
		});
	}
}

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
export class MissingHandlerError extends KitWiringError<"MISSING_HANDLER"> {
	constructor(
		public readonly eventType: string,
		cause?: unknown,
	) {
		super(
			"MISSING_HANDLER",
			`Missing handler for event type: ${eventType}`,
			cause,
		);
	}
}

/**
 * Thrown by `Projector.project` when an event cannot be watermarked:
 * it carries no `(aggregateVersion, commitSequence)` cursor (and no
 * custom `position` extractor covered it) or no `aggregateId`. An
 * unwatermarkable event cannot be deduped or ordered, so applying it
 * would silently break projection idempotency on redelivery; the
 * batch fails BEFORE anything is applied. Events written by
 * `withCommit` are stamped automatically; for other sources supply
 * the `position` extractor.
 *
 * A wiring error, not a `DomainError`: see {@link MissingHandlerError}
 * for the rationale of crashing loud at the App layer.
 */
export class UnprojectableEventError extends KitWiringError<"UNPROJECTABLE_EVENT"> {
	constructor(
		public readonly projection: string,
		public readonly eventId: string,
		reason: string,
		cause?: unknown,
	) {
		super(
			"UNPROJECTABLE_EVENT",
			`Projector(${projection}): event ${eventId} ${reason}`,
			cause,
		);
	}
}

/**
 * Thrown by `Entity` (constructor and `setState`) and by the event
 * metadata helpers (`createDomainEvent`'s `options.metadata`,
 * `mergeMetadata`, `copyMetadata`) when the value carries an own
 * `"__proto__"` data key:
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
export class HostileStateKeyError extends KitWiringError<"HOSTILE_STATE_KEY"> {
	constructor(
		public readonly key: string,
		subject: string = "Entity state",
	) {
		super(
			"HOSTILE_STATE_KEY",
			`${subject} carries a hostile own "${key}" key, which can never ` +
				"be legitimate domain data. Validate and strip untrusted input " +
				"at the boundary, or model arbitrary keys with a Map.",
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
export class UnreplayableAggregateError extends KitWiringError<"UNREPLAYABLE_AGGREGATE"> {
	constructor(
		public readonly aggregateId: string,
		reason: string,
	) {
		super(
			"UNREPLAYABLE_AGGREGATE",
			`Cannot restore or replay onto aggregate ${aggregateId}: ${reason}. ` +
				"Reconstitute on a fresh instance (no factory-recorded events, " +
				"no unpersisted mutations).",
		);
	}
}

/**
 * Thrown by `EventSourcedAggregate.apply()` when a NEW event carries an
 * `aggregateId` or `aggregateType` naming a different aggregate: a
 * deterministic programming bug at the call site (a hand-built or
 * copied event addressed elsewhere), caught before the event can be
 * recorded and poison the own stream. Events with MISSING address
 * fields do not trip this: `apply()` stamps them from the aggregate,
 * the same guarantee `recordEvent` gives. A wiring error, distinct
 * from {@link ForeignEventError} on purpose: a wrong new event is a
 * bug in today's code, a wrong PERSISTED row is corrupted or miswired
 * infrastructure, and handlers for one must not absorb the other.
 */
export class MisaddressedEventError extends KitWiringError<"MISADDRESSED_EVENT"> {
	constructor(
		public readonly expectedAggregateId: string,
		public readonly expectedAggregateType: string,
		public readonly eventType: string,
		public readonly actualAggregateId?: string,
		public readonly actualAggregateType?: string,
	) {
		super(
			"MISADDRESSED_EVENT",
			`New event "${eventType}" is addressed to ` +
				`${actualAggregateType ?? expectedAggregateType} ${actualAggregateId ?? expectedAggregateId} ` +
				`but was applied on ${expectedAggregateType} ${expectedAggregateId}: ` +
				"fix the call site (recordEvent stamps the right address).",
		);
	}
}

/**
 * Thrown by the replay entry points (`loadFromHistory`,
 * `restoreFromSnapshotWithEvents`) when a HISTORY event carries an
 * `aggregateId` or `aggregateType` that names a different aggregate:
 * the persisted row belongs to someone else (a miswired stream read,
 * ids colliding across aggregate types, a corrupted store). An
 * `InfrastructureError`, NOT a `DomainError` (same posture as
 * {@link SnapshotSchemaMismatchError}): a wrong address is data
 * corruption or wiring, never an expected business rejection, so it
 * must not be absorbed by generic domain error handling or presented
 * as a 4xx. It therefore PROPAGATES as a throw through the replay
 * methods' `Result` contract (which reserves `Err` for `DomainError`),
 * after the usual all-or-nothing rollback. History events without the
 * optional address fields pass unchecked (the fields are optional on
 * the event shape); new events are covered by
 * {@link MisaddressedEventError}.
 */
export class ForeignEventError extends InfrastructureError<"FOREIGN_EVENT"> {
	constructor(
		public readonly expectedAggregateId: string,
		public readonly expectedAggregateType: string,
		public readonly eventType: string,
		public readonly actualAggregateId?: string,
		public readonly actualAggregateType?: string,
	) {
		super({
			code: "FOREIGN_EVENT",
			message:
				`Replayed event "${eventType}" belongs to ` +
				`${actualAggregateType ?? expectedAggregateType} ${actualAggregateId ?? expectedAggregateId}, ` +
				`not to ${expectedAggregateType} ${expectedAggregateId}: ` +
				"the stream row addresses a different aggregate.",
		});
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
export class EventHarvestError extends KitWiringError<"EVENT_HARVEST_FAILED"> {
	constructor(
		message: string,
		/** The `type` of the offending event, for programmatic routing. */
		public readonly eventType?: string,
	) {
		super("EVENT_HARVEST_FAILED", message);
	}
}

/**
 * Shared guard for the loud-rejection contract on own `__proto__` data
 * keys (the shape `JSON.parse` produces for hostile rows, bodies, or
 * envelopes): used by `Entity` state copies and the event metadata
 * helpers. One implementation so the contract cannot drift.
 * Module-internal export; not part of the package entries.
 */
export function assertNoHostileOwnProtoKey(
	value: object,
	subject: string,
): void {
	if (Object.hasOwn(value, "__proto__")) {
		throw new HostileStateKeyError("__proto__", subject);
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
 * Carries the `WIRING` category (same crash-loud family as
 * {@link MissingHandlerError}), and since v3 it is THROWN by `execute`
 * and `executeUnsafe` alike, never delivered through the error channel:
 * the channel carries expected failures a registered handler produced,
 * and a generic err-branch must not absorb a mis-wired bus. Catch it
 * only at a boundary that turns bugs into 500s.
 */
export class UnregisteredHandlerError extends KitWiringError<"UNREGISTERED_HANDLER"> {
	readonly busKind: "command" | "query";
	readonly messageType: string;

	constructor(options: UnregisteredHandlerErrorOptions) {
		super(
			"UNREGISTERED_HANDLER",
			`No handler registered for ${options.busKind} type: ${options.messageType}`,
		);
		this.busKind = options.busKind;
		this.messageType = options.messageType;
	}
}

/** Constructor options for {@link DuplicateHandlerRegistrationError}. */
export interface DuplicateHandlerRegistrationErrorOptions {
	/** Which bus rejected the registration. */
	readonly busKind: "command" | "query";
	/** The message type a handler was already registered for. */
	readonly messageType: string;
}

/**
 * Produced by `CommandBus.register` / `QueryBus.register` when a handler
 * is registered for a type that already has one: silent replacement would
 * turn the first handler into dead code with no signal, so the wiring bug
 * surfaces at registration time. Same crash-loud family as
 * {@link UnregisteredHandlerError}; catch it only at a boundary that
 * turns bugs into 500s.
 */
export class DuplicateHandlerRegistrationError extends KitWiringError<"DUPLICATE_HANDLER_REGISTRATION"> {
	readonly busKind: "command" | "query";
	readonly messageType: string;

	constructor(options: DuplicateHandlerRegistrationErrorOptions) {
		super(
			"DUPLICATE_HANDLER_REGISTRATION",
			`A handler for ${options.busKind} type "${options.messageType}" is ` +
				"already registered; the duplicate would silently shadow the " +
				"first. Register each type exactly once at bootstrap.",
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
 * Carries the `WIRING` category (same crash-loud family as
 * {@link MissingHandlerError} and {@link UnregisteredHandlerError}): it is
 * thrown, never delivered through the error channel.
 */
export class ErrorMapperFailedError extends KitWiringError<"ERROR_MAPPER_FAILED"> {
	readonly busKind: "command" | "query";
	/** The value the errorMapper itself threw. */
	readonly mapperCause: unknown;

	constructor(options: ErrorMapperFailedErrorOptions) {
		super(
			"ERROR_MAPPER_FAILED",
			`The ${options.busKind} bus errorMapper threw while mapping a ` +
				"handler failure. The original handler error is preserved as " +
				"cause; the mapper's own failure as mapperCause.",
			options.handlerError,
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
 * `findById`), and detects new events by comparing the pending-event COUNT
 * at load against commit, which assumes the kit's append-only event model
 * (so it cannot see events that were recorded and then cleared within the
 * same run). A freshly *created* aggregate that was never enrolled is
 * invisible to the kit. The repository contract test suite remains the
 * full mitigation. See the Unit of Work guide.
 */
export class UnenrolledChangesError extends KitWiringError<"UNENROLLED_CHANGES"> {
	constructor(public readonly aggregateId: string) {
		super(
			"UNENROLLED_CHANGES",
			`Aggregate ${aggregateId} was loaded in this unit of work and has ` +
				"pending events, but was never enrolled (no save), so its events " +
				"would be silently dropped. Call repository.save(aggregate), and " +
				"ensure save() calls session.enrollSaved before the row write.",
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
 * Carries the `WIRING` category (same reasoning as
 * {@link MissingHandlerError}): a programming bug that should crash
 * loud, not be absorbed by a generic infrastructure-error handler.
 */
export class AggregateDeletedError extends KitWiringError<"AGGREGATE_DELETED"> {
	constructor(public readonly aggregateId: string) {
		super(
			"AGGREGATE_DELETED",
			`Aggregate ${aggregateId} was deleted in this unit of work and ` +
				"cannot be saved or registered again. Deletion is final within an " +
				"operation; if the aggregate must live, do not delete it.",
		);
	}
}

/**
 * Thrown by `IRepository.getById()` when an aggregate with the
 * given id does not exist. `InfrastructureError` because the storage
 * boundary, not a business rule, decided the row is absent. Use the
 * nullable variant `findById()` if "not found" is a valid outcome.
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

export class AggregateNotFoundError extends InfrastructureError<"AGGREGATE_NOT_FOUND"> {
	readonly aggregateType: string;
	readonly id: string;

	constructor(options: AggregateNotFoundErrorOptions) {
		super({
			code: "AGGREGATE_NOT_FOUND",
			message: `Aggregate not found: ${options.aggregateType}(${options.id})`,
			cause: options.cause,
		});
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

export class DuplicateAggregateError extends InfrastructureError<"DUPLICATE_AGGREGATE"> {
	readonly aggregateType: string;
	readonly aggregateId: string;

	constructor(options: DuplicateAggregateErrorOptions) {
		super({
			code: "DUPLICATE_AGGREGATE",
			message: `Duplicate aggregate: ${options.aggregateType}(${options.aggregateId}) already exists`,
			cause: options.cause,
		});
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

export class SnapshotSchemaMismatchError extends InfrastructureError<"SNAPSHOT_SCHEMA_MISMATCH"> {
	readonly aggregateType: string;
	readonly aggregateId: string;
	readonly expectedSchemaVersion: number;
	readonly actualSchemaVersion: number;

	constructor(options: SnapshotSchemaMismatchErrorOptions) {
		super({
			code: "SNAPSHOT_SCHEMA_MISMATCH",
			message:
				`Snapshot schema mismatch on ${options.aggregateType}(${options.aggregateId}): ` +
				`the aggregate expects snapshot schema ${options.expectedSchemaVersion}, ` +
				`the stored snapshot carries ${options.actualSchemaVersion}. Override ` +
				`migrateSnapshotState to upgrade old snapshots, or discard the snapshot ` +
				`and refold from the full event stream.`,
		});
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

export class ConcurrencyConflictError extends InfrastructureError<"CONCURRENCY_CONFLICT"> {
	readonly aggregateType: string;
	readonly aggregateId: string;
	readonly expectedVersion: number;
	readonly actualVersion: number;

	constructor(options: ConcurrencyConflictErrorOptions) {
		super({
			code: "CONCURRENCY_CONFLICT",
			message: `Concurrency conflict on ${options.aggregateType}(${options.aggregateId}): expected version ${options.expectedVersion}, actual ${options.actualVersion}`,
			cause: options.cause,
			// The canonical OCC pattern: reload the aggregate, re-apply the
			// use case, retry in a FRESH unit of work. The structured field
			// is what the retry classifier (someChainRetryable) reads.
			retryable: true,
		});
		this.aggregateType = options.aggregateType;
		this.aggregateId = options.aggregateId;
		this.expectedVersion = options.expectedVersion;
		this.actualVersion = options.actualVersion;
	}
}

/**
 * Options bag for {@link IdempotencyKeyReuseError}.
 */
export interface IdempotencyKeyReuseErrorOptions {
	readonly key: string;
	readonly storedFingerprint: string;
	readonly receivedFingerprint: string;
	/** Optional driver-level error to preserve in the cause chain. */
	readonly cause?: unknown;
}

/**
 * Thrown by `IdempotencyStore.claim()` when the same idempotency key
 * arrives with a DIFFERENT command fingerprint than the one it was
 * first claimed with: the caller is reusing a key for a different
 * command. Replaying the stored outcome would answer a question that
 * was never asked; rejecting is the only safe reaction.
 *
 * `InfrastructureError` because the store detects the collision, same
 * delegation model as {@link DuplicateAggregateError}. NOT retryable:
 * re-sending the same mismatched pair cannot succeed. Map it to an
 * unprocessable/conflict application outcome.
 */
export class IdempotencyKeyReuseError extends InfrastructureError<"IDEMPOTENCY_KEY_REUSE"> {
	readonly key: string;
	readonly storedFingerprint: string;
	readonly receivedFingerprint: string;

	constructor(options: IdempotencyKeyReuseErrorOptions) {
		super({
			code: "IDEMPOTENCY_KEY_REUSE",
			message:
				`Idempotency key reuse on "${options.key}": stored fingerprint ` +
				`${options.storedFingerprint}, received ${options.receivedFingerprint}`,
			cause: options.cause,
		});
		this.key = options.key;
		this.storedFingerprint = options.storedFingerprint;
		this.receivedFingerprint = options.receivedFingerprint;
	}
}

/**
 * Options bag for {@link IdempotencyInFlightError}.
 */
export interface IdempotencyInFlightErrorOptions {
	readonly key: string;
	/** Optional driver-level error to preserve in the cause chain. */
	readonly cause?: unknown;
}

/**
 * Thrown by `IdempotencyStore.claim()` when the key is already claimed
 * by an execution that has not completed yet: the first delivery of the
 * command is still running (or crashed mid-flight on a
 * non-transactional store). Retryable by design: a later retry either
 * finds the completed outcome and replays it, or finds the claim
 * released (rolled back) and executes fresh. `RetryingTransactionScope`
 * picks this up through the `retryable` flag without extra wiring.
 */
export class IdempotencyInFlightError extends InfrastructureError<"IDEMPOTENCY_IN_FLIGHT"> {
	readonly key: string;

	constructor(options: IdempotencyInFlightErrorOptions) {
		super({
			code: "IDEMPOTENCY_IN_FLIGHT",
			message:
				`Idempotency key "${options.key}" is claimed by an execution ` +
				`that has not completed yet`,
			cause: options.cause,
			retryable: true,
		});
		this.key = options.key;
	}
}

/**
 * Thrown by `IdempotencyStore.complete()` when no pending claim exists
 * for the key: `complete` ran without a preceding successful `claim`
 * in the same execution, or against a key whose claim was already
 * completed or abandoned. Always a wiring bug in hand-rolled
 * orchestration (`withIdempotentCommit` cannot produce it), hence the
 * crash-loud category.
 */
export class IdempotencyCompletionWithoutClaimError extends KitWiringError<"IDEMPOTENCY_COMPLETED_WITHOUT_CLAIM"> {
	constructor(public readonly key: string) {
		super(
			"IDEMPOTENCY_COMPLETED_WITHOUT_CLAIM",
			`IdempotencyStore.complete() called for key "${key}" without a ` +
				"pending claim; call claim() first (or use withIdempotentCommit)",
		);
	}
}

/**
 * The closed union of every error code the kit itself can produce
 * (consumer subclasses of {@link DomainError} / {@link InfrastructureError}
 * add their own on top). Useful for building `switch` tables or
 * base-error `matchError` cases that cover kit and consumer codes
 * together, without importing anything from base-error.
 */
export type KitErrorCode =
	| "AGGREGATE_DELETED"
	| "AGGREGATE_NOT_FOUND"
	| "COMMIT_FAILED"
	| "CONCURRENCY_CONFLICT"
	| "DOMAIN_TRANSITION_GUARD_REJECTED"
	| "DUPLICATE_AGGREGATE"
	| "DUPLICATE_HANDLER_REGISTRATION"
	| "ERROR_MAPPER_FAILED"
	| "EVENT_HARVEST_FAILED"
	| "FOREIGN_EVENT"
	| "HOSTILE_STATE_KEY"
	| "IDEMPOTENCY_COMPLETED_WITHOUT_CLAIM"
	| "IDEMPOTENCY_IN_FLIGHT"
	| "IDEMPOTENCY_KEY_REUSE"
	| "INVALID_DOMAIN_MACHINE_CONTEXT"
	| "INVALID_DOMAIN_MACHINE_DEFINITION"
	| "INVALID_DOMAIN_MACHINE_INPUT"
	| "INVALID_DOMAIN_MACHINE_SNAPSHOT"
	| "INVALID_DOMAIN_TRANSITION"
	| "INVALID_DOMAIN_TRANSITION_GUARD_RESULT"
	| "INVALID_DOMAIN_TRANSITION_RESULT"
	| "INVALID_MONEY"
	| "MISADDRESSED_EVENT"
	| "MISSING_HANDLER"
	| "MONEY_CURRENCY_MISMATCH"
	| "MONEY_PRECISION_LOSS"
	| "MONEY_SCALE_MISMATCH"
	| "NESTED_UNIT_OF_WORK"
	| "REENTRANT_DOMAIN_STATE_MACHINE_EVALUATION"
	| "ROLLBACK_FAILED"
	| "SNAPSHOT_SCHEMA_MISMATCH"
	| "TRANSACTION_CLOSED"
	| "UNENROLLED_CHANGES"
	| "UNKNOWN_CURRENCY"
	| "UNREGISTERED_HANDLER"
	| "UNREPLAYABLE_AGGREGATE";
