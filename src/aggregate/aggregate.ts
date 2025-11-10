import type { Id } from "../core/id";

export type Version = number & { readonly __v: true };

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
export interface DomainEvent<T extends string, P> {
	/**
	 * The type of the event, used for routing and handling.
	 */
	type: T;

	/**
	 * The event payload containing the domain data.
	 */
	payload: P;

	/**
	 * Timestamp when the event occurred.
	 */
	occurredAt: Date;

	/**
	 * Event schema version for handling schema evolution.
	 * Defaults to 1 if not specified. Higher versions indicate schema changes.
	 */
	version?: number;

	/**
	 * Optional metadata for traceability, correlation, and auditing.
	 * Includes correlationId, causationId, userId, source, and custom fields.
	 */
	metadata?: EventMetadata;
}

export interface Aggregate<State, Evt extends DomainEvent<string, unknown>> {
	state: Readonly<State>;
	version: Version;
	pendingEvents: ReadonlyArray<Evt>;
}

export function aggregate<State, Evt extends DomainEvent<string, unknown>>(
	state: State,
	version: Version = 0 as Version,
): Aggregate<State, Evt> {
	return { state, version, pendingEvents: [] };
}

export function withEvent<S, E extends DomainEvent<string, unknown>>(
	agg: Aggregate<S, E>,
	evt: E,
): Aggregate<S, E> {
	return { ...agg, pendingEvents: [...agg.pendingEvents, evt] };
}

export function bump<S, E extends DomainEvent<string, unknown>>(
	agg: Aggregate<S, E>,
): Aggregate<S, E> {
	return { ...agg, version: (agg.version + 1) as Version };
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
export function createDomainEvent<T extends string, P>(
	type: T,
	payload: P,
	options?: {
		occurredAt?: Date;
		version?: number;
		metadata?: EventMetadata;
	},
): DomainEvent<T, P> {
	return {
		type,
		payload,
		occurredAt: options?.occurredAt ?? new Date(),
		version: options?.version ?? 1,
		metadata: options?.metadata,
	};
}

/**
 * Creates a domain event with metadata for traceability.
 * Convenience function for creating events with correlation and causation IDs.
 *
 * @param type - The event type
 * @param payload - The event payload
 * @param metadata - Event metadata for traceability
 * @param options - Optional event configuration
 * @returns A domain event with metadata
 *
 * @example
 * ```typescript
 * const event = createDomainEventWithMetadata(
 *   "OrderCreated",
 *   { orderId: "123" },
 *   {
 *     correlationId: "corr-123",
 *     causationId: "cmd-456",
 *     userId: "user-789"
 *   }
 * );
 * ```
 */
export function createDomainEventWithMetadata<T extends string, P>(
	type: T,
	payload: P,
	metadata: EventMetadata,
	options?: {
		occurredAt?: Date;
		version?: number;
	},
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
 * @param sourceEvent - The source event to copy metadata from
 * @param additionalMetadata - Additional metadata to merge in
 * @returns Event metadata with copied and merged values
 *
 * @example
 * ```typescript
 * const newEvent = createDomainEvent(
 *   "OrderShipped",
 *   { orderId: "123" },
 *   {
 *     metadata: copyMetadata(previousEvent, { causationId: previousEvent.type })
 *   }
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
 * @param metadataObjects - Array of metadata objects to merge
 * @returns Merged event metadata
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

/**
 * Snapshot of an aggregate state at a specific point in time.
 * Used for optimizing event replay by starting from a snapshot
 * instead of replaying all events from the beginning.
 *
 * @template TState - The type of the aggregate state
 */
export interface AggregateSnapshot<TState> {
	/**
	 * The state of the aggregate at the time of the snapshot.
	 */
	state: TState;

	/**
	 * The version of the aggregate when the snapshot was taken.
	 */
	version: Version;

	/**
	 * Timestamp when the snapshot was created.
	 */
	snapshotAt: Date;
}

/**
 * Checks if two aggregates are the same (same ID and version).
 * Useful for optimistic concurrency control checks.
 *
 * @param a - First aggregate
 * @param b - Second aggregate
 * @returns true if both aggregates have the same ID and version
 *
 * @example
 * ```typescript
 * const aggregate1 = await repository.getById(id);
 * // ... some operations ...
 * const aggregate2 = await repository.getById(id);
 *
 * if (!sameAggregate(aggregate1, aggregate2)) {
 *   throw new Error("Aggregate was modified by another process");
 * }
 * ```
 */
export function sameAggregate<TId extends Id<string>>(
	a: { id: TId; version: Version },
	b: { id: TId; version: Version },
): boolean {
	return a.id === b.id && a.version === b.version;
}
