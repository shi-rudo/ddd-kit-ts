import { describe, expect, it } from "vitest";
import { Order, type OrderId } from "./order";
import type { ItemId } from "./order-item";

describe("Order with Entity Items", () => {
	it("should create an order and add items", () => {
		const order = Order.create("order-1" as OrderId, "customer-1");

		const itemId = order.addItem("product-1", 2, 10.0);

		expect(order.state.items).toHaveLength(1);
		expect(order.state.items[0].id).toBe(itemId);
		expect(order.state.items[0].state.productId).toBe("product-1");
		expect(order.state.items[0].state.quantity).toBe(2);
		expect(order.version).toBe(1);
	});

	it("should update item quantity using entity logic", () => {
		const order = Order.create("order-1" as OrderId, "customer-1");
		const itemId = order.addItem("product-1", 2, 10.0);

		order.updateItemQuantity(itemId, 5);

		const item = order.getItem(itemId);
		expect(item?.state.quantity).toBe(5);
		expect(order.version).toBe(2); // One for add, one for update
	});

	it("should calculate total using entity logic", () => {
		const order = Order.create("order-1" as OrderId, "customer-1");
		order.addItem("product-1", 2, 10.0); // 20.0
		order.addItem("product-2", 3, 5.0); // 15.0

		const total = order.calculateTotal();

		expect(total).toBe(35.0);
	});

	it("should validate item quantity through entity", () => {
		const order = Order.create("order-1" as OrderId, "customer-1");
		const itemId = order.addItem("product-1", 2, 10.0);

		expect(() => order.updateItemQuantity(itemId, 0)).toThrow(
			"Quantity must be greater than 0",
		);
		expect(() => order.updateItemQuantity(itemId, -1)).toThrow(
			"Quantity must be greater than 0",
		);
	});

	it("should remove items", () => {
		const order = Order.create("order-1" as OrderId, "customer-1");
		const itemId1 = order.addItem("product-1", 2, 10.0);
		const itemId2 = order.addItem("product-2", 3, 5.0);

		order.removeItem(itemId1);

		expect(order.state.items).toHaveLength(1);
		expect(order.state.items[0].id).toBe(itemId2);
	});

	it("should enforce aggregate invariants on confirm", () => {
		const order = Order.create("order-1" as OrderId, "customer-1");

		expect(() => order.confirm()).toThrow(
			"Cannot confirm an order without items",
		);

		order.addItem("product-1", 2, 10.0);
		order.confirm();

		expect(order.state.status).toBe("confirmed");
	});

	it("should prevent modifications after confirmation", () => {
		const order = Order.create("order-1" as OrderId, "customer-1");
		const itemId = order.addItem("product-1", 2, 10.0);
		order.confirm();

		expect(() => order.addItem("product-2", 1, 5.0)).toThrow(
			"Cannot add items to a non-pending order",
		);
		expect(() => order.updateItemQuantity(itemId, 5)).toThrow(
			"Cannot modify items in a non-pending order",
		);
		expect(() => order.removeItem(itemId)).toThrow(
			"Cannot remove items from a non-pending order",
		);
	});

	it("should use entity methods for business logic", () => {
		const order = Order.create("order-1" as OrderId, "customer-1");
		const itemId = order.addItem("product-1", 2, 10.0);

		const item = order.getItem(itemId);
		expect(item).toBeDefined();
		expect(item?.calculateSubtotal()).toBe(20.0);
		expect(item?.isForProduct("product-1")).toBe(true);
		expect(item?.isForProduct("product-2")).toBe(false);
	});

	it("should version the aggregate on each change", () => {
		const order = Order.create("order-1" as OrderId, "customer-1");
		expect(order.version).toBe(0);

		const itemId = order.addItem("product-1", 2, 10.0);
		expect(order.version).toBe(1);

		order.updateItemQuantity(itemId, 3);
		expect(order.version).toBe(2);

		order.confirm();
		expect(order.version).toBe(3);

		order.ship();
		expect(order.version).toBe(4);
	});
});
