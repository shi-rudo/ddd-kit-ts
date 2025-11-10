import type { Id } from "../core/id";
import type {
	AggregateRoot,
	AggregateSnapshot,
	Version,
} from "./aggregate";

/**
 * Configuration options for AggregateBase behavior.
 */
export interface AggregateConfig {
	/**
	 * Whether to automatically bump the version when state changes.
	 * Defaults to false. Set to true for automatic versioning.
	 */
	autoVersionBump?: boolean;
}

/**
 * Base class for creating Aggregate Roots (Entities) without Event Sourcing.
 * 
 * This class creates an Entity that serves as the Aggregate Root. The Aggregate Root
 * is the parent Entity of the aggregate and represents it externally. It has identity
 * (id) and version for optimistic concurrency control.
 * 
 * The aggregate state (`TState`) contains:
 * - Child entities (Entities with id, but no own version)
 * - Value objects (immutable objects)
 * 
 * All changes to child entities are versioned through the Aggregate Root. The version
 * applies to the entire aggregate, including all child entities.
 * 
 * Provides core functionality:
 * - ID and Version management (for Optimistic Concurrency Control)
 * - State management (containing child entities and value objects)
 * - Snapshot support for performance optimization
 *
 * Implements `AggregateRoot<TId>` to mark this as an Aggregate Root Entity.
 *
 * Use this class when you don't need Event Sourcing but still want
 * aggregate patterns with versioning and state management.
 *
 * @template TState - The type of the aggregate state (contains child entities and value objects)
 * @template TId - The type of the aggregate root identifier
 *
 * @example
 * ```typescript
 * // Order is an Aggregate Root (an Entity)
 * class Order extends AggregateBase<OrderState, OrderId> implements AggregateRoot<OrderId> {
 *   constructor(id: OrderId, initialState: OrderState) {
 *     super(id, initialState);
 *   }
 *
 *   confirm(): void {
 *     this._state = { ...this._state, status: "confirmed" };
 *     this.bumpVersion(); // Versions the entire aggregate
 *   }
 * }
 * ```
 */
export abstract class AggregateBase<TState, TId extends Id<string>>
	implements AggregateRoot<TId>
{
	public readonly id: TId;
	public version: Version = 0 as Version;

	private readonly _config: AggregateConfig;
	private readonly _autoVersionBump: boolean;

	public get state(): TState {
		return this._state;
	}

	/**
	 * The state is 'protected' so that only the subclass can change it.
	 * Subclasses can mutate this directly or use helper methods.
	 */
	protected _state: TState;

	protected constructor(
		id: TId,
		initialState: TState,
		config?: AggregateConfig,
	) {
		this.id = id;
		this._state = initialState;
		this._config = config ?? {};
		this._autoVersionBump = this._config.autoVersionBump ?? false;
	}

	/**
	 * Manually bumps the aggregate version.
	 * Call this after state changes for Optimistic Concurrency Control.
	 *
	 * If `autoVersionBump` is enabled, this is called automatically
	 * when using `setState()`.
	 */
	protected bumpVersion(): void {
		this.version = (this.version + 1) as Version;
	}

	/**
	 * Sets the state and optionally bumps the version automatically.
	 * This is a convenience method for state mutations.
	 *
	 * @param newState - The new state
	 * @param bumpVersion - Whether to bump the version (defaults to autoVersionBump config)
	 */
	protected setState(
		newState: TState,
		bumpVersion?: boolean,
	): void {
		this._state = newState;
		const shouldBump = bumpVersion ?? this._autoVersionBump;
		if (shouldBump) {
			this.bumpVersion();
		}
	}

	/**
	 * Creates a snapshot of the current aggregate state.
	 * Useful for performance optimization, backup/restore, and audit trails.
	 *
	 * @returns A snapshot containing the current state and version
	 *
	 * @example
	 * ```typescript
	 * const snapshot = aggregate.createSnapshot();
	 * await snapshotRepository.save(aggregate.id, snapshot);
	 * ```
	 */
	public createSnapshot(): AggregateSnapshot<TState> {
		return {
			state: { ...this._state } as TState,
			version: this.version,
			snapshotAt: new Date(),
		};
	}

	/**
	 * Restores the aggregate from a snapshot.
	 * This is useful for loading aggregates from snapshots instead of
	 * rebuilding them from scratch.
	 *
	 * @param snapshot - The snapshot to restore from
	 *
	 * @example
	 * ```typescript
	 * const snapshot = await snapshotRepository.getLatest(aggregateId);
	 * aggregate.restoreFromSnapshot(snapshot);
	 * ```
	 */
	public restoreFromSnapshot(snapshot: AggregateSnapshot<TState>): void {
		this._state = snapshot.state;
		this.version = snapshot.version;
	}
}
