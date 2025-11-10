import { describe, expect, it } from "vitest";
import { Order, type OrderId } from "./order";

describe("Order Aggregate (without Event Sourcing)", () => {
	it("should create an order", () => {
		const orderId = "order-123" as OrderId;
		const order = Order.create(orderId, "customer-456");

		expect(order.id).toBe(orderId);
		expect(order.state.customerId).toBe("customer-456");
		expect(order.state.status).toBe("pending");
		expect(order.state.items).toHaveLength(0);
		expect(order.state.total).toBe(0);
		expect(order.version).toBe(0);
	});

	it("should add items to order", () => {
		const order = Order.create("order-123" as OrderId, "customer-456");

		order.addItem("product-1", 2, 10.0);
		order.addItem("product-2", 1, 5.0);

		expect(order.state.items).toHaveLength(2);
		expect(order.state.total).toBe(25.0);
		expect(order.version).toBe(2);
	});

	it("should confirm order", () => {
		const order = Order.create("order-123" as OrderId, "customer-456");
		order.addItem("product-1", 1, 10.0);

		order.confirm();

		expect(order.state.status).toBe("confirmed");
		expect(order.version).toBe(2); // 1 for addItem, 1 for confirm
	});

	it("should not allow confirming empty order", () => {
		const order = Order.create("order-123" as OrderId, "customer-456");

		expect(() => order.confirm()).toThrow("Cannot confirm an order without items");
	});

	it("should ship confirmed order", () => {
		const order = Order.create("order-123" as OrderId, "customer-456");
		order.addItem("product-1", 1, 10.0);
		order.confirm();

		order.ship();

		expect(order.state.status).toBe("shipped");
		expect(order.version).toBe(3);
	});

	it("should not allow shipping non-confirmed order", () => {
		const order = Order.create("order-123" as OrderId, "customer-456");
		order.addItem("product-1", 1, 10.0);

		expect(() => order.ship()).toThrow("Only confirmed orders can be shipped");
	});

	it("should cancel pending order", () => {
		const order = Order.create("order-123" as OrderId, "customer-456");
		order.addItem("product-1", 1, 10.0);

		order.cancel();

		expect(order.state.status).toBe("cancelled");
	});

	it("should not allow cancelling shipped order", () => {
		const order = Order.create("order-123" as OrderId, "customer-456");
		order.addItem("product-1", 1, 10.0);
		order.confirm();
		order.ship();

		expect(() => order.cancel()).toThrow("Cannot cancel a shipped order");
	});

	it("should create snapshot", () => {
		const order = Order.create("order-123" as OrderId, "customer-456");
		order.addItem("product-1", 2, 10.0);
		order.confirm();

		const snapshot = order.createSnapshot();

		expect(snapshot.state.status).toBe("confirmed");
		expect(snapshot.state.total).toBe(20.0);
		expect(snapshot.version).toBe(2);
		expect(snapshot.snapshotAt).toBeInstanceOf(Date);
	});

	it("should restore from snapshot", () => {
		const order1 = Order.create("order-123" as OrderId, "customer-456");
		order1.addItem("product-1", 2, 10.0);
		order1.confirm();

		const snapshot = order1.createSnapshot();

		const order2 = Order.create("order-123" as OrderId, "customer-456");
		order2.restoreFromSnapshot(snapshot);

		expect(order2.state.status).toBe("confirmed");
		expect(order2.state.total).toBe(20.0);
		expect(order2.version).toBe(2);
	});
});

