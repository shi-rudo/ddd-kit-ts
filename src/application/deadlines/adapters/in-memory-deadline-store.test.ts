import { describe, expect, it } from "vite-plus/test";
import { InMemoryCapacityExceededError } from "../../../errors/kit-errors";
import { InMemoryTransactionScope } from "../../../persistence/repository/adapters/in-memory-transaction-scope";
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
		if (record === undefined)
			throw new Error("expected the scheduled deadline");
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

describe("InMemoryDeadlineStore in an InMemoryTransactionScope", () => {
	it("restores attempts and the pending state after a rolled-back dead-lettering", async () => {
		const store = new InMemoryDeadlineStore({ maxDeliveryAttempts: 2 });
		const scope = new InMemoryTransactionScope([store]);
		await store.schedule({ scope: "orders", key: "o-1", dueAt, payload: 1 });
		const [record] = await store.due(dueAt, 1);
		if (record === undefined) throw new Error("expected a due deadline");
		await store.markFailed(record.deliveryId, "first");

		await scope
			.transactional(async () => {
				await store.markFailed(record.deliveryId, "second");
				throw new Error("work failed");
			})
			.catch(() => {});

		expect(await store.deadLetters()).toEqual([]);
		expect(await store.due(dueAt, 1)).toMatchObject([
			{ deliveryId: record.deliveryId, attempts: 1 },
		]);
	});

	async function dueWhileOpen(
		scope: InMemoryTransactionScope,
		store: InMemoryDeadlineStore,
		write: () => Promise<void>,
	) {
		let release!: () => void;
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		let written!: () => void;
		const workWritten = new Promise<void>((resolve) => {
			written = resolve;
		});
		const transaction = scope.transactional(async () => {
			await write();
			written();
			await released;
		});
		await workWritten;
		const due = await store.due(dueAt, 10);
		release();
		await transaction;
		return due;
	}

	it("returns a committed deadline that an open transaction cancels", async () => {
		const store = new InMemoryDeadlineStore();
		const scope = new InMemoryTransactionScope([store]);
		await scope.transactional(() =>
			store.schedule({ scope: "orders", key: "o-1", dueAt, payload: 1 }),
		);

		const duringTransaction = await dueWhileOpen(scope, store, () =>
			store.cancel("orders", "o-1"),
		);

		expect(duringTransaction).toMatchObject([{ key: "o-1" }]);
		expect(await store.due(dueAt, 10)).toEqual([]);
	});

	it("returns the committed incarnation of a deadline that an open transaction reschedules", async () => {
		const store = new InMemoryDeadlineStore();
		const scope = new InMemoryTransactionScope([store]);
		await scope.transactional(() =>
			store.schedule({ scope: "orders", key: "o-1", dueAt, payload: 1 }),
		);

		const duringTransaction = await dueWhileOpen(scope, store, () =>
			store.schedule({ scope: "orders", key: "o-1", dueAt, payload: 2 }),
		);

		expect(duringTransaction).toMatchObject([{ key: "o-1", payload: 1 }]);
		expect(await store.due(dueAt, 10)).toMatchObject([
			{ key: "o-1", payload: 2 },
		]);
	});

	it("does not return a committed deadline again after a processor acknowledged it", async () => {
		const store = new InMemoryDeadlineStore();
		const scope = new InMemoryTransactionScope([store]);
		await scope.transactional(() =>
			store.schedule({ scope: "orders", key: "o-1", dueAt, payload: 1 }),
		);
		let releaseWork!: () => void;
		const workReleased = new Promise<void>((resolve) => {
			releaseWork = resolve;
		});
		let cancelled!: () => void;
		const workCancelled = new Promise<void>((resolve) => {
			cancelled = resolve;
		});
		const transaction = scope.transactional(async () => {
			await store.cancel("orders", "o-1");
			cancelled();
			await workReleased;
		});
		await workCancelled;

		const [delivered] = await store.due(dueAt, 10);
		await store.markDelivered([delivered?.deliveryId ?? ""]);
		const nextPoll = await store.due(dueAt, 10);
		releaseWork();
		await transaction;

		expect(delivered).toMatchObject({ key: "o-1" });
		expect(nextPoll).toEqual([]);
	});

	it("hides the deadlines of an open transaction from due until the commit", async () => {
		const store = new InMemoryDeadlineStore();
		const scope = new InMemoryTransactionScope([store]);
		await scope.transactional(() =>
			store.schedule({ scope: "orders", key: "o-1", dueAt, payload: 1 }),
		);
		let release!: () => void;
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		let scheduled!: () => void;
		const workScheduled = new Promise<void>((resolve) => {
			scheduled = resolve;
		});

		const transaction = scope.transactional(async () => {
			await store.schedule({ scope: "orders", key: "o-2", dueAt, payload: 2 });
			scheduled();
			await released;
		});
		await workScheduled;
		const duringTransaction = await store.due(dueAt, 10);
		release();
		await transaction;

		expect(duringTransaction.map((deadline) => deadline.key)).toEqual(["o-1"]);
		expect(
			(await store.due(dueAt, 10)).map((deadline) => deadline.key),
		).toEqual(["o-1", "o-2"]);
	});

	it("keeps the writes of a committed transaction", async () => {
		const store = new InMemoryDeadlineStore();
		const scope = new InMemoryTransactionScope([store]);

		await scope.transactional(() =>
			store.schedule({ scope: "orders", key: "o-1", dueAt, payload: 1 }),
		);

		expect(await store.due(dueAt, 10)).toMatchObject([{ key: "o-1" }]);
	});
});
