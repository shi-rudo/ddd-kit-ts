import type { Result } from "@shirudo/result";
import type { DomainError } from "../core/errors";
import type { Id } from "../core/id";
import type { AnyDomainEvent } from "./domain-event";

// Re-export domain event types for convenience
export * from "./domain-event";

// --- Aggregate types ---

export type Version = number & { readonly __v: true };

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
	readonly state: TState;

	/**
	 * The version of the aggregate when the snapshot was taken.
	 */
	readonly version: Version;

	/**
	 * Timestamp when the snapshot was created.
	 */
	readonly snapshotAt: Date;

	/**
	 * Schema version of the SHAPE of `state` (the aggregate's declared
	 * `snapshotSchemaVersion`), stamped by `createSnapshot`. Distinct from
	 * {@link version}, which counts mutations: this field says "which
	 * shape does the stored state have", so a restore can detect a
	 * snapshot written against an older `TSnapshotState` and migrate or
	 * discard it instead of crashing later. Optional: absent on snapshots
	 * written by older kit versions, which restore treats as schema `1`.
	 */
	readonly schemaVersion?: number;
}

/**
 * Public contract every Aggregate Root satisfies. Implemented by
 * `BaseAggregate` and inherited by both `AggregateRoot` and
 * `EventSourcedAggregate`. Repository implementations type their
 * `save(aggregate)` parameter against this interface rather than the
 * concrete classes, so the repo layer does not take a compile-time
 * dependency on the aggregate hierarchy.
 *
 * Full per-member documentation lives on the concrete `BaseAggregate`
 * class; the interface is intentionally terse to avoid drift.
 *
 * @template TId    - The aggregate root identifier (branded via `Id<Tag>`)
 * @template TEvent - The domain-event union, defaults to `never`
 */
export interface IAggregateRoot<TId extends Id<string>, TEvent = never> {
	readonly id: TId;
	readonly version: Version;
	readonly persistedVersion: Version | undefined;
	readonly pendingEvents: ReadonlyArray<TEvent>;
	clearPendingEvents(): void;
	markPersisted(version: Version): void;
}

/**
 * Public contract for Event-Sourced Aggregate Roots. Extends
 * `IAggregateRoot` with the replay-from-history boundary.
 *
 * @template TId    - The aggregate root identifier
 * @template TEvent - The union type of all domain events
 */
export interface IEventSourcedAggregate<
	TId extends Id<string>,
	TEvent extends AnyDomainEvent,
> extends IAggregateRoot<TId, TEvent> {
	/**
	 * Reconstitutes the aggregate from an event history. Returns
	 * `Result` because event-stream corruption is an expected
	 * recoverable failure at the infrastructure boundary.
	 */
	loadFromHistory(history: ReadonlyArray<TEvent>): Result<void, DomainError>;
}

/**
 * Checks if two aggregates are at the same version (same ID and version).
 * Useful for optimistic concurrency control checks.
 *
 * Note: Two aggregates with the same ID ARE the same aggregate (identity).
 * This function checks if they are at the same version: i.e., no concurrent modification.
 *
 * @example
 * ```typescript
 * const before = await repository.getById(id);
 * // ... some operations ...
 * const after = await repository.getById(id);
 *
 * if (!sameVersion(before, after)) {
 *   throw new Error("Aggregate was modified by another process");
 * }
 * ```
 */
export function sameVersion<TId extends Id<string>>(
	a: { id: TId; version: Version },
	b: { id: TId; version: Version },
): boolean {
	return a.id === b.id && a.version === b.version;
}
