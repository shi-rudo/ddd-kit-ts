import { describe, expect, it } from "vite-plus/test";
import { EventBusClosedError, EventBusImpl } from "../../src";
import {
	createDomainEvent,
	type DomainEvent,
} from "../../src/domain/event/domain-event";

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
		const bus = new EventBusImpl<OrderCreated>();
		const waiting = bus.once("OrderCreated", { signal: controller.signal });

		bus.close();
		await expect(waiting).rejects.toThrow(EventBusClosedError);

		// A listener left attached keeps the closed bus reachable from a
		// long-lived request signal.
		expect(() => controller.abort(new Error("later"))).not.toThrow();
		void createDomainEvent("OrderCreated", { orderId: "o-1" });
	});
});
