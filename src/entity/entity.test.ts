import { describe, expect, it } from "vitest";
import type { Id } from "../core/id";
import {
	entityIds,
	findEntityById,
	hasEntityId,
	removeEntityById,
	replaceEntityById,
	sameEntity,
	type Entity,
	updateEntityById,
} from "./entity";

type ItemId = Id<"ItemId">;
type OrderItem = Entity<ItemId> & {
	productId: string;
	quantity: number;
	price: number;
};

describe("Entity", () => {
	describe("Entity interface", () => {
		it("should define entity with id", () => {
			const item: OrderItem = {
				id: "item-1" as ItemId,
				productId: "prod-1",
				quantity: 2,
				price: 10.99,
			};

			expect(item.id).toBe("item-1");
			expect(item.productId).toBe("prod-1");
		});
	});

	describe("sameEntity()", () => {
		it("should return true for entities with same ID", () => {
			const item1: OrderItem = {
				id: "item-1" as ItemId,
				productId: "prod-1",
				quantity: 2,
				price: 10.99,
			};
			const item2: OrderItem = {
				id: "item-1" as ItemId,
				productId: "prod-2",
				quantity: 3,
				price: 20.99,
			};

			expect(sameEntity(item1, item2)).toBe(true);
		});

		it("should return false for entities with different IDs", () => {
			const item1: OrderItem = {
				id: "item-1" as ItemId,
				productId: "prod-1",
				quantity: 2,
				price: 10.99,
			};
			const item2: OrderItem = {
				id: "item-2" as ItemId,
				productId: "prod-1",
				quantity: 2,
				price: 10.99,
			};

			expect(sameEntity(item1, item2)).toBe(false);
		});

		it("should work with any object that has id property", () => {
			const obj1 = { id: "id-1", name: "test" };
			const obj2 = { id: "id-1", name: "different" };
			const obj3 = { id: "id-2", name: "test" };

			expect(sameEntity(obj1, obj2)).toBe(true);
			expect(sameEntity(obj1, obj3)).toBe(false);
		});
	});

	describe("findEntityById()", () => {
		it("should find entity by ID", () => {
			const items: OrderItem[] = [
				{
					id: "item-1" as ItemId,
					productId: "prod-1",
					quantity: 2,
					price: 10.99,
				},
				{
					id: "item-2" as ItemId,
					productId: "prod-2",
					quantity: 1,
					price: 20.99,
				},
			];

			const found = findEntityById(items, "item-1" as ItemId);

			expect(found).toBeDefined();
			expect(found?.id).toBe("item-1");
			expect(found?.productId).toBe("prod-1");
		});

		it("should return undefined if entity not found", () => {
			const items: OrderItem[] = [
				{
					id: "item-1" as ItemId,
					productId: "prod-1",
					quantity: 2,
					price: 10.99,
				},
			];

			const found = findEntityById(items, "item-999" as ItemId);

			expect(found).toBeUndefined();
		});

		it("should work with empty array", () => {
			const items: OrderItem[] = [];

			const found = findEntityById(items, "item-1" as ItemId);

			expect(found).toBeUndefined();
		});
	});

	describe("hasEntityId()", () => {
		it("should return true if entity exists", () => {
			const items: OrderItem[] = [
				{
					id: "item-1" as ItemId,
					productId: "prod-1",
					quantity: 2,
					price: 10.99,
				},
			];

			expect(hasEntityId(items, "item-1" as ItemId)).toBe(true);
		});

		it("should return false if entity does not exist", () => {
			const items: OrderItem[] = [
				{
					id: "item-1" as ItemId,
					productId: "prod-1",
					quantity: 2,
					price: 10.99,
				},
			];

			expect(hasEntityId(items, "item-999" as ItemId)).toBe(false);
		});

		it("should work with empty array", () => {
			const items: OrderItem[] = [];

			expect(hasEntityId(items, "item-1" as ItemId)).toBe(false);
		});
	});

	describe("removeEntityById()", () => {
		it("should remove entity by ID", () => {
			const items: OrderItem[] = [
				{
					id: "item-1" as ItemId,
					productId: "prod-1",
					quantity: 2,
					price: 10.99,
				},
				{
					id: "item-2" as ItemId,
					productId: "prod-2",
					quantity: 1,
					price: 20.99,
				},
			];

			const updated = removeEntityById(items, "item-1" as ItemId);

			expect(updated).toHaveLength(1);
			expect(updated[0]?.id).toBe("item-2");
			expect(items).toHaveLength(2); // Original unchanged
		});

		it("should return original array if entity not found", () => {
			const items: OrderItem[] = [
				{
					id: "item-1" as ItemId,
					productId: "prod-1",
					quantity: 2,
					price: 10.99,
				},
			];

			const updated = removeEntityById(items, "item-999" as ItemId);

			expect(updated).toEqual(items);
			expect(updated).toHaveLength(1);
		});

		it("should work with empty array", () => {
			const items: OrderItem[] = [];

			const updated = removeEntityById(items, "item-1" as ItemId);

			expect(updated).toEqual([]);
		});
	});

	describe("updateEntityById()", () => {
		it("should update entity by ID", () => {
			const items: OrderItem[] = [
				{
					id: "item-1" as ItemId,
					productId: "prod-1",
					quantity: 2,
					price: 10.99,
				},
				{
					id: "item-2" as ItemId,
					productId: "prod-2",
					quantity: 1,
					price: 20.99,
				},
			];

			const updated = updateEntityById(items, "item-1" as ItemId, (item) => ({
				...item,
				quantity: item.quantity + 1,
			}));

			expect(updated[0]?.quantity).toBe(3);
			expect(updated[1]?.quantity).toBe(1); // Unchanged
			expect(items[0]?.quantity).toBe(2); // Original unchanged
		});

		it("should return original array if entity not found", () => {
			const items: OrderItem[] = [
				{
					id: "item-1" as ItemId,
					productId: "prod-1",
					quantity: 2,
					price: 10.99,
				},
			];

			const updated = updateEntityById(items, "item-999" as ItemId, (item) => ({
				...item,
				quantity: 999,
			}));

			expect(updated).toEqual(items);
		});
	});

	describe("replaceEntityById()", () => {
		it("should replace entity by ID", () => {
			const items: OrderItem[] = [
				{
					id: "item-1" as ItemId,
					productId: "prod-1",
					quantity: 2,
					price: 10.99,
				},
				{
					id: "item-2" as ItemId,
					productId: "prod-2",
					quantity: 1,
					price: 20.99,
				},
			];

			const replacement: OrderItem = {
				id: "item-1" as ItemId,
				productId: "prod-1-updated",
				quantity: 5,
				price: 15.99,
			};

			const updated = replaceEntityById(items, "item-1" as ItemId, replacement);

			expect(updated[0]).toEqual(replacement);
			expect(updated[1]).toEqual(items[1]); // Unchanged
			expect(items[0]).not.toEqual(replacement); // Original unchanged
		});

		it("should return original array if entity not found", () => {
			const items: OrderItem[] = [
				{
					id: "item-1" as ItemId,
					productId: "prod-1",
					quantity: 2,
					price: 10.99,
				},
			];

			const replacement: OrderItem = {
				id: "item-999" as ItemId,
				productId: "prod-999",
				quantity: 999,
				price: 99.99,
			};

			const updated = replaceEntityById(items, "item-999" as ItemId, replacement);

			expect(updated).toEqual(items);
		});
	});

	describe("entityIds()", () => {
		it("should extract all IDs from entities", () => {
			const items: OrderItem[] = [
				{
					id: "item-1" as ItemId,
					productId: "prod-1",
					quantity: 2,
					price: 10.99,
				},
				{
					id: "item-2" as ItemId,
					productId: "prod-2",
					quantity: 1,
					price: 20.99,
				},
			];

			const ids = entityIds(items);

			expect(ids).toEqual(["item-1", "item-2"]);
		});

		it("should return empty array for empty collection", () => {
			const items: OrderItem[] = [];

			const ids = entityIds(items);

			expect(ids).toEqual([]);
		});

		it("should work with any object that has id property", () => {
			const objects = [
				{ id: "id-1", name: "test1" },
				{ id: "id-2", name: "test2" },
			];

			const ids = entityIds(objects);

			expect(ids).toEqual(["id-1", "id-2"]);
		});
	});

	describe("Type safety", () => {
		it("should preserve entity types", () => {
			const items: OrderItem[] = [
				{
					id: "item-1" as ItemId,
					productId: "prod-1",
					quantity: 2,
					price: 10.99,
				},
			];

			const found = findEntityById(items, "item-1" as ItemId);

			expect(found).toBeDefined();
			expect(found?.productId).toBe("prod-1");
			expect(found?.quantity).toBe(2);
		});
	});
});

