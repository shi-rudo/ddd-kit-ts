import type { Result } from "@shirudo/result";
import { type DomainError, InvalidVersionError } from "../../errors/kit-errors";
import type { AnyDomainEvent, PendingDomainEvent } from "../event/domain-event";
import type { Id } from "../identity/id";

// --- Aggregate types ---

export type Version = number & { readonly __v: true };

/**
 * Brands a stored number as an aggregate {@link Version}. A version is a
 * safe integer of at least zero. Use it in repository adapters instead of
 * a cast, so a corrupt row value fails here with {@link InvalidVersionError}
 * and never reaches the optimistic-concurrency cursor.
 */
export function toVersion(value: number): Version {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new InvalidVersionError(
			value,
			"is not a safe integer of at least zero",
		);
	}
	return value as Version;
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
	 * Schema version of the stored `state` shape, declared and stamped by
	 * the persistence adapter that captures the snapshot. Distinct from
	 * {@link version}, which counts mutations: this field says "which
	 * shape does the stored state have", so a restore can detect a
	 * snapshot written against an older DTO shape and migrate or
	 * discard it instead of crashing later. Optional: a snapshot without
	 * this field restores as schema `1`.
	 */
	readonly schemaVersion?: number;
}

/**
 * Public contract every Aggregate Root satisfies. Implemented by
 * `BaseAggregate` and inherited by both `StateStoredAggregate` and
 * `EventSourcedAggregate`. Repository ports use this interface as their
 * aggregate type rather than depending on concrete base classes, so persistence
 * orchestration does not take a compile-time
 * dependency on the aggregate hierarchy.
 *
 * Full per-member documentation lives on the concrete `BaseAggregate`
 * class; the interface is intentionally terse to avoid drift. Persistence
 * facts are readable, but acknowledgement and pending-event disposal are not
 * part of this surface. The application shell holds that authority.
 *
 * @template TId    - The aggregate root identifier (branded via `Id<Tag>`)
 * @template TEvent - The domain-event union, defaults to `never`
 */
export interface Aggregate<
	TId extends Id<string>,
	TEvent extends AnyDomainEvent = never,
> {
	readonly id: TId;
	readonly version: Version;
	readonly pendingEvents: ReadonlyArray<PendingDomainEvent<TEvent>>;
}

/**
 * Public contract for Event-Sourced Aggregate Roots. Extends
 * `Aggregate` with the replay-from-history boundary.
 *
 * @template TId    - The aggregate root identifier
 * @template TEvent - The union type of all domain events
 */
export interface ReplayableAggregate<
	TId extends Id<string>,
	TEvent extends AnyDomainEvent,
> extends Aggregate<TId, TEvent> {
	/**
	 * Reconstitutes the aggregate from an event history. Returns
	 * `Result` because event-stream corruption is an expected
	 * recoverable failure at the infrastructure boundary.
	 */
	replayHistory(history: ReadonlyArray<TEvent>): Result<void, DomainError>;
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
 * const before = await repository.findById(id);
 * // ... some operations ...
 * const after = await repository.findById(id);
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
