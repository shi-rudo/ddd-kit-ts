import { describe, expect, it } from "vite-plus/test";
import { InMemoryCapacityExceededError } from "../../../errors/kit-errors";
import { InMemoryTransactionScope } from "../../../persistence/repository/adapters/in-memory-transaction-scope";
import { InMemoryProjectionCheckpointStore } from "./in-memory-checkpoint-store";

const identity = (aggregateId: string) => ({
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
		await store.save(undefined, "orders", identity("o-1"), checkpoint(1));

		await expect(
			store.save(undefined, "orders", identity("o-2"), checkpoint(1)),
		).rejects.toMatchObject({
			code: "IN_MEMORY_CAPACITY_EXCEEDED",
			store: "InMemoryProjectionCheckpointStore",
			resource: "checkpoints",
			limit: 1,
			current: 1,
			attempted: 1,
		});
		await expect(
			store.load(undefined, "orders", identity("o-2")),
		).resolves.toBeUndefined();

		await store.save(undefined, "orders", identity("o-1"), checkpoint(2));
		await expect(
			store.load(undefined, "orders", identity("o-1")),
		).resolves.toEqual(checkpoint(2));
	});

	it("counts checkpoints globally and reset releases their capacity", async () => {
		const store = new InMemoryProjectionCheckpointStore({ maxCheckpoints: 1 });
		await store.save(undefined, "orders", identity("o-1"), checkpoint(1));

		await expect(
			store.save(undefined, "audit", identity("o-1"), checkpoint(1)),
		).rejects.toBeInstanceOf(InMemoryCapacityExceededError);

		await store.reset(undefined, "orders");
		await expect(
			store.save(undefined, "audit", identity("o-1"), checkpoint(1)),
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

describe("InMemoryProjectionCheckpointStore and caller code in a checkpoint", () => {
	it("checks the capacity after a checkpoint getter saved another checkpoint", async () => {
		const store = new InMemoryProjectionCheckpointStore({ maxCheckpoints: 1 });
		let inner: Promise<void> | undefined;
		const outerCheckpoint = {
			...checkpoint(1),
			get lastAppliedEventId() {
				inner ??= store.save(
					undefined,
					"orders",
					identity("o-2"),
					checkpoint(1),
				);
				return "evt-1";
			},
		};

		const outer = store.save(
			undefined,
			"orders",
			identity("o-1"),
			outerCheckpoint,
		);

		await expect(outer).rejects.toBeInstanceOf(InMemoryCapacityExceededError);
		await expect(inner).resolves.toBeUndefined();
		expect(await store.load(undefined, "orders", identity("o-1"))).toBe(
			undefined,
		);
	});

	it("reads the position of a checkpoint once", async () => {
		const store = new InMemoryProjectionCheckpointStore();
		let positionReads = 0;
		const counted = {
			lastAppliedEventId: "evt-1",
			get position() {
				positionReads += 1;
				return checkpoint(1).position;
			},
		};

		await store.save(undefined, "orders", identity("o-1"), counted);

		expect(positionReads).toBe(1);
	});
});

describe("InMemoryProjectionCheckpointStore in an InMemoryTransactionScope", () => {
	it("restores the checkpoints of a rolled-back reset", async () => {
		const store = new InMemoryProjectionCheckpointStore();
		const scope = new InMemoryTransactionScope([store]);
		await store.save(undefined, "orders", identity("o-1"), checkpoint(2));

		await scope
			.transactional(async () => {
				await store.reset(undefined, "orders");
				throw new Error("rebuild failed");
			})
			.catch(() => {});

		expect(await store.load(undefined, "orders", identity("o-1"))).toEqual(
			checkpoint(2),
		);
	});

	it("releases the capacity of a rolled-back new checkpoint", async () => {
		const store = new InMemoryProjectionCheckpointStore({ maxCheckpoints: 1 });
		const scope = new InMemoryTransactionScope([store]);

		await scope
			.transactional(async () => {
				await store.save(undefined, "orders", identity("o-1"), checkpoint(1));
				throw new Error("batch failed");
			})
			.catch(() => {});

		await expect(
			store.save(undefined, "orders", identity("o-2"), checkpoint(1)),
		).resolves.toBeUndefined();
		expect(await store.load(undefined, "orders", identity("o-1"))).toBe(
			undefined,
		);
	});

	it("answers hasReached from the committed checkpoints while a transaction is open", async () => {
		const store = new InMemoryProjectionCheckpointStore();
		const scope = new InMemoryTransactionScope([store]);
		await scope.transactional(() =>
			store.save(undefined, "orders", identity("o-1"), checkpoint(1)),
		);
		let release!: () => void;
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		let saved!: () => void;
		const workSaved = new Promise<void>((resolve) => {
			saved = resolve;
		});

		const transaction = scope.transactional(async () => {
			await store.save(undefined, "orders", identity("o-1"), checkpoint(2));
			saved();
			await released;
		});
		await workSaved;
		const reachedDuringTransaction = await store.hasReached(
			"orders",
			identity("o-1"),
			checkpoint(2).position,
		);
		release();
		await transaction;

		expect(reachedDuringTransaction).toBe(false);
		expect(
			await store.hasReached("orders", identity("o-1"), checkpoint(2).position),
		).toBe(true);
	});

	it("does not release a checkpoint lock that a caller still holds after a rollback", async () => {
		const store = new InMemoryProjectionCheckpointStore();
		const scope = new InMemoryTransactionScope([store]);
		const steps: string[] = [];
		let releaseHolder!: () => void;
		const holderReleased = new Promise<void>((resolve) => {
			releaseHolder = resolve;
		});
		let holder!: Promise<void>;

		await scope
			.transactional(async () => {
				holder = store.withCheckpointLocks(
					undefined,
					"orders",
					[identity("o-1")],
					() => holderReleased,
				);
				throw new Error("batch failed");
			})
			.catch(() => {});
		const waiter = store.withCheckpointLocks(
			undefined,
			"orders",
			[identity("o-1")],
			async () => {
				steps.push("waiter");
			},
		);
		await Promise.resolve();
		steps.push("holder released");
		releaseHolder();
		await Promise.all([holder, waiter]);

		expect(steps).toEqual(["holder released", "waiter"]);
	});
});
