import { describe, expect, it } from "vitest";
import type { Id } from "../core/id";
import {
	Entity,
	entityIds,
	findEntityById,
	hasEntityId,
	removeEntityById,
	replaceEntityById,
	sameEntity,
	type Identifiable,
	updateEntityById,
} from "./entity";

type ItemId = Id<"ItemId">;

// Functional usage
type OrderItem = Identifiable<ItemId> & {
	productId: string;
	quantity: number;
	price: number;
};

// OOP usage
class OrderItemEntity extends Entity<ItemId> {
	constructor(id: ItemId, public productId: string, public quantity: number) {
		super(id);
	}
}

describe("Entity", () => {
	describe("Functional Pattern (Identifiable)", () => {
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
			});
		});
	});

	describe("Abstract Pattern (Entity Class)", () => {
		it("should enforce equality by ID", () => {
			const e1 = new OrderItemEntity("id-1" as ItemId, "prod-1", 1);
			const e2 = new OrderItemEntity("id-1" as ItemId, "prod-2", 2);
			const e3 = new OrderItemEntity("id-2" as ItemId, "prod-1", 1);

			expect(e1.equals(e2)).toBe(true);
			expect(e1.equals(e3)).toBe(false);
		});

		it("should return false for non-entities and null", () => {
			const e1 = new OrderItemEntity("id-1" as ItemId, "prod-1", 1);
			// @ts-expect-error - testing null safety
			expect(e1.equals(null)).toBe(false);
			// @ts-expect-error - testing undefined safety
			expect(e1.equals(undefined)).toBe(false);
		});

		it("should return true for same instance", () => {
			const e1 = new OrderItemEntity("id-1" as ItemId, "prod-1", 1);
			expect(e1.equals(e1)).toBe(true);
		});

		it("should throw if ID is null or undefined", () => {
			// @ts-expect-error - testing invalid input
			expect(() => new OrderItemEntity(null, "p1", 1)).toThrow(
				"Entity ID cannot be null or undefined",
			);
			// @ts-expect-error - testing invalid input
			expect(() => new OrderItemEntity(undefined, "p1", 1)).toThrow(
				"Entity ID cannot be null or undefined",
			);
		});

		it("should call validate during construction", () => {
			class ValidatedEntity extends Entity<ItemId> {
				constructor(id: ItemId) {
					super(id);
				}
				protected validate(): void {
					throw new Error("Validation failed");
				}
			}

			expect(() => new ValidatedEntity("id-1" as ItemId)).toThrow(
				"Validation failed",
			);
		});

		it("should check toJSON serialization", () => {
			const e1 = new OrderItemEntity("id-1" as ItemId, "prod-1", 1);
			const json = JSON.parse(JSON.stringify(e1));

			expect(json).toEqual({
				id: "id-1",
				productId: "prod-1",
				quantity: 1
			});
		});
	});

	// Helper functions should work with both
	describe("Helper functions compatibility", () => {
		it("should work with class instances", () => {
			const e1 = new OrderItemEntity("id-1" as ItemId, "prod-1", 1);
			const e2 = new OrderItemEntity("id-2" as ItemId, "prod-2", 2);
			const list = [e1, e2];

			expect(hasEntityId(list, "id-1" as ItemId)).toBe(true);
			expect(findEntityById(list, "id-1" as ItemId)).toEqual(e1);

			const ids = entityIds(list);
			expect(ids).toEqual(["id-1", "id-2"]);
		});
	});
});


