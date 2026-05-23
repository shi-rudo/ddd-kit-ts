import { describe, expect, it, vi } from "vitest";
import { withCommit } from "./handler";
import type { Outbox, EventBus } from "../events/ports";
import type { TransactionScope } from "../repo/scope";

type TestEvent = { type: "OrderCreated"; orderId: string };

function createMockScope(): TransactionScope {
	return {
		transactional: <T>(fn: () => Promise<T>) => fn(),
	};
}

function createMockOutbox(): Outbox<TestEvent> & { added: TestEvent[][] } {
	const added: TestEvent[][] = [];
	return {
		added,
		add: async (events) => {
			added.push([...events]);
		},
		getPending: async () => [],
		markDispatched: async () => {},
	};
}

function createMockBus(): EventBus<TestEvent> & { published: TestEvent[][] } {
	const published: TestEvent[][] = [];
	return {
		published,
		publish: async (events) => {
			published.push([...events]);
		},
		subscribe: () => () => {},
		once: () => new Promise(() => {}),
	};
}

describe("withCommit", () => {
	it("should return the result from the function", async () => {
		const result = await withCommit(
			{ outbox: createMockOutbox(), scope: createMockScope() },
			async () => ({
				result: "order-123",
				events: [],
			}),
		);

		expect(result).toBe("order-123");
	});

	it("should add events to the outbox", async () => {
		const outbox = createMockOutbox();
		const events: TestEvent[] = [{ type: "OrderCreated", orderId: "order-1" }];

		await withCommit(
			{ outbox, scope: createMockScope() },
			async () => ({ result: "ok", events }),
		);

		expect(outbox.added).toHaveLength(1);
		expect(outbox.added[0]).toEqual(events);
	});

	it("should publish events to bus when provided", async () => {
		const outbox = createMockOutbox();
		const bus = createMockBus();
		const events: TestEvent[] = [{ type: "OrderCreated", orderId: "order-1" }];

		await withCommit(
			{ outbox, bus, scope: createMockScope() },
			async () => ({ result: "ok", events }),
		);

		expect(bus.published).toHaveLength(1);
		expect(bus.published[0]).toEqual(events);
	});

	it("should not fail when bus is not provided", async () => {
		const outbox = createMockOutbox();
		const events: TestEvent[] = [{ type: "OrderCreated", orderId: "order-1" }];

		const result = await withCommit(
			{ outbox, scope: createMockScope() },
			async () => ({ result: "ok", events }),
		);

		expect(result).toBe("ok");
		expect(outbox.added).toHaveLength(1);
	});

	it("should execute within the unit of work transaction", async () => {
		const callOrder: string[] = [];
		const scope: TransactionScope = {
			transactional: async <T>(fn: () => Promise<T>) => {
				callOrder.push("tx-start");
				const result = await fn();
				callOrder.push("tx-end");
				return result;
			},
		};
		const outbox = createMockOutbox();

		await withCommit(
			{ outbox, scope },
			async () => {
				callOrder.push("fn");
				return { result: "ok", events: [] };
			},
		);

		expect(callOrder).toEqual(["tx-start", "fn", "tx-end"]);
	});

	it("should propagate errors from the function", async () => {
		await expect(
			withCommit(
				{ outbox: createMockOutbox(), scope: createMockScope() },
				async () => {
					throw new Error("Something went wrong");
				},
			),
		).rejects.toThrow("Something went wrong");
	});

	it("should propagate errors from the outbox", async () => {
		const outbox: Outbox<TestEvent> = {
			add: async () => {
				throw new Error("Outbox failed");
			},
			getPending: async () => [],
			markDispatched: async () => {},
		};

		await expect(
			withCommit(
				{ outbox, scope: createMockScope() },
				async () => ({
					result: "ok",
					events: [{ type: "OrderCreated", orderId: "order-1" }] as TestEvent[],
				}),
			),
		).rejects.toThrow("Outbox failed");
	});

	it("publishes to the bus only AFTER the transaction has committed", async () => {
		const callOrder: string[] = [];
		const scope: TransactionScope = {
			transactional: async <T>(fn: () => Promise<T>) => {
				callOrder.push("tx-start");
				const result = await fn();
				callOrder.push("tx-commit");
				return result;
			},
		};
		const outbox: Outbox<TestEvent> = {
			add: async () => {
				callOrder.push("outbox.add");
			},
			getPending: async () => [],
			markDispatched: async () => {},
		};
		const bus: EventBus<TestEvent> = {
			publish: async () => {
				callOrder.push("bus.publish");
			},
			subscribe: () => () => {},
			once: () => new Promise(() => {}),
		};

		await withCommit(
			{ outbox, bus, scope },
			async () => {
				callOrder.push("fn");
				return {
					result: "ok",
					events: [{ type: "OrderCreated", orderId: "o-1" }] as TestEvent[],
				};
			},
		);

		// Outbox stays inside the TX so the events persist atomically with state;
		// bus.publish must happen AFTER tx-commit so subscribers never see events
		// from a rolled-back transaction.
		expect(callOrder).toEqual([
			"tx-start",
			"fn",
			"outbox.add",
			"tx-commit",
			"bus.publish",
		]);
	});

	it("does not publish to the bus when the transaction throws", async () => {
		const scope: TransactionScope = {
			transactional: async <T>(fn: () => Promise<T>) => fn(),
		};
		const outbox = createMockOutbox();
		const bus = createMockBus();

		await expect(
			withCommit(
				{ outbox, bus, scope },
				async () => {
					throw new Error("write failed");
				},
			),
		).rejects.toThrow("write failed");

		expect(bus.published).toHaveLength(0);
	});
});
