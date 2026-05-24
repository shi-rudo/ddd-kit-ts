import { describe, expect, it } from "vitest";
import { createDomainEvent, type DomainEvent } from "../aggregate/domain-event";
import type { EventBus, Outbox } from "../events/ports";
import type { TransactionScope } from "../repo/scope";
import { withCommit } from "./handler";

type TestEvent = DomainEvent<"OrderCreated", { orderId: string }>;

function createMockScope(): TransactionScope<undefined> {
	return {
		transactional: <T>(fn: (_ctx: undefined) => Promise<T>) => fn(undefined),
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
		const events: TestEvent[] = [
			createDomainEvent("OrderCreated", { orderId: "order-1" }),
		];

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
		const events: TestEvent[] = [
			createDomainEvent("OrderCreated", { orderId: "order-1" }),
		];

		await withCommit(
			{ outbox, bus, scope: createMockScope() },
			async () => ({ result: "ok", events }),
		);

		expect(bus.published).toHaveLength(1);
		expect(bus.published[0]).toEqual(events);
	});

	it("should not fail when bus is not provided", async () => {
		const outbox = createMockOutbox();
		const events: TestEvent[] = [
			createDomainEvent("OrderCreated", { orderId: "order-1" }),
		];

		const result = await withCommit(
			{ outbox, scope: createMockScope() },
			async () => ({ result: "ok", events }),
		);

		expect(result).toBe("ok");
		expect(outbox.added).toHaveLength(1);
	});

	it("should execute within the unit of work transaction", async () => {
		const callOrder: string[] = [];
		const scope: TransactionScope<undefined> = {
			transactional: async <T>(fn: (_ctx: undefined) => Promise<T>) => {
				callOrder.push("tx-start");
				const result = await fn(undefined);
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
					events: [createDomainEvent("OrderCreated", { orderId: "order-1" })],
				}),
			),
		).rejects.toThrow("Outbox failed");
	});

	it("publishes to the bus only AFTER the transaction has committed", async () => {
		const callOrder: string[] = [];
		const scope: TransactionScope<undefined> = {
			transactional: async <T>(fn: (_ctx: undefined) => Promise<T>) => {
				callOrder.push("tx-start");
				const result = await fn(undefined);
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
					events: [createDomainEvent("OrderCreated", { orderId: "o-1" })],
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

	it("threads the TransactionScope context through to fn (Drizzle/Prisma/Mongo-tx pattern)", async () => {
		// Simulate a persistence-layer transaction handle that the scope
		// passes into the callback. Real-world examples: Drizzle's tx,
		// Prisma's tx, Mongo's session. The scope opens it, the use case
		// hands it to its repositories so writes bind to that transaction.
		type DrizzleLikeTx = { id: string; isTx: true };

		const tx: DrizzleLikeTx = { id: "tx-42", isTx: true };

		const scope: TransactionScope<DrizzleLikeTx> = {
			transactional: async <T>(
				fn: (ctx: DrizzleLikeTx) => Promise<T>,
			): Promise<T> => fn(tx),
		};

		const outbox = createMockOutbox();

		let received: DrizzleLikeTx | undefined;
		await withCommit({ outbox, scope }, async (ctx) => {
			received = ctx;
			return {
				result: ctx.id,
				events: [],
			};
		});

		expect(received).toBe(tx);
	});

	it("typing: context-free scopes use TransactionScope<undefined> as the explicit no-ctx idiom", async () => {
		// No default for TCtx — context-free callers spell out
		// `TransactionScope<undefined>` so "there is nothing here" is a
		// conscious choice, not an inherited `unknown` fallback.
		const outbox = createMockOutbox();
		const result = await withCommit(
			{ outbox, scope: createMockScope() },
			async () => ({ result: "ok", events: [] }),
		);

		expect(result).toBe("ok");
	});

	it("does not publish to the bus when the transaction throws", async () => {
		const scope = createMockScope();
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
