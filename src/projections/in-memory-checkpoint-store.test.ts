import { describe, expect, it } from "vitest";
import { InMemoryCapacityExceededError } from "../core/errors";
import { InMemoryProjectionCheckpointStore } from "./in-memory-checkpoint-store";

const address = (aggregateId: string) => ({
	aggregateType: "Order",
	aggregateId,
});

const checkpoint = (aggregateVersion: number) => ({
	position: {
		aggregateVersion,
		commitSequence: 0,
		commitSize: 1,
		previousEventfulAggregateVersion:
			aggregateVersion === 1 ? null : aggregateVersion - 1,
	},
	lastAppliedEventId: `evt-${aggregateVersion}`,
});

describe("InMemoryProjectionCheckpointStore capacity", () => {
	it("rejects a new checkpoint atomically while allowing updates at capacity", async () => {
		const store = new InMemoryProjectionCheckpointStore({ maxCheckpoints: 1 });
		await store.save(undefined, "orders", address("o-1"), checkpoint(1));

		await expect(
			store.save(undefined, "orders", address("o-2"), checkpoint(1)),
		).rejects.toMatchObject({
			code: "IN_MEMORY_CAPACITY_EXCEEDED",
			store: "InMemoryProjectionCheckpointStore",
			resource: "checkpoints",
			limit: 1,
			current: 1,
			attempted: 1,
		});
		await expect(
			store.load(undefined, "orders", address("o-2")),
		).resolves.toBeUndefined();

		await store.save(undefined, "orders", address("o-1"), checkpoint(2));
		await expect(
			store.load(undefined, "orders", address("o-1")),
		).resolves.toEqual(checkpoint(2));
	});

	it("counts checkpoints globally and reset releases their capacity", async () => {
		const store = new InMemoryProjectionCheckpointStore({ maxCheckpoints: 1 });
		await store.save(undefined, "orders", address("o-1"), checkpoint(1));

		await expect(
			store.save(undefined, "audit", address("o-1"), checkpoint(1)),
		).rejects.toBeInstanceOf(InMemoryCapacityExceededError);

		await store.reset(undefined, "orders");
		await expect(
			store.save(undefined, "audit", address("o-1"), checkpoint(1)),
		).resolves.toBeUndefined();
	});

	it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
		"rejects invalid maxCheckpoints capacity %s",
		(maxCheckpoints) => {
			expect(
				() => new InMemoryProjectionCheckpointStore({ maxCheckpoints }),
			).toThrow(RangeError);
		},
	);
});
