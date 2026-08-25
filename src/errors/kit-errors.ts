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
 * `RollbackError` (in `src/application/unit-of-work/errors.ts`).
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
 * Copy-safe membership check for the kit's domain-error family.
 *
 * `instanceof` is false for an error constructed by another loaded copy of
 * the kit (a separately installed adapter package, a CJS/ESM dual load), so
 * kit boundaries that route by error family fall back to the structural
 * `category` field, the stable cross-copy contract.
 */
export function isDomainErrorLike(value: unknown): value is DomainError {
	return (
		value instanceof DomainError ||
		(value instanceof Error &&
			(value as { readonly category?: unknown }).category === "DOMAIN")
	);
}

/**
 * Copy-safe membership check for the kit's infrastructure-error family.
 * Same rationale as {@link isDomainErrorLike}.
 */
export function isInfrastructureErrorLike(
	value: unknown,
): value is InfrastructureError {
	return (
		value instanceof InfrastructureError ||
		(value instanceof Error &&
			(value as { readonly category?: unknown }).category === "INFRASTRUCTURE")
	);
}

/** Options bag for {@link InMemoryCapacityExceededError}. */
export interface InMemoryCapacityExceededErrorOptions {
	/** Concrete reference adapter whose configured capacity was exhausted. */
	readonly store: string;
	/** Bounded collection or logical resource, such as `events` or `sources`. */
	readonly resource: string;
	/** Configured maximum number of retained records. */
	readonly limit: number;
	/** Records retained before the rejected operation. */
	readonly current: number;
	/** New records the rejected operation would have retained. */
	readonly attempted: number;
}

/**
 * A finite-capacity in-memory reference adapter rejected new state before
 * mutation. Existing records remain usable; callers must release explicit
 * lifecycle state, increase the configured limit, or switch to a durable
 * adapter. The error is not retryable without one of those external changes.
 */
export class InMemoryCapacityExceededError extends InfrastructureError<"IN_MEMORY_CAPACITY_EXCEEDED"> {
	readonly store: string;
	readonly resource: string;
	readonly limit: number;
	readonly current: number;
	readonly attempted: number;

	constructor(options: InMemoryCapacityExceededErrorOptions) {
		super({
			code: "IN_MEMORY_CAPACITY_EXCEEDED",
			message:
				`${options.store} cannot retain ${options.attempted} new ` +
				`${options.resource}: configured limit ${options.limit}, ` +
				`currently retained ${options.current}`,
		});
		this.store = options.store;
		this.resource = options.resource;
		this.limit = options.limit;
		this.current = options.current;
		this.attempted = options.attempted;
	}
}

/**
 * Thrown when event dispatch reaches a type with no own handler registration.
 * This covers `EventSourcedAggregate.apply()` and the exhaustive
 * `projectionFromHandlers` helper: the declared event union and its handler map
 * disagree at runtime, which is a programming / configuration bug rather than
 * a domain or infrastructure failure.
 *
 * Deliberately **not** on `DomainError` or `InfrastructureError`:
 * a generic `catch (e instanceof DomainError)` handler at the App
 * layer must not mask a forgotten handler; this should crash loud and
 * fail the calling Use Case so the bug surfaces in development. The
 * replay through `loadFromHistory` also lets it propagate uncaught instead
 * of wrapping it in `Result.Err`.
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
 * Thrown by an event-sourced aggregate when a handler returns `undefined`
 * for an event, which is almost always a fold without a `return` statement.
 * Storing that result would set the aggregate state to `undefined`, record
 * the fact anyway on the apply path, and leave every later fold working on
 * nothing. Same posture as {@link MissingHandlerError}: a deterministic bug
 * in the handler map, never a domain rejection, so it propagates through
 * `loadFromHistory` instead of riding its `Result`.
 */
export class HandlerReturnedNoStateError extends KitWiringError<"HANDLER_RETURNED_NO_STATE"> {
	constructor(public readonly eventType: string) {
		super(
			"HANDLER_RETURNED_NO_STATE",
			`The handler for event type "${eventType}" returned no state. ` +
				"A handler must return the next state; check for a missing " +
				"return statement.",
		);
	}
}

/**
 * Thrown by `EventSourcedAggregate.setState`: on an event-sourced aggregate
 * the state changes only through `apply()`, where the fact is recorded and
 * the version advances with it. A direct state write would leave the
 * instance ahead of its stream with nothing to replay. A wiring error: a
 * deterministic bug in the aggregate's own code, the remedy is an event
 * and a handler.
 */
export class DirectStateMutationError extends KitWiringError<"DIRECT_STATE_MUTATION"> {
	constructor(public readonly aggregateId: string) {
		super(
			"DIRECT_STATE_MUTATION",
			`Aggregate ${aggregateId} is event-sourced: its state changes only ` +
				"through apply(). Record the fact as an event and fold it in a " +
				"handler instead of calling setState.",
		);
	}
}

/**
 * Thrown by `Projector.project` when an event cannot be projected
 * safely because its cursor is missing or malformed, or its aggregate
 * address is absent. Applying such an event would break idempotency, so
 * the batch fails. Events written by `withCommit` carry the complete
 * cursor automatically; other sources compose a gap-proof committed-event
 * envelope. A well-formed cursor that does not continue the stored chain
 * instead throws {@link ProjectionGapError}.
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
 * Thrown when a valid projection cursor does not continue the stored
 * per-aggregate chain. This is an infrastructure/delivery failure: an
 * event or commit is missing, commonly because a partition reordered or
 * dead-lettered it. The projector does not apply the later event and the
 * checkpoint stays put until the missing history is replayed or the
 * projection is rebuilt.
 */
export class ProjectionGapError extends InfrastructureError<"PROJECTION_GAP"> {
	constructor(
		public readonly projection: string,
		public readonly eventId: string,
		public readonly previousPosition: string,
		public readonly receivedPosition: string,
	) {
		super({
			code: "PROJECTION_GAP",
			message:
				`Projector(${projection}): event ${eventId} creates a projection ` +
				`gap after ${previousPosition}; received ${receivedPosition}. ` +
				"Replay the missing commit before advancing the checkpoint.",
		});
	}
}

/**
 * Thrown when one batch delivers previously unseen positions of the same
 * aggregate in descending order. Unlike {@link ProjectionGapError}, this is
 * direct proof that the feed violated its per-aggregate ordering contract;
 * no missing-history inference is needed. Positions already covered by the
 * checkpoint at batch start and exact receipts repeated inside the batch
 * remain valid redeliveries and do not trip this diagnostic guard.
 */
export class ProjectionOrderViolationError extends InfrastructureError<"PROJECTION_ORDER_VIOLATION"> {
	constructor(
		public readonly projection: string,
		public readonly eventId: string,
		public readonly previousReceivedPosition: string,
		public readonly receivedPosition: string,
	) {
		super({
			code: "PROJECTION_ORDER_VIOLATION",
			message:
				`Projector(${projection}): event ${eventId} at ${receivedPosition} ` +
				`arrived after the later unprocessed position ${previousReceivedPosition} ` +
				"in the same batch. Partition or serialize the feed by aggregate source.",
		});
	}
}

/**
 * Thrown when a source maps different event identities to one position, either
 * inside the current batch or at the position stored as the projection's
 * watermark. The checkpoint retains the identity of that one last-applied
 * event, so the durable collision is provable without keeping an unbounded
 * processed-event ledger. Positions behind the watermark remain governed by
 * the source's one-logical-event-per-position contract.
 */
export class ProjectionIdentityViolationError extends InfrastructureError<"PROJECTION_IDENTITY_VIOLATION"> {
	constructor(
		public readonly projection: string,
		public readonly eventId: string,
		public readonly recordedEventId: string,
		public readonly position: string,
	) {
		super({
			code: "PROJECTION_IDENTITY_VIOLATION",
			message:
				`Projector(${projection}): position ${position} was already associated ` +
				`with event ${recordedEventId}, but the source supplied event ${eventId} ` +
				"at the same position. A source must map exactly one logical event to each position.",
		});
	}
}

/**
 * Thrown when one logical projection position keeps its event identity but its
 * commit-boundary receipt changes. `commitSize` and
 * `previousEventfulAggregateVersion` are part of the continuity proof, so a
 * source must keep them immutable just like the eventId. Accepting a
 * contradictory redelivery could hide an incomplete commit or predecessor.
 */
export class ProjectionReceiptViolationError extends InfrastructureError<"PROJECTION_RECEIPT_VIOLATION"> {
	constructor(
		public readonly projection: string,
		public readonly eventId: string,
		public readonly recordedReceipt: string,
		public readonly receivedReceipt: string,
	) {
		super({
			code: "PROJECTION_RECEIPT_VIOLATION",
			message:
				`Projector(${projection}): event ${eventId} changed its commit receipt ` +
				`at one logical position from ${recordedReceipt} to ${receivedReceipt}. ` +
				"A source must keep commitSize and previousEventfulAggregateVersion immutable.",
		});
	}
}

/** A malformed or non-JSON-safe message at an integration boundary. */
export class InvalidIntegrationMessageError extends InfrastructureError<"INVALID_INTEGRATION_MESSAGE"> {
	constructor(
		public readonly path: string,
		public readonly reason: string,
		cause?: unknown,
	) {
		super({
			code: "INVALID_INTEGRATION_MESSAGE",
			message: `Invalid integration message at ${path}: ${reason}`,
			cause,
		});
	}
}

/** A malformed or non-JSON-safe command selected for durable delivery. */
export class InvalidCommandMessageError extends InfrastructureError<"INVALID_COMMAND_MESSAGE"> {
	constructor(
		public readonly path: string,
		public readonly reason: string,
		cause?: unknown,
	) {
		super({
			code: "INVALID_COMMAND_MESSAGE",
			message: `Invalid command message at ${path}: ${reason}`,
			cause,
		});
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
 * Thrown by the `Entity` constructor when the id is `null` or `undefined`.
 * An entity without an identity cannot be tracked, compared, or persisted,
 * so the construction fails before any state is stored. A wiring error: a
 * deterministic bug at the call site, never a domain rejection.
 */
export class MissingEntityIdError extends KitWiringError<"MISSING_ENTITY_ID"> {
	constructor() {
		super("MISSING_ENTITY_ID", "Entity ID cannot be null or undefined.");
	}
}

/**
 * Thrown when a number that is not a valid aggregate version reaches the
 * kit: `toVersion`, `markRestored`, `setVersion`, and the post-commit
 * acknowledgement all reject it. A version is a safe integer of at least
 * zero, and a restore never moves below the current version. A wiring
 * error: an adapter passed a corrupt row value or a wrong number, and
 * the optimistic-concurrency cursor must not carry it. Not retryable.
 */
export class InvalidVersionError extends KitWiringError<"INVALID_VERSION"> {
	constructor(
		public readonly value: unknown,
		/** Why the value was rejected, for example "is not a safe integer". */
		public readonly reason: string,
	) {
		super(
			"INVALID_VERSION",
			`Version ${String(value)} ${reason}. A version is a safe integer of ` +
				"at least zero; create one with toVersion(n) from the stored " +
				"row value.",
		);
	}
}

/**
 * Thrown by `EventSourcedAggregate.loadFromHistory` when the replay target
 * carries unflushed `pendingEvents`. Replaying persisted facts onto that
 * instance would advance the version underneath decisions made against an
 * older state and could later claim history the stream does not carry.
 *
 * Deliberately **not** a `DomainError` or `InfrastructureError` (same
 * posture as {@link MissingHandlerError}): a deterministic programming
 * bug in how the aggregate was constructed before the restore. It
 * propagates as a throw instead of riding the replay methods' `Result`
 * channel, so a generic corrupted-stream handler cannot absorb it.
 * Reconstitution belongs on a bare instance: construct the aggregate
 * without factory-recorded events or prior mutations, then restore.
 *
 * Each throw site carries the safe remedy in its `reason`. Persistence
 * lifecycle state is intentionally not mutable through the aggregate API:
 * commit an actually saved instance through application orchestration, or
 * discard a dirty instance and replay into a fresh one.
 */
export class UnreplayableAggregateError extends KitWiringError<"UNREPLAYABLE_AGGREGATE"> {
	constructor(
		public readonly aggregateId: string,
		reason: string,
	) {
		super(
			"UNREPLAYABLE_AGGREGATE",
			`Cannot replay onto aggregate ${aggregateId}: ${reason}. ` +
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
 * the same guarantee `createEvent` gives. A wiring error, distinct
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
				"fix the call site (createEvent stamps the right address).",
		);
	}
}

/**
 * The structural-integrity rejection for a stored snapshot. A consumer's
 * adapter-owned `SnapshotModel` may throw it from migration or reconstitution
 * when the blob could not have been produced by any version of the model
 * (missing fields, impossible types, truncated data). An
 * `InfrastructureError`, because corrupted persistence is a storage
 * problem, never a business rejection; it is nevertheless RECOVERABLE
 * by design: the repository catches it, discards the derived snapshot, and
 * refolds from the authoritative event stream.
 */
export class SnapshotCorruptedError extends InfrastructureError<"SNAPSHOT_CORRUPTED"> {
	constructor(message: string, cause?: unknown) {
		super({ code: "SNAPSHOT_CORRUPTED", message, cause });
	}
}

/**
 * Thrown when an event reaches the aggregate's recording paths
 * (`apply`, `commit`, `addDomainEvent`) without having been minted by
 * the kit's constructors: `createDomainEvent`,
 * `createDomainEventFromFacts`, `createUncommittedDomainEvent`, or aggregate
 * event helpers
 * deep-freeze the event and defensively copy payload and metadata,
 * and register the result in an internal, unforgeable mint marker.
 * Anything else (a hand-rolled literal, a shallow-frozen copy with
 * mutable nested data) is rejected: a mutable event recorded next to
 * a state change can silently diverge from it afterwards. A wiring
 * error: deterministic bug at the call site, the remedy is minting
 * through the constructors.
 */
export class UnmintedEventError extends KitWiringError<"UNMINTED_EVENT"> {
	constructor(eventType: string) {
		super(
			"UNMINTED_EVENT",
			`Event "${eventType}" was not minted by a domain-event constructor ` +
				"or aggregate createEvent(...) helper. Those " +
				"constructors deep-freeze the event " +
				"and defensively copy payload and metadata; a mutable event " +
				"could diverge from the state change it records.",
		);
	}
}

/**
 * Thrown by `recordPendingEvents` when the aggregate's pending-event list
 * changes while its events are being stamped: a stamp provider that
 * directly or transitively triggers a new decision on the same aggregate
 * would otherwise have that decision silently discarded when recording
 * replaces the pending list. Recording is atomic: when this guard fires,
 * every decision (including the re-entrant one) remains unrecorded. A
 * wiring error: deterministic bug at the call site, the remedy is keeping
 * stamp providers free of domain decisions.
 */
export class ReentrantEventRecordingError extends KitWiringError<"REENTRANT_EVENT_RECORDING"> {
	constructor(aggregateId: string) {
		super(
			"REENTRANT_EVENT_RECORDING",
			`Pending events of aggregate ${aggregateId} changed while ` +
				"recordPendingEvents was stamping them. A stamp provider must not " +
				"trigger new decisions on the aggregate being recorded; make every " +
				"domain decision first, then record.",
		);
	}
}

/**
 * Thrown by `recordPendingEvents` when two events in one aggregate's pending
 * batch carry the same `eventId`: a stamp provider that returns one reused
 * stamp (or repeats an explicit id) would otherwise mint two distinct facts
 * sharing one identity, and downstream idempotent consumers keyed on
 * `eventId` silently drop one of them. A wiring error: deterministic bug in
 * the stamp provider, the remedy is one fresh identity per decision.
 */
export class DuplicateEventIdError extends KitWiringError<"DUPLICATE_EVENT_ID"> {
	constructor(
		aggregateId: string,
		/** The identity two pending events would have shared. */
		public readonly eventId: string,
	) {
		super(
			"DUPLICATE_EVENT_ID",
			`Two pending events of aggregate ${aggregateId} carry the same ` +
				`eventId "${eventId}". Each decision needs its own identity; ` +
				"return a fresh stamp per event from the stamp provider.",
		);
	}
}

/**
 * Thrown by the post-commit acknowledgement of an aggregate when the
 * committed batch is not the prefix of its pending events any more. The
 * batch is longer than the pending list, or an event in it is not the
 * pending event at the same position. Acknowledging such a batch would
 * drop decisions the commit never persisted or keep events it did. The
 * pending list stays untouched. A wiring error in application commit
 * orchestration: acknowledge exactly the batch that was enrolled, once.
 */
export class PendingEventBatchMismatchError extends KitWiringError<"PENDING_EVENT_BATCH_MISMATCH"> {
	constructor(
		public readonly aggregateId: string,
		public readonly batchLength: number,
		public readonly pendingLength: number,
	) {
		super(
			"PENDING_EVENT_BATCH_MISMATCH",
			`The committed batch of ${batchLength} event(s) is no longer the ` +
				`pending prefix of aggregate ${aggregateId} (${pendingLength} ` +
				"pending). Acknowledge exactly the batch that was enrolled, once.",
		);
	}
}

/**
 * Thrown by persisted-event consumers (including `loadFromHistory` and
 * `Projector`) when an event carries an
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
				`Persisted event "${eventType}" belongs to ` +
				`${actualAggregateType ?? expectedAggregateType} ${actualAggregateId ?? expectedAggregateId}, ` +
				`not to ${expectedAggregateType} ${expectedAggregateId}: ` +
				"the stream row addresses a different aggregate.",
		});
	}
}

/** Constructor options for {@link NonProgressingEventStreamPageError}. */
export interface NonProgressingEventStreamPageErrorOptions {
	readonly aggregateType: string;
	readonly aggregateId: string;
	/** Exclusive continuation cursor supplied to `EventStore.readStream`. */
	readonly fromVersion: number;
	/** Pinned inclusive stream version the replay still has to reach. */
	readonly targetVersion: number;
}

/**
 * Thrown by a paged EventStore consumer when `readStream` returns no events
 * even though its continuation cursor has not reached the pinned target.
 * Such a page cannot advance and violates the EventStore port contract; a
 * replay loop that merely continued would spin forever.
 *
 * This is a non-retryable infrastructure error: the persistence adapter
 * deterministically contradicted its port contract, so retrying the same read
 * is not a recovery policy. Run `createEventStoreContractTests` against the
 * adapter and fix its windowing/continuation implementation.
 */
export class NonProgressingEventStreamPageError extends InfrastructureError<"NON_PROGRESSING_EVENT_STREAM_PAGE"> {
	readonly aggregateType: string;
	readonly aggregateId: string;
	readonly fromVersion: number;
	readonly targetVersion: number;

	constructor(options: NonProgressingEventStreamPageErrorOptions) {
		super({
			code: "NON_PROGRESSING_EVENT_STREAM_PAGE",
			message:
				`EventStore returned no events for ${options.aggregateType}(${options.aggregateId}) ` +
				`after version ${options.fromVersion}, before pinned target version ` +
				`${options.targetVersion}. The page cannot advance; run the EventStore ` +
				"contract suite and fix the adapter's continuation window.",
		});
		this.aggregateType = options.aggregateType;
		this.aggregateId = options.aggregateId;
		this.fromVersion = options.fromVersion;
		this.targetVersion = options.targetVersion;
	}
}

/**
 * Thrown when an event harvested from an aggregate cannot be safely composed
 * into a commit envelope, or when an outbox can prove that accepting a
 * candidate would violate its event identity/source chain. Harvest failures
 * include missing `aggregateId` / `aggregateType` (downstream routing would
 * break), or an
 * eventful persisted aggregate did not advance its version (two commits
 * would receive the same source position). These programming bugs are
 * deterministic and fail identically on every retry.
 *
 * Deliberately **not** an {@link InfrastructureError} (same reasoning as
 * {@link MissingHandlerError}): this is a deterministic programming error,
 * not a transient storage failure. A `catch (e instanceof InfrastructureError)`
 * retry handler, or a retrying `TransactionScope`, must NOT mask it or loop on
 * it forever; it should crash loud so the caller misuse surfaces in
 * development. This is why `withCommit` throws it directly and
 * `UnitOfWork.run` passes it through unchanged instead of wrapping it in
 * `CommitError`.
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
 * Thrown when a kit operation receives an instance that this package did
 * not construct: a structural lookalike, a repository DTO, or an instance
 * from an incompatible copy of the package. Such an instance carries none
 * of the kit-managed capabilities the operation needs. A wiring error:
 * extend the kit's base classes and run one compatible package copy.
 */
export class UnmanagedInstanceError extends KitWiringError<"UNMANAGED_INSTANCE"> {
	constructor(
		/** The kit operation that rejected the instance. */
		public readonly operation: string,
		/** The rejected instance: its id, or a description when it has none. */
		public readonly instance: string,
	) {
		super(
			"UNMANAGED_INSTANCE",
			`${operation} requires an instance constructed by this package; ` +
				`${instance} carries no kit-managed capability. Extend the ` +
				"kit's base classes; a structural lookalike or an instance from " +
				"an incompatible package copy cannot be managed.",
		);
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
	/** The mapper failure or invalid-decision diagnostic. */
	readonly mapperError: unknown;
}

/**
 * Produced by the in-memory `CommandBus` / `QueryBus` when the configured
 * `mapExpectedError` policy fails while classifying a registered handler's
 * failure, either by throwing or by returning an invalid decision. A broken
 * mapper is a wiring bug: letting its failure propagate bare would
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
	/** The mapper failure or invalid-decision diagnostic. */
	readonly mapperCause: unknown;

	constructor(options: ErrorMapperFailedErrorOptions) {
		super(
			"ERROR_MAPPER_FAILED",
			`The ${options.busKind} bus mapExpectedError policy failed while ` +
				"classifying a " +
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
 * loaded into the identity map changed but no `update` intent was registered.
 * Without this guard the changed state or pending events would be silently
 * dropped.
 *
 * Deliberately **not** an `InfrastructureError` (same posture as
 * {@link MissingHandlerError}): a programming bug that must crash loud,
 * not be absorbed by a generic infrastructure-error handler. The throw
 * happens inside the transaction, so the unit of work rolls back and
 * leaves no partial state.
 *
 * **Scope of the guard.** A best-effort runtime safety net, not a proof.
 * It sees aggregates that repository adapters register through
 * `tracking.trackLoaded` and detects ordinary state changes through the version
 * captured at load. The pending-event count remains a second guard for an
 * invalid event-only mutation that did not advance the version. A freshly
 * created aggregate that is never passed to `add` is invisible to the kit.
 */
export class UnenrolledChangesError extends KitWiringError<"UNENROLLED_CHANGES"> {
	constructor(public readonly aggregateId: string) {
		super(
			"UNENROLLED_CHANGES",
			`Aggregate ${aggregateId} was loaded and changed in this unit of work, ` +
				"but no update intent was registered. Call repository.update(aggregate) " +
				"after the final domain decision so state and events flush together.",
		);
	}
}

/**
 * Thrown when an aggregate removed within the current unit of work is added,
 * updated, or tracked again in the same operation. Removal is final within an
 * operation; writing afterwards would resurrect the row, which is always a
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
			`Aggregate ${aggregateId} was removed in this unit of work and ` +
				"cannot be added, updated, tracked, or removed through another " +
				"instance again. Removal is final within an operation. A repeated " +
				"remove of the SAME instance is an accepted no-op; if the " +
				"aggregate must remain, do not remove it.",
		);
	}
}

/**
 * Thrown by `AggregatePersistence.getById()` when an aggregate with the
 * given id does not exist. `InfrastructureError` because the storage
 * boundary, not a business rule, decided the row is absent. Use the
 * nullable variant `findById()` if "not found" is a valid outcome.
 *
 * Accepts an optional `cause` so a repository adapter can wrap a lower-level
 * "row not found" or driver-level error without
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
 * Thrown by a repository's `add()` flush when a row with the
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
 * Thrown by `reconstituteAggregateFromSnapshot` when the stored snapshot
 * carries a different schema version than its adapter-owned `SnapshotModel`
 * and the model declares no `migrate` function. Without the check, a snapshot
 * written against an older DTO shape would surface as an undefined-field crash on
 * the first method call after a much later restore.
 *
 * `InfrastructureError` because the storage boundary served outdated
 * data; the schema evolving past stored snapshots is an expected
 * lifecycle event, not a programming bug. NOT retryable: the recovery
 * is a code path, not a repeat. Add `migrate` to the snapshot model (upgrade
 * old DTOs in place), or catch this error in the repository, discard the
 * snapshot, and refold from the full event stream / reload from the source of
 * truth.
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
				`the snapshot model expects schema ${options.expectedSchemaVersion}, ` +
				`the stored snapshot carries ${options.actualSchemaVersion}. Override ` +
				`the model's migrate function to upgrade old snapshots, or discard the snapshot ` +
				`and refold from the full event stream.`,
		});
		this.aggregateType = options.aggregateType;
		this.aggregateId = options.aggregateId;
		this.expectedSchemaVersion = options.expectedSchemaVersion;
		this.actualSchemaVersion = options.actualSchemaVersion;
	}
}

/**
 * Surfaced by a Unit-of-Work flush when the aggregate's expected version does
 * not match the version currently persisted: i.e. another writer
 * updated the aggregate concurrently. The canonical optimistic-
 * concurrency signal; the App-Service typically reloads, re-applies
 * the use case, and retries, or surfaces HTTP 409 to the caller.
 *
 * **Retry means a FRESH unit of work** (a new `UnitOfWork.run()` /
 * `withCommit` invocation): reload, re-apply, and register `update` again. Do NOT catch this
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

/** Options bag for {@link IdempotencyClaimLostError}. */
export interface IdempotencyClaimLostErrorOptions {
	readonly key: string;
	readonly token: string;
	/** Optional driver-level error to preserve in the cause chain. */
	readonly cause?: unknown;
}

/**
 * Thrown when a leased idempotency owner tries to renew, complete, or
 * reconcile through a claim token that no longer owns the key. The usual
 * cause is lease expiry followed by a successful takeover. The stale
 * execution must abort before its transaction commits; retrying starts from
 * a fresh claim or replays the winner.
 */
export class IdempotencyClaimLostError extends InfrastructureError<"IDEMPOTENCY_CLAIM_LOST"> {
	readonly key: string;
	readonly token: string;

	constructor(options: IdempotencyClaimLostErrorOptions) {
		super({
			code: "IDEMPOTENCY_CLAIM_LOST",
			message:
				`Idempotency claim for key "${options.key}" no longer belongs to ` +
				`token "${options.token}"`,
			cause: options.cause,
			retryable: true,
		});
		this.key = options.key;
		this.token = options.token;
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

/** Options bag for {@link IdempotencyReconciliationRequiredError}. */
export interface IdempotencyReconciliationRequiredErrorOptions {
	readonly key: string;
	readonly fingerprint: string;
	readonly token: string;
	readonly expiredAt: string;
}

/**
 * An expired staged outcome cannot be replayed or discarded until the
 * application checks the authoritative write model. Immediate retry without
 * that evidence cannot make progress, so this error is deliberately not
 * marked retryable.
 */
export class IdempotencyReconciliationRequiredError extends InfrastructureError<"IDEMPOTENCY_RECONCILIATION_REQUIRED"> {
	readonly key: string;
	readonly fingerprint: string;
	readonly token: string;
	readonly expiredAt: string;

	constructor(options: IdempotencyReconciliationRequiredErrorOptions) {
		super({
			code: "IDEMPOTENCY_RECONCILIATION_REQUIRED",
			message:
				`Idempotency key "${options.key}" has an expired staged outcome; ` +
				"consult the authoritative write model before confirming or releasing it",
		});
		this.key = options.key;
		this.fingerprint = options.fingerprint;
		this.token = options.token;
		this.expiredAt = options.expiredAt;
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
	| "AGGREGATE_TRACKING"
	| "COMMIT_FAILED"
	| "CONCURRENCY_CONFLICT"
	| "DIRECT_STATE_MUTATION"
	| "DOMAIN_TRANSITION_GUARD_REJECTED"
	| "DUPLICATE_AGGREGATE"
	| "DUPLICATE_EVENT_ID"
	| "DUPLICATE_HANDLER_REGISTRATION"
	| "ERROR_MAPPER_FAILED"
	| "EVENT_ADDRESS_INVALID"
	| "EVENT_BUS_CLOSED"
	| "EVENT_HARVEST_FAILED"
	| "EVENT_ID_INVALID"
	| "EVENT_ID_REQUIRED"
	| "EVENT_OCCURRED_AT_INVALID"
	| "EVENT_OCCURRED_AT_REQUIRED"
	| "EVENT_SCHEMA_VERSION_INVALID"
	| "EVENT_TYPE_INVALID"
	| "FOREIGN_EVENT"
	| "HANDLER_RETURNED_NO_STATE"
	| "HOSTILE_STATE_KEY"
	| "IDEMPOTENCY_CLAIM_LOST"
	| "IDEMPOTENCY_COMPLETED_WITHOUT_CLAIM"
	| "IDEMPOTENCY_IN_FLIGHT"
	| "IDEMPOTENCY_KEY_REUSE"
	| "IDEMPOTENCY_RECONCILIATION_REQUIRED"
	| "IN_MEMORY_CAPACITY_EXCEEDED"
	| "INVALID_DOMAIN_MACHINE_CONTEXT"
	| "INVALID_DOMAIN_MACHINE_DEFINITION"
	| "INVALID_DOMAIN_MACHINE_INPUT"
	| "INVALID_DOMAIN_MACHINE_SNAPSHOT"
	| "INVALID_DOMAIN_TRANSITION"
	| "INVALID_DOMAIN_TRANSITION_GUARD_RESULT"
	| "INVALID_DOMAIN_TRANSITION_RESULT"
	| "INVALID_COMMAND_MESSAGE"
	| "INVALID_INTEGRATION_MESSAGE"
	| "INVALID_MONEY"
	| "INVALID_REPOSITORY_ADAPTER"
	| "INVALID_REPOSITORY_DEFINITION"
	| "INVALID_VERSION"
	| "MISADDRESSED_EVENT"
	| "MISSING_ENTITY_ID"
	| "MISSING_HANDLER"
	| "MONEY_CURRENCY_MISMATCH"
	| "MONEY_PRECISION_LOSS"
	| "MONEY_SCALE_MISMATCH"
	| "NESTED_UNIT_OF_WORK"
	| "NON_PROGRESSING_EVENT_STREAM_PAGE"
	| "PENDING_EVENT_BATCH_MISMATCH"
	| "PROJECTION_GAP"
	| "PROJECTION_IDENTITY_VIOLATION"
	| "PROJECTION_ORDER_VIOLATION"
	| "PROJECTION_RECEIPT_VIOLATION"
	| "PUBLISH_DEPTH_EXCEEDED"
	| "REENTRANT_DOMAIN_STATE_MACHINE_EVALUATION"
	| "REENTRANT_EVENT_RECORDING"
	| "REPOSITORY_ERROR_MAPPING_FAILED"
	| "ROLLBACK_FAILED"
	| "SNAPSHOT_CORRUPTED"
	| "SNAPSHOT_SCHEMA_MISMATCH"
	| "SNAPSHOT_TIME_INVALID"
	| "TRANSACTION_CLOSED"
	| "UNENROLLED_CHANGES"
	| "UNKNOWN_CURRENCY"
	| "UNMANAGED_INSTANCE"
	| "UNMINTED_EVENT"
	| "UNPROJECTABLE_EVENT"
	| "UNREGISTERED_HANDLER"
	| "UNREPLAYABLE_AGGREGATE";
