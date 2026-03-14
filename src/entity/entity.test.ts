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

// Functional usage (simple data, no logic)
type OrderItem = Identifiable<ItemId> & {
	productId: string;
	quantity: number;
};

// Class-based usage (with state and logic)
type OrderItemState = {
	productId: string;
	quantity: number;
};

class OrderItemEntity extends Entity<OrderItemState, ItemId> {
	constructor(id: ItemId, productId: string, quantity: number) {
		const initialState: OrderItemState = { productId, quantity };
		super(id, initialState);
	}

	updateQuantity(newQuantity: number): void {
		this._state = { ...this._state, quantity: newQuantity };
	}

	protected validateState(state: OrderItemState): void {
		if (state.quantity < 0) {
			throw new Error("Quantity cannot be negative");
		}
	}
}

describe("Entity", () => {
	describe("Functional Pattern (Identifiable)", () => {
		it("should define entity with id", () => {
			const item: OrderItem = {
				id: "item-1" as ItemId,
				productId: "prod-1",
				quantity: 2,
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
				};
				const item2: OrderItem = {
					id: "item-1" as ItemId,
					productId: "prod-2",
					quantity: 5,
				};

				expect(sameEntity(item1, item2)).toBe(true);
			});

			it("should return false for entities with different IDs", () => {
				const item1: OrderItem = {
					id: "item-1" as ItemId,
					productId: "prod-1",
					quantity: 2,
				};
				const item2: OrderItem = {
					id: "item-2" as ItemId,
					productId: "prod-1",
					quantity: 2,
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
					},
					{
						id: "item-2" as ItemId,
						productId: "prod-2",
						quantity: 5,
					},
				];

				const found = findEntityById(items, "item-1" as ItemId);

				expect(found).toBeDefined();
				expect(found?.id).toBe("item-1");
			});
		});
	});

	describe("Class-based Pattern (Entity with State)", () => {
		it("should create entity with id and state", () => {
			const entity = new OrderItemEntity("id-1" as ItemId, "prod-1", 2);

			expect(entity.id).toBe("id-1");
			expect(entity.state.productId).toBe("prod-1");
			expect(entity.state.quantity).toBe(2);
		});

		it("should allow state mutations through methods", () => {
			const entity = new OrderItemEntity("id-1" as ItemId, "prod-1", 2);

			entity.updateQuantity(5);

			expect(entity.state.quantity).toBe(5);
		});

		it("should enforce entity equality by ID using sameEntity()", () => {
			const e1 = new OrderItemEntity("id-1" as ItemId, "prod-1", 1);
			const e2 = new OrderItemEntity("id-1" as ItemId, "prod-2", 2);
			const e3 = new OrderItemEntity("id-2" as ItemId, "prod-1", 1);

			expect(sameEntity(e1, e2)).toBe(true); // Same ID
			expect(sameEntity(e1, e3)).toBe(false); // Different ID
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

		it("should call validateState during construction", () => {
			expect(() => new OrderItemEntity("id-1" as ItemId, "prod-1", -5)).toThrow(
				"Quantity cannot be negative",
			);
		});

		it("should have readonly state from outside", () => {
			const entity = new OrderItemEntity("id-1" as ItemId, "prod-1", 2);
			const state = entity.state;

			// TypeScript prevents: state.quantity = 10;
			// But we can verify state is returned
			expect(state.quantity).toBe(2);
		});
	});

	describe("Helper functions compatibility", () => {
		it("should work with class instances", () => {
			const e1 = new OrderItemEntity("id-1" as ItemId, "prod-1", 1);
			const e2 = new OrderItemEntity("id-2" as ItemId, "prod-2", 2);
			const entities = [e1, e2];

			const found = findEntityById(entities, "id-1" as ItemId);
			expect(found).toBe(e1);

			const hasId = hasEntityId(entities, "id-1" as ItemId);
			expect(hasId).toBe(true);

			const ids = entityIds(entities);
			expect(ids).toEqual(["id-1", "id-2"]);

			const updated = updateEntityById(entities, "id-1" as ItemId, (e) => {
				e.updateQuantity(5);
				return e;
			});
			expect(updated[0]!.state.quantity).toBe(5);

			const removed = removeEntityById(entities, "id-1" as ItemId);
			expect(removed).toHaveLength(1);
			expect(removed[0]!.id).toBe("id-2");
		});
	});
});
