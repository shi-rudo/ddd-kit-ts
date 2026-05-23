/**
 * Factory function producing a fresh, unique event identifier for each call.
 *
 * The library ships a default that uses Web Crypto `crypto.randomUUID()`
 * (works on Node 19+, modern browsers in secure contexts, Deno, Bun,
 * Cloudflare Workers, Vercel Edge, and other runtimes that implement Web
 * Crypto). Override globally via `setEventIdFactory` to plug in ULID,
 * KSUID, a deterministic test factory, or whatever your platform requires.
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
 */
export function setEventIdFactory(factory: EventIdFactory): void {
	currentEventIdFactory = factory;
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
 * @param type - The event type
 * @param payload - The event payload
 * @param options - Optional event configuration
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
	return {
		eventId: options?.eventId ?? currentEventIdFactory(),
		type,
		aggregateId: options?.aggregateId,
		aggregateType: options?.aggregateType,
		payload: payload as P,
		occurredAt: options?.occurredAt ?? new Date(),
		version: options?.version ?? 1,
		metadata: options?.metadata,
	};
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
	sourceEvent: DomainEvent<string, unknown>,
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
