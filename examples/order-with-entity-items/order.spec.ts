import { describe, expect, it } from "vitest";
import { type Money, moneyOfMinor } from "../../src/money";
import { Order, type OrderId } from "./order";

const eur = (minor: bigint): Money => moneyOfMinor(minor, "EUR", 2);

describe("Order with Entity Items", () => {
	it("should create an order and add items", () => {
		const order = Order.create("order-1" as OrderId, "customer-1");

		const itemId = order.addItem("product-1", 2, eur(2000n));

		expect(order.itemCount).toBe(1);
		expect(order.getItem(itemId)).toMatchObject({
			id: itemId,
			productId: "product-1",
			quantity: 2,
		});
		expect(order.version).toBe(1);
	});

	it("should update item quantity using entity logic", () => {
		const order = Order.create("order-1" as OrderId, "customer-1");
		const itemId = order.addItem("product-1", 2, eur(2000n));

		order.updateItemQuantity(itemId, 5, eur(5000n));

		const item = order.getItem(itemId);
		expect(item?.quantity).toBe(5);
		expect(item?.lineTotal).toEqual(eur(5000n));
		expect(order.version).toBe(2); // One for add, one for update
	});

	it("should calculate total using entity logic", () => {
		const order = Order.create("order-1" as OrderId, "customer-1");
		order.addItem("product-1", 2, eur(2000n)); // 2 x 10.00
		order.addItem("product-2", 3, eur(1500n)); // 3 x 5.00

		const total = order.calculateTotal();

		expect(total).toEqual(eur(3500n));
	});

	it("should have no total without items", () => {
		const order = Order.create("order-1" as OrderId, "customer-1");

		expect(order.calculateTotal()).toBeUndefined();
	});

	it("should validate item quantity through entity", () => {
		const order = Order.create("order-1" as OrderId, "customer-1");
		const itemId = order.addItem("product-1", 2, eur(2000n));

		expect(() => order.updateItemQuantity(itemId, 0, eur(0n))).toThrow(
			"Quantity must be greater than 0",
		);
		expect(() => order.updateItemQuantity(itemId, -1, eur(0n))).toThrow(
			"Quantity must be greater than 0",
		);
	});

	it("should remove items", () => {
		const order = Order.create("order-1" as OrderId, "customer-1");
		const itemId1 = order.addItem("product-1", 2, eur(2000n));
		const itemId2 = order.addItem("product-2", 3, eur(1500n));

		order.removeItem(itemId1);

		expect(order.itemCount).toBe(1);
		expect(order.getItem(itemId2)?.id).toBe(itemId2);
	});

	it("should enforce aggregate invariants on confirm", () => {
		const order = Order.create("order-1" as OrderId, "customer-1");

		expect(() => order.confirm()).toThrow(
			"Cannot confirm an order without items",
		);

		order.addItem("product-1", 2, eur(2000n));
		order.confirm();

		expect(order.status).toBe("confirmed");
	});

	it("should prevent modifications after confirmation", () => {
		const order = Order.create("order-1" as OrderId, "customer-1");
		const itemId = order.addItem("product-1", 2, eur(2000n));
		order.confirm();

		expect(() => order.addItem("product-2", 1, eur(500n))).toThrow(
			"Cannot add items to a non-pending order",
		);
		expect(() => order.updateItemQuantity(itemId, 5, eur(5000n))).toThrow(
			"Cannot modify items in a non-pending order",
		);
		expect(() => order.removeItem(itemId)).toThrow(
			"Cannot remove items from a non-pending order",
		);
	});

	it("should use entity methods for business logic", () => {
		const order = Order.create("order-1" as OrderId, "customer-1");
		const itemId = order.addItem("product-1", 2, eur(2000n));

		const item = order.getItem(itemId);
		expect(item).toBeDefined();
		expect(item?.lineTotal).toEqual(eur(2000n));
		expect(order.hasProduct(itemId, "product-1")).toBe(true);
		expect(order.hasProduct(itemId, "product-2")).toBe(false);
	});

	it("should version the aggregate on each change", () => {
		const order = Order.create("order-1" as OrderId, "customer-1");
		expect(order.version).toBe(0);

		const itemId = order.addItem("product-1", 2, eur(2000n));
		expect(order.version).toBe(1);

		order.updateItemQuantity(itemId, 3, eur(3000n));
		expect(order.version).toBe(2);

		order.confirm();
		expect(order.version).toBe(3);

		order.ship();
		expect(order.version).toBe(4);
	});
});
