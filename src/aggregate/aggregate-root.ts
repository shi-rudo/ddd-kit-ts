import type { Id } from "../core/id";
import { freezeShallow } from "../entity/entity";
import { BaseAggregate } from "./base-aggregate";
import type { AggregateSnapshot } from "./aggregate";
import type { AnyDomainEvent } from "./domain-event";

// Re-export for backwards compatibility: `IAggregateRoot` lives in
// `aggregate.ts` (the type hub) but consumers historically imported it
// from `@shirudo/ddd-kit` / `./aggregate-root`. Keep both paths working.
export type { IAggregateRoot } from "./aggregate";

/**
 * Configuration options for AggregateRoot behavior.
 */
export interface AggregateConfig {
	/**
	 * Whether `setState()` should bump the version automatically when the
	 * caller omits the per-call `bumpVersion` argument.
	 *
	 * Defaults to **`false`**: `setState()` already takes an explicit
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
 * In DDD (Evans), an Aggregate is a cluster of objects (root entity, child entities,
 * and value objects) treated as a unit for consistency. The **Aggregate Root** is the
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
 * @template TEvent - The type of domain events recorded by this aggregate. Defaults to `never`: aggregates without a declared event type cannot emit events (emitting any event becomes a compile error). Supply a concrete event union to opt in.
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
	TSnapshotState = TState,
> extends BaseAggregate<TState, TId, TEvent, TSnapshotState> {
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
	 *  1. `setState(newState, true)`: runs `validateState` first.
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
	 * Restores the aggregate from a snapshot: loads state and aligns
	 * `version` + `persistedVersion` to the snapshot version. Validates
	 * the restored state.
	 *
	 * @param snapshot - The snapshot to restore from
	 */
	public restoreFromSnapshot(snapshot: AggregateSnapshot<TSnapshotState>): void {
		const restored = this.fromSnapshotState(snapshot.state);
		this.validateState(restored);
		this._state = freezeShallow(restored);
		this.markRestored(snapshot.version);
	}
}
