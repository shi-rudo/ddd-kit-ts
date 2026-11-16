import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { DomainEvent } from "../../domain/event/domain-event";
import { InProcessEventBus } from "./event-bus";

type OrderCreated = DomainEvent<"OrderCreated", { orderId: string }>;

describe("event bus close releases what it holds", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("clears the timer of a waiter it settles", async () => {
		// Only Node lists active timers, so the test watches the timer calls.
		const armTimer = vi.spyOn(globalThis, "setTimeout");
		const clearTimer = vi.spyOn(globalThis, "clearTimeout");
		const bus = new InProcessEventBus<OrderCreated>();
		const waiting = bus.once("OrderCreated", { timeoutMs: 60_000 });

		expect(armTimer).toHaveBeenCalledExactlyOnceWith(
			expect.any(Function),
			60_000,
		);
		const timer = armTimer.mock.results[0]?.value;
		bus.close();
		await expect(waiting).rejects.toThrow(
			expect.objectContaining({ code: "EVENT_BUS_CLOSED" }),
		);

		// A timer left armed holds the event loop open for a waiter that
		// already settled, which is the leak close() exists to end.
		expect(clearTimer).toHaveBeenCalledWith(timer);
		expect(armTimer).toHaveBeenCalledOnce();
	});

	it("removes the abort listener of a waiter it settles", async () => {
		const controller = new AbortController();
		// Counting the listeners is the only way to see one that stays: an
		// attached listener that runs after the promise settled changes
		// nothing observable, so asserting on behaviour proves nothing.
		let attached = 0;
		const signal = new Proxy(controller.signal, {
			get(target, property) {
				if (property === "addEventListener") {
					return (...args: Parameters<AbortSignal["addEventListener"]>) => {
						attached++;
						target.addEventListener(...args);
					};
				}
				if (property === "removeEventListener") {
					return (...args: Parameters<AbortSignal["removeEventListener"]>) => {
						attached--;
						target.removeEventListener(...args);
					};
				}
				// The signal is the receiver: Bun's getters reject the proxy.
				const value = Reflect.get(target, property);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const bus = new InProcessEventBus<OrderCreated>();
		const waiting = bus.once("OrderCreated", { signal });

		expect(attached).toBe(1);
		bus.close();
		await expect(waiting).rejects.toThrow(
			expect.objectContaining({ code: "EVENT_BUS_CLOSED" }),
		);

		// A listener left attached keeps the closed bus reachable from a
		// long-lived request signal.
		expect(attached).toBe(0);
	});
});
