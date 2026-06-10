import { deepFreeze } from "../value-object/value-object";

/**
 * Factory function producing a fresh, unique event identifier for each call.
 *
 * The library ships a default that uses Web Crypto `crypto.randomUUID()`
 * (works on Node 19+, modern browsers in secure contexts, Deno, Bun,
 * Cloudflare Workers, Vercel Edge, and any runtime that implements Web
 * Crypto). Note that `crypto.randomUUID()` returns **UUID v4** (purely
 * random) — for production event stores prefer a **time-ordered** id
 * format (UUID v7 / ULID / KSUID) so B-tree indexes on the eventId
 * column stay clustered and `ORDER BY eventId` matches creation order.
 * Swap one in via `setEventIdFactory(() => uuidv7())` or `() => ulid()`.
 */
export type EventIdFactory = () => string;

const defaultEventIdFactory: EventIdFactory = () => crypto.randomUUID();
let currentEventIdFactory: EventIdFactory = defaultEventIdFactory;

/**
 * Replaces the global event-id factory used by `createDomainEvent` and
 * `createDomainEventWithMetadata`. Call once during application bootstrap,
 * for example:
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
 * **Module-scoped — last setter wins.** The factory lives as a single
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
 * Internal guard for the scoped factory helpers. Throws a clear error
 * when the user-supplied `fn` returns a thenable — the helpers are
 * synchronous-only, and a silent async-misuse would restore the factory
 * before the awaited body of `fn` runs, leaving the awaited code
 * reading the previous factory.
 */
function assertNotThenable(result: unknown, helperName: string): void {
	if (
		result !== null &&
		(typeof result === "object" || typeof result === "function") &&
		typeof (result as { then?: unknown }).then === "function"
	) {
		throw new Error(
			`${helperName}: fn returned a thenable. ` +
				`The factory is only installed for the synchronous portion of fn; ` +
				`awaited continuations would see the previous factory. ` +
				`For async-scoped factories use AsyncLocalStorage.`,
		);
	}
}

/**
 * Scoped variant of {@link setEventIdFactory}: installs `factory`,
 * runs `fn`, then restores the previous factory in a `finally` block —
 * so the restoration happens even if `fn` throws. Safe for parallel
 * tests and for synchronous request handlers that need a tenant-
 * specific factory without polluting the global.
 *
 * **Synchronous-only — enforced at runtime.** If `fn` returns a
 * thenable (a `Promise` or any object with a `then` method), the
 * helper throws *before* returning the value to the caller. This
 * catches the async-misuse footgun where the factory would be
 * restored before the awaited body of `fn` runs, leaving the awaited
 * code reading the previous factory. For async scoping across `await`
 * boundaries, use `AsyncLocalStorage` — out of scope for this helper;
 * build it on top if you need it.
 *
 * Composes by nesting: an inner `withEventIdFactory` restores back to
 * the outer's factory; the outer restores to the original.
 *
 * **When to prefer the per-call `options.eventId` instead.** If you're
 * constructing a single event and want full control over its id,
 * passing `{ eventId: "..." }` to `createDomainEvent` is the strongest
 * isolation — it bypasses the factory mechanism entirely, no global
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
export function withEventIdFactory<T>(
	factory: EventIdFactory,
	fn: () => T,
): T {
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
 * Clock function producing a fresh `Date` for each call. The library
 * defaults to `() => new Date()`; override globally via `setClockFactory`
 * for deterministic event-sourcing tests, time-travel debugging, or any
 * scenario where `occurredAt` must be reproducible.
 */
export type ClockFactory = () => Date;

const defaultClockFactory: ClockFactory = () => new Date();
let currentClockFactory: ClockFactory = defaultClockFactory;

/**
 * Replaces the global clock factory used by `createDomainEvent` and
 * `createDomainEventWithMetadata`. Call once during application bootstrap
 * (or per-test in deterministic test suites):
 *
 * ```ts
 * import { setClockFactory } from "@shirudo/ddd-kit";
 *
 * setClockFactory(() => new Date("2026-01-01T00:00:00Z"));
 * ```
 *
 * The per-call `options.occurredAt` override always wins over this
 * factory. Symmetric to `setEventIdFactory`.
 *
 * Module-scoped — see {@link setEventIdFactory} for the global-state
 * caveats. For test isolation prefer {@link withClockFactory}; for
 * multi-tenant request isolation prefer the per-call
 * `options.occurredAt`.
 */
export function setClockFactory(factory: ClockFactory): void {
	currentClockFactory = factory;
}

/**
 * Scoped variant of {@link setClockFactory}: installs `factory`, runs
 * `fn`, then restores the previous factory in a `finally` block.
 * Synchronous-only — same constraints (and same runtime thenable
 * guard) as {@link withEventIdFactory}.
 *
 * **When to prefer the per-call `options.occurredAt` instead.** Same
 * trade-off as {@link withEventIdFactory}: passing `{ occurredAt }`
 * to `createDomainEvent` is the strongest isolation for single-event
 * cases. The scoped helper is for events constructed deep inside
 * domain methods where threading an explicit timestamp is awkward.
 *
 * @example
 * ```ts
 * it("stamps events with a fixed clock", () => {
 *   const fixed = new Date("2026-01-01T00:00:00Z");
 *   withClockFactory(() => fixed, () => {
 *     const e = createDomainEvent("X", { v: 1 });
 *     expect(e.occurredAt).toEqual(fixed);
 *   });
 * });
 * ```
 */
export function withClockFactory<T>(factory: ClockFactory, fn: () => T): T {
	const previous = currentClockFactory;
	currentClockFactory = factory;
	try {
		const result = fn();
		assertNotThenable(result, "withClockFactory");
		return result;
	} finally {
		currentClockFactory = previous;
	}
}

/**
 * Restores the default clock factory (`() => new Date()`).
 * Intended for use in test `afterEach` hooks.
 */
export function resetClockFactory(): void {
	currentClockFactory = defaultClockFactory;
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
	 * library level — set it whenever the producing aggregate is known so
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
	 */
	version: number;

	/**
	 * Optional metadata for traceability, correlation, and auditing.
	 * Includes correlationId, causationId, userId, source, and custom fields.
	 */
	metadata?: EventMetadata;
}

/**
 * Upper-bound alias for "any `DomainEvent` shape". Use as a generic
 * constraint when a type parameter should accept any concrete event
 * union. The `unknown` payload is the upper bound — concrete unions
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
	 * Event metadata — correlation, causation, user, source, custom fields.
	 */
	metadata?: EventMetadata;
}

/**
 * Creates a domain event with default values.
 * Sets occurredAt to current date and version to 1 if not provided.
 *
 * **For aggregate-internal events, prefer `this.recordEvent(...)` on
 * `AggregateRoot` / `EventSourcedAggregate`.** That helper auto-injects
 * `aggregateId` (from `this.id`) and `aggregateType` (from the
 * aggregate's declared `aggregateType` property), which downstream
 * consumers — outbox dispatchers, projection handlers, audit logs —
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
		payload: payload as P,
		// Defensive copy — the event must not share the caller's live Date
		// instance, or a later mutation of it would bleed into the event.
		occurredAt: options?.occurredAt
			? new Date(options.occurredAt.getTime())
			: currentClockFactory(),
		version: options?.version ?? 1,
		metadata: options?.metadata,
	};
	// Deep-freeze so a mutating subscriber cannot poison subsequent
	// handlers — events are facts of the past and must be immutable
	// (Vernon, IDDD §8).
	return deepFreeze(event) as DomainEvent<T, P>;
}

/**
 * Creates a domain event with metadata for traceability.
 * Convenience function for creating events with correlation and causation IDs.
 *
 * @example
 * ```typescript
 * const event = createDomainEventWithMetadata(
 *   "OrderCreated",
 *   { orderId: "123" },
 *   { correlationId: "corr-123", causationId: "cmd-456", userId: "user-789" }
 * );
 * ```
 */
export function createDomainEventWithMetadata<T extends string, P>(
	type: T,
	payload: P,
	metadata: EventMetadata,
	options?: Omit<CreateDomainEventOptions, "metadata">,
): DomainEvent<T, P> {
	return createDomainEvent(type, payload, {
		...options,
		metadata,
	});
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
	return Object.assign({}, ...metadataObjects.filter(Boolean));
}
