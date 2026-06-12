import type { Id } from "../core/id";
import { freezeShallow } from "../entity/entity";
import { BaseAggregate } from "./base-aggregate";
import type { AggregateSnapshot, Version } from "./aggregate";
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

	/**
	 * The state reference as of the last {@link markRestored} /
	 * `markPersisted` (the persistence-lifecycle markers). Only
	 * meaningful while {@link _hasBaseline} is `true`; tracked by a
	 * separate flag rather than an `undefined` sentinel so a `TState`
	 * that itself admits `undefined` cannot be confused with the
	 * never-persisted insert path.
	 *
	 * Held by reference, never copied: `_state` is shallow-frozen and only
	 * ever *replaced* (via `setState` / restore), so the captured reference
	 * stays an exact image of the state at baseline time.
	 */
	private _baselineState: TState | undefined = undefined;

	/**
	 * `false` until the aggregate has been persisted or restored at least
	 * once: the insert path, where every key counts as changed.
	 */
	private _hasBaseline = false;

	protected constructor(
		id: TId,
		initialState: TState,
		config?: AggregateConfig,
	) {
		super(id, initialState);
		this._autoVersionBump = config?.autoVersionBump ?? false;
	}

	/**
	 * **Lifecycle marker, Post-Load (see `BaseAggregate.markRestored`).**
	 * Additionally captures the current state reference as the dirty-
	 * tracking baseline for {@link changedKeys} / {@link hasChanges}.
	 *
	 * Covers all three baseline-capture paths through a single override:
	 * `reconstitute(...)` factories, {@link restoreFromSnapshot} (which
	 * assigns the restored state *before* calling this), and
	 * `markPersisted` (which delegates here, so a successful save
	 * re-baselines the diff).
	 *
	 * If you override this, call `super.markRestored(version)` FIRST:
	 * skipping it leaves the baseline uncaptured, so `changedKeys`
	 * permanently reports ALL keys and `hasChanges` never returns `false`
	 * — partial-write repositories silently degrade to full writes — on
	 * top of breaking version sync.
	 */
	protected override markRestored(version: Version): void {
		super.markRestored(version);
		this._baselineState = this._state;
		this._hasBaseline = true;
	}

	/**
	 * Top-level state keys whose value (or presence) changed since the
	 * last {@link markRestored} / `markPersisted`. Never-persisted
	 * aggregates report ALL current keys (the insert path).
	 *
	 * This is the write-scoping signal for **partial writes in multi-table
	 * repositories**: a `save()` for an aggregate whose state spans a root
	 * row plus N child-collection tables can write only the collections
	 * whose key is dirty, while the root-row OCC version write rides every
	 * save. See `docs/guide/repository.md` → "Partial writes for
	 * multi-table aggregates".
	 *
	 * **How it works.** `setState()` replaces state immutably and the
	 * state object is shallow-frozen, so unchanged top-level sub-objects
	 * keep reference identity across mutations. The diff is therefore a
	 * shallow per-key `!==` against the baseline reference — O(top-level
	 * keys), no proxies, no deep diff. A key also counts as dirty when its
	 * *presence* differs (added or removed, even with an `undefined`
	 * value). Computed fresh on every access (a new `Set` each time), so
	 * callers cannot poison later reads.
	 *
	 * **Soundness contract (same one `freezeShallow` already makes):**
	 * the per-key diff is exact only for plain-record `TState` mutated via
	 * `setState` / `commit` (whole-state replacement). In-place mutation
	 * of NESTED objects bypasses the shallow freeze AND this diff; a
	 * class-instance `TState` mutated through its own methods defeats
	 * tracking entirely (the reference never changes). A keyless `TState`
	 * (primitive, bare `Date`) has no keys to report, so `changedKeys`
	 * stays empty for it — use {@link hasChanges}, whose reference
	 * fallback covers keyless states. A deep-equal but newly-referenced
	 * value reports a false POSITIVE (harmless extra write); under the
	 * contract above there are no false negatives.
	 *
	 * Granularity is per top-level key — table-granular, not row-granular:
	 * a dirty collection key means "this child table changed", not which
	 * rows. `EventSourcedAggregate` deliberately has no `changedKeys`;
	 * its `pendingEvents` are the change record.
	 */
	public get changedKeys(): ReadonlySet<Extract<keyof TState, string>> {
		if (!this._hasBaseline) {
			return new Set(ownKeys(this._state)) as unknown as ReadonlySet<
				Extract<keyof TState, string>
			>;
		}
		return computeChangedKeys(this._baselineState as TState, this._state);
	}

	/**
	 * Safe skip signal: `false` only when there is genuinely nothing to
	 * persist or flush. `true` when the aggregate has never been
	 * persisted, the version moved past `persistedVersion`, there are
	 * unflushed {@link pendingEvents}, any state key is dirty, or — for
	 * keyless states the per-key diff cannot see (primitive `TState`,
	 * zero-own-key objects like a bare `Date`) — the state reference
	 * changed since the baseline.
	 *
	 * The version clause is deliberate: `setState({...state}, true)` with
	 * identical per-key values yields empty {@link changedKeys} but a
	 * bumped version. If a repository skipped `save()` on a state-only
	 * check, `withCommit` would still call `markPersisted(version)` after
	 * commit, desyncing `persistedVersion` from the DB row — and the next
	 * uncontended save would throw a false `ConcurrencyConflictError`.
	 *
	 * The pending-events clause covers the sanctioned decoupled
	 * `addDomainEvent` path (an event recorded without a state change,
	 * e.g. a deletion event before a hard delete): the aggregate still
	 * needs its trip through `withCommit` so the event reaches the
	 * outbox. With all clauses included, `hasChanges === false` genuinely
	 * means "skipping save is safe".
	 */
	public get hasChanges(): boolean {
		if (!this._hasBaseline) return true;
		if (this.version !== this.persistedVersion) return true;
		if (this.pendingEvents.length > 0) return true;
		if (this.changedKeys.size > 0) return true;
		// Keyless states are invisible to the per-key diff; fall back to
		// the state reference itself — setState always replaces it.
		const baseline = this._baselineState;
		return (
			baseline !== this._state &&
			ownKeys(baseline).length === 0 &&
			ownKeys(this._state).length === 0
		);
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

/**
 * Own enumerable string keys of a state value; empty for primitives.
 * Mirrors what `shallowCopyOwned` copies and what the snapshot walk
 * serialises (own ENUMERABLE string-keyed values). Symbol-keyed
 * properties are invisible to the diff, exactly as they are invisible
 * to `Object.keys`-based persistence mapping.
 */
function ownKeys(value: unknown): readonly string[] {
	return value !== null && typeof value === "object" ? Object.keys(value) : [];
}

/**
 * Shallow per-key diff between the baseline state and the current state:
 * a key is dirty when its PRESENCE differs (added/removed key, including
 * one whose value was `undefined`) or its value reference differs
 * (`!==`). The never-persisted insert path is handled by the caller
 * (`changedKeys` reports all current keys), not here.
 *
 * Presence is compared via own-enumerable-key membership, never via the
 * prototype chain, so state keys named `constructor` or `__proto__`
 * cannot resolve through `Object.prototype` and compare wrong (same
 * own-key discipline as `EventSourcedAggregate`'s handler dispatch).
 */
function computeChangedKeys<TState>(
	baseline: TState,
	current: TState,
): ReadonlySet<Extract<keyof TState, string>> {
	const baselineKeys = new Set(ownKeys(baseline));
	const currentKeys = new Set(ownKeys(current));
	const dirty = new Set<string>();
	for (const key of currentKeys) {
		if (!baselineKeys.has(key)) {
			// Added key.
			dirty.add(key);
			continue;
		}
		// Key is an own enumerable property on BOTH sides; the indexed
		// reads below can never fall through to the prototype chain.
		const before = (baseline as Record<string, unknown>)[key];
		const after = (current as Record<string, unknown>)[key];
		if (before !== after) {
			dirty.add(key);
		}
	}
	for (const key of baselineKeys) {
		if (!currentKeys.has(key)) {
			// Removed key.
			dirty.add(key);
		}
	}
	return dirty as unknown as ReadonlySet<Extract<keyof TState, string>>;
}
