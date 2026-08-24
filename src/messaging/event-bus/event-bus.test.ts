import { describe, expect, it, vi } from "vite-plus/test";
import {
	createDomainEvent,
	type DomainEvent,
} from "../../domain/aggregate/aggregate";
import {
	type ExecutionContext,
	runBoundedExecution,
} from "../../internal/async/execution";
import { PublishDepthExceededError } from "./errors";
import { EventBusImpl, type EventBusObservers } from "./event-bus";
import type { PublishChainStore } from "./publish-chain";

/** Every observer is required. Tests override only the one they assert on. */
const silentObservers = (): EventBusObservers => ({
	onSubscriptionThresholdExceeded: () => {},
	onHandlerError: () => {},
	onPublishAborted: () => {},
});

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

			const unsubscribe = bus.subscribe("OrderCreated", async () => {});

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

		it("times out a never-settling handler and aborts its execution context", async () => {
			vi.useFakeTimers();
			const bus = new EventBusImpl<OrderEvent>();
			let context: ExecutionContext | undefined;
			let handlerStarted!: () => void;
			const started = new Promise<void>((resolve) => {
				handlerStarted = resolve;
			});
			bus.subscribe("OrderCreated", async (_event, received) => {
				context = received;
				handlerStarted();
				await new Promise<void>(() => {});
			});
			const event = createDomainEvent("OrderCreated", {
				orderId: "order-123",
			}) as OrderCreated;
			const execution = bus.publish([event], { timeoutMs: 5 }).then(
				() => "resolved" as const,
				(error: unknown) => error,
			);

			try {
				await started;
				await vi.advanceTimersByTimeAsync(5);
				await expect(execution).resolves.toMatchObject({
					name: "TimeoutError",
				});
				expect(context?.signal.aborted).toBe(true);
				expect(context?.deadlineAt).toBeTypeOf("number");
			} finally {
				vi.useRealTimers();
			}
		});

		it("carries accumulated handler failures on the abort error", async () => {
			const bus = new EventBusImpl<OrderEvent>();
			const handlerFailure = new Error("db write failed");
			bus.subscribe("OrderCreated", async () => {
				throw handlerFailure;
			});
			let hung: ExecutionContext | undefined;
			bus.subscribe("OrderCreated", async (_event, received) => {
				hung = received;
				await new Promise<void>(() => {});
			});
			const event = createDomainEvent("OrderCreated", {
				orderId: "order-123",
			}) as OrderCreated;
			const stop = new AbortController();
			const execution = bus.publish([event], {
				signal: stop.signal,
				timeoutMs: 1_000,
			});
			await expect.poll(() => hung).toBeDefined();
			const reason = new Error("request cancelled");

			stop.abort(reason);

			// The abort ends the batch, but the real failure that already
			// happened must not vanish behind it.
			const rejection = await execution.then(
				() => undefined,
				(error: unknown) => error,
			);
			expect(rejection).toBeInstanceOf(AggregateError);
			expect((rejection as AggregateError).errors).toContain(reason);
			expect((rejection as AggregateError).errors).toContain(handlerFailure);
		});

		it("propagates owner cancellation to a never-settling handler", async () => {
			const bus = new EventBusImpl<OrderEvent>();
			let context: ExecutionContext | undefined;
			bus.subscribe("OrderCreated", async (_event, received) => {
				context = received;
				await new Promise<void>(() => {});
			});
			const event = createDomainEvent("OrderCreated", {
				orderId: "order-123",
			}) as OrderCreated;
			const stop = new AbortController();
			const execution = bus.publish([event], {
				signal: stop.signal,
				timeoutMs: 1_000,
			});
			await expect.poll(() => context).toBeDefined();
			const reason = new Error("request cancelled");

			stop.abort(reason);

			await expect(execution).rejects.toBe(reason);
			expect(context?.signal.reason).toBe(reason);
		});

		it("rejects an invalid publication timeout", async () => {
			const bus = new EventBusImpl<OrderEvent>();

			await expect(bus.publish([], { timeoutMs: Number.NaN })).rejects.toThrow(
				/timeoutMs/,
			);
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

			await expect(bus.publish([event])).rejects.toThrow(
				"Multiple event handlers failed",
			);
		});
	});

	describe("subscribeAll", () => {
		const created = (orderId: string) =>
			createDomainEvent("OrderCreated", { orderId }) as OrderCreated;
		const shipped = (orderId: string) =>
			createDomainEvent("OrderShipped", { orderId }) as OrderShipped;

		it("receives every event type, in input order, without enumerating the union", async () => {
			const bus = new EventBusImpl<OrderEvent>();
			const seen: string[] = [];

			bus.subscribeAll(async (event) => {
				seen.push(event.type);
			});

			await bus.publish([created("o-1"), shipped("o-1"), created("o-2")]);

			expect(seen).toEqual(["OrderCreated", "OrderShipped", "OrderCreated"]);
		});

		it("runs even when the event type has no typed subscriber", async () => {
			const bus = new EventBusImpl<OrderEvent>();
			const seen: string[] = [];

			bus.subscribeAll(async (event) => {
				seen.push(event.type);
			});

			await bus.publish([shipped("o-1")]);

			expect(seen).toEqual(["OrderShipped"]);
		});

		it("shares one batch with typed handlers: a failing peer skips nobody", async () => {
			const bus = new EventBusImpl<OrderEvent>();
			const ran: string[] = [];

			bus.subscribe("OrderCreated", async () => {
				ran.push("typed");
				throw new Error("typed handler failed");
			});
			bus.subscribeAll(async () => {
				ran.push("catch-all");
				throw new Error("catch-all handler failed");
			});
			bus.subscribe("OrderCreated", async () => {
				ran.push("typed-healthy");
			});

			const rejection = await bus
				.publish([created("o-1")])
				.then(() => undefined)
				.catch((thrown: unknown) => thrown);

			// Every handler ran despite two failures in the same batch, and
			// both errors are collected into the one aggregated throw.
			expect(ran.sort()).toEqual(["catch-all", "typed", "typed-healthy"]);
			expect(rejection).toBeInstanceOf(AggregateError);
			expect((rejection as AggregateError).errors).toHaveLength(2);
		});

		it("unsubscribe removes exactly one subscription of a twice-subscribed handler", async () => {
			const bus = new EventBusImpl<OrderEvent>();
			let calls = 0;
			const handler = async () => {
				calls += 1;
			};

			const first = bus.subscribeAll(handler);
			bus.subscribeAll(handler);
			first();
			first(); // idempotent: a second call must not remove the sibling

			await bus.publish([created("o-1")]);

			expect(calls).toBe(1);
		});

		it("a synchronous throw in a catch-all handler is collected, not escaping the batch", async () => {
			const bus = new EventBusImpl<OrderEvent>();

			bus.subscribeAll(() => {
				throw new Error("sync catch-all bug");
			});

			await expect(bus.publish([created("o-1")])).rejects.toThrow(
				"sync catch-all bug",
			);
		});

		it("does not disturb once(): the waiter resolves alongside a catch-all", async () => {
			const bus = new EventBusImpl<OrderEvent>();
			const seen: string[] = [];
			bus.subscribeAll(async (event) => {
				seen.push(event.type);
			});

			const waiter = bus.once("OrderShipped");
			await bus.publish([shipped("o-9")]);

			await expect(waiter).resolves.toMatchObject({
				payload: { orderId: "o-9" },
			});
			expect(seen).toEqual(["OrderShipped"]);
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

			// Handler A tries to mutate the event; it must throw because
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

			// Peers ran even though one threw: allSettled semantics.
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

			// All three events dispatched: failures don't short-circuit the batch.
			expect(seen).toEqual(["o-1", "o-2", "o-3"]);
		});
	});

	describe("non-Error rejection reasons", () => {
		it("preserves the original reason as the Error cause", async () => {
			const bus = new EventBusImpl<OrderEvent>();
			const reason = { code: "RATE_LIMIT", retryAfter: 30 };

			bus.subscribe("OrderCreated", async () => {
				throw reason;
			});

			const event = createDomainEvent("OrderCreated", {
				orderId: "o-1",
			}) as OrderCreated;

			// The wrapping Error must carry the structured payload; a bare
			// '[object Object]' string destroys all diagnostic information.
			await expect(bus.publish([event])).rejects.toMatchObject({
				cause: reason,
			});
		});
	});

	describe("synchronously throwing handlers", () => {
		it("runs peer handlers and dispatches remaining events when a handler throws synchronously", async () => {
			const bus = new EventBusImpl<OrderEvent>();
			const seen: string[] = [];

			// EventHandler allows `Promise<void> | void`: a plain sync handler
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

			// Peer handler ran for BOTH events: the sync throw neither skipped
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

			// Set-coalescing would yield 1; Array semantics yield 2: the standard
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

			// Type inference from the eventType: handler is typed as OrderCreated
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

	describe("unsubscribe", () => {
		it("ignores a second call", () => {
			const bus = new EventBusImpl<OrderEvent>();
			const seen: string[] = [];
			const releaseFirst = bus.subscribe("OrderCreated", () => {
				seen.push("first");
			});
			bus.subscribe("OrderCreated", () => {
				seen.push("second");
			});

			releaseFirst();
			releaseFirst();

			expect(() => releaseFirst()).not.toThrow();
			expect(seen).toEqual([]);
		});

		it("ignores a second call on a catch-all subscription", () => {
			const bus = new EventBusImpl<OrderEvent>();
			const release = bus.subscribeAll(() => {});

			release();

			expect(() => release()).not.toThrow();
		});
	});

	describe("abort reason that is not an error", () => {
		it("carries it alongside the handler failures", async () => {
			const controller = new AbortController();
			const bus = new EventBusImpl<OrderEvent>();

			bus.subscribe("OrderCreated", async () => {
				controller.abort("stopped by a string");
				throw new Error("handler failed");
			});

			const error = (await bus
				.publish(
					[
						createDomainEvent("OrderCreated", {
							orderId: "o-1",
						}) as OrderCreated,
					],
					{ signal: controller.signal },
				)
				.catch((reason) => reason)) as AggregateError;

			expect(error).toBeInstanceOf(AggregateError);
			for (const collected of error.errors) {
				expect(collected).toBeInstanceOf(Error);
			}
		});
	});

	describe("construction options", () => {
		it("rejects a maximum publish depth that is not a positive integer", () => {
			for (const invalid of [0, -1, 1.5, Number.NaN]) {
				expect(
					() => new EventBusImpl<OrderEvent>({ maxPublishDepth: invalid }),
				).toThrow();
			}
		});

		it("rejects a subscription threshold that is not a positive integer", () => {
			expect(
				() => new EventBusImpl<OrderEvent>({ maxSubscriptionsPerEventType: 0 }),
			).toThrow();
		});

		it("rejects a chain store without run and getStore", () => {
			expect(
				() =>
					new EventBusImpl<OrderEvent>({
						chainStore: {} as unknown as PublishChainStore,
					}),
			).toThrow(TypeError);
			expect(
				() =>
					new EventBusImpl<OrderEvent>({
						chainStore: {
							run: () => undefined,
						} as unknown as PublishChainStore,
					}),
			).toThrow(TypeError);
		});
	});

	describe("abort between the events of one batch", () => {
		it("dispatches nothing when the signal is already aborted", async () => {
			const controller = new AbortController();
			controller.abort(new Error("owner stopped before publish"));
			const bus = new EventBusImpl<OrderEvent>();
			let called = false;

			bus.subscribe("OrderCreated", () => {
				called = true;
			});

			await expect(
				bus.publish(
					[
						createDomainEvent("OrderCreated", {
							orderId: "o-1",
						}) as OrderCreated,
					],
					{ signal: controller.signal },
				),
			).rejects.toThrow();

			expect(called).toBe(false);
		});

		it("stops the batch and leaves the remaining events undispatched", async () => {
			const controller = new AbortController();
			const bus = new EventBusImpl<OrderEvent>();
			const seen: string[] = [];

			bus.subscribe("OrderCreated", async () => {
				seen.push("OrderCreated");
				controller.abort(new Error("owner stopped"));
			});
			bus.subscribe("OrderShipped", async () => {
				seen.push("OrderShipped");
			});

			await expect(
				bus.publish(
					[
						createDomainEvent("OrderCreated", {
							orderId: "o-1",
						}) as OrderCreated,
						createDomainEvent("OrderShipped", {
							orderId: "o-1",
						}) as OrderShipped,
					],
					{ signal: controller.signal },
				),
			).rejects.toThrow();

			expect(seen).toEqual(["OrderCreated"]);
		});
	});

	describe("publish recursion", () => {
		const created = () =>
			createDomainEvent("OrderCreated", { orderId: "o-1" }) as OrderCreated;
		const shipped = () =>
			createDomainEvent("OrderShipped", { orderId: "o-1" }) as OrderShipped;

		// Every cycle test carries its own brake. Without the guard the bus
		// overflows the stack or starves the event loop until the process dies,
		// and a test must not depend on that to fail.
		const BRAKE = 200;

		it("rejects a synchronous publish cycle instead of overflowing the stack", async () => {
			const bus = new EventBusImpl<OrderEvent>();
			let depth = 0;

			bus.subscribe("OrderCreated", (_event, context) => {
				if (depth >= BRAKE) return;
				depth++;
				return bus.publish([created()], { signal: context.signal });
			});

			await expect(bus.publish([created()])).rejects.toThrow(
				PublishDepthExceededError,
			);
			expect(depth).toBeLessThan(BRAKE);
		});

		it("rejects an asynchronous publish cycle that carries the context signal", async () => {
			const bus = new EventBusImpl<OrderEvent>();
			let depth = 0;

			bus.subscribe("OrderCreated", async (_event, context) => {
				if (depth >= BRAKE) return;
				depth++;
				await Promise.resolve();
				await bus.publish([created()], { signal: context.signal });
			});

			await expect(bus.publish([created()])).rejects.toThrow(
				PublishDepthExceededError,
			);
			expect(depth).toBeLessThan(BRAKE);
		});

		it("bounds a cycle whose signal crosses a nested bounded execution", async () => {
			const bus = new EventBusImpl<OrderEvent>();
			let depth = 0;

			bus.subscribe("OrderCreated", async (_event, context) => {
				if (depth >= BRAKE) return;
				depth++;
				// The await ends the synchronous window, so only the signal can
				// still carry the chain. withCommit then publishes from inside its
				// own bounded execution, so the bus receives a derived signal, not
				// the one it handed to the handler.
				await Promise.resolve();
				await runBoundedExecution(
					"nested",
					{ signal: context.signal, timeoutMs: 5_000 },
					(nested) => bus.publish([created()], { signal: nested.signal }),
				);
			});

			await expect(bus.publish([created()])).rejects.toThrow(
				PublishDepthExceededError,
			);
			expect(depth).toBeLessThan(BRAKE);
		});

		it("bounds a synchronous cycle that runs through a later event of a batch", async () => {
			const bus = new EventBusImpl<OrderEvent>({ maxPublishDepth: 8 });
			let hops = 0;

			// The nested publication carries two events. The cycling one is
			// second, so it dispatches after an await and the synchronous frame
			// of its parent has unwound.
			bus.subscribe("OrderCreated", () => {
				if (hops >= BRAKE) return;
				hops++;
				return bus.publish([shipped(), created()]);
			});
			bus.subscribe("OrderShipped", () => {});

			await expect(bus.publish([created()])).rejects.toThrow(
				PublishDepthExceededError,
			);
			expect(hops).toBeLessThan(BRAKE);
		});

		it("does not count a later scheduled publication that carries the signal", async () => {
			// The guide tells a handler to pass context.signal. A poll loop that
			// obeys it must not run into the bound: every generation finishes
			// before the next one starts, so nothing is nested.
			const bus = new EventBusImpl<OrderEvent>({ maxPublishDepth: 4 });
			let generations = 0;
			let failure: unknown;

			bus.subscribe("OrderCreated", (_event, context) => {
				if (generations >= 12) return;
				generations++;
				setTimeout(() => {
					bus
						.publish([created()], { signal: context.signal })
						.catch((reason) => {
							failure ??= reason;
						});
				}, 1);
			});

			await bus.publish([created()]);
			const started = Date.now();
			while (
				generations < 12 &&
				failure === undefined &&
				Date.now() - started < 5_000
			) {
				await new Promise((resolve) => setTimeout(resolve, 5));
			}

			expect(failure).toBeUndefined();
			expect(generations).toBe(12);
		});

		it("names the event types that formed the cycle", async () => {
			const bus = new EventBusImpl<OrderEvent>();
			let depth = 0;

			bus.subscribe("OrderCreated", (_event, context) => {
				if (depth >= BRAKE) return;
				depth++;
				return bus.publish([shipped()], { signal: context.signal });
			});
			bus.subscribe("OrderShipped", (_event, context) =>
				bus.publish([created()], { signal: context.signal }),
			);

			const error = await bus.publish([created()]).catch((reason) => reason);

			expect(error).toBeInstanceOf(PublishDepthExceededError);
			expect(error.code).toBe("PUBLISH_DEPTH_EXCEEDED");
			expect(error.message).toContain("OrderCreated");
			expect(error.message).toContain("OrderShipped");
		});

		it("dispatches nested publications that stay below the limit", async () => {
			const bus = new EventBusImpl<OrderEvent>({ maxPublishDepth: 4 });
			const seen: string[] = [];

			bus.subscribe("OrderCreated", (event, context) => {
				seen.push(event.type);
				return bus.publish([shipped()], { signal: context.signal });
			});
			bus.subscribe("OrderShipped", (event) => {
				seen.push(event.type);
			});

			await bus.publish([created()]);

			expect(seen).toEqual(["OrderCreated", "OrderShipped"]);
		});

		it("does not count concurrent publications on one bus as recursion", async () => {
			const bus = new EventBusImpl<OrderEvent>({ maxPublishDepth: 4 });
			let handled = 0;

			// One shared bus, published to concurrently, is correct usage. A
			// guard that counts per instance instead of per chain rejects this.
			bus.subscribe("OrderCreated", async () => {
				await Promise.resolve();
				handled++;
			});

			await Promise.all(
				Array.from({ length: 100 }, () => bus.publish([created()])),
			);

			expect(handled).toBe(100);
		});

		it("honours a configured maximum publish depth", async () => {
			const bus = new EventBusImpl<OrderEvent>({ maxPublishDepth: 3 });
			let depth = 0;

			bus.subscribe("OrderCreated", (_event, context) => {
				if (depth >= BRAKE) return;
				depth++;
				return bus.publish([created()], { signal: context.signal });
			});

			await expect(bus.publish([created()])).rejects.toThrow(
				PublishDepthExceededError,
			);
			expect(depth).toBe(3);
		});
	});

	describe("subscription accumulation", () => {
		const noop = () => {};

		it("reports the crossing, then each doubling", () => {
			const reports: unknown[] = [];
			const bus = new EventBusImpl<OrderEvent>({
				maxSubscriptionsPerEventType: 3,
				observers: {
					...silentObservers(),
					onSubscriptionThresholdExceeded: (report) => reports.push(report),
				},
			});

			for (let index = 0; index < 10; index++) {
				bus.subscribe("OrderCreated", noop);
			}

			expect(reports).toEqual([
				{ eventType: "OrderCreated", subscriptionCount: 4, threshold: 3 },
				{ eventType: "OrderCreated", subscriptionCount: 8, threshold: 3 },
			]);
		});

		it("reports each event type separately", () => {
			const types: (string | null)[] = [];
			const bus = new EventBusImpl<OrderEvent>({
				maxSubscriptionsPerEventType: 1,
				observers: {
					...silentObservers(),
					onSubscriptionThresholdExceeded: (report) =>
						types.push(report.eventType),
				},
			});

			bus.subscribe("OrderCreated", noop);
			bus.subscribe("OrderCreated", noop);
			bus.subscribe("OrderShipped", noop);
			bus.subscribe("OrderShipped", noop);

			expect(types).toEqual(["OrderCreated", "OrderShipped"]);
		});

		it("reports again after the count drops back to the threshold", () => {
			const counts: number[] = [];
			const bus = new EventBusImpl<OrderEvent>({
				maxSubscriptionsPerEventType: 2,
				observers: {
					...silentObservers(),
					onSubscriptionThresholdExceeded: (report) =>
						counts.push(report.subscriptionCount),
				},
			});

			bus.subscribe("OrderCreated", noop);
			bus.subscribe("OrderCreated", noop);
			// A transient spike, for example many in-flight `once` waiters, must
			// not mute the event type for the rest of the process.
			const release = bus.subscribe("OrderCreated", noop);
			release();
			bus.subscribe("OrderCreated", noop);

			expect(counts).toEqual([3, 3]);
		});

		it("stays muted while the count is still above the threshold", () => {
			const counts: number[] = [];
			const bus = new EventBusImpl<OrderEvent>({
				maxSubscriptionsPerEventType: 2,
				observers: {
					...silentObservers(),
					onSubscriptionThresholdExceeded: (report) =>
						counts.push(report.subscriptionCount),
				},
			});

			bus.subscribe("OrderCreated", noop);
			bus.subscribe("OrderCreated", noop);
			bus.subscribe("OrderCreated", noop);
			const release = bus.subscribe("OrderCreated", noop);
			// Back to 3, which is still over 2, so nothing is re-armed.
			release();
			bus.subscribe("OrderCreated", noop);

			expect(counts).toEqual([3]);
		});

		it("re-arms the catch-all report as well", () => {
			const counts: number[] = [];
			const bus = new EventBusImpl<OrderEvent>({
				maxSubscriptionsPerEventType: 1,
				observers: {
					...silentObservers(),
					onSubscriptionThresholdExceeded: (report) =>
						counts.push(report.subscriptionCount),
				},
			});

			bus.subscribeAll(noop);
			const release = bus.subscribeAll(noop);
			release();
			bus.subscribeAll(noop);

			expect(counts).toEqual([2, 2]);
		});

		it("keeps reporting as a monotonic leak grows", () => {
			const counts: number[] = [];
			const bus = new EventBusImpl<OrderEvent>({
				maxSubscriptionsPerEventType: 4,
				observers: {
					...silentObservers(),
					onSubscriptionThresholdExceeded: (report) =>
						counts.push(report.subscriptionCount),
				},
			});

			// A real leak never drops back, so a report that only fires on the
			// first crossing hides the number the operator needs.
			for (let index = 0; index < 40; index++) {
				bus.subscribe("OrderCreated", noop);
			}

			expect(counts).toEqual([5, 10, 20, 40]);
		});

		it("reports catch-all subscriptions with a null event type", () => {
			const reports: { eventType: string | null }[] = [];
			const bus = new EventBusImpl<OrderEvent>({
				maxSubscriptionsPerEventType: 2,
				observers: {
					...silentObservers(),
					onSubscriptionThresholdExceeded: (report) => reports.push(report),
				},
			});

			bus.subscribeAll(noop);
			bus.subscribeAll(noop);
			bus.subscribeAll(noop);

			expect(reports).toEqual([
				{ eventType: null, subscriptionCount: 3, threshold: 2 },
			]);
		});

		it("stays silent at or below the threshold", () => {
			let reported = false;
			const bus = new EventBusImpl<OrderEvent>({
				maxSubscriptionsPerEventType: 4,
				observers: {
					...silentObservers(),
					onSubscriptionThresholdExceeded: () => {
						reported = true;
					},
				},
			});

			for (let index = 0; index < 4; index++) {
				bus.subscribe("OrderCreated", noop);
			}

			expect(reported).toBe(false);
		});

		it("keeps subscribing when the observer throws", () => {
			const bus = new EventBusImpl<OrderEvent>({
				maxSubscriptionsPerEventType: 1,
				observers: {
					...silentObservers(),
					onSubscriptionThresholdExceeded: () => {
						throw new Error("observer boom");
					},
				},
			});

			bus.subscribe("OrderCreated", noop);

			expect(() => bus.subscribe("OrderCreated", noop)).not.toThrow();
		});

		it("rejects an observer bundle without the hook", () => {
			expect(
				() =>
					new EventBusImpl<OrderEvent>({
						observers: {} as unknown as EventBusObservers,
					}),
			).toThrow(TypeError);
		});

		it("subscribes without a configured observer", () => {
			const bus = new EventBusImpl<OrderEvent>({
				maxSubscriptionsPerEventType: 1,
			});

			expect(() => {
				bus.subscribe("OrderCreated", noop);
				bus.subscribe("OrderCreated", noop);
			}).not.toThrow();
		});
	});

	describe("dispatch observability", () => {
		const created = () =>
			createDomainEvent("OrderCreated", { orderId: "o-1" }) as OrderCreated;

		it("reports a failing handler with its position in the batch", async () => {
			const failures: unknown[] = [];
			const bus = new EventBusImpl<OrderEvent>({
				observers: {
					...silentObservers(),
					onHandlerError: (report) =>
						failures.push({
							index: report.index,
							catchAll: report.catchAll,
							type: report.event.type,
							message: report.error.message,
						}),
				},
			});

			bus.subscribe("OrderCreated", () => {});
			bus.subscribe("OrderCreated", () => {
				throw new Error("second handler failed");
			});

			await expect(bus.publish([created()])).rejects.toThrow(
				"second handler failed",
			);

			expect(failures).toEqual([
				{
					index: 1,
					catchAll: false,
					type: "OrderCreated",
					message: "second handler failed",
				},
			]);
		});

		it("marks a catch-all handler in the failure report", async () => {
			const catchAll: boolean[] = [];
			const bus = new EventBusImpl<OrderEvent>({
				observers: {
					...silentObservers(),
					onHandlerError: (report) => catchAll.push(report.catchAll),
				},
			});

			bus.subscribe("OrderCreated", () => {
				throw new Error("typed");
			});
			bus.subscribeAll(() => {
				throw new Error("catch all");
			});

			await expect(bus.publish([created()])).rejects.toThrow(AggregateError);

			expect(catchAll).toEqual([false, true]);
		});

		it("keeps the catch-all flag correct when a peer unsubscribes mid-dispatch", async () => {
			const flags: boolean[] = [];
			const bus = new EventBusImpl<OrderEvent>({
				observers: {
					...silentObservers(),
					onHandlerError: (report) => flags.push(report.catchAll),
				},
			});

			// The batch is snapshotted so an unsubscribe cannot shift indices.
			// Anything derived from the live array must be snapshotted with it.
			let releasePeer = () => {};
			bus.subscribe("OrderCreated", () => {
				releasePeer();
			});
			releasePeer = bus.subscribe("OrderCreated", () => {
				throw new Error("typed handler failed");
			});

			await expect(bus.publish([created()])).rejects.toThrow(
				"typed handler failed",
			);

			expect(flags).toEqual([false]);
		});

		it("does not report a synchronously finished handler as still running", async () => {
			const reports: (readonly number[])[] = [];
			const controller = new AbortController();
			const bus = new EventBusImpl<OrderEvent>({
				observers: {
					...silentObservers(),
					onPublishAborted: (report) => reports.push(report.pendingIndices),
				},
			});

			// An async handler that returns at once resolves a microtask later.
			// A report taken in the same turn would call it abandoned.
			bus.subscribe("OrderCreated", async () => {});
			bus.subscribe("OrderCreated", () => {
				controller.abort(new Error("owner stopped"));
			});
			bus.subscribe("OrderCreated", () => new Promise<void>(() => {}));

			await expect(
				bus.publish([created()], { signal: controller.signal }),
			).rejects.toThrow();

			// Only index 2 is open. Index 0 resolved, index 1 returned right
			// after it aborted, and both settle before the report is taken.
			expect(reports).toEqual([[2]]);
		});

		it("names the handlers that were still running when the publish aborted", async () => {
			const reports: unknown[] = [];
			const bus = new EventBusImpl<OrderEvent>({
				observers: {
					...silentObservers(),
					onPublishAborted: (report) =>
						reports.push({
							pending: report.pendingIndices,
							type: report.event.type,
							reason: (report.reason as Error)?.name,
						}),
				},
			});

			bus.subscribe("OrderCreated", async () => {});
			// Never settles. This is the handler an operator needs named.
			bus.subscribe("OrderCreated", () => new Promise<void>(() => {}));

			await expect(
				bus.publish([created()], { timeoutMs: 30 }),
			).rejects.toThrow();

			expect(reports).toEqual([
				{ pending: [1], type: "OrderCreated", reason: "TimeoutError" },
			]);
		});

		it("reports nothing when the abort finds every handler settled", async () => {
			const controller = new AbortController();
			let reported = false;
			const bus = new EventBusImpl<OrderEvent>({
				observers: {
					...silentObservers(),
					onPublishAborted: () => {
						reported = true;
					},
				},
			});

			// Both handlers return without a promise, so both are settled when
			// the report is taken. An abort with nothing left running must not
			// raise a false alarm.
			bus.subscribe("OrderCreated", () => {
				controller.abort(new Error("owner stopped"));
			});
			bus.subscribe("OrderCreated", () => {});

			await expect(
				bus.publish([created()], { signal: controller.signal }),
			).rejects.toThrow();
			await new Promise((resolve) => setTimeout(resolve, 5));

			expect(reported).toBe(false);
		});

		it("reports nothing abandoned when every handler settles", async () => {
			let aborted = 0;
			const bus = new EventBusImpl<OrderEvent>({
				observers: {
					...silentObservers(),
					onPublishAborted: () => {
						aborted++;
					},
				},
			});
			bus.subscribe("OrderCreated", async () => {});

			await bus.publish([created()]);

			expect(aborted).toBe(0);
		});

		it("keeps a rejection that cannot become a string", async () => {
			const bus = new EventBusImpl<OrderEvent>();

			// A value without a prototype has no string form, so String() on it
			// throws. That must not swallow the failure of a peer.
			bus.subscribe("OrderCreated", () => {
				throw Object.create(null);
			});
			bus.subscribe("OrderCreated", () => {
				throw new Error("second handler failed");
			});

			const error = (await bus
				.publish([created()])
				.catch((reason) => reason)) as AggregateError;

			expect(error).toBeInstanceOf(AggregateError);
			expect(error.errors).toHaveLength(2);
			for (const collected of error.errors) {
				expect(collected).toBeInstanceOf(Error);
			}
		});

		it("rejects with an error when the only rejection has no string form", async () => {
			const bus = new EventBusImpl<OrderEvent>();
			const reason = Object.create(null);
			bus.subscribe("OrderCreated", () => {
				throw reason;
			});

			const error = await bus.publish([created()]).catch((thrown) => thrown);

			expect(error).toBeInstanceOf(Error);
			expect((error as Error).cause).toBe(reason);
		});

		it("publishes an empty batch at the depth bound", async () => {
			const bus = new EventBusImpl<OrderEvent>({ maxPublishDepth: 1 });
			let nested: unknown = "not attempted";

			// An empty batch dispatches nothing, so it cannot extend a cycle.
			bus.subscribe("OrderCreated", async (_event, context) => {
				nested = await bus
					.publish([], { signal: context.signal })
					.then(() => "resolved")
					.catch((reason) => reason);
			});

			await bus.publish([created()]);

			expect(nested).toBe("resolved");
		});

		it("keeps the failure contract when a failure observer throws", async () => {
			const bus = new EventBusImpl<OrderEvent>({
				observers: {
					...silentObservers(),
					onHandlerError: () => {
						throw new Error("observer boom");
					},
				},
			});
			bus.subscribe("OrderCreated", () => {
				throw new Error("handler boom");
			});

			await expect(bus.publish([created()])).rejects.toThrow("handler boom");
		});
	});
});
