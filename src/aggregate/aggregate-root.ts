import type { Id } from "../core/id";
import { freezeShallow } from "../entity/entity";
import { BaseAggregate } from "./base-aggregate";
import type { AggregateSnapshot, Version } from "./aggregate";
import type { AnyDomainEvent } from "./domain-event";

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
export interface IAggregateRoot<TId extends Id<string>, TEvent = never> {
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
	 * DB-baseline version. `undefined` until the aggregate has been
	 * persisted or restored at least once. Repository implementations
	 * route INSERT vs UPDATE on this field and use it as the OCC
	 * baseline in the UPDATE's `WHERE version = ?` predicate. See
	 * `IRepository.save` JSDoc for the full routing rule.
	 */
	readonly persistedVersion: Version | undefined;

	/**
	 * Read-only list of domain events recorded on this aggregate that have
	 * not yet been flushed to the outbox / persistence layer. Both state-
	 * stored (`AggregateRoot`) and event-sourced (`EventSourcedAggregate`)
	 * aggregates expose them under the same name, so Repository.save() can
	 * harvest them uniformly without branching on the aggregate flavour.
	 */
	readonly pendingEvents: ReadonlyArray<TEvent>;

	/**
	 * Clears the pending-event list. Called by `markPersisted` after a
	 * successful write — the events have been handed off to the outbox
	 * / event store and are no longer the aggregate's responsibility.
	 */
	clearPendingEvents(): void;

	/**
	 * Post-save hook: a `Repository.save()` implementation calls this with
	 * the persisted version after a successful write to push the new
	 * version back into the aggregate and clear pendingEvents (they are
	 * now safely on the write side / in the outbox).
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
	 * Whether `setState()` should bump the version automatically when the
	 * caller omits the per-call `bumpVersion` argument.
	 *
	 * Defaults to **`false`** — `setState()` already takes an explicit
	 * `bumpVersion` argument per call, so the config is just the default
	 * the per-call argument falls back to. Set to `true` only if you have
	 * a subclass that never passes `bumpVersion` and you want every state
	 * change to advance the version anyway.
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
 * - Version + persistedVersion + pending-event tracking (via `BaseAggregate`)
 * - `setState`-based mutation with optional version bumping
 * - `commit()` record-after-mutation helper
 * - Snapshot support for performance optimization
 *
 * All changes to child entities within `TState` are versioned through this root.
 * Use `setState()` for state mutations to ensure invariant validation.
 *
 * For event sourcing, use `EventSourcedAggregate` instead.
 *
 * @template TState - The type of the aggregate state (contains child entities and value objects)
 * @template TId - The type of the aggregate root identifier
 * @template TEvent - The type of domain events recorded by this aggregate. Defaults to `never` — aggregates without a declared event type cannot emit events (emitting any event becomes a compile error). Supply a concrete event union to opt in.
 *
 * @example
 * ```typescript
 * // Order is an Aggregate Root (an Entity with version)
 * class Order extends AggregateRoot<OrderState, OrderId> {
 *   protected readonly aggregateType = "Order";
 *
 *   constructor(id: OrderId, initialState: OrderState) {
 *     super(id, initialState);
 *   }
 *
 *   confirm(): void {
 *     this.commit(
 *       { ...this.state, status: "confirmed" },
 *       this.recordEvent("OrderConfirmed", { orderId: this.id }),
 *     );
 *   }
 * }
 * ```
 */
export abstract class AggregateRoot<
	TState,
	TId extends Id<string>,
	TEvent extends AnyDomainEvent = never,
> extends BaseAggregate<TState, TId, TEvent> {
	private readonly _autoVersionBump: boolean;

	protected constructor(
		id: TId,
		initialState: TState,
		config?: AggregateConfig,
	) {
		super(id, initialState);
		this._autoVersionBump = config?.autoVersionBump ?? false;
	}

	/**
	 * Mutates state and records the resulting domain events in the
	 * **canonical record-after-mutation order**. Use this instead of calling
	 * `setState` + `addDomainEvent` separately and you cannot trip the
	 * "event for a fact that never happened" footgun.
	 *
	 * Order of operations:
	 *  1. `setState(newState, true)` — runs `validateState` first.
	 *     If it throws, the method propagates and **no event is recorded
	 *     and no version is bumped**.
	 *  2. Each event in `events` is appended via `addDomainEvent`.
	 *
	 * `commit()` **always bumps the version**, regardless of the aggregate's
	 * `autoVersionBump` config. Recording a domain event implies "something
	 * happened that the outside world cares about", and optimistic-
	 * concurrency callers must see a fresh version every time. The config
	 * still governs the un-coupled `setState` path. If you need to mutate
	 * state without bumping (e.g. cosmetic caches), call `setState(newState,
	 * false)` and skip `commit` entirely.
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
	 *     this.recordEvent("OrderConfirmed", { orderId: this.id }),
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
	 */
	protected commit(
		newState: TState,
		events: TEvent | readonly TEvent[] = [],
	): void {
		this.setState(newState, true);
		const list: readonly TEvent[] = Array.isArray(events)
			? events
			: [events as TEvent];
		for (const ev of list) {
			this.addDomainEvent(ev);
		}
	}

	/**
	 * Sets the state and optionally bumps the version automatically.
	 * Validates `newState` via `validateState()`.
	 *
	 * @param newState - The new state
	 * @param bumpVersion - Whether to bump the version (defaults to autoVersionBump config)
	 */
	protected setState(newState: TState, bumpVersion?: boolean): void {
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
	 */
	public createSnapshot(): AggregateSnapshot<TState> {
		return {
			state: structuredClone(this._state),
			version: this.version,
			snapshotAt: new Date(),
		};
	}

	/**
	 * Restores the aggregate from a snapshot — loads state and aligns
	 * `version` + `persistedVersion` to the snapshot version. Validates
	 * the restored state.
	 *
	 * @param snapshot - The snapshot to restore from
	 */
	public restoreFromSnapshot(snapshot: AggregateSnapshot<TState>): void {
		const cloned = structuredClone(snapshot.state);
		this.validateState(cloned);
		this._state = freezeShallow(cloned);
		this.markRestored(snapshot.version);
	}
}
