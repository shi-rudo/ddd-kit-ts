import type { Id } from "../core/id";
import { Entity } from "../entity/entity";
import type {
	AggregateSnapshot,
	Version,
} from "./aggregate";

/**
 * Marker interface for Aggregate Roots.
 *
 * In Domain-Driven Design, an Aggregate Root is an Entity (the parent Entity of the aggregate).
 * It represents the aggregate externally and is the only object that external code
 * is allowed to hold references to. All access to child entities within the aggregate
 * must go through the Aggregate Root.
 *
 * An Aggregate consists of:
 * - One Aggregate Root (Entity with id + version)
 * - Optional child entities (Entities with id + state, but no own version)
 * - Optional value objects
 *
 * The Aggregate Root has identity (id), state, and version for optimistic concurrency control.
 * Child entities exist only within the aggregate boundary and are versioned through
 * the Aggregate Root.
 *
 * @template TId - The type of the aggregate root identifier
 *
 * @example
 * ```typescript
 * class Order extends AggregateRoot<OrderState, OrderId> implements IAggregateRoot<OrderId> {
 *   // Order is an Aggregate Root (an Entity with version)
 *   // OrderState contains child entities (e.g., OrderItem) and value objects
 * }
 * ```
 */
export interface IAggregateRoot<TId extends Id<string>> {
	/**
	 * Unique identifier of the aggregate root entity.
	 */
	readonly id: TId;

	/**
	 * Version number for optimistic concurrency control.
	 * Incremented on each state change to detect concurrent modifications.
	 * This version applies to the entire aggregate, including all child entities.
	 */
	readonly version: Version;
}

/**
 * Configuration options for AggregateRoot behavior.
 */
export interface AggregateConfig {
	/**
	 * Whether to automatically bump the version when state changes.
	 * Defaults to false. Set to true for automatic versioning.
	 */
	autoVersionBump?: boolean;
}

/**
 * Base class for Aggregate Roots without Event Sourcing.
 *
 * In DDD (Evans), an Aggregate is a cluster of objects — root entity, child entities,
 * and value objects — treated as a unit for consistency. The **Aggregate Root** is the
 * root entity that represents the aggregate externally and is the only entry point
 * for external code. This class serves as both: it IS the root entity and it contains
 * the aggregate state (`TState`) which holds child entities and value objects.
 *
 * Provides:
 * - Identity (id) and state management (via `Entity`)
 * - Version management for optimistic concurrency control
 * - Domain event tracking for side-effects
 * - Snapshot support for performance optimization
 *
 * All changes to child entities within `TState` are versioned through this root.
 * Use `setState()` for state mutations to ensure invariant validation.
 *
 * For event sourcing, use `EventSourcedAggregate` instead.
 *
 * @template TState - The type of the aggregate state (contains child entities and value objects)
 * @template TId - The type of the aggregate root identifier
 * @template TEvent - The type of domain events recorded by this aggregate (defaults to unknown)
 *
 * @example
 * ```typescript
 * // Order is an Aggregate Root (an Entity with version)
 * class Order extends AggregateRoot<OrderState, OrderId> {
 *   constructor(id: OrderId, initialState: OrderState) {
 *     super(id, initialState);
 *   }
 *
 *   confirm(): void {
 *     this.setState({ ...this.state, status: "confirmed" }, true);
 *   }
 * }
 * ```
 */
export abstract class AggregateRoot<TState, TId extends Id<string>, TEvent = unknown>
	extends Entity<TState, TId>
	implements IAggregateRoot<TId> {
	private _version: Version = 0 as Version;

	public get version(): Version {
		return this._version;
	}

	protected setVersion(version: Version): void {
		this._version = version;
	}

	private readonly _config: AggregateConfig;
	private readonly _autoVersionBump: boolean;
	private _domainEvents: TEvent[] = [];

	/**
	 * Returns a read-only list of domain events recorded by this aggregate.
	 * These events are side-effects of state changes.
	 */
	public get domainEvents(): ReadonlyArray<TEvent> {
		return this._domainEvents;
	}

	/**
	 * Clears the list of recorded domain events.
	 * Call this after dispatching the events.
	 */
	public clearDomainEvents(): void {
		this._domainEvents = [];
	}

	protected constructor(
		id: TId,
		initialState: TState,
		config?: AggregateConfig,
	) {
		super(id, initialState);
		this._config = config ?? {};
		this._autoVersionBump = this._config.autoVersionBump ?? false;
	}

	/**
	 * Adds a domain event to the aggregate's list of changes.
	 * Use this to record side-effects that should be published.
	 *
	 * @param event - The domain event to add
	 */
	protected addDomainEvent(event: TEvent): void {
		this._domainEvents.push(event);
	}

	/**
	 * Manually bumps the aggregate version.
	 * Call this after state changes for Optimistic Concurrency Control.
	 *
	 * If `autoVersionBump` is enabled, this is called automatically
	 * when using `setState()`.
	 */
	protected bumpVersion(): void {
		this.setVersion((this._version + 1) as Version);
	}

	/**
	 * Sets the state and optionally bumps the version automatically.
	 * This is a convenience method for state mutations.
	 * Automatically validates the newState using `validateState()`.
	 * Overrides Entity.setState to add version bumping.
	 *
	 * @param newState - The new state
	 * @param bumpVersion - Whether to bump the version (defaults to autoVersionBump config)
	 */
	protected setState(
		newState: TState,
		bumpVersion?: boolean,
	): void {
		super.setState(newState);
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
			state: structuredClone(this._state),
			version: this.version,
			snapshotAt: new Date(),
		};
	}

	/**
	 * Restores the aggregate from a snapshot.
	 * This is useful for loading aggregates from snapshots instead of
	 * rebuilding them from scratch.
	 * Validates the restored state.
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
		this.validateState(snapshot.state);
		this._state = snapshot.state;
		this.setVersion(snapshot.version);
	}
}
