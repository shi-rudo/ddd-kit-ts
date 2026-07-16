import { describe, expect, it } from "vite-plus/test";
import { type Money, moneyOfMinor } from "../../src/money";
import { Order, type OrderId } from "./order";

const eur = (minor: bigint): Money => moneyOfMinor(minor, "EUR", 2);

describe("Order Aggregate (without Event Sourcing)", () => {
	it("should create an order", () => {
		const orderId = "order-123" as OrderId;
		const order = Order.create(orderId, "customer-456", eur(0n));

		expect(order.id).toBe(orderId);
		expect(order.customerId).toBe("customer-456");
		expect(order.status).toBe("pending");
		expect(order.itemCount).toBe(0);
		expect(order.total).toEqual(eur(0n));
		expect(order.version).toBe(0);
	});

	it("should add items to order", () => {
		const order = Order.create("order-123" as OrderId, "customer-456", eur(0n));

		order.addItem("product-1", 2, eur(2000n));
		order.addItem("product-2", 1, eur(500n));

		expect(order.itemCount).toBe(2);
		expect(order.total).toEqual(eur(2500n));
		expect(order.version).toBe(2);
	});

	it("should confirm order", () => {
		const order = Order.create("order-123" as OrderId, "customer-456", eur(0n));
		order.addItem("product-1", 1, eur(1000n));

		order.confirm();

		expect(order.status).toBe("confirmed");
		expect(order.version).toBe(2); // 1 for addItem, 1 for confirm
	});

	it("should not allow confirming empty order", () => {
		const order = Order.create("order-123" as OrderId, "customer-456", eur(0n));

		expect(() => order.confirm()).toThrow(
			"Cannot confirm an order without items",
		);
	});

	it("should ship confirmed order", () => {
		const order = Order.create("order-123" as OrderId, "customer-456", eur(0n));
		order.addItem("product-1", 1, eur(1000n));
		order.confirm();

		order.ship();

		expect(order.status).toBe("shipped");
		expect(order.version).toBe(3);
	});

	it("should not allow shipping non-confirmed order", () => {
		const order = Order.create("order-123" as OrderId, "customer-456", eur(0n));
		order.addItem("product-1", 1, eur(1000n));

		expect(() => order.ship()).toThrow("Only confirmed orders can be shipped");
	});

	it("should cancel pending order", () => {
		const order = Order.create("order-123" as OrderId, "customer-456", eur(0n));
		order.addItem("product-1", 1, eur(1000n));

		order.cancel();

		expect(order.status).toBe("cancelled");
	});

	it("should not allow cancelling shipped order", () => {
		const order = Order.create("order-123" as OrderId, "customer-456", eur(0n));
		order.addItem("product-1", 1, eur(1000n));
		order.confirm();
		order.ship();

		expect(() => order.cancel()).toThrow("Cannot cancel a shipped order");
	});

	it("should create snapshot", () => {
		const order = Order.create("order-123" as OrderId, "customer-456", eur(0n));
		order.addItem("product-1", 2, eur(2000n));
		order.confirm();

		const snapshot = order.createSnapshot();

		expect(snapshot.state.status).toBe("confirmed");
		expect(snapshot.state.total).toEqual(eur(2000n));
		expect(snapshot.version).toBe(2);
		expect(snapshot.snapshotAt).toBeInstanceOf(Date);
	});

	it("should restore from snapshot", () => {
		const order1 = Order.create(
			"order-123" as OrderId,
			"customer-456",
			eur(0n),
		);
		order1.addItem("product-1", 2, eur(2000n));
		order1.confirm();

		const snapshot = order1.createSnapshot();

		const order2 = Order.create(
			"order-123" as OrderId,
			"customer-456",
			eur(0n),
		);
		order2.restoreFromSnapshot(snapshot);

		expect(order2.status).toBe("confirmed");
		expect(order2.total).toEqual(eur(2000n));
		expect(order2.version).toBe(2);
	});
});
