// @ts-expect-error Node's async_hooks exists in the test runtime; the package stays Node-type-free.
import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it } from "vite-plus/test";
import {
	createDomainEvent,
	type DomainEvent,
	EventBusImpl,
	type PublishChainState,
	PublishDepthExceededError,
} from "../../src";

type OrderCreated = DomainEvent<"OrderCreated", { orderId: string }>;

const created = () =>
	createDomainEvent("OrderCreated", { orderId: "o-1" }) as OrderCreated;

/** Stops the probe before an unbounded chain exhausts the test runner. */
const BRAKE = 150;

/** Waits for a condition instead of sleeping a fixed amount. */
async function until(
	reached: () => boolean,
	deadlineMs = 5_000,
): Promise<void> {
	const started = Date.now();
	while (!reached() && Date.now() - started < deadlineMs) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/**
 * A handler that gives its own publication an extra deadline writes exactly
 * this. The merged signal is not one the kit derived, so the owner chain ends
 * there and only an injected store can still carry the depth.
 */
function subscribeMergingSignals(
	bus: EventBusImpl<OrderCreated>,
	counter: { depth: number },
): void {
	bus.subscribe("OrderCreated", async (_event, context) => {
		if (counter.depth >= BRAKE) return;
		counter.depth++;
		await Promise.resolve();
		const merged = AbortSignal.any([
			context.signal,
			new AbortController().signal,
		]);
		await bus.publish([created()], { signal: merged });
	});
}

describe("event bus publish chain across a merged signal", () => {
	it("bounds the chain when the caller injects a chain store", async () => {
		const counter = { depth: 0 };
		const bus = new EventBusImpl<OrderCreated>({
			chainStore: new AsyncLocalStorage<PublishChainState>(),
			maxPublishDepth: 8,
		});
		subscribeMergingSignals(bus, counter);

		await expect(bus.publish([created()])).rejects.toThrow(
			PublishDepthExceededError,
		);
		expect(counter.depth).toBe(8);
	});

	it("loses the chain without a store, which is why the store exists", async () => {
		const counter = { depth: 0 };
		const bus = new EventBusImpl<OrderCreated>({ maxPublishDepth: 8 });
		subscribeMergingSignals(bus, counter);

		await bus.publish([created()]);

		expect(counter.depth).toBe(BRAKE);
	});

	it("does not count a later scheduled publication as part of the chain", async () => {
		// Each generation finishes before the next one starts, so nothing is
		// nested. AsyncLocalStorage still propagates into the timer callback,
		// and a depth that keeps counting there kills a correct poll loop.
		const bus = new EventBusImpl<OrderCreated>({
			chainStore: new AsyncLocalStorage<PublishChainState>(),
			maxPublishDepth: 4,
		});
		let generations = 0;
		let failure: unknown;

		bus.subscribe("OrderCreated", () => {
			if (generations >= 12) return;
			generations++;
			setTimeout(() => {
				bus.publish([created()]).catch((reason) => {
					failure ??= reason;
				});
			}, 1);
		});

		await bus.publish([created()]);
		await until(() => generations >= 12 || failure !== undefined);

		expect(failure).toBeUndefined();
		expect(generations).toBe(12);
	});

	it("does not count a relay that its parent no longer awaits", async () => {
		// The handler starts the next publication before it returns and never
		// awaits it. Each generation ends, so nothing accumulates. Counting
		// this as nesting kills a correct relay at the bound.
		for (const store of [
			undefined,
			new AsyncLocalStorage<PublishChainState>(),
		]) {
			const bus = new EventBusImpl<OrderCreated>({
				chainStore: store,
				maxPublishDepth: 4,
			});
			let generations = 0;
			let failure: unknown;

			bus.subscribe("OrderCreated", async (_event, context) => {
				if (generations >= 12) return;
				generations++;
				await new Promise((resolve) => setTimeout(resolve, 1));
				bus.publish([created()], { signal: context.signal }).catch((reason) => {
					failure ??= reason;
				});
			});

			await bus.publish([created()]);
			await until(() => generations >= 12 || failure !== undefined);

			expect(failure).toBeUndefined();
			expect(generations).toBe(12);
		}
	});
});
