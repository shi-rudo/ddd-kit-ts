/**
 * Entity utilities and interfaces for Domain-Driven Design.
 *
 * In Domain-Driven Design, there are two types of entities:
 *
 * 1. **Aggregate Root Entity**: The parent Entity of an aggregate.
 *    - Has identity (id), state, and version
 *    - Implemented by classes extending `StateStoredAggregate` or `EventSourcedAggregate`
 *    - Represents the aggregate externally
 *    - Loaded/saved through repositories
 *
 * 2. **Child Entities**: Entities within an aggregate.
 *    - Have identity (id) and state, but no own version
 *    - Can extend `Entity<TState, TId>` for class-based entities
 *    - Or use functional style with `Identifiable<TId> & TProps`
 *    - Exist only within the aggregate boundary
 *    - Versioned through the Aggregate Root
 *    - Cannot be referenced directly from outside the aggregate
 *
 * This module provides:
 * - `Entity<TState, TId>` - Base class for entities with state
 * - `EntityConfig` - Construction options (validation and opt-in deep freeze)
 * - `Identifiable<TId>` - Minimal interface for objects with id
 * - Helper functions for working with collections of entities
 *
 * @example
 * ```typescript
 * // Class-based child entity with logic
 * const validateOrderItemState = (state: OrderItemState): void => {
 *   if (state.quantity < 1) throw new Error("quantity must be positive");
 * };
 *
 * class OrderItem extends Entity<OrderItemState, ItemId> {
 *   constructor(id: ItemId, initialState: OrderItemState) {
 *     super(id, initialState, { validateState: validateOrderItemState });
 *   }
 *
 *   updateQuantity(quantity: number): void {
 *     // setState validates the next state and freezes it.
 *     this.setState({ ...this.state, quantity });
 *   }
 *
 *   calculateSubtotal(): number {
 *     return this.state.price * this.state.quantity;
 *   }
 * }
 *
 * // Functional-style child entity (simpler, no logic)
 * type OrderItem = Identifiable<ItemId> & {
 *   productId: string;
 *   quantity: number;
 *   price: number;
 * };
 *
 * // Aggregate Root (Entity with version)
 * class Order extends StateStoredAggregate<OrderState, OrderId> {
 *   // Order is an Aggregate Root Entity
 *   // OrderState contains OrderItem child entities
 * }
 * ```
 */
import {
	assertNoHostileOwnProtoKey,
	MissingEntityIdError,
	UnmanagedInstanceError,
} from "../../errors/kit-errors";
import type { Id } from "../identity/id";
import { deepFreeze } from "../value-object/value-object";

/** A pure invariant check that throws when a candidate state is invalid. */
export type StateValidator<TState> = (state: TState) => void;

/**
 * Construction options shared by `Entity` and (via `AggregateConfig`) the
 * aggregate base classes.
 */
export interface EntityConfig<TState = unknown> {
	/**
	 * Pure state-invariant validator captured by the entity instance. It runs
	 * against the exact frozen copy the entity stores, during construction,
	 * every {@link Entity.setState} call, and the event-sourced apply path.
	 * Throw to reject the candidate state. A validator that tries to mutate
	 * the candidate fails loudly, because the candidate is already frozen.
	 *
	 * Passing validation as data avoids virtual dispatch from the base
	 * constructor: the function cannot observe partly initialised subclass
	 * fields through `this`. Close over immutable policy supplied to the
	 * concrete constructor when validation needs instance-specific inputs.
	 */
	readonly validateState?: StateValidator<TState>;

	/**
	 * Opt-in: freeze the WHOLE state graph (via `deepFreeze`) instead of
	 * the default shallow freeze. This protects against nested aliases
	 * retained by constructor callers and against accidental in-place
	 * writes inside the entity; live state itself is never public.
	 *
	 * Defaults to `false` (the documented shallow contract). A deep freeze
	 * walks the part of the graph the write changed: subtrees the kit
	 * already deep-froze are skipped, so `{ ...state, status }` costs the
	 * root object. A write that replaces a large subtree walks that subtree.
	 *
	 * **Only for plain-data states.** The deep freeze walks the entire
	 * graph: a class-based child entity inside the state would be frozen
	 * too, and its own mutation methods would start throwing. States
	 * carrying class-based children must keep the default shallow freeze.
	 * Note that the ownership transfer widens accordingly: nested objects
	 * passed into the constructor or `setState` are frozen IN PLACE (the
	 * shallow copy protects only the top-level input object).
	 *
	 * Under the shallow freeze a nested object of the state stays open. A
	 * fold or a validator that writes into it in place changes the state
	 * the entity already holds, and no gate sees the write. The
	 * event-sourced replay rollback restores the previous state object by
	 * reference, so such a write survives the rollback. The deep freeze
	 * makes the write throw at the write site.
	 */
	deepFreezeState?: boolean;

	/**
	 * For reconstitution factories only: the initial state is a persisted
	 * fact, like an event history, so {@link validateState} does not run
	 * on it. Every later {@link Entity.setState} call and every
	 * event-sourced apply still runs the validator. Without this option a
	 * rule that tightened after a snapshot was taken makes every restore of
	 * that snapshot throw. Never pass it for a new aggregate: a factory
	 * yields valid objects only. The structural gates (frozen copy, hostile
	 * own-key check) run regardless.
	 */
	trustInitialState?: boolean;
}

/**
 * Functional definition of an Entity via its capability: an object is
 * identifiable if it has an `id`.
 *
 * `TId` is constrained to `Id<string>` so the brand discipline that
 * `Id<Tag>` enforces is preserved end-to-end: an `Identifiable<UserId>`
 * cannot accidentally be paired with an `Identifiable<OrderId>` or with
 * a plain `string`.
 */
export type Identifiable<TId extends Id<string>> = {
	readonly id: TId;
};

/**
 * Interface for Entities with state.
 *
 * In Domain-Driven Design, Entities have:
 * - Identity (id): Distinguishes one entity from another
 * - State: The attributes/properties of the entity
 *
 * Unlike Value Objects (which are immutable and compared by value),
 * Entities are compared by identity and can have mutable state.
 *
 * @template TId - The type of the entity identifier
 */
export interface IEntity<TId extends Id<string>> extends Identifiable<TId> {
	/**
	 * Unique identifier of the entity.
	 */
	readonly id: TId;
}

/**
 * Freezes `value` by the entity's configured mode. The default is a
 * shallow freeze. When {@link EntityConfig.deepFreezeState} was enabled
 * at construction, the mode is `deepFreeze`. It does not store the value.
 * The event-sourced `apply` freezes the fold result first, then validates
 * it. So the object that passed validation is the object that
 * {@link storeTrustedState} stores.
 *
 * @internal Shared by the kit's own entity subclasses; not part of the
 * public API.
 */
export let freezeEntityState: <TState>(
	entity: Entity<TState, Id<string>>,
	value: TState,
) => TState;

/**
 * Stores a state that is accepted fact. The event-sourced replay stores
 * history through it. The event-sourced `apply` stores a state that it
 * validated on its own path. The instance-bound
 * {@link EntityConfig.validateState} does not run. The value is frozen by
 * the configured mode and becomes the entity's own state without a copy.
 * A value that is frozen already is stored as is. So the write cannot
 * throw, and a caller may write the version first and store second.
 *
 * Bound in the static block of {@link Entity}, so it reaches the private
 * fields. A subclass cannot redirect it, unlike a protected method.
 *
 * @internal Shared by the kit's own entity subclasses; not part of the
 * public API.
 */
export let storeTrustedState: <TState>(
	entity: Entity<TState, Id<string>>,
	trusted: TState,
) => void;

/**
 * Abstract base class for Entities with state.
 *
 * Provides:
 * - Identity management (id)
 * - State management
 * - Instance-bound pure state validation
 * - Protected state access for domain behavior
 *
 * This is the foundation for all Entities in DDD:
 * - Child Entities within aggregates can extend this
 * - Aggregate Roots extend this and add version + events
 *
 * @template TState - The type of the entity state
 * @template TId - The type of the entity identifier
 *
 * @example
 * ```typescript
 * // Child Entity within an aggregate
 * const validateOrderItemState = (state: OrderItemState): void => {
 *   if (state.quantity < 1) throw new Error("quantity must be positive");
 * };
 *
 * class OrderItem extends Entity<OrderItemState, ItemId> {
 *   constructor(id: ItemId, initialState: OrderItemState) {
 *     super(id, initialState, { validateState: validateOrderItemState });
 *   }
 *
 *   updateQuantity(quantity: number): void {
 *     // setState validates the next state and freezes it.
 *     this.setState({ ...this.state, quantity });
 *   }
 * }
 * ```
 */
export abstract class Entity<TState, TId extends Id<string>>
	implements IEntity<TId>
{
	public readonly id: TId;

	/**
	 * Returns the live state to subclass domain behavior.
	 *
	 * This accessor is deliberately protected: returning the generic
	 * `TState` publicly would expose the aggregate's live object graph and
	 * let nested mutation bypass behavior, validation, versioning, and
	 * dirty tracking. Concrete entities should expose business-meaningful queries or
	 * detached immutable DTOs. Snapshot projection belongs to the persistence
	 * adapter, which captures the aggregate from outside rather than asking
	 * the entity to create its own persistence memento.
	 */
	protected get state(): TState {
		return this._state;
	}

	/**
	 * Private, so a subclass writes only through {@link setState}. The
	 * kit's own replay path stores accepted history through
	 * {@link storeTrustedState}, which skips the validator.
	 */
	private _state: TState;

	private readonly _stateFreezeMode: StateFreezeMode;

	// The kit-internal writers reach the private fields from here. A
	// subclass cannot override or observe them, unlike a protected method.
	static {
		freezeEntityState = (entity, value) =>
			freezeStateByMode(value, entity._stateFreezeMode);
		storeTrustedState = (entity, trusted) => {
			entity._state = freezeStateByMode(trusted, entity._stateFreezeMode);
		};
	}

	/**
	 * Declared and never assigned: a subclass that declares a member named
	 * `validateState` (a method or a field) fails to compile against this
	 * private member. The validator itself lives in a module-level map, so
	 * the runtime ignores such a member anyway; this declaration turns the
	 * silent no-op into a compile error.
	 */
	private declare readonly validateState: never;

	/**
	 * **State ownership.** Plain-object and array states are shallow-copied
	 * before the freeze, so the caller's own object stays mutable. A CLASS
	 * INSTANCE passed as state is an ownership transfer: it is frozen
	 * in place (a copy would strip its prototype). Do not keep mutating
	 * the instance after handing it to the entity. The same contract
	 * applies to {@link setState}. With
	 * {@link EntityConfig.deepFreezeState} enabled, the ownership transfer
	 * widens to the whole graph: NESTED objects are frozen in place too.
	 *
	 * @throws MissingEntityIdError when `id` is not a non-blank string.
	 * @throws HostileStateKeyError when a plain-object, null-prototype,
	 * or array state carries an own `"__proto__"` data key; validate and
	 * strip untrusted input at the boundary.
	 */
	protected constructor(
		id: TId,
		initialState: TState,
		config?: EntityConfig<TState>,
	) {
		if (typeof id !== "string" || id.trim() === "") {
			throw new MissingEntityIdError(id);
		}
		this.id = id;
		this._stateFreezeMode =
			(config?.deepFreezeState ?? false) ? "deep" : "shallow";
		stateValidators.set(
			this,
			(config?.validateState ?? noStateValidation) as StateValidator<unknown>,
		);
		// Copy, freeze, validate, assign: the object validated IS the frozen
		// object stored, so a validator that tries to mutate it fails loudly.
		// The validator lives in a module-level map keyed by instance, and
		// the freeze helper is a module function, so a same-named member in a
		// JavaScript subclass cannot turn this constructor call into virtual
		// dispatch.
		const initial = freezeStateByMode(
			shallowCopyOwned(initialState),
			this._stateFreezeMode,
		);
		if (!(config?.trustInitialState ?? false)) {
			assertStateInvariant(this, initial);
		}
		this._state = initial;
	}

	/**
	 * Sets the state of the entity.
	 * This is a convenience method for state mutations.
	 * Automatically validates `newState` with the instance-bound
	 * {@link EntityConfig.validateState} function.
	 *
	 * Plain-object and array states are shallow-copied before the freeze
	 * (the caller's object stays mutable); a class-instance state is an
	 * ownership transfer and is frozen in place; see the constructor.
	 *
	 * @param newState - The new state
	 * @throws HostileStateKeyError when the state carries an own
	 * `"__proto__"` data key; the previous state is kept.
	 */
	protected setState(newState: TState): void {
		// Same copy-freeze-validate-assign order as the constructor: the
		// object validated IS the frozen object stored, and a validation
		// throw leaves the previous state untouched.
		const next = freezeStateByMode(
			shallowCopyOwned(newState),
			this._stateFreezeMode,
		);
		assertStateInvariant(this, next);
		this._state = next;
	}
}

const noStateValidation: StateValidator<unknown> = () => {};

/** The instance-bound validator of every constructed entity, keyed by instance. */
const stateValidators = new WeakMap<object, StateValidator<unknown>>();

/**
 * Runs the entity's instance-bound {@link EntityConfig.validateState}
 * against a candidate state. The constructor, {@link Entity.setState}, and
 * the event-sourced apply path all use it. Replay skips it because history
 * is accepted fact. Call it with the exact frozen object that will be
 * stored, so a validator that tries to mutate it fails loudly.
 *
 * Deliberately a module-level function with a per-instance lookup. A
 * method could be overridden. A property could be shadowed by a subclass
 * field initializer that runs after `super()`. Neither can redirect this
 * lookup.
 *
 * @internal Shared by the kit's own entity subclasses; not part of the
 * public API.
 */
export function assertStateInvariant<TState>(
	entity: Entity<TState, Id<string>>,
	candidate: TState,
): void {
	const validateState = stateValidators.get(entity);
	if (validateState === undefined) {
		throw new UnmanagedInstanceError(
			"assertStateInvariant",
			"entity",
			(entity as { id?: unknown } | null)?.id,
		);
	}
	validateState(candidate);
}

/** The entity's configured freeze depth, fixed once at construction. */
type StateFreezeMode = "shallow" | "deep";

function freezeStateByMode<TState>(
	value: TState,
	mode: StateFreezeMode,
): TState {
	return mode === "deep" ? (deepFreeze(value) as TState) : freezeShallow(value);
}

/**
 * Shallow-freezes `value` when it's a non-null object or array, so that
 * direct property writes throw in strict mode. Returns the value as-is for
 * primitives. `Entity` picks this or {@link deepFreeze} per the
 * `deepFreezeState` config, so state read through the `state` getter
 * cannot be mutated from outside, without a deep clone on every read.
 *
 * Subclass code stores state through `setState`, which freezes by the
 * configured mode. The export remains for consumers using it as a
 * standalone utility.
 */
export function freezeShallow<T>(value: T): T {
	if (value !== null && typeof value === "object") {
		return Object.freeze(value);
	}
	return value;
}

/**
 * The hostile own-key guard for a state value that is about to be stored.
 * It checks the root object only, and only the shapes a JSON row can
 * produce: a plain object, a null-prototype object, or an array. A class
 * instance is an ownership transfer and passes. The constructor,
 * {@link Entity.setState}, and the event-sourced fold all use it, so the
 * depth and the shape rule cannot drift between the paths.
 *
 * @internal Shared by the kit's own entity subclasses; not part of the
 * public API.
 */
export function assertStateHasNoHostileOwnKey(
	state: unknown,
	subject: string,
): void {
	if (state === null || typeof state !== "object") return;
	if (Array.isArray(state)) {
		assertNoHostileOwnProtoKey(state, subject);
		return;
	}
	const proto = Object.getPrototypeOf(state);
	if (proto !== Object.prototype && proto !== null) return;
	assertNoHostileOwnProtoKey(state, subject);
}

/**
 * Returns a shallow copy for plain objects and arrays so the subsequent
 * `freezeShallow` never locks the caller's own object in place (their later
 * writes to it would throw in strict mode). Class instances and primitives
 * pass through unchanged: a spread would strip an instance's prototype,
 * and handing a class instance as state is an ownership transfer. Nested
 * objects stay shared by design (shallow-freeze, no deep clone).
 */
function shallowCopyOwned<T>(value: T): T {
	if (value === null || typeof value !== "object") return value;
	assertStateHasNoHostileOwnKey(value, "Entity state");
	if (Array.isArray(value)) {
		// Spread copies only iterated index elements; transfer own
		// enumerable NON-INDEX keys (items.total = 5 style annotations) as
		// data properties too, mirroring the plain-object branch, so the
		// copy never silently loses caller state.
		const copy = [...value];
		for (const key of Reflect.ownKeys(value)) {
			if (key === "length" || Object.hasOwn(copy, key)) continue;
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor?.enumerable) continue;
			Object.defineProperty(copy, key, {
				value: (value as Record<PropertyKey, unknown>)[key],
				writable: true,
				enumerable: true,
				configurable: true,
			});
		}
		return copy as T;
	}
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) return value;
	// Copy as data properties, never through [[Set]]: object spread uses
	// CreateDataProperty, so even without the guard above no key could
	// reach the `__proto__` setter the way Object.assign onto an
	// Object.prototype-based target would. On a null-prototype target no
	// setter exists in the chain, so Object.assign is safe there.
	return (
		proto === null ? Object.assign(Object.create(null), value) : { ...value }
	) as T;
}

/**
 * Checks if two entities have the same ID.
 * Works with any object that has an 'id' property.
 *
 * @param a - First entity
 * @param b - Second entity
 * @returns true if both entities have the same ID, false otherwise
 *
 * @example
 * ```typescript
 * const item1: OrderItem = { id: itemId1, productId: "prod-1", quantity: 2 };
 * const item2: OrderItem = { id: itemId2, productId: "prod-2", quantity: 1 };
 *
 * sameEntity(item1, item2); // false
 * sameEntity(item1, item1); // true
 * ```
 */
export function sameEntity<TId extends Id<string>>(
	a: Identifiable<TId>,
	b: Identifiable<TId>,
): boolean {
	return a.id === b.id;
}

/**
 * Finds an entity by ID in a collection.
 * Returns undefined if not found.
 *
 * @param entities - Array of entities to search
 * @param id - The ID to search for
 * @returns The entity if found, undefined otherwise
 *
 * @example
 * ```typescript
 * const items: OrderItem[] = [
 *   { id: itemId1, productId: "prod-1", quantity: 2 },
 *   { id: itemId2, productId: "prod-2", quantity: 1 }
 * ];
 *
 * const item = findEntityById(items, itemId1);
 * // item is { id: itemId1, productId: "prod-1", quantity: 2 }
 * ```
 */
export function findEntityById<
	TId extends Id<string>,
	T extends Identifiable<TId>,
>(entities: ReadonlyArray<T>, id: TId): T | undefined {
	return entities.find((entity) => entity.id === id);
}

/**
 * Checks if an entity with the given ID exists in the collection.
 *
 * @param entities - Array of entities to search
 * @param id - The ID to check for
 * @returns true if an entity with the ID exists, false otherwise
 *
 * @example
 * ```typescript
 * const items: OrderItem[] = [
 *   { id: itemId1, productId: "prod-1", quantity: 2 }
 * ];
 *
 * hasEntityId(items, itemId1); // true
 * hasEntityId(items, itemId2); // false
 * ```
 */
export function hasEntityId<
	TId extends Id<string>,
	T extends Identifiable<TId>,
>(entities: ReadonlyArray<T>, id: TId): boolean {
	return entities.some((entity) => entity.id === id);
}

/**
 * Removes an entity with the given ID from the collection. Returns the
 * ORIGINAL array when the id is absent (structural sharing for the
 * reference-based dirty tracking; see `updateEntityById`), otherwise a
 * new array without the entity.
 *
 * @param entities - Array of entities
 * @param id - The ID of the entity to remove
 * @returns A new array without the entity with the given ID
 *
 * @example
 * ```typescript
 * const items: OrderItem[] = [
 *   { id: itemId1, productId: "prod-1", quantity: 2 },
 *   { id: itemId2, productId: "prod-2", quantity: 1 }
 * ];
 *
 * const updated = removeEntityById(items, itemId1);
 * // updated is [{ id: itemId2, productId: "prod-2", quantity: 1 }]
 * ```
 */
export function removeEntityById<
	TId extends Id<string>,
	T extends Identifiable<TId>,
>(entities: ReadonlyArray<T>, id: TId): ReadonlyArray<T> {
	const filtered = entities.filter((entity) => entity.id !== id);
	return filtered.length === entities.length ? entities : filtered;
}

/**
 * Updates an entity with the given ID in the collection.
 * Returns a new array with the updated entity.
 * Structural sharing for adapter-owned persistence projections: returns
 * the ORIGINAL array when nothing changed (no match, or the element kept
 * its reference), so a partial-write adapter can skip the untouched
 * collection; a new array only when an
 * element reference actually changed. The result is `ReadonlyArray<T>`:
 * it may BE the (possibly frozen) input; spread it if you need a mutable
 * copy.
 *
 * @param entities - Array of entities
 * @param id - The ID of the entity to update
 * @param updater - Function that takes the entity and returns the updated entity
 * @returns A new array with the updated entity
 *
 * @example
 * ```typescript
 * const items: OrderItem[] = [
 *   { id: itemId1, productId: "prod-1", quantity: 2 }
 * ];
 *
 * const updated = updateEntityById(items, itemId1, (item) => ({
 *   ...item,
 *   quantity: item.quantity + 1
 * }));
 * // updated is [{ id: itemId1, productId: "prod-1", quantity: 3 }]
 * ```
 */
export function updateEntityById<
	TId extends Id<string>,
	T extends Identifiable<TId>,
>(
	entities: ReadonlyArray<T>,
	id: TId,
	updater: (entity: T) => T,
): ReadonlyArray<T> {
	let changed = false;
	const mapped = entities.map((entity) => {
		if (entity.id !== id) return entity;
		const next = updater(entity);
		if (next !== entity) changed = true;
		return next;
	});
	return changed ? mapped : entities;
}

/**
 * Replaces an entity with the given ID in the collection.
 * Returns a new array with the replaced entity.
 * Structural sharing for adapter-owned persistence projections: returns
 * the ORIGINAL array when nothing changed (no match, or the element kept
 * its reference), so a partial-write adapter can skip the untouched
 * collection; a new array only when an
 * element reference actually changed. The result is `ReadonlyArray<T>`:
 * it may BE the (possibly frozen) input; spread it if you need a mutable
 * copy.
 *
 * @param entities - Array of entities
 * @param id - The ID of the entity to replace
 * @param replacement - The replacement entity
 * @returns A new array with the replaced entity
 *
 * @example
 * ```typescript
 * const items: OrderItem[] = [
 *   { id: itemId1, productId: "prod-1", quantity: 2 }
 * ];
 *
 * const updated = replaceEntityById(items, itemId1, {
 *   id: itemId1,
 *   productId: "prod-1",
 *   quantity: 5
 * });
 * ```
 */
export function replaceEntityById<
	TId extends Id<string>,
	T extends Identifiable<TId>,
>(entities: ReadonlyArray<T>, id: TId, replacement: T): ReadonlyArray<T> {
	let changed = false;
	const mapped = entities.map((entity) => {
		if (entity.id !== id) return entity;
		if (replacement !== entity) changed = true;
		return replacement;
	});
	return changed ? mapped : entities;
}

/**
 * Extracts all IDs from a collection of entities.
 *
 * @param entities - Array of entities
 * @returns Array of entity IDs
 *
 * @example
 * ```typescript
 * const items: OrderItem[] = [
 *   { id: itemId1, productId: "prod-1", quantity: 2 },
 *   { id: itemId2, productId: "prod-2", quantity: 1 }
 * ];
 *
 * const ids = entityIds(items);
 * // ids is [itemId1, itemId2]
 * ```
 */
export function entityIds<TId extends Id<string>, T extends Identifiable<TId>>(
	entities: ReadonlyArray<T>,
): TId[] {
	return entities.map((entity) => entity.id);
}
