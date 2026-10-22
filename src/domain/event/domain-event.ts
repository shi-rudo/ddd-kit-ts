import { assertNoOwnProtoKey } from "../../errors/kit-errors";
import {
	assertNotFromAnotherKitCopy,
	markKitCopy,
} from "../../internal/kit-copy";
import { copyPlainData, isDate } from "../../internal/structural/plain-data";
import { uuidV7 } from "../../internal/uuid-v7";
import { deepFreeze } from "../value-object/value-object";
import { type ClockFactory, defaultClockFactory, readClock } from "./clock";
import {
	type DomainEventDefinition,
	type DomainEventOf,
	type DomainEventPayloadInput,
	isDomainEventDefinition,
	ownDefinedPayload,
} from "./domain-event-definition";
import {
	assertEventSchemaVersion,
	assertNonBlankEventField,
	DomainEventValidationError,
} from "./domain-event-errors";

export type { ClockFactory } from "./clock";

/**
 * Factory function producing a fresh, unique event identifier for each call.
 *
 * The library ships a default that creates a time-ordered **UUID v7** from
 * Web Crypto random bits (works on Node 19+, modern browsers in secure
 * contexts, Deno, Bun, Cloudflare Workers, Vercel Edge, and any runtime that
 * implements Web Crypto). A B-tree index on the eventId column stays
 * clustered. The id is no ordering authority: ids from several processes
 * interleave within one millisecond, and clock skew can invert them. Order
 * events by aggregate version or stream position. Supply another generator
 * to {@link createDomainEventFactory} to
 * use ULID, KSUID, or another collision-safe format without mutating module
 * state.
 */
export type EventIdFactory = () => string;

const defaultEventIdFactory: EventIdFactory = uuidV7;

/**
 * Metadata associated with a domain event for traceability and correlation.
 * Used in event-driven architectures to track event flow across services.
 */
export interface EventMetadata {
	/**
	 * Correlation ID for tracing events across multiple services/components.
	 * Typically used to group related events in a distributed system.
	 */
	readonly correlationId?: string;

	/**
	 * Conversation ID shared by every message in one long-running business
	 * interaction, even when that interaction spans several correlations.
	 */
	readonly conversationId?: string;

	/**
	 * Causation ID referencing the event or command that caused this event.
	 * Used to build event chains and understand causality.
	 */
	readonly causationId?: string;

	/**
	 * W3C Trace Context parent for technical tracing across process boundaries.
	 * This is distinct from business correlation and conversation identifiers.
	 */
	readonly traceparent?: string;

	/** Optional W3C vendor trace state associated with `traceparent`. */
	readonly tracestate?: string;

	/**
	 * User ID of the person or system that triggered the event.
	 */
	readonly userId?: string;

	/**
	 * Source service or component that produced the event.
	 */
	readonly source?: string;

	/**
	 * Additional custom metadata fields.
	 * Allows extensibility for domain-specific metadata.
	 */
	readonly [key: string]: unknown;
}

/**
 * Domain Event represents something meaningful that happened in the domain.
 * Events are immutable and carry information about what occurred.
 *
 * **Events are PLAIN DATA objects**, constructed via `createDomainEvent`
 * (or the aggregate's `createEvent` plus application-shell stamping)
 * and deeply frozen. Class-based
 * event objects that satisfy this shape structurally via prototype
 * members are unsupported.
 *
 * **Field-accretion boundary.** Persistence positions, commit boundaries,
 * broker offsets, and other delivery concerns belong in an event envelope,
 * not on the domain event itself.
 *
 * @template T - The event type name (e.g., "OrderCreated")
 * @template P - The event payload type
 */
export interface DomainEvent<T extends string, P = void> {
	/**
	 * Unique identifier for this specific event instance. Used by idempotent
	 * consumers, outbox dispatch tracking, and as the target of
	 * `metadata.causationId`. Convenience constructors default to a UUID v7;
	 * strict construction requires the caller to supply it.
	 */
	readonly eventId: string;

	/**
	 * The type of the event, used for routing and handling.
	 */
	readonly type: T;

	/**
	 * Identifier of the aggregate that produced the event. Optional at the
	 * library level; set it whenever the producing aggregate is known so
	 * downstream subscribers, outboxes, and projections can scope by entity.
	 */
	readonly aggregateId?: string;

	/**
	 * Name of the aggregate type that produced the event (e.g. "Order").
	 * Pairs with `aggregateId` to fully qualify the source aggregate.
	 */
	readonly aggregateType?: string;

	/**
	 * The event payload containing the domain data. The field is always
	 * present; its value is `undefined` when `P` is `void`.
	 */
	readonly payload: P;

	/**
	 * Timestamp when the application shell stamped the accepted fact.
	 * Put business-relevant time in the payload under a domain name.
	 */
	readonly occurredAt: Date;

	/**
	 * Event schema version for handling schema evolution.
	 * Required for safe schema migration in event-sourced systems.
	 * Use 1 for the initial schema version.
	 *
	 * This is the event PAYLOAD schema version, not a persisted aggregate
	 * position. Commit positions live on `CommittedDomainEvent`. It is
	 * also not `AggregateSnapshot.schemaVersion`: that field versions the
	 * stored snapshot state shape. The two evolve independently.
	 */
	readonly schemaVersion: number;

	/**
	 * Optional metadata for traceability, correlation, and auditing.
	 * Includes correlationId, conversationId, causationId, userId, source, and
	 * custom fields.
	 */
	readonly metadata?: EventMetadata;
}

/**
 * Upper-bound alias for "any `DomainEvent` shape". Use as a generic
 * constraint when a type parameter should accept any concrete event
 * union. The `unknown` payload is the upper bound; concrete unions
 * still narrow via `Extract<Evt, { type: K }>` at the use-site.
 */
export type AnyDomainEvent = DomainEvent<string, unknown>;

/**
 * A domain event accepted by an aggregate but not yet given its event id,
 * stamp time, or delivery metadata.
 *
 * The aggregate owns the event type, payload, source aggregate identity,
 * and payload schema version because those values describe the business
 * fact it produced.
 * The application shell later turns this value into a {@link DomainEvent}.
 */
export interface UnstampedDomainEvent<T extends string, P = void> {
	readonly type: T;
	readonly aggregateId?: string;
	readonly aggregateType?: string;
	readonly payload: P;
	readonly schemaVersion: number;
}

/** Upper-bound alias for any unstamped domain-event shape. */
export type AnyUnstampedDomainEvent = UnstampedDomainEvent<string, unknown>;

/** Derives the unstamped shape represented by a concrete event or event union. */
export type UnstampedDomainEventOf<TEvent extends AnyDomainEvent> =
	TEvent extends DomainEvent<infer TType, infer TPayload>
		? UnstampedDomainEvent<TType, TPayload>
		: never;

/** An aggregate may hold unstamped decisions and already stamped events together. */
export type PendingDomainEvent<TEvent extends AnyDomainEvent> =
	| TEvent
	| UnstampedDomainEventOf<TEvent>;

/**
 * Options of `createEvent` in an aggregate. The aggregate fills its own
 * identity, so only the schema version of the payload is left.
 */
export interface CreateEventOptions {
	readonly schemaVersion?: number;
}

/** Producer-owned options for an unstamped event. */
export interface CreateUnstampedDomainEventOptions extends CreateEventOptions {
	readonly aggregateId?: string;
	readonly aggregateType?: string;
}

/**
 * Shared option bag for the `createDomainEvent*` factories.
 */
export interface CreateDomainEventOptions {
	/**
	 * Override for the auto-generated `eventId`. Pass an existing id (for
	 * replay, tests, or deterministic event sourcing) instead of letting the
	 * factory generate a UUID v7.
	 */
	eventId?: string;

	/**
	 * Identifier of the aggregate that produced the event.
	 */
	aggregateId?: string;

	/**
	 * Name of the aggregate type that produced the event.
	 */
	aggregateType?: string;

	/**
	 * Override for the auto-generated `occurredAt` timestamp.
	 */
	occurredAt?: Date;

	/**
	 * Override for the default schema version (1).
	 */
	schemaVersion?: number;

	/**
	 * Event metadata: correlation, causation, user, source, custom fields.
	 */
	metadata?: EventMetadata;
}

/** Technical stamp data attached by the application shell. */
export interface DomainEventStamp {
	/** Stable identity for this event instance. */
	readonly eventId: string;
	/** Time at which the accepted domain fact was recorded. */
	readonly occurredAt: Date;
	/** Optional correlation, causation, actor, and source metadata. */
	readonly metadata?: EventMetadata;
}

/** Full strict-construction options, including producer-owned event fields. */
export interface CreateStampedDomainEventOptions extends DomainEventStamp {
	readonly aggregateId?: string;
	readonly aggregateType?: string;
	readonly schemaVersion?: number;
}

/** Overrides accepted when an application-shell factory creates a stamp. */
export interface CreateDomainEventStampOptions {
	readonly eventId?: string;
	readonly occurredAt?: Date;
	readonly metadata?: EventMetadata;
}

/** Dependencies captured by one immutable domain-event factory instance. */
export interface DomainEventFactoryOptions {
	/** Event-id generator. Defaults to a UUID v7 from Web Crypto random bits. */
	readonly eventIdFactory?: EventIdFactory;
	/** Event-recording clock. Defaults to `() => new Date()`. */
	readonly clock?: ClockFactory;
	/**
	 * Origin stamped on every event this factory builds, unless the call site
	 * names one itself.
	 *
	 * A plain value, not a factory like the two above. Those produce a new
	 * value for each event. An origin identifies the system that builds them
	 * and does not change between two of them.
	 */
	readonly source?: string;
}

/**
 * Instance-bound event constructor. Each factory permanently captures its
 * own event-id and clock dependencies, so request and test instances cannot
 * overwrite one another through module state.
 */
export interface DomainEventFactory {
	/**
	 * Creates immutable technical stamp data in the application shell.
	 */
	readonly createStamp: (
		options?: CreateDomainEventStampOptions,
	) => DomainEventStamp;
	readonly create: {
		<T extends string>(
			type: T,
			payload?: undefined,
			options?: CreateDomainEventOptions,
		): DomainEvent<T, void>;
		<T extends string, P>(
			type: T,
			payload: P,
			options?: CreateDomainEventOptions,
		): DomainEvent<T, P>;
		<D extends DomainEventDefinition>(
			definition: D,
			payload: DomainEventPayloadInput<D>,
			options?: Omit<CreateDomainEventOptions, "schemaVersion">,
		): DomainEventOf<D>;
	};
	/**
	 * Reads the captured clock and returns a defensive `Date` copy.
	 * Throws `TypeError` when the clock does not return a valid date.
	 */
	readonly now: () => Date;
}

/**
 * Creates an immutable, instance-bound domain-event factory.
 *
 * The supplied functions are read once and captured by value. The returned
 * object is frozen, so another request, test, or library cannot replace its
 * policy. Its {@link DomainEventFactory.createStamp} method is the
 * application-shell bridge that stamps an accepted aggregate decision.
 * Passing the factory through `AggregateConfig`
 * enables the explicitly named convenience methods, whose defaults read time
 * and randomness.
 *
 * @example
 * ```ts
 * const domainEvents = createDomainEventFactory({
 *   eventIdFactory: () => uuidv7(),
 *   clock: () => new Date(),
 * });
 * const uow = new UnitOfWork({ ...deps, eventStampFactory: domainEvents });
 * ```
 */
export function createDomainEventFactory(
	options: DomainEventFactoryOptions = {},
): DomainEventFactory {
	return buildDomainEventFactory(options, "DomainEventFactory.create");
}

/** `createOperation` is the name that the errors of `create` give. */
function buildDomainEventFactory(
	options: DomainEventFactoryOptions,
	createOperation: string,
): DomainEventFactory {
	const eventIdFactory = options.eventIdFactory ?? defaultEventIdFactory;
	const clock = options.clock ?? defaultClockFactory;
	const { source } = options;
	const create = (<T extends string, P>(
		type: T | DomainEventDefinition<T>,
		payload?: P,
		createOptions?: CreateDomainEventOptions,
	): DomainEvent<T, P> =>
		buildDomainEvent(
			type,
			payload,
			createOptions,
			eventIdFactory,
			clock,
			createOperation,
			source,
		)) as DomainEventFactory["create"];
	const createStamp = (
		stampOptions: CreateDomainEventStampOptions = {},
	): DomainEventStamp => {
		const explicitOccurredAt =
			stampOptions.occurredAt === undefined
				? undefined
				: copyValidEventDate(stampOptions.occurredAt);
		if (stampOptions.eventId !== undefined) {
			assertNonBlankEventField(
				stampOptions.eventId,
				"eventId",
				"EVENT_ID_INVALID",
			);
		}
		const eventId = stampOptions.eventId ?? eventIdFactory();
		assertNonBlankEventField(eventId, "eventId", "EVENT_ID_INVALID");
		const occurredAt = explicitOccurredAt ?? readEventClock(clock);
		const metadata = ownedEventMetadata(
			stampOptions.metadata,
			"DomainEventFactory.createStamp",
			source,
		);
		const stamp: DomainEventStamp = {
			eventId,
			occurredAt,
			metadata,
		};
		const owned = deepFreeze(stamp) as DomainEventStamp;
		FACTORY_OWNED_EVENT_STAMPS.add(owned);
		return owned;
	};

	return Object.freeze({
		createStamp,
		create,
		now: () => readClock(clock),
	});
}

/**
 * Immutable UUID-v7/platform-clock factory used by the top-level
 * {@link createDomainEvent}. It cannot be reconfigured; construct an instance
 * with {@link createDomainEventFactory} for custom policy.
 */
export const defaultDomainEventFactory: DomainEventFactory =
	buildDomainEventFactory({}, "createDomainEvent");

// Every stamped event a kit constructor returns is registered here: the
// module-private tier of the recorded-event marker (nothing outside this
// module can add to the set), so the aggregate recording paths can check
// "built by a kit constructor" directly instead of approximating it with
// frozen-ness probes. Kit-built implies deeply frozen with owned payload/metadata
// (binary buffers, which cannot be frozen, are rejected at the door).
// WeakSet entries do not keep events alive.
const STAMPED_EVENTS = new WeakSet<object>();
const UNSTAMPED_EVENTS = new WeakSet<object>();
const FACTORY_OWNED_EVENT_STAMPS = new WeakSet<object>();

function isFactoryOwnedDomainEventStamp(stamp: object): boolean {
	return FACTORY_OWNED_EVENT_STAMPS.has(stamp);
}

/**
 * Whether `event` is a stamped domain event that this copy of the kit
 * built: it came out of {@link createDomainEvent},
 * {@link createStampedDomainEvent}, or {@link stampDomainEvent}, so it is
 * deeply frozen with defensively copied payload and metadata. An unstamped
 * decision is in the other set; see {@link isUnstampedDomainEvent}.
 * Module-internal export for the aggregate recording paths; not part of
 * the package entries.
 */
export function isStampedDomainEvent(event: object): event is AnyDomainEvent {
	return STAMPED_EVENTS.has(event);
}

/** Whether a value is an unstamped event that this copy of the kit built. */
export function isUnstampedDomainEvent(
	event: object,
): event is AnyUnstampedDomainEvent {
	return UNSTAMPED_EVENTS.has(event);
}

/**
 * Throws `DuplicateKitCopyError` when another loaded copy of the kit built
 * `event`. A recording path calls it before it reports the event as
 * hand-built.
 */
export function assertEventNotFromAnotherKitCopy(event: unknown): void {
	assertNotFromAnotherKitCopy(event, "The domain event");
}

/**
 * Creates an unstamped domain event: the event that an aggregate method
 * returns before the commit stamps it. The payload and the
 * metadata follow the input ownership rule of {@link createDomainEvent}.
 */
export function createUnstampedDomainEvent<T extends string>(
	type: T,
	payload?: undefined,
	options?: CreateUnstampedDomainEventOptions,
): UnstampedDomainEvent<T, void>;
export function createUnstampedDomainEvent<T extends string, P>(
	type: T,
	payload: P,
	options?: CreateUnstampedDomainEventOptions,
): UnstampedDomainEvent<T, P>;
export function createUnstampedDomainEvent<T extends string, P>(
	type: T,
	payload?: P,
	options?: CreateUnstampedDomainEventOptions,
): UnstampedDomainEvent<T, P> {
	return buildUnstampedDomainEvent(
		type,
		payload,
		options,
		"createUnstampedDomainEvent",
	);
}

/**
 * {@link createUnstampedDomainEvent} whose errors name `operation`, the
 * function that the caller called. Module-internal export; not part of the
 * package entries.
 */
export function buildUnstampedDomainEvent<T extends string, P>(
	typeOrDefinition: T | DomainEventDefinition<T>,
	payload: P | undefined,
	unstampedOptions: CreateUnstampedDomainEventOptions | undefined,
	operation: string,
): UnstampedDomainEvent<T, P> {
	const definition = definitionOf(typeOrDefinition);
	const type = definition?.type ?? (typeOrDefinition as T);
	const options = withDefinitionVersion(
		definition,
		unstampedOptions,
		operation,
	);
	assertProducerOwnedEventFields(type, options);
	const event: UnstampedDomainEvent<T, P> = {
		type,
		aggregateId: options?.aggregateId,
		aggregateType: options?.aggregateType,
		payload: ownEventPayload(definition, payload, operation),
		schemaVersion: options?.schemaVersion ?? 1,
	};
	markKitCopy(event);
	const unstamped = deepFreeze(event) as UnstampedDomainEvent<T, P>;
	UNSTAMPED_EVENTS.add(unstamped);
	return unstamped;
}

/** Marks and freezes a kit-derived copy of an unstamped event. */
export function adoptUnstampedDomainEvent<T extends object>(copy: T): T {
	markKitCopy(copy);
	Object.freeze(copy);
	UNSTAMPED_EVENTS.add(copy);
	return copy;
}

/**
 * Attaches shell-owned stamp data to an accepted aggregate decision.
 *
 * The decision supplies the domain type, payload, source aggregate
 * identity, and payload schema version. The stamp supplies only event
 * identity, stamp time, and trace metadata.
 */
export function stampDomainEvent<T extends string, P>(
	event: UnstampedDomainEvent<T, P>,
	stamp: DomainEventStamp,
): DomainEvent<T, P> {
	if (!isUnstampedDomainEvent(event)) {
		assertEventNotFromAnotherKitCopy(event);
		throw new TypeError(
			"stampDomainEvent requires an unstamped event from an aggregate's createEvent",
		);
	}
	if (isFactoryOwnedDomainEventStamp(stamp)) {
		// createStamp already validated, defensively copied, and deep-froze
		// every stamp field; re-validating or re-copying here would only pay
		// the work twice per stamped event.
		return buildStampedEvent(
			event,
			stamp.eventId,
			stamp.occurredAt,
			stamp.metadata,
		);
	}
	// A caller-built stamp is caller-owned and unfrozen: validate and copy
	// the stamp fields before they enter the immutable event.
	assertNonBlankEventField(stamp.eventId, "eventId", "EVENT_ID_INVALID");
	const occurredAt = deepFreeze(copyValidEventDate(stamp.occurredAt)) as Date;
	const metadata = ownedEventMetadata(stamp.metadata, "stampDomainEvent");
	return buildStampedEvent(
		event,
		stamp.eventId,
		occurredAt,
		metadata === undefined
			? undefined
			: (deepFreeze(metadata) as EventMetadata),
	);
}

/**
 * Single build tail for both stamp provenances. The stamp fields arrive
 * pre-validated, copied, and frozen (by `createStamp` for factory-owned
 * stamps, by `stampDomainEvent` for caller-built stamps); the unstamped
 * event's payload is already defensively cloned and deeply frozen by its
 * constructor and is shared instead of paying a second deep copy per event.
 */
function buildStampedEvent<T extends string, P>(
	event: UnstampedDomainEvent<T, P>,
	eventId: string,
	occurredAt: Date,
	metadata: EventMetadata | undefined,
): DomainEvent<T, P> {
	assertProducerOwnedEventFields(event.type, event);
	const recorded: DomainEvent<T, P> = {
		eventId,
		type: event.type,
		aggregateId: event.aggregateId,
		aggregateType: event.aggregateType,
		payload: event.payload,
		occurredAt,
		schemaVersion: event.schemaVersion,
		metadata,
	};
	markKitCopy(recorded);
	Object.freeze(recorded);
	STAMPED_EVENTS.add(recorded);
	return recorded;
}

/**
 * Marks, freezes, and registers a kit-derived copy of a stamped event
 * (e.g. the copy `apply()` stamps with the aggregate identity) as recorded
 * itself.
 * The copy shares the already-frozen payload/metadata of its source,
 * so the kit-built guarantee carries over. Module-internal export; not
 * part of the package entries.
 */
export function adoptStampedDomainEvent<T extends object>(copy: T): T {
	markKitCopy(copy);
	Object.freeze(copy);
	STAMPED_EVENTS.add(copy);
	return copy;
}

/**
 * Creates a domain event with default values.
 * Sets occurredAt to current date and schemaVersion to 1 if not provided.
 *
 * **Input ownership.** The event is deeply frozen, and `payload` and
 * `metadata` are copied first, so the caller's own objects are never
 * frozen in place and later mutation of them does not bleed into the event
 * (same contract as `valueObject()`). The copy follows the plain-data rule
 * of the kit (records, arrays, `Date`, `Map`, `Set`, and primitives; see
 * the design decisions). A value outside it throws a `TypeError` that names
 * the path, for example a function, a class instance, a `RegExp`, binary
 * data, or an accessor. Map a value object to plain data before it goes
 * into an event. `toJSON()` of a `ValueObject` is shallow, so map a nested
 * value object too.
 *
 * **With a definition.** Pass a definition from `defineDomainEvent` in
 * place of the type, and its Standard Schema decides what the payload may
 * contain. The payload is the schema output, copied and frozen, and the
 * event takes the schema version of the definition.
 *
 * **For aggregate-internal events, prefer `this.createEvent(...)` on
 * `StateStoredAggregate` / `EventSourcedAggregate`.** That helper auto-injects
 * `aggregateId` (from `this.id`) and `aggregateType` (from the
 * aggregate's declared `aggregateType` property), which downstream
 * consumers (outbox dispatchers, projection handlers, audit logs)
 * route by. The commit boundary validates that both fields are present
 * and throws if they are missing, so a direct `createDomainEvent(...)`
 * call inside an aggregate that forgets the options is caught at
 * runtime. The commit stamps pending decisions when a repository write
 * registers the aggregate.
 *
 * Use `createDomainEvent(...)` directly for events that don't belong to
 * an aggregate: system events, integration events, configuration events,
 * test fixtures. For those, set `aggregateId` / `aggregateType` in
 * `options` if downstream consumers expect routing metadata.
 *
 * @param type - The event type
 * @param payload - The event payload
 * @param options - Optional event configuration (including `aggregateId`
 *   and `aggregateType` for routing)
 * @returns A domain event
 *
 * @example
 * ```typescript
 * const event = createDomainEvent("OrderCreated", { orderId: "123" });
 * ```
 */
export function createDomainEvent<T extends string>(
	type: T,
	payload?: undefined,
	options?: CreateDomainEventOptions,
): DomainEvent<T, void>;
export function createDomainEvent<T extends string, P>(
	type: T,
	payload: P,
	options?: CreateDomainEventOptions,
): DomainEvent<T, P>;
export function createDomainEvent<D extends DomainEventDefinition>(
	definition: D,
	payload: DomainEventPayloadInput<D>,
	options?: Omit<CreateDomainEventOptions, "schemaVersion">,
): DomainEventOf<D>;
export function createDomainEvent<T extends string, P>(
	type: T | DomainEventDefinition<T>,
	payload?: P,
	options?: CreateDomainEventOptions,
): DomainEvent<T, P> {
	return (
		defaultDomainEventFactory.create as (
			type: T | DomainEventDefinition<T>,
			payload?: P,
			options?: CreateDomainEventOptions,
		) => DomainEvent<T, P>
	)(type, payload, options);
}

/**
 * Creates a kit-built, stamped domain event exclusively from explicit envelope
 * facts. Unlike {@link createDomainEvent}, it has no clock or event-id fallback
 * and is useful when replay, migration, or a caller-owned boundary already has
 * the final identity and occurrence time.
 *
 * Aggregate behavior normally creates an {@link UnstampedDomainEvent} through
 * its protected `createEvent` helper. The application shell later records that
 * pending fact with caller-owned time and identity.
 */
export function createStampedDomainEvent<T extends string>(
	type: T,
	payload: undefined,
	options: CreateStampedDomainEventOptions,
): DomainEvent<T, void>;
export function createStampedDomainEvent<T extends string, P>(
	type: T,
	payload: P,
	options: CreateStampedDomainEventOptions,
): DomainEvent<T, P>;
export function createStampedDomainEvent<D extends DomainEventDefinition>(
	definition: D,
	payload: DomainEventPayloadInput<D>,
	options: Omit<CreateStampedDomainEventOptions, "schemaVersion">,
): DomainEventOf<D>;
export function createStampedDomainEvent<T extends string, P>(
	type: T | DomainEventDefinition<T>,
	payload: P | undefined,
	options: CreateStampedDomainEventOptions,
): DomainEvent<T, P> {
	if (options?.eventId === undefined) {
		missingExplicitEventId();
	}
	if (options.occurredAt === undefined) {
		missingExplicitOccurredAt();
	}
	return buildDomainEvent(
		type,
		payload,
		options,
		missingExplicitEventId,
		missingExplicitOccurredAt,
		"createStampedDomainEvent",
	);
}

function missingExplicitEventId(): string {
	throw new DomainEventValidationError(
		"EVENT_ID_REQUIRED",
		"eventId",
		"createStampedDomainEvent requires an explicit eventId",
	);
}

function missingExplicitOccurredAt(): Date {
	throw new DomainEventValidationError(
		"EVENT_OCCURRED_AT_REQUIRED",
		"occurredAt",
		"createStampedDomainEvent requires an explicit occurredAt",
	);
}

function buildDomainEvent<T extends string, P>(
	typeOrDefinition: T | DomainEventDefinition<T>,
	payload: P | undefined,
	createOptions: CreateDomainEventOptions | undefined,
	eventIdFactory: EventIdFactory,
	clock: ClockFactory,
	operation: string,
	factorySource?: string,
): DomainEvent<T, P> {
	const definition = definitionOf(typeOrDefinition);
	const type = definition?.type ?? (typeOrDefinition as T);
	const options = withDefinitionVersion(definition, createOptions, operation);
	assertProducerOwnedEventFields(type, options);
	const eventId = options?.eventId ?? eventIdFactory();
	assertNonBlankEventField(eventId, "eventId", "EVENT_ID_INVALID");
	const occurredAt =
		options?.occurredAt === undefined
			? readEventClock(clock)
			: copyValidEventDate(options.occurredAt);
	const schemaVersion = options?.schemaVersion ?? 1;
	const event: DomainEvent<T, P> = {
		eventId,
		type,
		aggregateId: options?.aggregateId,
		aggregateType: options?.aggregateType,
		// Defensive copies throughout: the deep-freeze below must never
		// reach the caller's own object graph. Without the clone, passing
		// (parts of) live aggregate state as payload, or reusing a metadata
		// object across events, would freeze the caller's objects in place;
		// the next mutation then throws far away from the cause. Same
		// ownership contract as `valueObject()` and the occurredAt copy.
		payload: ownEventPayload(definition, payload, operation),
		// A caller-supplied occurredAt and a factory reading are both copied
		// before the event is frozen, so neither aliases caller-owned state.
		occurredAt,
		schemaVersion,
		metadata: ownedEventMetadata(options?.metadata, operation, factorySource),
	};
	// Deep-freeze so a mutating subscriber cannot poison subsequent
	// handlers: events are facts of the past and must be immutable
	// (Vernon, IDDD §8).
	// Brand BEFORE the freeze (a frozen object rejects new properties);
	// non-enumerable, so spreads, JSON, and equality never see it.
	markKitCopy(event);
	const built = deepFreeze(event) as DomainEvent<T, P>;
	STAMPED_EVENTS.add(built);
	return built;
}

function assertProducerOwnedEventFields(
	type: unknown,
	options:
		| CreateDomainEventOptions
		| CreateUnstampedDomainEventOptions
		| undefined,
): void {
	assertNonBlankEventField(type, "type", "EVENT_TYPE_INVALID");
	assertEventSchemaVersion(options?.schemaVersion ?? 1);
	if (options?.aggregateId !== undefined) {
		assertNonBlankEventField(
			options.aggregateId,
			"aggregateId",
			"EVENT_AGGREGATE_IDENTITY_INVALID",
		);
	}
	if (options?.aggregateType !== undefined) {
		assertNonBlankEventField(
			options.aggregateType,
			"aggregateType",
			"EVENT_AGGREGATE_IDENTITY_INVALID",
		);
	}
}

function copyValidEventDate(value: unknown): Date {
	if (!isDate(value) || !Number.isFinite(value.getTime())) {
		throw new DomainEventValidationError(
			"EVENT_OCCURRED_AT_INVALID",
			"occurredAt",
			"domain-event occurredAt must be a valid Date",
		);
	}
	return new Date(value.getTime());
}

function readEventClock(clock: ClockFactory): Date {
	return copyValidEventDate(clock());
}

/**
 * Copies the caller's metadata and checks the copy. Metadata is a plain
 * record or absent; a null from a JSON envelope would build and then fail
 * every metadata read far from the producer. A factory origin fills
 * `source` only after the check, and a call site that names its own source
 * keeps it: an explicit fact about one event outranks the default of the
 * factory that builds it.
 */
function ownedEventMetadata(
	metadata: EventMetadata | undefined,
	operation: string,
	factorySource?: string,
): EventMetadata | undefined {
	if (metadata === undefined) {
		return factorySource === undefined ? undefined : { source: factorySource };
	}
	const owned: unknown = cloneOwnedEventData(metadata, "metadata", operation);
	if (!isPlainRecord(owned)) {
		const received =
			typeof owned === "object"
				? owned === null
					? "null"
					: Object.prototype.toString.call(owned)
				: `a ${typeof owned}`;
		throw new TypeError(
			`${operation}: metadata must be an object or undefined, and a plain record; received ${received}`,
		);
	}
	const record = owned as EventMetadata;
	if (factorySource === undefined || record.source !== undefined) {
		return record;
	}
	return { ...record, source: factorySource };
}

/** True for the copy of a record: the copy lives in this realm. */
function isPlainRecord(copy: unknown): boolean {
	if (typeof copy !== "object" || copy === null) return false;
	const prototype = Object.getPrototypeOf(copy);
	return prototype === Object.prototype || prototype === null;
}

/**
 * Copies caller-supplied event data (payload, metadata) under the
 * plain-data rule before the event is frozen, so a constructor never freezes
 * or aliases the caller's own object graph.
 */
function cloneOwnedEventData<T>(
	value: T,
	field: "payload" | "metadata",
	operation: string,
): T {
	return copyPlainData(value, { subject: `${operation}: ${field}` });
}

/** The definition when the caller passed one in place of the type. */
function definitionOf<T extends string>(
	typeOrDefinition: T | DomainEventDefinition<T>,
): DomainEventDefinition<T> | undefined {
	return isDomainEventDefinition(typeOrDefinition)
		? (typeOrDefinition as DomainEventDefinition<T>)
		: undefined;
}

/**
 * The options with the schema version of the definition. A definition owns
 * the version of its payload schema, so an explicit version contradicts it.
 */
function withDefinitionVersion<
	TOptions extends { readonly schemaVersion?: number },
>(
	definition: DomainEventDefinition | undefined,
	options: TOptions | undefined,
	operation: string,
): TOptions | undefined {
	if (definition === undefined) return options;
	if (options?.schemaVersion !== undefined) {
		throw new DomainEventValidationError(
			"EVENT_SCHEMA_VERSION_INVALID",
			"schemaVersion",
			`${operation}: an event of the definition "${definition.type}" takes its schemaVersion from the definition`,
		);
	}
	return { ...options, schemaVersion: definition.schemaVersion } as TOptions;
}

/**
 * The owned copy of the payload: the checked schema output for a defined
 * event, and the deep-checked copy for any other event.
 */
function ownEventPayload<P>(
	definition: DomainEventDefinition | undefined,
	payload: P | undefined,
	operation: string,
): P {
	return definition === undefined
		? cloneOwnedEventData(payload as P, "payload", operation)
		: (ownDefinedPayload(definition, payload, operation) as P);
}

/**
 * Copies metadata from a source event to a new event.
 * Useful for maintaining correlation chains in event-driven architectures.
 *
 * @example
 * ```typescript
 * const newEvent = createDomainEvent(
 *   "OrderShipped",
 *   { orderId: "123" },
 *   { metadata: copyMetadata(previousEvent, { causationId: previousEvent.eventId }) }
 * );
 * ```
 */
export function copyMetadata(
	sourceEvent: AnyDomainEvent,
	additionalMetadata?: Partial<EventMetadata>,
): EventMetadata {
	// Guard BOTH inputs: additional metadata from the caller AND the
	// source event's metadata, because events can be hand-built without
	// createDomainEvent. Spread itself is safe (CreateDataProperty, never
	// the __proto__ setter); the guard is about not CARRYING the payload.
	if (sourceEvent.metadata !== undefined) {
		assertNoOwnProtoKey(sourceEvent.metadata, "Event metadata");
	}
	if (additionalMetadata !== undefined) {
		assertNoOwnProtoKey(additionalMetadata, "Event metadata");
	}
	return {
		...(sourceEvent.metadata ?? {}),
		...(additionalMetadata ?? {}),
	};
}

/**
 * Merges multiple metadata objects into one.
 * Later metadata objects override earlier ones for the same keys.
 *
 * @example
 * ```typescript
 * const metadata = mergeMetadata(
 *   { correlationId: "corr-123" },
 *   { userId: "user-456" },
 *   { source: "order-service" }
 * );
 * ```
 */
export function mergeMetadata(
	...metadataObjects: Array<EventMetadata | undefined>
): EventMetadata {
	const merged: Record<PropertyKey, unknown> = {};
	for (const metadata of metadataObjects) {
		if (!metadata) continue;
		// An own "__proto__" key, typical of JSON.parse'd metadata, would
		// reach the prototype setter of `merged` through Object.assign.
		assertNoOwnProtoKey(metadata, "Event metadata");
		Object.assign(merged, metadata);
	}
	return merged as EventMetadata;
}
