import { describe, expect, it } from "vite-plus/test";
import { EventBusClosedError, EventBusImpl } from "../../src";
import type { DomainEvent } from "../../src/domain/event/domain-event";

type OrderCreated = DomainEvent<"OrderCreated", { orderId: string }>;

/**
 * Active timer handles. Reading them needs Node, which is why this test lives
 * here and not beside the implementation.
 */
function countTimers(): number {
	// @ts-expect-error Node's process exists in the test runtime; the package stays Node-type-free.
	const resources: readonly string[] = process.getActiveResourcesInfo();
	return resources.filter((resource) => resource === "Timeout").length;
}

describe("event bus close releases what it holds", () => {
	it("clears the timer of a waiter it settles", async () => {
		const bus = new EventBusImpl<OrderCreated>();
		const before = countTimers();
		const waiting = bus.once("OrderCreated", { timeoutMs: 60_000 });

		expect(countTimers()).toBe(before + 1);
		bus.close();
		await expect(waiting).rejects.toThrow(EventBusClosedError);

		// A timer left armed holds the event loop open for a waiter that
		// already settled, which is the leak close() exists to end.
		expect(countTimers()).toBe(before);
	});

	it("removes the abort listener of a waiter it settles", async () => {
		const controller = new AbortController();
		// Counting the listeners is the only way to see one that stays: an
		// attached listener that runs after the promise settled changes
		// nothing observable, so asserting on behaviour proves nothing.
		let attached = 0;
		const signal = new Proxy(controller.signal, {
			get(target, property, receiver) {
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
				const value = Reflect.get(target, property, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const bus = new EventBusImpl<OrderCreated>();
		const waiting = bus.once("OrderCreated", { signal });

		expect(attached).toBe(1);
		bus.close();
		await expect(waiting).rejects.toThrow(EventBusClosedError);

		// A listener left attached keeps the closed bus reachable from a
		// long-lived request signal.
		expect(attached).toBe(0);
	});
});
