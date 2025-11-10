/**
 * Optional interface for entities with identity.
 * Use this when you need explicit entity types for nested entities
 * within aggregates or for entities that are not aggregate roots.
 *
 * @template TId - The type of the entity identifier
 *
 * @example
 * ```typescript
 * type OrderItem = Entity<ItemId> & {
 *   productId: string;
 *   quantity: number;
 * };
 * ```
 */
export interface Entity<TId> {
	readonly id: TId;
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
export function sameEntity<TId>(a: { id: TId }, b: { id: TId }): boolean {
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
export function findEntityById<TId, T extends { id: TId }>(
	entities: T[],
	id: TId,
): T | undefined {
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
export function hasEntityId<TId, T extends { id: TId }>(
	entities: T[],
	id: TId,
): boolean {
	return entities.some((entity) => entity.id === id);
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
export function removeEntityById<TId, T extends { id: TId }>(
	entities: T[],
	id: TId,
): T[] {
	return entities.filter((entity) => entity.id !== id);
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
export function updateEntityById<TId, T extends { id: TId }>(
	entities: T[],
	id: TId,
	updater: (entity: T) => T,
): T[] {
	return entities.map((entity) => (entity.id === id ? updater(entity) : entity));
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
export function replaceEntityById<TId, T extends { id: TId }>(
	entities: T[],
	id: TId,
	replacement: T,
): T[] {
	return entities.map((entity) => (entity.id === id ? replacement : entity));
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
export function entityIds<TId, T extends { id: TId }>(entities: T[]): TId[] {
	return entities.map((entity) => entity.id);
}

