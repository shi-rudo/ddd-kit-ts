import type { Id } from "../core/id";

// Re-export domain event types for convenience
export * from "./domain-event";

// Re-export interfaces from their respective files
export type { IAggregateRoot } from "./aggregate-root";
export type { IEventSourcedAggregate } from "./event-sourced-aggregate";

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
 * Checks if two aggregates are at the same version (same ID and version).
 * Useful for optimistic concurrency control checks.
 *
 * Note: Two aggregates with the same ID ARE the same aggregate (identity).
 * This function checks if they are at the same version — i.e., no concurrent modification.
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
