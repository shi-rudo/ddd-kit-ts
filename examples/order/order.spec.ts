import { describe, expect, it } from "vite-plus/test";
import {
	type Money,
	moneyOfMinor,
	moneyToSnapshot,
} from "../../src/domain/value-object/money";
import {
	captureAggregateSnapshot,
	reconstituteAggregateFromSnapshot,
} from "../../src/persistence/snapshot-store/snapshot-model";
import {
	type CustomerId,
	EmptyOrderError,
	Order,
	type OrderId,
	OrderInWrongStateError,
	type ProductId,
} from "./order";
import { orderSnapshotModel } from "./order-snapshot-model";

const eur = (minor: bigint): Money => moneyOfMinor(minor, "EUR", 2);
const orderId = "order-123" as OrderId;
const customerId = "customer-456" as CustomerId;
const product1 = "product-1" as ProductId;
const product2 = "product-2" as ProductId;

describe("Order Aggregate (without Event Sourcing)", () => {
	it("should create an order", () => {
		const order = Order.create(orderId, customerId, eur(0n));

		expect(order.id).toBe(orderId);
		expect(order.customerId).toBe(customerId);
		expect(order.status).toBe("pending");
		expect(order.itemCount).toBe(0);
		expect(order.total).toEqual(eur(0n));
		expect(order.version).toBe(0);
	});

	it("should add items to order", () => {
		const order = Order.create(orderId, customerId, eur(0n));

		order.addItem(product1, 2, eur(2000n));
		order.addItem(product2, 1, eur(500n));

		expect(order.itemCount).toBe(2);
		expect(order.total).toEqual(eur(2500n));
		expect(order.version).toBe(2);
	});

	it("should confirm order", () => {
		const order = Order.create(orderId, customerId, eur(0n));
		order.addItem(product1, 1, eur(1000n));

		order.confirm();

		expect(order.status).toBe("confirmed");
		expect(order.version).toBe(2); // 1 for addItem, 1 for confirm
	});

	it("should not allow confirming empty order", () => {
		const order = Order.create(orderId, customerId, eur(0n));

		expect(() => order.confirm()).toThrow(EmptyOrderError);
	});

	it("should ship confirmed order", () => {
		const order = Order.create(orderId, customerId, eur(0n));
		order.addItem(product1, 1, eur(1000n));
		order.confirm();

		order.ship();

		expect(order.status).toBe("shipped");
		expect(order.version).toBe(3);
	});

	it("should not allow shipping non-confirmed order", () => {
		const order = Order.create(orderId, customerId, eur(0n));
		order.addItem(product1, 1, eur(1000n));

		expect(() => order.ship()).toThrow(OrderInWrongStateError);
	});

	it("should cancel pending order", () => {
		const order = Order.create(orderId, customerId, eur(0n));
		order.addItem(product1, 1, eur(1000n));

		order.cancel();

		expect(order.status).toBe("cancelled");
	});

	it("should not allow cancelling shipped order", () => {
		const order = Order.create(orderId, customerId, eur(0n));
		order.addItem(product1, 1, eur(1000n));
		order.confirm();
		order.ship();

		expect(() => order.cancel()).toThrow(OrderInWrongStateError);
	});

	it("should create snapshot", () => {
		const order = Order.create(orderId, customerId, eur(0n));
		order.addItem(product1, 2, eur(2000n));
		order.confirm();

		const snapshotAt = new Date("2027-04-05T06:07:08.000Z");
		const snapshot = captureAggregateSnapshot(
			orderSnapshotModel,
			order,
			snapshotAt,
		);

		expect(snapshot.state.status).toBe("confirmed");
		expect(snapshot.state.total).toEqual(moneyToSnapshot(eur(2000n)));
		expect(snapshot.version).toBe(2);
		expect(snapshot.snapshotAt).toEqual(snapshotAt);
		expect(snapshot.snapshotAt).not.toBe(snapshotAt);
		// The stored DTO must survive a JSON-backed snapshot store: raw Money
		// carries a bigint and would throw here.
		expect(JSON.parse(JSON.stringify(snapshot.state))).toEqual(snapshot.state);
	});

	it("should restore from snapshot", () => {
		const order1 = Order.create(orderId, customerId, eur(0n));
		order1.addItem(product1, 2, eur(2000n));
		order1.confirm();

		const snapshot = captureAggregateSnapshot(
			orderSnapshotModel,
			order1,
			new Date("2027-04-05T06:07:08.000Z"),
		);

		const order2 = reconstituteAggregateFromSnapshot(
			orderSnapshotModel,
			orderId,
			snapshot,
		);

		expect(order2.status).toBe("confirmed");
		expect(order2.total).toEqual(eur(2000n));
		expect(order2.version).toBe(2);
	});
});
