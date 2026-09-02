import { assertNoHostileOwnProtoKey } from "../../errors/kit-errors";
import { deepFreeze } from "../value-object/value-object";
import { type ClockFactory, defaultClockFactory, readClock } from "./clock";
import { DomainEventValidationError } from "./domain-event-errors";

export type { ClockFactory } from "./clock";

/**
 * Factory function producing a fresh, unique event identifier for each call.
 *
 * The library ships a default that uses Web Crypto `crypto.randomUUID()`
 * (works on Node 19+, modern browsers in secure contexts, Deno, Bun,
 * Cloudflare Workers, Vercel Edge, and any runtime that implements Web
 * Crypto). Note that `crypto.randomUUID()` returns **UUID v4** (purely
 * random); for production event stores prefer a **time-ordered** id
 * format (UUID v7 / ULID / KSUID) so B-tree indexes on the eventId
 * column stay clustered and `ORDER BY eventId` matches creation order.
 * Supply one to {@link createDomainEventFactory} to use UUID v7, ULID,
 * KSUID, or another collision-safe format without mutating module state.
 */
export type EventIdFactory = () => string;

const defaultEventIdFactory: EventIdFactory = () => crypto.randomUUID();

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
 * (or the aggregate's `createEvent` plus application-shell recording path)
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
	 * `metadata.causationId`. Convenience constructors default to
	 * `crypto.randomUUID()`; strict construction requires the caller to supply it.
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
	 * Timestamp when the accepted fact was recorded by the application shell.
	 * Put business-relevant time in the payload under a domain name.
	 */
	readonly occurredAt: Date;

	/**
	 * Event schema version for handling schema evolution.
	 * Required for safe schema migration in event-sourced systems.
	 * Use 1 for the initial schema version.
	 *
	 * This is the event PAYLOAD schema version, not a persisted aggregate
	 * position. Commit positions live on `CommittedDomainEvent`.
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
 * A domain event accepted by an aggregate but not yet given its recording
 * identity, recording time, or delivery metadata.
 *
 * The aggregate owns the event type, payload, source address, and payload
 * schema version because those values describe the business fact it produced.
 * The application shell later turns this value into a {@link DomainEvent}.
 */
export interface UncommittedDomainEvent<T extends string, P = void> {
	readonly type: T;
	readonly aggregateId?: string;
	readonly aggregateType?: string;
	readonly payload: P;
	readonly schemaVersion: number;
}

/** Upper-bound alias for any uncommitted domain-event shape. */
export type AnyUncommittedDomainEvent = UncommittedDomainEvent<string, unknown>;

/** Derives the uncommitted shape represented by a concrete event or event union. */
export type UncommittedDomainEventOf<TEvent extends AnyDomainEvent> =
	TEvent extends DomainEvent<infer TType, infer TPayload>
		? UncommittedDomainEvent<TType, TPayload>
		: never;

/** An aggregate may hold unstamped decisions and already recorded events together. */
export type PendingDomainEvent<TEvent extends AnyDomainEvent> =
	| TEvent
	| UncommittedDomainEventOf<TEvent>;

/** Producer-owned options for an uncommitted event. */
export interface CreateUncommittedDomainEventOptions {
	readonly aggregateId?: string;
	readonly aggregateType?: string;
	readonly schemaVersion?: number;
}

/**
 * Shared option bag for the `createDomainEvent*` factories.
 */
export interface CreateDomainEventOptions {
	/**
	 * Override for the auto-generated `eventId`. Pass an existing id (for
	 * replay, tests, or deterministic event sourcing) instead of letting the
	 * factory call `crypto.randomUUID()`.
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

/** Technical recording data attached by the application shell. */
export interface DomainEventStamp {
	/** Stable identity for this event instance. */
	readonly eventId: string;
	/** Time at which the accepted domain fact was recorded. */
	readonly occurredAt: Date;
	/** Optional correlation, causation, actor, and source metadata. */
	readonly metadata?: EventMetadata;
}

/** Full strict-construction options, including producer-owned event fields. */
export interface CreateDomainEventFromFactsOptions extends DomainEventStamp {
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
	/** Event-id generator. Defaults to Web Crypto `crypto.randomUUID()`. */
	readonly eventIdFactory?: EventIdFactory;
	/** Event-recording clock. Defaults to `() => new Date()`. */
	readonly clock?: ClockFactory;
	/**
	 * Origin stamped on every event this factory mints, unless the call site
	 * names one itself.
	 *
	 * A plain value, not a factory like the two above. Those produce a new
	 * value for each event. An origin identifies the system that mints them
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
	 * Creates immutable technical recording data in the application shell.
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
 * application-shell bridge that records an accepted aggregate decision.
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
 * order.confirm();
 * recordPendingEvents(order, domainEvents);
 * ```
 */
/**
 * Fills the origin of a factory into options that name none.
 *
 * A call site that states its own source keeps it: an explicit fact about one
 * event outranks the default of the factory that mints it.
 */
function withFactorySource<T extends { readonly metadata?: EventMetadata }>(
	options: T | undefined,
	source: string | undefined,
): T {
	const given = (options ?? {}) as T;
	if (source === undefined || given.metadata?.source !== undefined) {
		return given;
	}
	return { ...given, metadata: { ...given.metadata, source } };
}

export function createDomainEventFactory(
	options: DomainEventFactoryOptions = {},
): DomainEventFactory {
	const eventIdFactory = options.eventIdFactory ?? defaultEventIdFactory;
	const clock = options.clock ?? defaultClockFactory;
	const { source } = options;
	const create = (<T extends string, P>(
		type: T,
		payload?: P,
		createOptions?: CreateDomainEventOptions,
	): DomainEvent<T, P> =>
		mintDomainEvent(
			type,
			payload,
			withFactorySource(createOptions, source),
			eventIdFactory,
			clock,
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
		const metadata = cloneOwnedEventData(
			withFactorySource(stampOptions, source).metadata,
			"metadata",
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
 * Immutable UUID-v4/platform-clock factory used by the top-level
 * {@link createDomainEvent}. It cannot be reconfigured; construct an instance
 * with {@link createDomainEventFactory} for custom policy.
 */
export const defaultDomainEventFactory: DomainEventFactory =
	createDomainEventFactory();

/**
 * Creates a domain event with default values.
 * Sets occurredAt to current date and schemaVersion to 1 if not provided.
 *
 * **Input ownership.** The event is deeply frozen, and `payload` and
 * `metadata` are deep-cloned first, so the caller's own objects are never
 * frozen in place and later mutation of them does not bleed into the
 * event (same contract as `vo()`). The clone follows the plain-data event
 * contract via `structuredClone`: functions, Promise, and WeakMap/WeakSet
 * values throw a `TypeError`; symbol-keyed properties are not carried
 * over.
 *
 * **For aggregate-internal events, prefer `this.createEvent(...)` on
 * `StateStoredAggregate` / `EventSourcedAggregate`.** That helper auto-injects
 * `aggregateId` (from `this.id`) and `aggregateType` (from the
 * aggregate's declared `aggregateType` property), which downstream
 * consumers (outbox dispatchers, projection handlers, audit logs)
 * route by. The commit boundary validates that both fields are present
 * and throws if they are missing, so a direct `createDomainEvent(...)`
 * call inside an aggregate that forgets the options is caught at
 * runtime. Record pending decisions in the application
 * shell before repository persistence or outbox harvest.
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
// Every recorded event a kit constructor returns is registered here: the
// module-private tier of the recorded-event marker (nothing outside this
// module can add to the set), so the aggregate recording paths can check
// "minted by the constructor" directly instead of approximating it with
// frozen-ness probes. Minted implies deeply frozen with owned payload/metadata
// (binary buffers, which cannot be frozen, are rejected at the door).
// WeakSet entries do not keep events alive.
const RECORDED_EVENTS = new WeakSet<object>();
const UNCOMMITTED_EVENTS = new WeakSet<object>();
const FACTORY_OWNED_EVENT_STAMPS = new WeakSet<object>();

// Cooperative cross-instance tier of the mint check: a WeakSet is
// bound to ONE loaded copy of this module, so an event legitimately
// minted by a second copy of the kit (duplicate npm dependency, dual
// CJS/ESM load, plugin bundle) would be rejected as unminted. Such
// events are recognized by this global-registry brand instead, which
// every constructor and kit-derived copy stamps (non-enumerable, so it
// never leaks into spreads, JSON, or equality). The brand is forgeable
// BY DESIGN: the mint gate catches accidental hand-rolled literals, it
// is not a security boundary against code that deliberately fakes the
// brand inside the same process. The probes read the brand as an OWN
// property. An object that inherits a minted event through its prototype
// can carry mutable own overrides, so it is not minted.
const RECORDED_BRAND = Symbol.for("@shirudo/ddd-kit.mintedEvent");
const UNCOMMITTED_BRAND = Symbol.for("@shirudo/ddd-kit.uncommittedEvent");

function stampRecordedBrand(event: object): void {
	Object.defineProperty(event, RECORDED_BRAND, {
		value: true,
		enumerable: false,
		writable: false,
		configurable: false,
	});
}

function stampUncommittedBrand(event: object): void {
	Object.defineProperty(event, UNCOMMITTED_BRAND, {
		value: true,
		enumerable: false,
		writable: false,
		configurable: false,
	});
}

function isFactoryOwnedDomainEventStamp(stamp: object): boolean {
	return FACTORY_OWNED_EVENT_STAMPS.has(stamp);
}

/**
 * Whether `event` is a recorded domain event: it came out of
 * {@link createDomainEvent}, {@link createDomainEventFromFacts}, or
 * {@link recordDomainEvent}, so it is deeply frozen with defensively copied
 * payload and metadata. An uncommitted decision carries the other brand; see
 * {@link isUncommittedDomainEvent}. Two tiers: events of THIS
 * loaded copy of the kit are verified through the module-private
 * WeakSet; events minted by ANOTHER copy (duplicate dependency, dual
 * CJS/ESM load) are recognized through a cooperative `Symbol.for`
 * brand that code in the same process can fake. The gate catches
 * accidents, not adversaries. Module-internal export for the aggregate
 * recording paths; not part of the package entries.
 */
export function isRecordedDomainEvent(event: object): event is AnyDomainEvent {
	return (
		RECORDED_EVENTS.has(event) ||
		(Object.hasOwn(event, RECORDED_BRAND) &&
			(event as Record<symbol, unknown>)[RECORDED_BRAND] === true)
	);
}

/** Whether a value was created by {@link createUncommittedDomainEvent}. */
export function isUncommittedDomainEvent(
	event: object,
): event is AnyUncommittedDomainEvent {
	return (
		UNCOMMITTED_EVENTS.has(event) ||
		(Object.hasOwn(event, UNCOMMITTED_BRAND) &&
			(event as Record<symbol, unknown>)[UNCOMMITTED_BRAND] === true)
	);
}

export function createUncommittedDomainEvent<T extends string>(
	type: T,
	payload?: undefined,
	options?: CreateUncommittedDomainEventOptions,
): UncommittedDomainEvent<T, void>;
export function createUncommittedDomainEvent<T extends string, P>(
	type: T,
	payload: P,
	options?: CreateUncommittedDomainEventOptions,
): UncommittedDomainEvent<T, P>;
export function createUncommittedDomainEvent<T extends string, P>(
	type: T,
	payload?: P,
	options?: CreateUncommittedDomainEventOptions,
): UncommittedDomainEvent<T, P> {
	assertProducerOwnedEventFields(type, options);
	const event: UncommittedDomainEvent<T, P> = {
		type,
		aggregateId: options?.aggregateId,
		aggregateType: options?.aggregateType,
		payload: cloneOwnedEventData(payload as P, "payload"),
		schemaVersion: options?.schemaVersion ?? 1,
	};
	stampUncommittedBrand(event);
	const uncommitted = deepFreeze(event) as UncommittedDomainEvent<T, P>;
	UNCOMMITTED_EVENTS.add(uncommitted);
	return uncommitted;
}

/** Brands and freezes a kit-derived copy of an uncommitted event. */
export function adoptUncommittedDomainEvent<T extends object>(copy: T): T {
	stampUncommittedBrand(copy);
	Object.freeze(copy);
	UNCOMMITTED_EVENTS.add(copy);
	return copy;
}

/**
 * Attaches shell-owned recording data to an accepted aggregate decision.
 *
 * The decision supplies the domain type, payload, source address, and payload
 * schema version. The stamp supplies only event identity, recording time, and
 * trace metadata.
 */
export function recordDomainEvent<T extends string, P>(
	event: UncommittedDomainEvent<T, P>,
	stamp: DomainEventStamp,
): DomainEvent<T, P> {
	if (!isUncommittedDomainEvent(event)) {
		throw new TypeError(
			"recordDomainEvent requires an event created by createUncommittedDomainEvent",
		);
	}
	if (isFactoryOwnedDomainEventStamp(stamp)) {
		// createStamp already validated, defensively copied, and deep-froze
		// every stamp field; re-validating or re-copying here would only pay
		// the work twice per recorded event.
		return mintRecordedEvent(
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
	const metadata = cloneOwnedEventData(stamp.metadata, "metadata");
	return mintRecordedEvent(
		event,
		stamp.eventId,
		occurredAt,
		metadata === undefined
			? undefined
			: (deepFreeze(metadata) as EventMetadata),
	);
}

/**
 * Single mint tail for both stamp provenances. The stamp fields arrive
 * pre-validated, copied, and frozen (by `createStamp` for factory-owned
 * stamps, by `recordDomainEvent` for caller-built stamps); the uncommitted
 * event's payload is already defensively cloned and deeply frozen by its
 * constructor and is shared instead of paying a second deep copy per event.
 */
function mintRecordedEvent<T extends string, P>(
	event: UncommittedDomainEvent<T, P>,
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
	stampRecordedBrand(recorded);
	Object.freeze(recorded);
	RECORDED_EVENTS.add(recorded);
	return recorded;
}

/**
 * Brands, freezes, and registers a kit-derived copy of a recorded event
 * (e.g. the address-stamped copy `apply()` creates) as recorded itself.
 * The copy shares the already-frozen payload/metadata of its source,
 * so the mint guarantee carries over. Stamping the cooperative brand
 * before freezing keeps the copy recognizable by another loaded kit
 * instance as well as by this instance's WeakSet. Module-internal
 * export; not part of the package entries.
 */
export function adoptRecordedDomainEvent<T extends object>(copy: T): T {
	stampRecordedBrand(copy);
	Object.freeze(copy);
	RECORDED_EVENTS.add(copy);
	return copy;
}

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
export function createDomainEvent<T extends string, P>(
	type: T,
	payload?: P,
	options?: CreateDomainEventOptions,
): DomainEvent<T, P> {
	return defaultDomainEventFactory.create(
		type,
		payload as P,
		options,
	) as DomainEvent<T, P>;
}

/**
 * Creates an already minted domain event exclusively from explicit envelope
 * facts. Unlike {@link createDomainEvent}, it has no clock or event-id fallback
 * and is useful when replay, migration, or a caller-owned boundary already has
 * the final identity and occurrence time.
 *
 * Aggregate behavior normally creates an {@link UncommittedDomainEvent} through
 * its protected `createEvent` helper. The application shell later records that
 * pending fact with caller-owned time and identity.
 */
export function createDomainEventFromFacts<T extends string>(
	type: T,
	payload: undefined,
	options: CreateDomainEventFromFactsOptions,
): DomainEvent<T, void>;
export function createDomainEventFromFacts<T extends string, P>(
	type: T,
	payload: P,
	options: CreateDomainEventFromFactsOptions,
): DomainEvent<T, P>;
export function createDomainEventFromFacts<T extends string, P>(
	type: T,
	payload: P | undefined,
	options: CreateDomainEventFromFactsOptions,
): DomainEvent<T, P> {
	if (options?.eventId === undefined) {
		missingExplicitEventId();
	}
	if (options.occurredAt === undefined) {
		missingExplicitOccurredAt();
	}
	return mintDomainEvent(
		type,
		payload,
		options,
		missingExplicitEventId,
		missingExplicitOccurredAt,
	);
}

function missingExplicitEventId(): string {
	throw new DomainEventValidationError(
		"EVENT_ID_REQUIRED",
		"eventId",
		"createDomainEventFromFacts requires an explicit eventId",
	);
}

function missingExplicitOccurredAt(): Date {
	throw new DomainEventValidationError(
		"EVENT_OCCURRED_AT_REQUIRED",
		"occurredAt",
		"createDomainEventFromFacts requires an explicit occurredAt",
	);
}

function mintDomainEvent<T extends string, P>(
	type: T,
	payload: P | undefined,
	options: CreateDomainEventOptions | undefined,
	eventIdFactory: EventIdFactory,
	clock: ClockFactory,
): DomainEvent<T, P> {
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
		// ownership contract as `vo()` and the occurredAt copy.
		payload: cloneOwnedEventData(payload as P, "payload"),
		// A caller-supplied occurredAt and a factory reading are both copied
		// before the event is frozen, so neither aliases caller-owned state.
		occurredAt,
		schemaVersion,
		metadata: cloneOwnedEventData(options?.metadata, "metadata"),
	};
	// Deep-freeze so a mutating subscriber cannot poison subsequent
	// handlers: events are facts of the past and must be immutable
	// (Vernon, IDDD §8).
	// Brand BEFORE the freeze (a frozen object rejects new properties);
	// non-enumerable, so spreads, JSON, and equality never see it.
	stampRecordedBrand(event);
	const minted = deepFreeze(event) as DomainEvent<T, P>;
	RECORDED_EVENTS.add(minted);
	return minted;
}

function assertProducerOwnedEventFields(
	type: unknown,
	options:
		| CreateDomainEventOptions
		| CreateUncommittedDomainEventOptions
		| undefined,
): void {
	assertNonBlankEventField(type, "type", "EVENT_TYPE_INVALID");
	const schemaVersion = options?.schemaVersion ?? 1;
	if (
		!Number.isSafeInteger(schemaVersion) ||
		typeof schemaVersion !== "number" ||
		schemaVersion < 1
	) {
		throw new DomainEventValidationError(
			"EVENT_SCHEMA_VERSION_INVALID",
			"schemaVersion",
			"domain-event schemaVersion must be a safe integer greater than or equal to 1",
		);
	}
	if (options?.aggregateId !== undefined) {
		assertNonBlankEventField(
			options.aggregateId,
			"aggregateId",
			"EVENT_ADDRESS_INVALID",
		);
	}
	if (options?.aggregateType !== undefined) {
		assertNonBlankEventField(
			options.aggregateType,
			"aggregateType",
			"EVENT_ADDRESS_INVALID",
		);
	}
}

function assertNonBlankEventField(
	value: unknown,
	field: "eventId" | "type" | "aggregateId" | "aggregateType",
	code: "EVENT_ID_INVALID" | "EVENT_TYPE_INVALID" | "EVENT_ADDRESS_INVALID",
): asserts value is string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new DomainEventValidationError(
			code,
			field,
			`domain-event ${field} must be a non-blank string`,
		);
	}
}

function copyValidEventDate(value: unknown): Date {
	if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
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
 * Deep-clones caller-supplied event data (payload, metadata) before the
 * event is frozen, so `createDomainEvent` never freezes or aliases the
 * caller's own object graph. Primitives pass through unchanged.
 *
 * Uses `structuredClone`, which matches the documented plain-data event
 * contract: functions, Promise, and WeakMap/WeakSet values throw a
 * descriptive `TypeError` (they are not data); symbol-keyed properties
 * are not carried over; a class instance would silently lose its
 * prototype, which the plain-data contract already rules out.
 */
function cloneOwnedEventData<T>(value: T, field: "payload" | "metadata"): T {
	if (typeof value === "function") {
		throw new TypeError(
			`createDomainEvent: ${field} must not be a function: domain events are plain data`,
		);
	}
	// Metadata is an object or absent; a null from a JSON envelope would
	// mint and then fail every metadata read far from the producer.
	if (value === null && field === "metadata") {
		throw new TypeError(
			"createDomainEvent: metadata must be an object or undefined; received null",
		);
	}
	if (value === null || typeof value !== "object") {
		return value;
	}
	// An own "__proto__" data key survives structuredClone and would
	// re-arm prototype pollution in every [[Set]]-based consumer of the
	// event; reject it at the root, the same contract as entity state.
	assertNoHostileOwnProtoKey(
		value,
		field === "payload" ? "Event payload" : "Event metadata",
	);
	// Binary buffers are rejected BEFORE the clone: freezing cannot make
	// them immutable (the spec forbids freezing a view with elements, and
	// a frozen view still shares its mutable buffer), so accepting them
	// would break the mint guarantee "minted implies deeply frozen". They
	// do not survive JSON either, the wire discipline events already
	// document; encode binary as a string (base64/hex) or store it
	// outside the event and reference it.
	assertNoBinaryData(value, field);
	try {
		return structuredClone(value);
	} catch (cause) {
		throw new TypeError(
			`createDomainEvent: ${field} must be plain, structured-cloneable data ` +
				`(no functions, Promises, or WeakMap/WeakSet values): domain events ` +
				`are plain data`,
			{ cause },
		);
	}
}

function isBinaryData(value: object): boolean {
	return (
		ArrayBuffer.isView(value) ||
		value instanceof ArrayBuffer ||
		(typeof SharedArrayBuffer !== "undefined" &&
			value instanceof SharedArrayBuffer)
	);
}

/**
 * Walks caller-supplied event data and rejects binary buffers anywhere
 * in the graph (TypedArray, DataView, ArrayBuffer, SharedArrayBuffer):
 * they are mutable by construction, so the deep-freeze that backs the
 * mint guarantee cannot cover them. Runs before the structured clone,
 * on the small plain-data graphs events are documented to carry.
 */
function assertNoBinaryData(
	value: unknown,
	field: "payload" | "metadata",
	visited = new WeakSet<object>(),
): void {
	if (value === null || typeof value !== "object") return;
	if (isBinaryData(value)) {
		throw new TypeError(
			`createDomainEvent: ${field} must not contain binary buffers ` +
				`(TypedArray, DataView, ArrayBuffer, SharedArrayBuffer): they stay ` +
				`mutable under freezing and do not survive JSON. Encode binary as ` +
				`a string (base64/hex) or store it outside the event.`,
		);
	}
	if (visited.has(value)) return;
	visited.add(value);
	if (value instanceof Map) {
		for (const [k, v] of value) {
			assertNoBinaryData(k, field, visited);
			assertNoBinaryData(v, field, visited);
		}
		return;
	}
	if (value instanceof Set) {
		for (const v of value) assertNoBinaryData(v, field, visited);
		return;
	}
	if (Array.isArray(value)) {
		for (const v of value) assertNoBinaryData(v, field, visited);
		return;
	}
	for (const key of Object.keys(value)) {
		assertNoBinaryData((value as Record<string, unknown>)[key], field, visited);
	}
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
		assertNoHostileOwnProtoKey(sourceEvent.metadata, "Event metadata");
	}
	if (additionalMetadata !== undefined) {
		assertNoHostileOwnProtoKey(additionalMetadata, "Event metadata");
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
	// Copy via defineProperty, not Object.assign: assign uses [[Set]],
	// which invokes the `__proto__` setter for an own "__proto__" key
	// (typical of JSON.parse'd metadata from outbox rows or message
	// envelopes) and would install an attacker-controlled prototype.
	const merged: Record<PropertyKey, unknown> = {};
	for (const metadata of metadataObjects) {
		if (!metadata) continue;
		assertNoHostileOwnProtoKey(metadata, "Event metadata");
		for (const key of Reflect.ownKeys(metadata)) {
			const descriptor = Object.getOwnPropertyDescriptor(metadata, key);
			if (!descriptor?.enumerable) continue;
			Object.defineProperty(merged, key, {
				value: (metadata as Record<PropertyKey, unknown>)[key],
				writable: true,
				enumerable: true,
				configurable: true,
			});
		}
	}
	return merged as EventMetadata;
}
