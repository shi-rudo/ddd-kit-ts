/**
 * Entity utilities and interfaces for Domain-Driven Design.
 *
 * In Domain-Driven Design, there are two types of entities:
 *
 * 1. **Aggregate Root Entity**: The parent Entity of an aggregate.
 *    - Has identity (id), state, and version
 *    - Implemented by classes extending `AggregateRoot` or `EventSourcedAggregate`
 *    - Represents the aggregate externally
 *    - Loaded/saved through repositories
 *
 * 2. **Child Entities**: Entities within an aggregate.
 *    - Have identity (id) and state, but no own version
 *    - Can extend `EntityBase<TState, TId>` for class-based entities
 *    - Or use functional style with `Identifiable<TId> & TProps`
 *    - Exist only within the aggregate boundary
 *    - Versioned through the Aggregate Root
 *    - Cannot be referenced directly from outside the aggregate
 *
 * This module provides:
 * - `EntityBase<TState, TId>` - Base class for entities with state
 * - `Entity<TId>` - Simple class for entities without state management
 * - `Identifiable<TId>` - Minimal interface for objects with id
 * - Helper functions for working with collections of entities
 *
 * @example
 * ```typescript
 * // Class-based child entity with logic
 * class OrderItem extends EntityBase<OrderItemState, ItemId> {
 *   constructor(id: ItemId, initialState: OrderItemState) {
 *     super(id, initialState);
 *   }
 *
 *   updateQuantity(quantity: number): void {
 *     this._state = { ...this._state, quantity };
 *   }
 *
 *   calculateSubtotal(): number {
 *     return this._state.price * this._state.quantity;
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
 * class Order extends AggregateRoot<OrderState, OrderId> {
 *   // Order is an Aggregate Root Entity
 *   // OrderState contains OrderItem child entities
 * }
 * ```
 */
import { deepEqual } from "../utils/array/deep-equal";

import type { Id } from "../core/id";

/**
 * Functional definition of an Entity via its capability.
 * An object is identifiable if it has an id.
 */
export type Identifiable<TId> = {
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
 * @template TState - The type of the entity state
 */
export interface IEntity<TId extends Id<string>, TState> extends Identifiable<TId> {
	/**
	 * Unique identifier of the entity.
	 */
	readonly id: TId;

	/**
	 * The current state of the entity.
	 */
	readonly state: TState;
}

/**
 * Abstract base class for Entities with state.
 *
 * Provides:
 * - Identity management (id)
 * - State management
 * - State validation hook
 * - Immutable state access through getter
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
 * class OrderItem extends Entity<OrderItemState, ItemId> {
 *   constructor(id: ItemId, initialState: OrderItemState) {
 *     super(id, initialState);
 *   }
 *
 *   updateQuantity(quantity: number): void {
 *     this._state = { ...this._state, quantity };
 *   }
 * }
 * ```
 */
export abstract class Entity<TState, TId extends Id<string>>
	implements IEntity<TId, TState> {
	public readonly id: TId;

	/**
	 * Returns the current state of the entity.
	 * State is readonly from outside to enforce encapsulation.
	 */
	public get state(): TState {
		return this._state;
	}

	/**
	 * The state is 'protected' so that only the subclass can modify it.
	 * Subclasses can mutate this directly or use helper methods.
	 */
	protected _state: TState;

	protected constructor(id: TId, initialState: TState) {
		if (id === null || id === undefined) {
			throw new Error("Entity ID cannot be null or undefined");
		}
		this.id = id;
		this._state = initialState;
		this.validateState(this._state);
	}

	/**
	 * Optional validation hook to ensure state invariants.
	 * Called during construction and whenever helpful.
	 * Override this method to implement validation logic.
	 *
	 * @param state - The state to validate
	 * @throws Error if validation fails
	 */
	protected validateState(_state: TState): void {
		// Default implementation does nothing
	}

	/**
	 * Sets the state of the entity.
	 * This is a convenience method for state mutations.
	 * Automatically validates the newState using `validateState()`.
	 *
	 * @param newState - The new state
	 */
	protected setState(newState: TState): void {
		this.validateState(newState);
		this._state = newState;
	}
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
export function sameEntity<TId>(a: Identifiable<TId>, b: Identifiable<TId>): boolean {
	return deepEqual(a.id, b.id);
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
export function findEntityById<TId, T extends Identifiable<TId>>(
	entities: T[],
	id: TId,
): T | undefined {
	return entities.find((entity) => deepEqual(entity.id, id));
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
export function hasEntityId<TId, T extends Identifiable<TId>>(
	entities: T[],
	id: TId,
): boolean {
	return entities.some((entity) => deepEqual(entity.id, id));
}

/**
 * Removes an entity with the given ID from the collection.
 * Returns a new array without the entity.
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
export function removeEntityById<TId, T extends Identifiable<TId>>(
	entities: T[],
	id: TId,
): T[] {
	return entities.filter((entity) => !deepEqual(entity.id, id));
}

/**
 * Updates an entity with the given ID in the collection.
 * Returns a new array with the updated entity.
 * If the entity is not found, returns the original array unchanged.
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
export function updateEntityById<TId, T extends Identifiable<TId>>(
	entities: T[],
	id: TId,
	updater: (entity: T) => T,
): T[] {
	return entities.map((entity) => (deepEqual(entity.id, id) ? updater(entity) : entity));
}

/**
 * Replaces an entity with the given ID in the collection.
 * Returns a new array with the replaced entity.
 * If the entity is not found, returns the original array unchanged.
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
export function replaceEntityById<TId, T extends Identifiable<TId>>(
	entities: T[],
	id: TId,
	replacement: T,
): T[] {
	return entities.map((entity) => (deepEqual(entity.id, id) ? replacement : entity));
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
export function entityIds<TId, T extends Identifiable<TId>>(entities: T[]): TId[] {
	return entities.map((entity) => entity.id);
}

