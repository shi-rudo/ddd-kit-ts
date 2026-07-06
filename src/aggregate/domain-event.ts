import { assertNoHostileOwnProtoKey } from "../core/errors";
import { deepFreeze } from "../value-object/value-object";
import { assertNotThenable, now } from "./clock";

// The swappable clock lives in ./clock (so BaseAggregate.createSnapshot
// can read it without an import cycle); its public API ships from here,
// unchanged.
export {
	type ClockFactory,
	resetClockFactory,
	setClockFactory,
	withClockFactory,
} from "./clock";

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
 * Swap one in via `setEventIdFactory(() => uuidv7())` or `() => ulid()`.
 */
export type EventIdFactory = () => string;

const defaultEventIdFactory: EventIdFactory = () => crypto.randomUUID();
let currentEventIdFactory: EventIdFactory = defaultEventIdFactory;

/**
 * Replaces the global event-id factory used by `createDomainEvent`. Call
 * once during application bootstrap, for example:
 *
 * ```ts
 * import { ulid } from "ulid";
 * import { setEventIdFactory } from "@shirudo/ddd-kit";
 *
 * setEventIdFactory(() => ulid());
 * ```
 *
 * The per-call `options.eventId` override always wins over this factory.
 *
 * **Module-scoped: last setter wins.** The factory lives as a single
 * module variable; importing two libraries that both call this races on
 * load order, and parallel test workers will see each other's factory.
 * For test isolation and short-lived contexts prefer
 * {@link withEventIdFactory}; for multi-tenant request isolation
 * (e.g. one factory per tenant in a single Worker invocation) **prefer
 * the per-call `options.eventId`** instead of mutating the global. Same
 * caveat applies to `setClockFactory`.
 */
export function setEventIdFactory(factory: EventIdFactory): void {
	currentEventIdFactory = factory;
}

/**
 * Scoped variant of {@link setEventIdFactory}: installs `factory`,
 * runs `fn`, then restores the previous factory in a `finally` block,
 * so the restoration happens even if `fn` throws. Safe for parallel
 * tests and for synchronous request handlers that need a tenant-
 * specific factory without polluting the global.
 *
 * **Synchronous-only, enforced at runtime.** If `fn` returns a
 * thenable (a `Promise` or any object with a `then` method), the
 * helper throws *before* returning the value to the caller. This
 * catches the async-misuse footgun where the factory would be
 * restored before the awaited body of `fn` runs, leaving the awaited
 * code reading the previous factory. For async scoping across `await`
 * boundaries, use `AsyncLocalStorage`, which is out of scope for this
 * helper; build it on top if you need it.
 *
 * Composes by nesting: an inner `withEventIdFactory` restores back to
 * the outer's factory; the outer restores to the original.
 *
 * **When to prefer the per-call `options.eventId` instead.** If you're
 * constructing a single event and want full control over its id,
 * passing `{ eventId: "..." }` to `createDomainEvent` is the strongest
 * isolation: it bypasses the factory mechanism entirely, no global
 * mutation, no scope to manage. Reach for `withEventIdFactory` when
 * the events are constructed deep inside domain methods you can't
 * thread an explicit id through (typical test scenario), or when many
 * events in a scope should share the same factory.
 *
 * @example
 * ```ts
 * // In a vitest test:
 * it("emits deterministic ids", () => {
 *   withEventIdFactory(() => "evt-fixed", () => {
 *     const e = createDomainEvent("X", { v: 1 });
 *     expect(e.eventId).toBe("evt-fixed");
 *   });
 *   // Outside the callback the default crypto.randomUUID is restored,
 *   // even if the body had thrown.
 * });
 * ```
 */
export function withEventIdFactory<T>(factory: EventIdFactory, fn: () => T): T {
	const previous = currentEventIdFactory;
	currentEventIdFactory = factory;
	try {
		const result = fn();
		assertNotThenable(result, "withEventIdFactory");
		return result;
	} finally {
		currentEventIdFactory = previous;
	}
}

/**
 * Restores the default event-id factory (`crypto.randomUUID()`).
 * Intended for use in test `afterEach` hooks.
 */
export function resetEventIdFactory(): void {
	currentEventIdFactory = defaultEventIdFactory;
}

/**
 * Metadata associated with a domain event for traceability and correlation.
 * Used in event-driven architectures to track event flow across services.
 */
export interface EventMetadata {
	/**
	 * Correlation ID for tracing events across multiple services/components.
	 * Typically used to group related events in a distributed system.
	 */
	correlationId?: string;

	/**
	 * Causation ID referencing the event or command that caused this event.
	 * Used to build event chains and understand causality.
	 */
	causationId?: string;

	/**
	 * User ID of the person or system that triggered the event.
	 */
	userId?: string;

	/**
	 * Source service or component that produced the event.
	 */
	source?: string;

	/**
	 * Additional custom metadata fields.
	 * Allows extensibility for domain-specific metadata.
	 */
	[key: string]: unknown;
}

/**
 * Domain Event represents something meaningful that happened in the domain.
 * Events are immutable and carry information about what occurred.
 *
 * **Events are PLAIN DATA objects**, constructed via `createDomainEvent`
 * (or the aggregate's `recordEvent` helper) and deeply frozen. Class-based
 * event objects that satisfy this shape structurally via prototype
 * members are unsupported: the `withCommit` harvest copies events with a
 * shallow spread (to stamp `aggregateVersion`), which only carries own
 * enumerable properties.
 *
 * **Field-accretion boundary.** This type already carries the write-side
 * transport concerns the outbox needs (`aggregateId`, `aggregateType`,
 * `aggregateVersion`, `metadata`). That is the line: further transport
 * fields (partition keys, tenancy, schema URNs, …) belong in an outbox
 * envelope / `metadata`, not on the domain event: the next first-class
 * transport field forces an `OutboxMessage` envelope port instead.
 *
 * @template T - The event type name (e.g., "OrderCreated")
 * @template P - The event payload type
 */
export interface DomainEvent<T extends string, P = void> {
	/**
	 * Unique identifier for this specific event instance. Used by idempotent
	 * consumers, outbox dispatch tracking, and as the target of
	 * `metadata.causationId`. Defaults to `crypto.randomUUID()` if not
	 * supplied.
	 */
	eventId: string;

	/**
	 * The type of the event, used for routing and handling.
	 */
	type: T;

	/**
	 * Identifier of the aggregate that produced the event. Optional at the
	 * library level; set it whenever the producing aggregate is known so
	 * downstream subscribers, outboxes, and projections can scope by entity.
	 */
	aggregateId?: string;

	/**
	 * Name of the aggregate type that produced the event (e.g. "Order").
	 * Pairs with `aggregateId` to fully qualify the source aggregate.
	 */
	aggregateType?: string;

	/**
	 * The event payload containing the domain data. The field is always
	 * present; its value is `undefined` when `P` is `void`.
	 */
	payload: P;

	/**
	 * Timestamp when the event occurred.
	 */
	occurredAt: Date;

	/**
	 * Event schema version for handling schema evolution.
	 * Required for safe schema migration in event-sourced systems.
	 * Use 1 for the initial schema version.
	 *
	 * **NOT the aggregate's version**: that is
	 * {@link aggregateVersion}. The two are deliberately distinct
	 * fields: this one says "which shape does the payload have"
	 * (upcasting), the other says "which state revision of the
	 * aggregate emitted this".
	 */
	version: number;

	/**
	 * The version of the producing aggregate at COMMIT time: the same
	 * value the OCC row write carries. Stamped automatically by
	 * `withCommit` at the harvest boundary (all events of one aggregate
	 * in one commit share it; their relative order within the commit is
	 * the harvest order), or set manually via
	 * `CreateDomainEventOptions.aggregateVersion`; a pre-set value is
	 * never overwritten.
	 *
	 * Consumers use it for cross-commit ordering and debugging. It is NOT
	 * a per-event idempotency key on its own: all events of one commit
	 * share the stamp. Pair it with {@link commitSequence} for a total
	 * order per aggregate and a compact per-event watermark; `eventId`
	 * dedup remains the fully general fallback (see the outbox guide).
	 * Optional at the type level: events created outside an aggregate
	 * (system/integration events) and events from older kit versions
	 * don't carry it.
	 */
	aggregateVersion?: number;

	/**
	 * Zero-based index of the event within its aggregate's harvest batch,
	 * stamped by `withCommit` next to {@link aggregateVersion} (a pre-set
	 * value is never overwritten). All events of one commit share the
	 * `aggregateVersion`, so the PAIR `(aggregateVersion, commitSequence)`
	 * is a total order per aggregate and a compact idempotency watermark:
	 * consumers sort and advance by the tuple instead of keeping an
	 * `eventId` set. Optional at the type level for the same reasons as
	 * `aggregateVersion` (system events, older kit versions, hand-rolled
	 * orchestrations).
	 */
	commitSequence?: number;

	/**
	 * Optional metadata for traceability, correlation, and auditing.
	 * Includes correlationId, causationId, userId, source, and custom fields.
	 */
	metadata?: EventMetadata;
}

/**
 * Upper-bound alias for "any `DomainEvent` shape". Use as a generic
 * constraint when a type parameter should accept any concrete event
 * union. The `unknown` payload is the upper bound; concrete unions
 * still narrow via `Extract<Evt, { type: K }>` at the use-site.
 */
export type AnyDomainEvent = DomainEvent<string, unknown>;

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
	version?: number;

	/**
	 * Pre-set the producing aggregate's version (see
	 * `DomainEvent.aggregateVersion`). Normally left unset (`withCommit`
	 * stamps it at the harvest boundary with the commit version), but
	 * useful for replay fixtures and events constructed outside an
	 * aggregate. A pre-set value is never overwritten by the harvest.
	 */
	aggregateVersion?: number;

	/**
	 * Pre-set the event's position within its commit batch (see
	 * `DomainEvent.commitSequence`). Normally left unset (`withCommit`
	 * stamps the zero-based harvest index); a pre-set value is never
	 * overwritten by the harvest.
	 */
	commitSequence?: number;

	/**
	 * Event metadata: correlation, causation, user, source, custom fields.
	 */
	metadata?: EventMetadata;
}

/**
 * Creates a domain event with default values.
 * Sets occurredAt to current date and version to 1 if not provided.
 *
 * **Input ownership.** The event is deeply frozen, and `payload` and
 * `metadata` are deep-cloned first, so the caller's own objects are never
 * frozen in place and later mutation of them does not bleed into the
 * event (same contract as `vo()`). The clone follows the plain-data event
 * contract via `structuredClone`: functions, Promise, and WeakMap/WeakSet
 * values throw a `TypeError`; symbol-keyed properties are not carried
 * over.
 *
 * **For aggregate-internal events, prefer `this.recordEvent(...)` on
 * `AggregateRoot` / `EventSourcedAggregate`.** That helper auto-injects
 * `aggregateId` (from `this.id`) and `aggregateType` (from the
 * aggregate's declared `aggregateType` property), which downstream
 * consumers (outbox dispatchers, projection handlers, audit logs)
 * route by. The `withCommit` harvest boundary now validates both fields
 * are present and throws if they're missing, so a direct
 * `createDomainEvent(...)` call inside an aggregate that forgets the
 * options is caught at runtime.
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
export function createDomainEvent<T extends string, P>(
	type: T,
	payload?: P,
	options?: CreateDomainEventOptions,
): DomainEvent<T, P> {
	const event: DomainEvent<T, P> = {
		eventId: options?.eventId ?? currentEventIdFactory(),
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
		// A caller-supplied occurredAt is copied here; the now() reading is
		// already a defensive copy at the source (see clock.ts).
		occurredAt: options?.occurredAt
			? new Date(options.occurredAt.getTime())
			: now(),
		version: options?.version ?? 1,
		aggregateVersion: options?.aggregateVersion,
		commitSequence: options?.commitSequence,
		metadata: guardedMetadataClone(options?.metadata),
	};
	// Deep-freeze so a mutating subscriber cannot poison subsequent
	// handlers: events are facts of the past and must be immutable
	// (Vernon, IDDD §8).
	return deepFreeze(event) as DomainEvent<T, P>;
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
	if (value === null || typeof value !== "object") {
		return value;
	}
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

/**
 * Copies metadata from a source event to a new event.
 * Useful for maintaining correlation chains in event-driven architectures.
 *
 * @example
 * ```typescript
 * const newEvent = createDomainEvent(
 *   "OrderShipped",
 *   { orderId: "123" },
 *   { metadata: copyMetadata(previousEvent, { causationId: previousEvent.type }) }
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

/**
 * Clones event metadata with the loud `__proto__` rejection applied at
 * the SOURCE: structuredClone preserves an own `__proto__` data key, so
 * without this guard a hostile envelope would ride into the frozen
 * event and re-arm downstream.
 */
function guardedMetadataClone(
	metadata: EventMetadata | undefined,
): EventMetadata | undefined {
	if (metadata !== undefined) {
		assertNoHostileOwnProtoKey(metadata, "Event metadata");
	}
	return cloneOwnedEventData(metadata, "metadata") as EventMetadata | undefined;
}
