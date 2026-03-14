import { describe, expect, it, vi } from "vitest";
import { withCommit } from "./handler";
import type { Outbox, EventBus } from "../events/ports";
import type { UnitOfWork } from "../repo/uow";

type TestEvent = { type: "OrderCreated"; orderId: string };

function createMockUow(): UnitOfWork {
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
			{ outbox: createMockOutbox(), uow: createMockUow() },
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
			{ outbox, uow: createMockUow() },
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
			{ outbox, bus, uow: createMockUow() },
			async () => ({ result: "ok", events }),
		);

		expect(bus.published).toHaveLength(1);
		expect(bus.published[0]).toEqual(events);
	});

	it("should not fail when bus is not provided", async () => {
		const outbox = createMockOutbox();
		const events: TestEvent[] = [{ type: "OrderCreated", orderId: "order-1" }];

		const result = await withCommit(
			{ outbox, uow: createMockUow() },
			async () => ({ result: "ok", events }),
		);

		expect(result).toBe("ok");
		expect(outbox.added).toHaveLength(1);
	});

	it("should execute within the unit of work transaction", async () => {
		const callOrder: string[] = [];
		const uow: UnitOfWork = {
			transactional: async <T>(fn: () => Promise<T>) => {
				callOrder.push("tx-start");
				const result = await fn();
				callOrder.push("tx-end");
				return result;
			},
		};
		const outbox = createMockOutbox();

		await withCommit(
			{ outbox, uow },
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
				{ outbox: createMockOutbox(), uow: createMockUow() },
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
		};

		await expect(
			withCommit(
				{ outbox, uow: createMockUow() },
				async () => ({
					result: "ok",
					events: [{ type: "OrderCreated", orderId: "order-1" }],
				}),
			),
		).rejects.toThrow("Outbox failed");
	});
});
