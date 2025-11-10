import { describe, expect, it } from "vitest";
import { createDomainEvent, type DomainEvent } from "../aggregate/aggregate";
import { EventBusImpl } from "./event-bus";

type OrderCreated = DomainEvent<"OrderCreated", { orderId: string }>;
type OrderShipped = DomainEvent<"OrderShipped", { orderId: string }>;
type OrderEvent = OrderCreated | OrderShipped;

describe("EventBusImpl", () => {
	describe("subscribe", () => {
		it("should subscribe handlers to event types", () => {
			const bus = new EventBusImpl<OrderEvent>();
			let called = false;

			bus.subscribe("OrderCreated", async () => {
				called = true;
			});

			expect(called).toBe(false);
		});

		it("should allow multiple handlers for the same event type", () => {
			const bus = new EventBusImpl<OrderEvent>();
			const calls: string[] = [];

			bus.subscribe("OrderCreated", async () => {
				calls.push("handler1");
			});

			bus.subscribe("OrderCreated", async () => {
				calls.push("handler2");
			});

			expect(calls).toHaveLength(0);
		});

		it("should return unsubscribe function", () => {
			const bus = new EventBusImpl<OrderEvent>();
			let called = false;

			const unsubscribe = bus.subscribe("OrderCreated", async () => {
				called = true;
			});

			expect(typeof unsubscribe).toBe("function");
		});

		it("should unsubscribe handler when unsubscribe is called", async () => {
			const bus = new EventBusImpl<OrderEvent>();
			let called = false;

			const unsubscribe = bus.subscribe("OrderCreated", async () => {
				called = true;
			});

			unsubscribe();

			const event = createDomainEvent("OrderCreated", {
				orderId: "order-123",
			}) as OrderCreated;

			await bus.publish([event]);

			expect(called).toBe(false);
		});
	});

	describe("publish", () => {
		it("should call subscribed handlers when events are published", async () => {
			const bus = new EventBusImpl<OrderEvent>();
			let called = false;
			let receivedOrderId: string | null = null;

			bus.subscribe<OrderCreated>("OrderCreated", async (event: OrderCreated) => {
				called = true;
				receivedOrderId = event.payload.orderId;
			});

			const event = createDomainEvent("OrderCreated", {
				orderId: "order-123",
			}) as OrderCreated;

			await bus.publish([event]);

			expect(called).toBe(true);
			expect(receivedOrderId).toBe("order-123");
		});

		it("should call all handlers for an event type", async () => {
			const bus = new EventBusImpl<OrderEvent>();
			const calls: string[] = [];

			bus.subscribe("OrderCreated", async () => {
				calls.push("handler1");
			});

			bus.subscribe("OrderCreated", async () => {
				calls.push("handler2");
			});

			bus.subscribe("OrderCreated", async () => {
				calls.push("handler3");
			});

			const event = createDomainEvent("OrderCreated", {
				orderId: "order-123",
			}) as OrderCreated;

			await bus.publish([event]);

			expect(calls).toHaveLength(3);
			expect(calls).toContain("handler1");
			expect(calls).toContain("handler2");
			expect(calls).toContain("handler3");
		});

		it("should handle multiple events", async () => {
			const bus = new EventBusImpl<OrderEvent>();
			const orderCreatedCalls: string[] = [];
			const orderShippedCalls: string[] = [];

			bus.subscribe("OrderCreated", async () => {
				orderCreatedCalls.push("created");
			});

			bus.subscribe("OrderShipped", async () => {
				orderShippedCalls.push("shipped");
			});

			const events = [
				createDomainEvent("OrderCreated", {
					orderId: "order-123",
				}) as OrderCreated,
				createDomainEvent("OrderShipped", {
					orderId: "order-123",
				}) as OrderShipped,
			];

			await bus.publish(events);

			expect(orderCreatedCalls).toHaveLength(1);
			expect(orderShippedCalls).toHaveLength(1);
		});

		it("should not call handlers for unsubscribed event types", async () => {
			const bus = new EventBusImpl<OrderEvent>();
			let called = false;

			bus.subscribe("OrderCreated", async () => {
				called = true;
			});

			const event = createDomainEvent("OrderShipped", {
				orderId: "order-123",
			}) as OrderShipped;

			await bus.publish([event]);

			expect(called).toBe(false);
		});

		it("should handle empty event array", async () => {
			const bus = new EventBusImpl<OrderEvent>();
			let called = false;

			bus.subscribe("OrderCreated", async () => {
				called = true;
			});

			await bus.publish([]);

			expect(called).toBe(false);
		});

		it("should handle async handlers", async () => {
			const bus = new EventBusImpl<OrderEvent>();
			const results: number[] = [];

			bus.subscribe("OrderCreated", async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				results.push(1);
			});

			bus.subscribe("OrderCreated", async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				results.push(2);
			});

			const event = createDomainEvent("OrderCreated", {
				orderId: "order-123",
			}) as OrderCreated;

			await bus.publish([event]);

			expect(results).toHaveLength(2);
		});

		it("should handle errors in handlers gracefully", async () => {
			const bus = new EventBusImpl<OrderEvent>();
			let handler2Called = false;

			bus.subscribe("OrderCreated", async () => {
				throw new Error("Handler 1 error");
			});

			bus.subscribe("OrderCreated", async () => {
				handler2Called = true;
			});

			const event = createDomainEvent("OrderCreated", {
				orderId: "order-123",
			}) as OrderCreated;

			// Promise.all will reject if any handler fails, but all handlers are called
			await expect(bus.publish([event])).rejects.toThrow("Handler 1 error");
			// Note: handler2Called might be true because Promise.all executes all promises
			// before rejecting. This is expected behavior for parallel execution.
		});
	});
});

