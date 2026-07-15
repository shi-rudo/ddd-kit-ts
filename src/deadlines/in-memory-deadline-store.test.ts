import { describe, expect, it } from "vitest";
import { InMemoryCapacityExceededError } from "../core/errors";
import { InMemoryDeadlineStore } from "./in-memory-deadline-store";

const dueAt = new Date("2026-07-15T08:00:00.000Z");

describe("InMemoryDeadlineStore capacity", () => {
	it("allows replacing an address at capacity and cancel releases its slot", async () => {
		const store = new InMemoryDeadlineStore({ maxRecords: 1 });
		await store.schedule({ scope: "orders", key: "o-1", dueAt, payload: 1 });

		await expect(
			store.schedule({ scope: "orders", key: "o-1", dueAt, payload: 2 }),
		).resolves.toBeUndefined();
		await expect(
			store.schedule({ scope: "orders", key: "o-2", dueAt, payload: 3 }),
		).rejects.toMatchObject({
			code: "IN_MEMORY_CAPACITY_EXCEEDED",
			store: "InMemoryDeadlineStore",
			resource: "records",
			limit: 1,
			current: 1,
			attempted: 1,
		});
		expect(await store.due(dueAt, 10)).toMatchObject([{ payload: 2 }]);

		await store.cancel("orders", "o-1");
		await expect(
			store.schedule({ scope: "orders", key: "o-2", dueAt, payload: 3 }),
		).resolves.toBeUndefined();
	});

	it("counts dead letters until they are explicitly delivered", async () => {
		const store = new InMemoryDeadlineStore({
			maxRecords: 1,
			maxDeliveryAttempts: 1,
		});
		await store.schedule({ scope: "orders", key: "o-1", dueAt, payload: 1 });
		const [record] = await store.due(dueAt, 1);
		if (record === undefined) throw new Error("expected the scheduled deadline");
		await store.markFailed(record.deliveryId, new Error("poison"));

		await expect(
			store.schedule({ scope: "orders", key: "o-2", dueAt, payload: 2 }),
		).rejects.toBeInstanceOf(InMemoryCapacityExceededError);
		await store.markDelivered([record.deliveryId]);
		await expect(
			store.schedule({ scope: "orders", key: "o-2", dueAt, payload: 2 }),
		).resolves.toBeUndefined();
	});

	it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
		"rejects invalid maxRecords capacity %s",
		(maxRecords) => {
			expect(() => new InMemoryDeadlineStore({ maxRecords })).toThrow(
				RangeError,
			);
		},
	);
});
