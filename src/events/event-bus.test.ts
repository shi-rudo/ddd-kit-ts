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

			bus.subscribe("OrderCreated", async (event: OrderCreated) => {
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

		it("should run all handlers even if one fails", async () => {
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

			await expect(bus.publish([event])).rejects.toThrow("Handler 1 error");
			expect(handler2Called).toBe(true);
		});

		it("should throw AggregateError when multiple handlers fail", async () => {
			const bus = new EventBusImpl<OrderEvent>();

			bus.subscribe("OrderCreated", async () => {
				throw new Error("Handler 1 error");
			});

			bus.subscribe("OrderCreated", async () => {
				throw new Error("Handler 2 error");
			});

			const event = createDomainEvent("OrderCreated", {
				orderId: "order-123",
			}) as OrderCreated;

			await expect(bus.publish([event])).rejects.toThrow("Multiple event handlers failed");
		});
	});

	describe("once", () => {
		it("should resolve with the event on next publish", async () => {
			const bus = new EventBusImpl<OrderEvent>();

			const promise = bus.once("OrderCreated");

			const event = createDomainEvent("OrderCreated", {
				orderId: "order-123",
			}) as OrderCreated;

			await bus.publish([event]);

			const received = await promise;
			expect(received.payload.orderId).toBe("order-123");
		});

		it("should automatically unsubscribe after first event", async () => {
			const bus = new EventBusImpl<OrderEvent>();

			const promise = bus.once("OrderCreated");

			const event1 = createDomainEvent("OrderCreated", {
				orderId: "order-1",
			}) as OrderCreated;
			const event2 = createDomainEvent("OrderCreated", {
				orderId: "order-2",
			}) as OrderCreated;

			await bus.publish([event1]);
			await bus.publish([event2]);

			const received = await promise;
			expect(received.payload.orderId).toBe("order-1");
		});
	});

	describe("event immutability across handler boundary", () => {
		it("a mutating handler cannot poison the event seen by subsequent handlers", async () => {
			const bus = new EventBusImpl<OrderEvent>();

			// Handler A tries to mutate the event — it must throw because
			// createDomainEvent freezes the event deeply.
			let handlerAThrew = false;
			bus.subscribe("OrderCreated", async (event) => {
				try {
					(event.payload as { orderId: string }).orderId = "PWNED";
				} catch {
					handlerAThrew = true;
				}
			});

			// Handler B must see the original payload, not the mutation A tried.
			let handlerBSaw: string | null = null;
			bus.subscribe("OrderCreated", async (event) => {
				handlerBSaw = event.payload.orderId;
			});

			const ev = createDomainEvent("OrderCreated", {
				orderId: "o-1",
			}) as OrderCreated;
			await bus.publish([ev]);

			expect(handlerAThrew).toBe(true);
			expect(handlerBSaw).toBe("o-1");
		});
	});

	describe("publish ordering & parallelism contract", () => {
		it("dispatches events in input order", async () => {
			const bus = new EventBusImpl<OrderEvent>();
			const seen: string[] = [];
			bus.subscribe("OrderCreated", async (event) => {
				seen.push(`created:${event.payload.orderId}`);
			});

			await bus.publish([
				createDomainEvent("OrderCreated", {
					orderId: "o-1",
				}) as OrderCreated,
				createDomainEvent("OrderCreated", {
					orderId: "o-2",
				}) as OrderCreated,
				createDomainEvent("OrderCreated", {
					orderId: "o-3",
				}) as OrderCreated,
			]);

			expect(seen).toEqual(["created:o-1", "created:o-2", "created:o-3"]);
		});

		it("runs handlers within a single event in parallel and collects all rejections", async () => {
			const bus = new EventBusImpl<OrderEvent>();
			let aDone = false;
			let cDone = false;

			bus.subscribe("OrderCreated", async () => {
				aDone = true;
			});
			bus.subscribe("OrderCreated", async () => {
				throw new Error("b failed");
			});
			bus.subscribe("OrderCreated", async () => {
				cDone = true;
			});

			const evt = createDomainEvent("OrderCreated", {
				orderId: "o-1",
			}) as OrderCreated;

			await expect(bus.publish([evt])).rejects.toThrow("b failed");

			// Peers ran even though one threw — allSettled semantics.
			expect(aDone).toBe(true);
			expect(cDone).toBe(true);
		});

		it("publishes remaining events when an earlier event's handler throws, then throws AggregateError at the end", async () => {
			const bus = new EventBusImpl<OrderEvent>();
			const seen: string[] = [];

			bus.subscribe("OrderCreated", async (event) => {
				seen.push(event.payload.orderId);
				if (event.payload.orderId === "o-1") throw new Error("e1");
				if (event.payload.orderId === "o-2") throw new Error("e2");
			});

			await expect(
				bus.publish([
					createDomainEvent("OrderCreated", {
						orderId: "o-1",
					}) as OrderCreated,
					createDomainEvent("OrderCreated", {
						orderId: "o-2",
					}) as OrderCreated,
					createDomainEvent("OrderCreated", {
						orderId: "o-3",
					}) as OrderCreated,
				]),
			).rejects.toBeInstanceOf(AggregateError);

			// All three events dispatched — failures don't short-circuit the batch.
			expect(seen).toEqual(["o-1", "o-2", "o-3"]);
		});
	});

	describe("synchronously throwing handlers", () => {
		it("runs peer handlers and dispatches remaining events when a handler throws synchronously", async () => {
			const bus = new EventBusImpl<OrderEvent>();
			const seen: string[] = [];

			// EventHandler allows `Promise<void> | void` — a plain sync handler
			// that throws must get the same allSettled treatment as a rejection.
			bus.subscribe("OrderCreated", () => {
				throw new Error("sync boom");
			});
			bus.subscribe("OrderCreated", async (event) => {
				seen.push(`peer:${event.payload.orderId}`);
			});

			await expect(
				bus.publish([
					createDomainEvent("OrderCreated", {
						orderId: "o-1",
					}) as OrderCreated,
					createDomainEvent("OrderCreated", {
						orderId: "o-2",
					}) as OrderCreated,
				]),
			).rejects.toBeInstanceOf(AggregateError);

			// Peer handler ran for BOTH events — the sync throw neither skipped
			// peers nor short-circuited the batch.
			expect(seen).toEqual(["peer:o-1", "peer:o-2"]);
		});

		it("aggregates a sync throw with an async rejection instead of orphaning the rejected promise", async () => {
			const bus = new EventBusImpl<OrderEvent>();

			// Order matters: the async rejecter is subscribed FIRST, so its
			// promise already exists when the second handler throws sync. If
			// the sync throw escaped .map(), that rejection would become an
			// unhandled promise rejection.
			bus.subscribe("OrderCreated", async () => {
				throw new Error("async boom");
			});
			bus.subscribe("OrderCreated", () => {
				throw new Error("sync boom");
			});

			const evt = createDomainEvent("OrderCreated", {
				orderId: "o-1",
			}) as OrderCreated;

			await expect(bus.publish([evt])).rejects.toMatchObject({
				message: "Multiple event handlers failed",
				errors: [
					expect.objectContaining({ message: "async boom" }),
					expect.objectContaining({ message: "sync boom" }),
				],
			});
		});
	});

	describe("duplicate subscription semantics", () => {
		it("invokes the same handler once per subscription when subscribed twice", async () => {
			const bus = new EventBusImpl<OrderEvent>();
			let calls = 0;
			const handler = async () => {
				calls += 1;
			};

			bus.subscribe("OrderCreated", handler);
			bus.subscribe("OrderCreated", handler);

			const event = createDomainEvent("OrderCreated", {
				orderId: "o-1",
			}) as OrderCreated;
			await bus.publish([event]);

			// Set-coalescing would yield 1; Array semantics yield 2 — the standard
			// pub/sub expectation (Node EventEmitter, RxJS subjects, etc.).
			expect(calls).toBe(2);
		});

		it("the returned unsubscribe removes exactly the matching subscription, not all duplicates", async () => {
			const bus = new EventBusImpl<OrderEvent>();
			let calls = 0;
			const handler = async () => {
				calls += 1;
			};

			const off1 = bus.subscribe("OrderCreated", handler);
			bus.subscribe("OrderCreated", handler);

			off1();

			await bus.publish([
				createDomainEvent("OrderCreated", {
					orderId: "o-1",
				}) as OrderCreated,
			]);

			// One subscription still alive → exactly one invocation
			expect(calls).toBe(1);
		});
	});

	describe("subscribe/once generic-binding to eventType", () => {
		type OrderCreated = DomainEvent<"OrderCreated", { orderId: string }>;
		type OrderShipped = DomainEvent<
			"OrderShipped",
			{ orderId: string; trackingNumber: string }
		>;
		type OrderEvt = OrderCreated | OrderShipped;

		it("infers the handler event type from the eventType argument", () => {
			const bus = new EventBusImpl<OrderEvt>();

			// Type inference from the eventType — handler is typed as OrderCreated
			bus.subscribe("OrderCreated", (event) => {
				// Narrowed: event.payload has orderId, no trackingNumber
				const _orderId: string = event.payload.orderId;
				// @ts-expect-error: trackingNumber only exists on OrderShipped
				const _tracking: string = event.payload.trackingNumber;
				void _orderId;
				void _tracking;
			});

			bus.subscribe("OrderShipped", (event) => {
				const _orderId: string = event.payload.orderId;
				const _tracking: string = event.payload.trackingNumber;
				void _orderId;
				void _tracking;
			});
		});

		it("rejects an unknown event type", () => {
			const bus = new EventBusImpl<OrderEvt>();
			// @ts-expect-error: "OrderBanana" is not a member of OrderEvt["type"]
			bus.subscribe("OrderBanana", () => {});
		});

		it("once() rejects when an AbortSignal is fired before the event arrives", async () => {
			const bus = new EventBusImpl<OrderEvt>();
			const ac = new AbortController();
			const p = bus.once("OrderCreated", { signal: ac.signal });

			ac.abort(new Error("client gave up"));

			await expect(p).rejects.toThrow("client gave up");
		});

		it("once() rejects with a timeout when timeoutMs elapses without the event", async () => {
			const bus = new EventBusImpl<OrderEvt>();
			const p = bus.once("OrderCreated", { timeoutMs: 10 });

			await expect(p).rejects.toThrow(/timed out.*OrderCreated/);
		});

		it("once() with timeoutMs resolves normally and clears the timer if the event arrives first", async () => {
			const bus = new EventBusImpl<OrderEvt>();
			const p = bus.once("OrderCreated", { timeoutMs: 50 });

			const evt = createDomainEvent("OrderCreated", {
				orderId: "o-1",
			}) as OrderCreated;
			await bus.publish([evt]);

			const received = await p;
			expect(received.payload.orderId).toBe("o-1");
			// Wait past the timeout to make sure no late rejection happens
			await new Promise((r) => setTimeout(r, 60));
		});

		it("once() with an already-aborted signal rejects synchronously without subscribing", async () => {
			const bus = new EventBusImpl<OrderEvt>();
			const ac = new AbortController();
			ac.abort();
			await expect(
				bus.once("OrderCreated", { signal: ac.signal }),
			).rejects.toBeDefined();
		});

		it("once() returns the event variant matching the eventType argument", async () => {
			const bus = new EventBusImpl<OrderEvt>();

			const p = bus.once("OrderShipped");
			// p is narrowed to Promise<OrderShipped>

			const event = createDomainEvent("OrderShipped", {
				orderId: "o-1",
				trackingNumber: "T-1",
			}) as OrderShipped;
			await bus.publish([event]);

			const received = await p;
			// Narrowed: trackingNumber is required on OrderShipped
			expect(received.payload.trackingNumber).toBe("T-1");
		});
	});
});

