import type { Id } from "../core/id";
import { Entity, freezeShallow } from "../entity/entity";
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

	/**
	 * Post-save hook: a `Repository.save()` implementation calls this with
	 * the persisted version after a successful write to push the new
	 * version back into the aggregate and clear any recorded domain events
	 * (they are now safely on the write side / in the outbox).
	 *
	 * Required by the interface so a Repository implementation can call it
	 * via the published `IAggregateRoot` contract without taking the
	 * abstract class as a compile-time dependency.
	 *
	 * @param version - The version assigned by the persistence layer
	 */
	markPersisted(version: Version): void;
}

/**
 * Configuration options for AggregateRoot behavior.
 */
export interface AggregateConfig {
	/**
	 * Whether `setState()` should bump the version automatically.
	 *
	 * Defaults to **`false`** for `AggregateRoot` — because `setState()`
	 * already takes an explicit `bumpVersion` argument per call, so adding
	 * an "always bump" config on top would be redundant. Keep it `false`
	 * unless you have a subclass that never passes `bumpVersion` and you
	 * want every state change to advance the version anyway.
	 *
	 * (Contrast with `EventSourcedAggregate`, which defaults this to
	 * `true` because every event-sourced state change is per definition a
	 * versioned commit.)
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
export abstract class AggregateRoot<
	TState,
	TId extends Id<string>,
	TEvent = never,
>
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
		return Object.freeze(this._domainEvents.slice());
	}

	/**
	 * Clears the list of recorded domain events.
	 * Call this after dispatching the events.
	 */
	public clearDomainEvents(): void {
		this._domainEvents = [];
	}

	/**
	 * Post-save hook called by a `Repository.save()` implementation to push
	 * the persisted version back into the in-memory aggregate and clear the
	 * recorded domain events (they are now safely on the write side / in
	 * the outbox).
	 *
	 * Use this so `save()` can keep its `Promise<void>` return type: the
	 * caller holds the aggregate reference, which is up to date after this
	 * call.
	 */
	public markPersisted(version: Version): void {
		this.setVersion(version);
		this._domainEvents = [];
	}

	/**
	 * Mutates state and records the resulting domain events in the
	 * **canonical record-after-mutation order**. Use this instead of calling
	 * `setState` + `addDomainEvent` separately and you cannot trip the
	 * "event for a fact that never happened" footgun.
	 *
	 * Order of operations:
	 *  1. `setState(newState)` — runs `validateState`. If it throws, the
	 *     method propagates and **no event is recorded**.
	 *  2. Each event in `events` is appended via `addDomainEvent`.
	 *
	 * `events` accepts a single event or an array. Omit it (or pass `[]`)
	 * for state-only mutations.
	 *
	 * @example
	 * ```ts
	 * confirm(): void {
	 *   if (this.state.status === "confirmed") {
	 *     throw new OrderAlreadyConfirmedError(this.id);
	 *   }
	 *   this.commit(
	 *     { ...this.state, status: "confirmed" },
	 *     { type: "OrderConfirmed", orderId: this.id },
	 *   );
	 * }
	 * ```
	 *
	 * `EventSourcedAggregate.apply()` enforces the same ordering
	 * structurally; `commit()` is the opt-in equivalent on `AggregateRoot`,
	 * where `setState` and `addDomainEvent` are otherwise decoupled and the
	 * ordering is convention-only.
	 *
	 * @param newState - The new state (validated by `validateState`)
	 * @param events - One event, an array of events, or none (default)
	 * @param bumpVersion - Override for `autoVersionBump`; defaults to the
	 *                     aggregate's configured value
	 */
	protected commit(
		newState: TState,
		events: TEvent | readonly TEvent[] = [],
		bumpVersion?: boolean,
	): void {
		this.setState(newState, bumpVersion);
		const list: readonly TEvent[] = Array.isArray(events)
			? events
			: [events as TEvent];
		for (const ev of list) {
			this.addDomainEvent(ev);
		}
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
	 * Records a domain event for later publication.
	 *
	 * **Ordering: record AFTER state mutation.** Vernon (IDDD §8) is
	 * explicit: a domain event describes something that has just happened
	 * to the aggregate — its existence implies the state change already
	 * occurred. Concretely:
	 *
	 * ```ts
	 * confirm(): void {
	 *   if (this.state.status === "confirmed") {
	 *     throw new OrderAlreadyConfirmedError(this.id);
	 *   }
	 *   this.setState({ ...this.state, status: "confirmed" }, true);
	 *   this.addDomainEvent({ type: "OrderConfirmed", orderId: this.id });
	 *   // ↑ post-mutation. The event represents the committed fact.
	 * }
	 * ```
	 *
	 * Recording before mutation is a footgun: if a subsequent invariant
	 * check throws, the event has already been queued but the state never
	 * actually changed — consumers see an event for a fact that did not
	 * happen.
	 *
	 * `EventSourcedAggregate.apply()` enforces this ordering structurally;
	 * `AggregateRoot` leaves it as a convention because the state-mutation
	 * path (`setState`) is decoupled from event recording.
	 *
	 * @param event - The domain event to record
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
		this._state = freezeShallow(snapshot.state);
		this.setVersion(snapshot.version);
	}
}
