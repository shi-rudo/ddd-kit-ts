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

/** The keys `StructuredError` owns, which a declared field never replaces. */
const ENVELOPE_FIELDS: ReadonlySet<string> = new Set(["_tag", "details"]);

/**
 * The fields a kit error declares of its own, for the raw log object.
 *
 * Every field of a kit error is an own enumerable property, so the log object
 * carries them without each class repeating them.
 */
function ownFields(error: object): Record<string, unknown> {
	const fields: Record<string, unknown> = {};
	for (const key of Object.keys(error)) {
		if (ENVELOPE_FIELDS.has(key)) continue;
		// A field can be an accessor, and a consumer's own error class decides
		// what it computes. Reading it must not fail the report.
		try {
			const safe = logSafeValue((error as Record<string, unknown>)[key]);
			if (safe !== undefined) fields[key] = safe;
		} catch {
			// The field cannot be read, so the log object leaves it out.
		}
	}
	return fields;
}

/**
 * Projects one field value to something a log serializer survives.
 *
 * A field of type `unknown` can hold a driver value with a cycle, a bigint or
 * a symbol, and `JSON.stringify` throws on the first two. A serializer that
 * throws inside the failure path costs the whole report, so a value that does
 * not survive the attempt is left out. An error keeps its name, message and
 * code, which is what a reader needs and cannot cycle.
 */
function logSafeValue(value: unknown): unknown {
	switch (typeof value) {
		case "string":
		case "number":
		case "boolean":
			return value;
		case "bigint":
		case "symbol":
			return String(value);
		case "undefined":
		case "function":
			return undefined;
		default:
			break;
	}
	if (value === null) return null;
	if (value instanceof Error) {
		const code = (value as { readonly code?: unknown }).code;
		return {
			name: String(value.name),
			message: String(value.message),
			...(typeof code === "string" ? { code } : {}),
		};
	}
	try {
		JSON.stringify(value);
		return value;
	} catch {
		return undefined;
	}
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

	/** Carries the fields the concrete error declares into the log object. */
	protected override buildLogObject(): Record<string, unknown> {
		return { ...ownFields(this), ...super.buildLogObject() };
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

	/** Carries the fields the concrete error declares into the log object. */
	protected override buildLogObject(): Record<string, unknown> {
		return { ...ownFields(this), ...super.buildLogObject() };
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

	/** Carries the fields the concrete error declares into the log object. */
	protected override buildLogObject(): Record<string, unknown> {
		return { ...ownFields(this), ...super.buildLogObject() };
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

/**
 * Copy-safe membership check for the kit's wiring-error family.
 * Same rationale as {@link isDomainErrorLike}.
 *
 * A wiring error states a deterministic programming or configuration defect.
 * A kit boundary that translates failures uses this check to pass such an
 * error through untouched, instead of relabelling it as a store failure.
 *
 * The check narrows to the structural shape, not to a class: the family's
 * base stays kit-internal, and an error from another kit copy carries the
 * shape without being an instance of this copy's class.
 */
export function isWiringErrorLike(value: unknown): value is Error & {
	readonly code: string;
	readonly category: "WIRING";
	readonly retryable: false;
} {
	return (
		value instanceof KitWiringError ||
		(value instanceof Error &&
			(value as { readonly category?: unknown }).category === "WIRING")
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
 * Thrown when a projection built with `projectionFromHandlers` receives an
 * event type with no own handler entry: the declared event union and the
 * handler map disagree at runtime, which is a programming / configuration
 * bug rather than a domain or infrastructure failure.
 *
 * Deliberately **not** on `DomainError` or `InfrastructureError`:
 * a generic `catch (e instanceof DomainError)` handler at the App
 * layer must not mask a forgotten handler; this should crash loud and
 * fail the calling Use Case so the bug surfaces in development.
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
 * Thrown by an event-sourced aggregate when `apply()` or replay reaches an
 * event type with no own entry in the `folds` map: the declared event union
 * and the map disagree at runtime. Same posture as
 * {@link MissingHandlerError}: a deterministic bug, never a domain
 * rejection, so it propagates through `replayHistory` instead of riding its
 * `Result`.
 */
export class MissingFoldError extends KitWiringError<"MISSING_FOLD"> {
	constructor(
		public readonly eventType: string,
		cause?: unknown,
	) {
		super("MISSING_FOLD", `Missing fold for event type: ${eventType}`, cause);
	}
}

/**
 * Thrown by an event-sourced aggregate when a fold returns `undefined`
 * for an event, which is almost always a fold without a `return` statement.
 * Storing that result would set the aggregate state to `undefined`, record
 * the fact anyway on the apply path, and leave every later fold working on
 * nothing. Same posture as {@link MissingFoldError}: a deterministic bug
 * in the folds map, never a domain rejection, so it propagates through
 * `replayHistory` instead of riding its `Result`.
 */
export class FoldReturnedNoStateError extends KitWiringError<"FOLD_RETURNED_NO_STATE"> {
	constructor(public readonly eventType: string) {
		super(
			"FOLD_RETURNED_NO_STATE",
			`The fold for event type "${eventType}" returned no state. ` +
				"A fold must return the next state; check for a missing " +
				"return statement.",
		);
	}
}

/** Constructor options for {@link DirectStateMutationError}. */
export interface DirectStateMutationErrorOptions {
	/** The aggregate the error names. */
	readonly identity: {
		readonly aggregateType: string;
		readonly aggregateId: string;
	};
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
	readonly identity: DirectStateMutationErrorOptions["identity"];

	constructor(options: DirectStateMutationErrorOptions) {
		super(
			"DIRECT_STATE_MUTATION",
			`Aggregate ${describeAggregateIdentity(options.identity)} is event-sourced: its state changes only ` +
				"through apply(). Record the fact as an event and fold it in a " +
				"handler instead of calling setState.",
		);
		this.identity = detachAggregateIdentity(options.identity);
	}
}

/**
 * Thrown by `Projector.project` when an event cannot be projected
 * safely because its cursor is missing or malformed, or its aggregate
 * identity is absent. Applying such an event would break idempotency, so
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
 * Thrown by `Entity` (constructor and `setState`), by the event-sourced
 * fold (`apply` and replay), by the event constructors for the payload,
 * and by the event metadata helpers (`createDomainEvent`'s
 * `options.metadata`, `mergeMetadata`, `copyMetadata`) when the value
 * carries an own `"__proto__"` data key:
 * the shape `JSON.parse` produces for hostile DB rows or request bodies
 * handed to reconstitute factories. Such a key can never be legitimate
 * domain state; accepting it would hand a prototype-pollution payload to
 * every downstream consumer that copies the state through `[[Set]]`
 * (`Object.assign`, for-in assignment loops), and dropping it would be
 * silent data mutation. The check looks at the root object only; nested
 * objects are not walked, and a class instance is an ownership transfer
 * that passes.
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
 * Thrown by the `Entity` constructor when the id is not a non-blank
 * string. That covers `null`, `undefined`, a blank string, and a
 * non-string value that reached the constructor through a cast. An
 * entity without a usable identity cannot be tracked, compared, or
 * persisted, so the construction fails before any state is stored. A
 * wiring error: a deterministic bug at the call site, never a domain
 * rejection.
 */
export class MissingEntityIdError extends KitWiringError<"MISSING_ENTITY_ID"> {
	constructor(
		/** The rejected value, for the message only; never a usable id. */
		received: unknown,
	) {
		super(
			"MISSING_ENTITY_ID",
			`Entity ID must be a non-blank string; received ${describeRejectedId(received)}.`,
		);
	}
}

// Never throws: an object with no primitive conversion is described by
// its kind, so the coded error reaches the caller for every input.
function describeRejectedId(value: unknown): string {
	if (typeof value === "string") return JSON.stringify(value);
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (typeof value === "object")
		return Array.isArray(value) ? "array" : "object";
	if (typeof value === "function") return "function";
	return `${typeof value} ${String(value)}`;
}

/**
 * Thrown when a number that is not a valid aggregate version reaches the
 * kit: `toVersion`, `markReconstituted`, `setVersion`, and the post-commit
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

/** Constructor options for {@link UnreplayableAggregateError}. */
export interface UnreplayableAggregateErrorOptions {
	/** The aggregate the error names. */
	readonly identity: {
		readonly aggregateType: string;
		readonly aggregateId: string;
	};
	/** Why the aggregate cannot take a replay, with the safe remedy. */
	readonly reason: string;
}

/**
 * Thrown by `EventSourcedAggregate.replayHistory` when the replay target
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
	readonly identity: UnreplayableAggregateErrorOptions["identity"];

	constructor(options: UnreplayableAggregateErrorOptions) {
		super(
			"UNREPLAYABLE_AGGREGATE",
			`Cannot replay onto aggregate ${describeAggregateIdentity(options.identity)}: ` +
				`${options.reason}. Reconstitute on a fresh instance ` +
				"(no factory-recorded events, no unpersisted mutations).",
		);
		this.identity = detachAggregateIdentity(options.identity);
	}
}

/**
 * Constructor options for {@link MisattributedEventError} and
 * {@link ForeignEventError}: the identity of the aggregate that received the
 * event, and the aggregate identity fields the event carries. A missing
 * field on the event matches by default, so `actual` names only what the
 * event states.
 */
export interface AggregateIdentityMismatchOptions {
	readonly expected: {
		readonly aggregateType: string;
		readonly aggregateId: string;
	};
	readonly actual: {
		readonly aggregateType?: string;
		readonly aggregateId?: string;
	};
	readonly eventType: string;
}

/**
 * Renders an aggregate identity for a kit message as `Type(id)`, the one
 * format every kit message uses, so a log search finds all of them. Kit
 * modules only; not part of the package entries.
 */
export function describeAggregateIdentity(identity: {
	readonly aggregateType: string;
	readonly aggregateId: string;
}): string {
	return `${identity.aggregateType}(${identity.aggregateId})`;
}

/**
 * A frozen copy of the two aggregate identity fields. An error keeps its own
 * copy, so it neither shares the caller's object nor carries its other
 * properties into the log. Kit modules only; not part of the package
 * entries.
 */
export function detachAggregateIdentity(identity: {
	readonly aggregateType: string;
	readonly aggregateId: string;
}): { readonly aggregateType: string; readonly aggregateId: string } {
	return Object.freeze({
		aggregateType: identity.aggregateType,
		aggregateId: identity.aggregateId,
	});
}

function detachPartialAggregateIdentity(
	identity: AggregateIdentityMismatchOptions["actual"],
): AggregateIdentityMismatchOptions["actual"] {
	return Object.freeze({
		...(identity.aggregateType === undefined
			? {}
			: { aggregateType: identity.aggregateType }),
		...(identity.aggregateId === undefined
			? {}
			: { aggregateId: identity.aggregateId }),
	});
}

/** The identity the event names; a missing field falls back to the receiving aggregate. */
function describeEventIdentity(
	options: AggregateIdentityMismatchOptions,
): string {
	const { expected, actual } = options;
	return describeAggregateIdentity({
		aggregateType: actual.aggregateType ?? expected.aggregateType,
		aggregateId: actual.aggregateId ?? expected.aggregateId,
	});
}

/**
 * Thrown by `EventSourcedAggregate.apply()` when a NEW event carries an
 * `aggregateId` or `aggregateType` naming a different aggregate: a
 * deterministic programming bug at the call site (a hand-built or
 * copied event that belongs elsewhere), caught before the event can be
 * recorded and poison the own stream. Events with MISSING aggregate
 * identity fields do not trip this: `apply()` stamps them from the aggregate,
 * the same guarantee `createEvent` gives. A wiring error, distinct
 * from {@link ForeignEventError} on purpose: a wrong new event is a
 * bug in today's code, a wrong PERSISTED row is corrupted or miswired
 * infrastructure, and handlers for one must not absorb the other.
 */
export class MisattributedEventError extends KitWiringError<"MISATTRIBUTED_EVENT"> {
	/** Identity of the aggregate that received the event. */
	readonly expected: AggregateIdentityMismatchOptions["expected"];
	/** Aggregate identity fields the event carries. */
	readonly actual: AggregateIdentityMismatchOptions["actual"];
	readonly eventType: string;

	constructor(options: AggregateIdentityMismatchOptions) {
		super(
			"MISATTRIBUTED_EVENT",
			`New event "${options.eventType}" belongs to ` +
				`${describeEventIdentity(options)} but was applied on ` +
				`${describeAggregateIdentity(options.expected)}: ` +
				"fix the call site (createEvent stamps the right identity).",
		);
		this.expected = detachAggregateIdentity(options.expected);
		this.actual = detachPartialAggregateIdentity(options.actual);
		this.eventType = options.eventType;
	}
}

/** Constructor options for {@link SnapshotVersionNotRestoredError}. */
export interface SnapshotVersionNotRestoredErrorOptions {
	/** The aggregate the error names. */
	readonly identity: {
		readonly aggregateType: string;
		readonly aggregateId: string;
	};
	/** The version the snapshot carries. */
	readonly snapshotVersion: number;
	/** The version the factory's aggregate reports. */
	readonly restoredVersion: number;
}

/**
 * Thrown by `reconstituteAggregateFromSnapshot` when the `reconstitute`
 * factory returns an aggregate at a version other than the snapshot
 * version. The factory ignored the version parameter, usually a forgotten
 * `markReconstituted(version)`. A wiring error in the snapshot model,
 * never snapshot corruption: routing it into the discard-and-refold
 * channel would mask it as perpetual silent refolding.
 */
export class SnapshotVersionNotRestoredError extends KitWiringError<"SNAPSHOT_VERSION_NOT_RESTORED"> {
	readonly identity: SnapshotVersionNotRestoredErrorOptions["identity"];
	readonly snapshotVersion: number;
	readonly restoredVersion: number;

	constructor(options: SnapshotVersionNotRestoredErrorOptions) {
		super(
			"SNAPSHOT_VERSION_NOT_RESTORED",
			`SnapshotModel.reconstitute for ${describeAggregateIdentity(options.identity)} ` +
				"returned an aggregate at version " +
				`${options.restoredVersion} for a snapshot at version ` +
				`${options.snapshotVersion}. Reconstitution must restore ` +
				"the persisted version; call markReconstituted(version) inside " +
				"the aggregate factory.",
		);
		this.identity = detachAggregateIdentity(options.identity);
		this.snapshotVersion = options.snapshotVersion;
		this.restoredVersion = options.restoredVersion;
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
 * (`apply`, `setState`, `addDomainEvent`) without having been minted by
 * the kit's constructors: `createDomainEvent`,
 * `createDomainEventFromFacts`, `createUncommittedDomainEvent`, or the
 * aggregate `createEvent` helper. Those constructors deep-freeze the
 * event, defensively copy payload and metadata, and mark the result as
 * minted. The mark has two tiers: a
 * module-private one for events of this loaded copy of the kit, and a
 * cooperative `Symbol.for` brand that a second loaded copy stamps and
 * recognizes. Anything else (a hand-rolled literal, a shallow-frozen
 * copy with mutable nested data) is rejected: a mutable event recorded
 * next to a state change can silently diverge from it afterwards. A
 * wiring error: deterministic bug at the call site, the remedy is
 * minting through the constructors. The gate catches accidents, not
 * adversaries: code in the same process can fake the brand.
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

/** Constructor options for {@link ReentrantEventRecordingError}. */
export interface ReentrantEventRecordingErrorOptions {
	/** The aggregate the error names. */
	readonly identity: {
		readonly aggregateType: string;
		readonly aggregateId: string;
	};
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
	readonly identity: ReentrantEventRecordingErrorOptions["identity"];

	constructor(options: ReentrantEventRecordingErrorOptions) {
		super(
			"REENTRANT_EVENT_RECORDING",
			"Pending events of aggregate " +
				`${describeAggregateIdentity(options.identity)} changed while ` +
				"recordPendingEvents was stamping them. A stamp provider must not " +
				"trigger new decisions on the aggregate being recorded; make every " +
				"domain decision first, then record.",
		);
		this.identity = detachAggregateIdentity(options.identity);
	}
}

/** Constructor options for {@link DuplicateEventIdError}. */
export interface DuplicateEventIdErrorOptions {
	/** The aggregate the error names. */
	readonly identity: {
		readonly aggregateType: string;
		readonly aggregateId: string;
	};
	/** The event id two pending events would have shared. */
	readonly eventId: string;
}

/**
 * Thrown when two facts of one aggregate would carry the same `eventId`.
 * Two causes, two sites: the aggregate rejects a recorded event that is
 * already pending at the append, before the state moves; and
 * `recordPendingEvents` rejects a stamp provider that returns one reused
 * stamp (or repeats an explicit id). Either would mint two distinct facts
 * sharing one identity, and downstream idempotent consumers keyed on
 * `eventId` silently drop one of them. A wiring error: deterministic bug at
 * the append site or in the stamp provider, the remedy is one fresh
 * identity per fact.
 */
export class DuplicateEventIdError extends KitWiringError<"DUPLICATE_EVENT_ID"> {
	readonly identity: DuplicateEventIdErrorOptions["identity"];
	/** The event id two pending events would have shared. */
	readonly eventId: string;

	constructor(options: DuplicateEventIdErrorOptions) {
		super(
			"DUPLICATE_EVENT_ID",
			"Two pending events of aggregate " +
				`${describeAggregateIdentity(options.identity)} carry the same ` +
				`eventId "${options.eventId}". Each fact needs its own event id: ` +
				"append a recorded event once, and return a fresh stamp per " +
				"decision from the stamp provider.",
		);
		this.identity = detachAggregateIdentity(options.identity);
		this.eventId = options.eventId;
	}
}

/** Constructor options for {@link PendingEventLimitExceededError}. */
export interface PendingEventLimitExceededErrorOptions {
	/** The aggregate the error names. */
	readonly identity: {
		readonly aggregateType: string;
		readonly aggregateId: string;
	};
	/** The configured `maxPendingEvents`. */
	readonly limit: number;
	/** Events pending before the rejected recording. */
	readonly pending: number;
	/** Events the rejected recording would have added. */
	readonly added: number;
}

/**
 * Thrown when a recording would grow the pending list of an aggregate past
 * `AggregateConfig.maxPendingEvents`. The check runs before the state
 * moves, so the rejected decision records nothing and moves nothing. The
 * limit is a modelling signal, not a runtime budget: a decision that emits
 * hundreds of facts points at a missing aggregate boundary, and a retry
 * repeats it. A wiring error: split the aggregate, or emit fewer facts
 * per decision.
 */
export class PendingEventLimitExceededError extends KitWiringError<"PENDING_EVENT_LIMIT_EXCEEDED"> {
	readonly identity: PendingEventLimitExceededErrorOptions["identity"];
	readonly limit: number;
	readonly pending: number;
	readonly added: number;

	constructor(options: PendingEventLimitExceededErrorOptions) {
		super(
			"PENDING_EVENT_LIMIT_EXCEEDED",
			`Aggregate ${describeAggregateIdentity(options.identity)} holds ` +
				`${options.pending} pending event(s) and cannot record ` +
				`${options.added} more: maxPendingEvents is ${options.limit}. ` +
				"A decision that emits this many facts points at a missing " +
				"aggregate boundary.",
		);
		this.identity = detachAggregateIdentity(options.identity);
		this.limit = options.limit;
		this.pending = options.pending;
		this.added = options.added;
	}
}

/** Constructor options for {@link PendingEventBatchMismatchError}. */
export interface PendingEventBatchMismatchErrorOptions {
	/** The aggregate the error names. */
	readonly identity: {
		readonly aggregateType: string;
		readonly aggregateId: string;
	};
	/** Events in the committed batch. */
	readonly batchLength: number;
	/** Events pending on the aggregate. */
	readonly pendingLength: number;
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
	readonly identity: PendingEventBatchMismatchErrorOptions["identity"];
	readonly batchLength: number;
	readonly pendingLength: number;

	constructor(options: PendingEventBatchMismatchErrorOptions) {
		super(
			"PENDING_EVENT_BATCH_MISMATCH",
			`The committed batch of ${options.batchLength} event(s) is no longer ` +
				"the pending prefix of aggregate " +
				`${describeAggregateIdentity(options.identity)} (${options.pendingLength} ` +
				"pending). Acknowledge exactly the batch that was enrolled, once.",
		);
		this.identity = detachAggregateIdentity(options.identity);
		this.batchLength = options.batchLength;
		this.pendingLength = options.pendingLength;
	}
}

/**
 * Thrown by persisted-event consumers (including `replayHistory` and
 * `Projector`) when an event carries an
 * `aggregateId` or `aggregateType` that names a different aggregate:
 * the persisted row belongs to someone else (a miswired stream read,
 * ids colliding across aggregate types, a corrupted store). An
 * `InfrastructureError`, NOT a `DomainError` (same posture as
 * {@link SnapshotSchemaMismatchError}): a wrong aggregate identity is data
 * corruption or wiring, never an expected business rejection, so it
 * must not be absorbed by generic domain error handling or presented
 * as a 4xx. It therefore PROPAGATES as a throw through the replay
 * methods' `Result` contract (which reserves `Err` for `DomainError`),
 * after the usual all-or-nothing rollback. History events without the
 * optional aggregate identity fields pass unchecked (the fields are optional on
 * the event shape); new events are covered by
 * {@link MisattributedEventError}.
 */
export class ForeignEventError extends InfrastructureError<"FOREIGN_EVENT"> {
	/** Identity of the aggregate that received the event. */
	readonly expected: AggregateIdentityMismatchOptions["expected"];
	/** Aggregate identity fields the event carries. */
	readonly actual: AggregateIdentityMismatchOptions["actual"];
	readonly eventType: string;

	constructor(options: AggregateIdentityMismatchOptions) {
		super({
			code: "FOREIGN_EVENT",
			message:
				`Persisted event "${options.eventType}" belongs to ` +
				`${describeEventIdentity(options)}, not to ` +
				`${describeAggregateIdentity(options.expected)}: ` +
				"the stream row belongs to a different aggregate.",
		});
		this.expected = detachAggregateIdentity(options.expected);
		this.actual = detachPartialAggregateIdentity(options.actual);
		this.eventType = options.eventType;
	}
}

/** How a page of a stream read breaks the `readStream` contract. */
export type EventStreamPageReason =
	| "empty_page"
	| "stream_vanished"
	| "page_past_target"
	| "page_over_limit"
	| "head_regressed"
	| "invalid_head";

/** Constructor options for {@link InvalidEventStreamPageError}. */
export interface InvalidEventStreamPageErrorOptions {
	/** The aggregate the error names. */
	readonly identity: {
		readonly aggregateType: string;
		readonly aggregateId: string;
	};
	/** How the page breaks the contract; see {@link EventStreamPageReason}. */
	readonly reason: EventStreamPageReason;
	/** The exclusive cursor the page followed. */
	readonly fromVersion: number;
	/**
	 * The pinned inclusive target version. Absent for `invalid_head` on the
	 * first page: that page pins no target.
	 */
	readonly targetVersion?: number;
	/**
	 * The stream head the page reported, as the adapter returned it. Present
	 * for `head_regressed` and `invalid_head`.
	 */
	readonly lastVersion?: unknown;
	/** The stream head the first page reported. Present for `head_regressed`. */
	readonly firstPageLastVersion?: number;
	/**
	 * The number of events on the page. Present for `page_past_target` and
	 * `page_over_limit`.
	 */
	readonly eventCount?: number;
	/** The page limit the read asked for. Present for `page_over_limit`. */
	readonly limit?: number;
}

function describeReportedHead(head: unknown): string {
	if (typeof head === "number" && Number.isFinite(head)) return String(head);
	return `${showReportedHead(head)} of type ${typeof head}`;
}

// Object.prototype.toString never converts its receiver: String() throws for
// an object without a prototype, and the error must still build.
function showReportedHead(head: unknown): string {
	if (typeof head === "string") return JSON.stringify(head);
	if (typeof head === "object" && head !== null) {
		return Object.prototype.toString.call(head);
	}
	return String(head);
}

function eventStreamPageReasonMessage(
	stream: string,
	options: InvalidEventStreamPageErrorOptions,
): string {
	const target = `target version ${String(options.targetVersion)}`;
	switch (options.reason) {
		case "empty_page":
			return (
				`The read of ${stream} returned an empty page after version ` +
				`${options.fromVersion} toward ${target}. A page holds at least one ` +
				"event while events remain."
			);
		case "stream_vanished":
			return (
				`readStream reported ${stream} absent after version ` +
				`${options.fromVersion} while the replay had not reached ${target}. ` +
				"A stream is append-only, and only a physical removal deletes it; " +
				"check for a removal that ran during the read."
			);
		case "page_past_target":
			return (
				`The read of ${stream} returned ${String(options.eventCount)} events ` +
				`after version ${options.fromVersion}, more than the window ` +
				`(${options.fromVersion}, ${String(options.targetVersion)}] holds.`
			);
		case "page_over_limit":
			return (
				`The read of ${stream} returned ${String(options.eventCount)} events ` +
				`after version ${options.fromVersion}, more than the limit of ` +
				`${String(options.limit)} it asked for.`
			);
		case "head_regressed":
			return (
				`readStream reported ${stream} at head ${String(options.lastVersion)} ` +
				`after version ${options.fromVersion}, below the head ` +
				`${String(options.firstPageLastVersion)} of the first page. A stream ` +
				"is append-only, so its head never moves back."
			);
		case "invalid_head":
			return (
				`readStream reported ${stream} with head ` +
				`${describeReportedHead(options.lastVersion)} after version ` +
				`${options.fromVersion}. The head of an existing stream is a safe ` +
				"integer of at least 1; report a stream without events as absent."
			);
	}
}

/**
 * Thrown when a page of a stream read breaks the `readStream` contract.
 * `readStreamPages` checks every page it reads, and
 * `reconstituteAggregateFromStreamPages` checks every page an adapter that
 * pages on its own hands over. Both throw this error for the same defect.
 *
 * The `reason` names the defect. `empty_page`: the page holds no event,
 * but events remain before the target version. `stream_vanished`: a
 * continuation page reports the stream absent. `page_past_target`: the
 * page holds more events than its window has left. `page_over_limit`: the
 * page holds more events than the `limit` of the read. `head_regressed`: a
 * continuation page reports a head below the head of the first page.
 * `invalid_head`: a page of an existing stream reports a head that is not
 * a safe integer of at least 1, for example `0` for a stream without
 * events, or a string from a driver that returns big integers as text.
 *
 * No case is retryable. Fix the adapter: run `createEventStoreContractTests`
 * against an EventStore adapter, and `createReplayableStreamPagesContractTests`
 * against an adapter that pages on its own. Two causes lie outside the
 * adapter. A stream is append-only, and only a physical removal deletes it
 * (the repository guide, "Domain deletion versus physical removal"), so a
 * removal that runs during the read gives `stream_vanished`. An upcaster
 * that splits one stored event into several gives `page_past_target` at
 * the replay, because the replay counts one version per event.
 */
export class InvalidEventStreamPageError extends InfrastructureError<"INVALID_EVENT_STREAM_PAGE"> {
	readonly identity: InvalidEventStreamPageErrorOptions["identity"];
	readonly reason: EventStreamPageReason;
	readonly fromVersion: number;
	readonly targetVersion: number | undefined;
	readonly lastVersion: unknown;
	readonly firstPageLastVersion: number | undefined;
	readonly eventCount: number | undefined;
	readonly limit: number | undefined;

	constructor(options: InvalidEventStreamPageErrorOptions) {
		const stream = `${describeAggregateIdentity(options.identity)}`;
		super({
			code: "INVALID_EVENT_STREAM_PAGE",
			message: eventStreamPageReasonMessage(stream, options),
		});
		this.identity = detachAggregateIdentity(options.identity);
		this.reason = options.reason;
		this.fromVersion = options.fromVersion;
		this.targetVersion = options.targetVersion;
		this.lastVersion = options.lastVersion;
		this.firstPageLastVersion = options.firstPageLastVersion;
		this.eventCount = options.eventCount;
		this.limit = options.limit;
	}
}

/** The check a {@link ReplayTargetMismatchError} reports. */
export type ReplayTargetMismatchReason =
	| "target_not_at_cursor"
	| "pages_short_of_target";

/** Constructor options for {@link ReplayTargetMismatchError}. */
export interface ReplayTargetMismatchErrorOptions {
	/** The aggregate the error names. */
	readonly identity: {
		readonly aggregateType: string;
		readonly aggregateId: string;
	};
	/** The check that failed; see {@link ReplayTargetMismatchReason}. */
	readonly reason: ReplayTargetMismatchReason;
	/** The cursor the read started at; the replay target must start here. */
	readonly fromVersion: number;
	/**
	 * Pinned inclusive target the replay had to reach: the stream head, or
	 * `toVersion` on a point-in-time read.
	 */
	readonly targetVersion: number;
	/** Version the aggregate held when the check ran. */
	readonly actualVersion: number;
}

function replayTargetMismatchMessage(
	stream: string,
	options: ReplayTargetMismatchErrorOptions,
): string {
	switch (options.reason) {
		case "target_not_at_cursor":
			return (
				`Replay target for ${stream} stands at version ${options.actualVersion}, ` +
				`but the read continues after version ${options.fromVersion}. The ` +
				"reconstitution factory reports a version other than the read cursor."
			);
		case "pages_short_of_target":
			return (
				`Replay of ${stream} ended at version ${options.actualVersion}, short of ` +
				`the pinned target version ${options.targetVersion}. The read stopped ` +
				`before the target version, the stream has a gap after version ` +
				`${options.actualVersion}, or an upcaster merged stored events.`
			);
	}
}

/**
 * Thrown by `reconstituteAggregateFromStreamPages`, or by a load recipe
 * that replays on its own, when the replay target does not line up with the
 * read. Events carry no stream position, so the aggregate cannot detect a
 * tail that overlaps or misses the version it was reconstituted at. Only
 * the caller, which pinned the target version, can compare. A single page
 * that breaks its window is an {@link InvalidEventStreamPageError} instead.
 *
 * The `reason` names the check that failed. `target_not_at_cursor`: the
 * replay target stands at a version other than the `fromVersion` the read
 * used, found before any page is replayed; a reconstitution factory reports
 * the wrong version. `pages_short_of_target`: the pages ended before the
 * target version. The read stopped early, the stream has a gap, or an
 * upcaster merged several stored events into one. For an EventStore
 * adapter, run `createEventStoreContractTests` and
 * `createEsRepositoryContractTests` against it and fix its windowing. None
 * of the cases is retryable. A snapshot beyond its stream does not reach
 * the replay: `readStreamPages` reports that window as unreachable first,
 * and an adapter that pages on its own must do the same.
 */
export class ReplayTargetMismatchError extends InfrastructureError<"REPLAY_TARGET_MISMATCH"> {
	readonly identity: ReplayTargetMismatchErrorOptions["identity"];
	readonly reason: ReplayTargetMismatchReason;
	readonly fromVersion: number;
	readonly targetVersion: number;
	readonly actualVersion: number;

	constructor(options: ReplayTargetMismatchErrorOptions) {
		const stream = `${describeAggregateIdentity(options.identity)}`;
		const message = replayTargetMismatchMessage(stream, options);
		super({ code: "REPLAY_TARGET_MISMATCH", message });
		this.identity = detachAggregateIdentity(options.identity);
		this.reason = options.reason;
		this.fromVersion = options.fromVersion;
		this.targetVersion = options.targetVersion;
		this.actualVersion = options.actualVersion;
	}
}

/** Constructor options for {@link ReplayRejectedError}. */
export interface ReplayRejectedErrorOptions {
	/** The aggregate the error names. */
	readonly identity: {
		readonly aggregateType: string;
		readonly aggregateId: string;
	};
	/**
	 * The version the aggregate held before the rejected page. With
	 * `toVersion`, it bounds the window `(fromVersion, toVersion]` of the
	 * rejected page, not the window of the read.
	 */
	readonly fromVersion: number;
	/** The last stream position of the rejected page (inclusive). */
	readonly toVersion: number;
	/** The error the aggregate raised for a stored event of the page. */
	readonly cause: DomainError;
}

/**
 * The `Err` of `reconstituteAggregateFromStreamPages`: the aggregate
 * rejected a stored event while it replayed a page of the stream.
 *
 * The window `(fromVersion, toVersion]` locates the rejected page, and
 * `cause` holds the `DomainError` of the aggregate. A stored stream that
 * the domain cannot replay is a defect of the stored data, not a request
 * the caller can correct. So this is an `InfrastructureError`, and it is
 * not retryable. An empty window means that the replay target rejected an
 * empty history before the first page.
 */
export class ReplayRejectedError extends InfrastructureError<"REPLAY_REJECTED"> {
	readonly identity: ReplayRejectedErrorOptions["identity"];
	readonly fromVersion: number;
	readonly toVersion: number;
	declare readonly cause: DomainError;

	constructor(options: ReplayRejectedErrorOptions) {
		const stream = `${describeAggregateIdentity(options.identity)}`;
		const rejected = `${options.cause.code}: ${options.cause.message}`;
		super({
			code: "REPLAY_REJECTED",
			message:
				options.fromVersion === options.toVersion
					? `The replay target of ${stream} rejected an empty history at ` +
						`version ${options.fromVersion} with ${rejected}`
					: `The aggregate ${stream} rejected a stored event in the page ` +
						`(${options.fromVersion}, ${options.toVersion}] with ${rejected}`,
			cause: options.cause,
		});
		this.identity = detachAggregateIdentity(options.identity);
		this.fromVersion = options.fromVersion;
		this.toVersion = options.toVersion;
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
 * Thrown at bootstrap when the global key of a kit capability registry
 * already holds a value that is not a registry: another module claimed
 * the key. The kit neither shares that value nor overwrites it, because a
 * silent replacement would break whichever module owned the key first. A
 * wiring error in the host process; the remedy is one owner per key.
 */
export class CapabilityRegistryConflictError extends KitWiringError<"CAPABILITY_REGISTRY_CONFLICT"> {
	constructor(public readonly key: symbol) {
		super(
			"CAPABILITY_REGISTRY_CONFLICT",
			`The global key ${String(key)} holds a value that is not a ` +
				"capability registry of this package. Another module claimed the " +
				"key; the kit refuses to share or overwrite it.",
		);
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
		/** What was rejected: "aggregate", "entity", "the persistence baseline". */
		public readonly subject: string,
		/** The rejected instance's id, when it has one. */
		public readonly instanceId?: unknown,
		/** One extra sentence about the registry state, when it explains the rejection. */
		detail?: string,
	) {
		super(
			"UNMANAGED_INSTANCE",
			`${operation} requires an instance constructed by this package; ` +
				`${instanceId === undefined ? subject : `${subject} ${String(instanceId)}`} ` +
				"carries no kit-managed capability. Construct it through this " +
				"package and run one compatible package copy; a structural " +
				"lookalike or an instance from another copy cannot be managed." +
				(detail === undefined ? "" : ` ${detail}`),
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

/** Constructor options for {@link UnenrolledChangesError}. */
export interface UnenrolledChangesErrorOptions {
	/** The aggregate the error names. */
	readonly identity: {
		readonly aggregateType: string;
		readonly aggregateId: string;
	};
	/** Whether the repository of the aggregate is append-only. */
	readonly appendOnly?: boolean;
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
 *
 * An append-only repository installs no `update`, so for its aggregate the
 * message names the rule instead: a loaded append-only aggregate must not
 * change.
 */
export class UnenrolledChangesError extends KitWiringError<"UNENROLLED_CHANGES"> {
	readonly identity: UnenrolledChangesErrorOptions["identity"];

	constructor(options: UnenrolledChangesErrorOptions) {
		super(
			"UNENROLLED_CHANGES",
			`Aggregate ${describeAggregateIdentity(options.identity)} was loaded and changed in this unit of work, ` +
				(options.appendOnly
					? "but its repository is append-only and installs no update. " +
						"An append-only aggregate must not change after add."
					: "but no update intent was registered. Call repository.update(aggregate) " +
						"after the final domain decision so state and events flush together."),
		);
		this.identity = detachAggregateIdentity(options.identity);
	}
}

/** Constructor options for {@link AggregateDeletedError}. */
export interface AggregateDeletedErrorOptions {
	/** The aggregate the error names. */
	readonly identity: {
		readonly aggregateType: string;
		readonly aggregateId: string;
	};
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
	readonly identity: AggregateDeletedErrorOptions["identity"];

	constructor(options: AggregateDeletedErrorOptions) {
		super(
			"AGGREGATE_DELETED",
			`Aggregate ${describeAggregateIdentity(options.identity)} was removed in this unit of work and ` +
				"cannot be added, updated, tracked, or removed through another " +
				"instance again. Removal is final within an operation. A repeated " +
				"remove of the SAME instance is an accepted no-op; if the " +
				"aggregate must remain, do not remove it.",
		);
		this.identity = detachAggregateIdentity(options.identity);
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
	/** The aggregate the error names. */
	readonly identity: {
		readonly aggregateType: string;
		readonly aggregateId: string;
	};
	/** Optional lower-level error to preserve in the cause chain. */
	readonly cause?: unknown;
}

export class AggregateNotFoundError extends InfrastructureError<"AGGREGATE_NOT_FOUND"> {
	readonly identity: AggregateNotFoundErrorOptions["identity"];

	constructor(options: AggregateNotFoundErrorOptions) {
		super({
			code: "AGGREGATE_NOT_FOUND",
			message: `Aggregate not found: ${describeAggregateIdentity(options.identity)}`,
			cause: options.cause,
		});
		this.identity = detachAggregateIdentity(options.identity);
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
	/** The aggregate the error names. */
	readonly identity: {
		readonly aggregateType: string;
		readonly aggregateId: string;
	};
	/** Optional driver-level error to preserve in the cause chain. */
	readonly cause?: unknown;
}

export class DuplicateAggregateError extends InfrastructureError<"DUPLICATE_AGGREGATE"> {
	readonly identity: DuplicateAggregateErrorOptions["identity"];

	constructor(options: DuplicateAggregateErrorOptions) {
		super({
			code: "DUPLICATE_AGGREGATE",
			message: `Duplicate aggregate: ${describeAggregateIdentity(options.identity)} already exists`,
			cause: options.cause,
		});
		this.identity = detachAggregateIdentity(options.identity);
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
	/** The aggregate the error names. */
	readonly identity: {
		readonly aggregateType: string;
		readonly aggregateId: string;
	};
	readonly expectedSchemaVersion: number;
	readonly actualSchemaVersion: number;
}

export class SnapshotSchemaMismatchError extends InfrastructureError<"SNAPSHOT_SCHEMA_MISMATCH"> {
	readonly identity: SnapshotSchemaMismatchErrorOptions["identity"];
	readonly expectedSchemaVersion: number;
	readonly actualSchemaVersion: number;

	constructor(options: SnapshotSchemaMismatchErrorOptions) {
		super({
			code: "SNAPSHOT_SCHEMA_MISMATCH",
			message:
				`Snapshot schema mismatch on ${describeAggregateIdentity(options.identity)}: ` +
				`the snapshot model expects schema ${options.expectedSchemaVersion}, ` +
				`the stored snapshot carries ${options.actualSchemaVersion}. Override ` +
				`the model's migrate function to upgrade old snapshots, or discard the snapshot ` +
				`and refold from the full event stream.`,
		});
		this.identity = detachAggregateIdentity(options.identity);
		this.expectedSchemaVersion = options.expectedSchemaVersion;
		this.actualSchemaVersion = options.actualSchemaVersion;
	}
}

/**
 * Why the version check failed, and whether a stored version exists to name.
 *
 * The reason is diagnostic. Callers branch on the code and on `retryable`,
 * never on the reason.
 */
export type ConcurrencyConflictReason =
	/** The aggregate is stored at another version. `actualVersion` carries it. */
	| "stale_version"
	/**
	 * The write matched nothing although the stored version equals the
	 * expected one. Either the write statement carries a condition beyond the
	 * version, for example a tenant id. Or its version read answered from a
	 * transaction snapshot instead of the current row. Both are defects of the
	 * adapter, so this reason is the one that is not retryable: a predicate
	 * defect fires on every write, and retrying it multiplies the load of a
	 * broken deployment instead of surfacing it.
	 *
	 * One occurrence does not tell the two causes apart; their rates do. A
	 * predicate defect fires at a flat rate whatever the load, a snapshot read
	 * only when writes race. An adapter whose version read is a snapshot read
	 * can opt this reason back into retrying through the `isRetryable` of its
	 * retry policy.
	 */
	| "version_unchanged"
	/**
	 * The aggregate no longer exists. Only a store that can lose a persisted
	 * record reports this. An append-only event stream cannot: a stream that
	 * was never created is at version 0, which is `stale_version`.
	 */
	| "aggregate_absent"
	/** The version read failed. The failure travels as the cause. */
	| "version_unknown";

export type ConcurrencyConflictErrorOptions = {
	/** The aggregate the error names. */
	readonly identity: {
		readonly aggregateType: string;
		readonly aggregateId: string;
	};
	/** The write that failed, or `null` when the raising code does not know it. */
	readonly intent?: "add" | "update" | "remove" | null;
	readonly expectedVersion: number;
	/** Optional driver-level error to preserve in the cause chain. */
	readonly cause?: unknown;
} & (
	| {
			readonly reason: "stale_version" | "version_unchanged";
			/** The version the store holds. */
			readonly actualVersion: number;
	  }
	| {
			readonly reason: "aggregate_absent" | "version_unknown";
			/** No stored version exists to name. */
			readonly actualVersion?: null;
	  }
);

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
 * rule) detects the race. Its `retryable` follows the reason, so the
 * `isRetryable` predicate from `@shirudo/base-error` picks up every reason
 * but `version_unchanged`, which names a defect of the adapter.
 */
export class ConcurrencyConflictError extends InfrastructureError<"CONCURRENCY_CONFLICT"> {
	readonly identity: ConcurrencyConflictErrorOptions["identity"];
	/** The write that failed, or `null` when the raising code does not know it. */
	readonly intent: NonNullable<
		ConcurrencyConflictErrorOptions["intent"]
	> | null;
	readonly expectedVersion: number;
	/** The stored version, or `null` when none exists to name. */
	readonly actualVersion: number | null;
	readonly reason: ConcurrencyConflictReason;

	constructor(options: ConcurrencyConflictErrorOptions) {
		super({
			code: "CONCURRENCY_CONFLICT",
			message: concurrencyConflictMessage(options),
			cause: options.cause,
			// The canonical OCC pattern: reload the aggregate, re-apply the
			// use case, retry in a FRESH unit of work. The structured field
			// is what the retry classifier (someChainRetryable) reads. A
			// version_unchanged names a defect of the adapter, and a retry
			// repeats it, so that one reason is not retryable.
			retryable: options.reason !== "version_unchanged",
		});
		this.identity = detachAggregateIdentity(options.identity);
		this.intent = options.intent ?? null;
		this.expectedVersion = options.expectedVersion;
		this.actualVersion = options.actualVersion ?? null;
		this.reason = options.reason;
	}
}

/**
 * Returns the conflict with the given write intent and every observed field
 * of the original: reason, versions, and cause.
 */
export function withWriteIntent(
	conflict: ConcurrencyConflictError,
	intent: NonNullable<ConcurrencyConflictErrorOptions["intent"]>,
): ConcurrencyConflictError {
	const shared = {
		identity: conflict.identity,
		intent,
		expectedVersion: conflict.expectedVersion,
		cause: conflict.cause,
	};
	const { reason, actualVersion } = conflict;
	if (reason === "aggregate_absent" || reason === "version_unknown") {
		return new ConcurrencyConflictError({ ...shared, reason });
	}
	if (actualVersion === null) {
		throw new TypeError(
			`withWriteIntent: a ${reason} conflict on ${describeAggregateIdentity(conflict.identity)} carries no actualVersion`,
		);
	}
	return new ConcurrencyConflictError({ ...shared, reason, actualVersion });
}

function concurrencyConflictMessage(
	options: ConcurrencyConflictErrorOptions,
): string {
	const aggregate = describeAggregateIdentity(options.identity);
	const site =
		options.intent == null ? aggregate : `${options.intent} of ${aggregate}`;
	switch (options.reason) {
		case "stale_version":
			return (
				`Concurrency conflict on ${site}: expected version ` +
				`${options.expectedVersion}, stored version ${options.actualVersion}.`
			);
		case "version_unchanged":
			return (
				`Concurrency conflict on ${site}: the write matched nothing, ` +
				`although the stored version is ${options.actualVersion}. Its ` +
				"statement carries a condition beyond the version, or its version " +
				"read answered from a transaction snapshot. Drop the extra " +
				"condition, or read the version with a locking read, for example " +
				"SELECT ... FOR SHARE."
			);
		case "aggregate_absent":
			return (
				`Concurrency conflict on ${site}: expected version ` +
				`${options.expectedVersion}, but the aggregate no longer exists.`
			);
		case "version_unknown":
			return (
				`Concurrency conflict on ${site}: expected version ` +
				`${options.expectedVersion}. The stored version could not be read; ` +
				"the read failure is the cause."
			);
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
	| "CAPABILITY_REGISTRY_CONFLICT"
	| "COMMIT_FAILED"
	| "CONCURRENCY_CONFLICT"
	| "DIRECT_STATE_MUTATION"
	| "DOMAIN_TRANSITION_GUARD_REJECTED"
	| "DUPLICATE_AGGREGATE"
	| "DUPLICATE_EVENT_ID"
	| "DUPLICATE_HANDLER_REGISTRATION"
	| "ERROR_MAPPER_FAILED"
	| "EVENT_AGGREGATE_IDENTITY_INVALID"
	| "EVENT_BUS_CLOSED"
	| "EVENT_HARVEST_FAILED"
	| "EVENT_ID_INVALID"
	| "EVENT_ID_REQUIRED"
	| "EVENT_OCCURRED_AT_INVALID"
	| "EVENT_OCCURRED_AT_REQUIRED"
	| "EVENT_SCHEMA_VERSION_INVALID"
	| "EVENT_TYPE_INVALID"
	| "FOLD_RETURNED_NO_STATE"
	| "FOREIGN_EVENT"
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
	| "INVALID_EVENT_STREAM_PAGE"
	| "INVALID_FLUSH_STATEMENT"
	| "INVALID_INTEGRATION_MESSAGE"
	| "INVALID_MONEY"
	| "INVALID_REPOSITORY_ADAPTER"
	| "INVALID_REPOSITORY_DEFINITION"
	| "INVALID_VERSION"
	| "MISATTRIBUTED_EVENT"
	| "MISSING_ENTITY_ID"
	| "MISSING_FOLD"
	| "MISSING_HANDLER"
	| "MONEY_CURRENCY_MISMATCH"
	| "MONEY_PRECISION_LOSS"
	| "MONEY_SCALE_MISMATCH"
	| "NESTED_UNIT_OF_WORK"
	| "PENDING_EVENT_BATCH_MISMATCH"
	| "PENDING_EVENT_LIMIT_EXCEEDED"
	| "PROJECTION_GAP"
	| "PROJECTION_IDENTITY_VIOLATION"
	| "PROJECTION_ORDER_VIOLATION"
	| "PROJECTION_RECEIPT_VIOLATION"
	| "PUBLISH_DEPTH_EXCEEDED"
	| "REENTRANT_DOMAIN_STATE_MACHINE_EVALUATION"
	| "REENTRANT_EVENT_RECORDING"
	| "REPLAY_REJECTED"
	| "REPLAY_TARGET_MISMATCH"
	| "REPOSITORY_ERROR_MAPPING_FAILED"
	| "ROLLBACK_FAILED"
	| "SNAPSHOT_CORRUPTED"
	| "SNAPSHOT_SCHEMA_MISMATCH"
	| "SNAPSHOT_TIME_INVALID"
	| "SNAPSHOT_VERSION_NOT_RESTORED"
	| "TRANSACTION_CLOSED"
	| "UNENROLLED_CHANGES"
	| "UNKNOWN_CURRENCY"
	| "UNMANAGED_INSTANCE"
	| "UNMINTED_EVENT"
	| "UNPROJECTABLE_EVENT"
	| "UNREGISTERED_HANDLER"
	| "UNREPLAYABLE_AGGREGATE";
