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

describe("InMemoryDeadlineStore and caller code in a deadline", () => {
	it("checks the capacity after a payload getter scheduled another deadline", async () => {
		const store = new InMemoryDeadlineStore<unknown>({ maxRecords: 1 });
		let inner: Promise<void> | undefined;
		const payload = {
			get note() {
				inner ??= store.schedule({
					scope: "orders",
					key: "o-2",
					dueAt,
					payload: 2,
				});
				return "outer";
			},
		};

		const outer = store.schedule({
			scope: "orders",
			key: "o-1",
			dueAt,
			payload,
		});

		await expect(outer).rejects.toBeInstanceOf(InMemoryCapacityExceededError);
		await expect(inner).resolves.toBeUndefined();
		expect(
			(await store.due(dueAt, 10)).map((deadline) => deadline.key),
		).toEqual(["o-2"]);
	});

	it("reads the address of a deadline once", async () => {
		const store = new InMemoryDeadlineStore();
		let scopeReads = 0;
		let keyReads = 0;
		const deadline = {
			get scope() {
				scopeReads += 1;
				return "orders";
			},
			get key() {
				keyReads += 1;
				return "o-1";
			},
			dueAt,
			payload: 1,
		};

		await store.schedule(deadline);

		expect({ scopeReads, keyReads }).toEqual({ scopeReads: 1, keyReads: 1 });
	});
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

	it("does not return a committed deadline that a processor dead-lettered before the transaction cancelled it", async () => {
		const store = new InMemoryDeadlineStore({ maxDeliveryAttempts: 1 });
		const scope = new InMemoryTransactionScope([store]);
		await scope.transactional(() =>
			store.schedule({ scope: "orders", key: "o-1", dueAt, payload: 1 }),
		);
		const [committed] = await store.due(dueAt, 10);
		let releaseWork!: () => void;
		const workReleased = new Promise<void>((resolve) => {
			releaseWork = resolve;
		});
		let deadLettered!: () => void;
		const failureReported = new Promise<void>((resolve) => {
			deadLettered = resolve;
		});
		let cancelled!: () => void;
		const workCancelled = new Promise<void>((resolve) => {
			cancelled = resolve;
		});
		let began!: () => void;
		const transactionBegan = new Promise<void>((resolve) => {
			began = resolve;
		});
		const transaction = scope.transactional(async () => {
			began();
			await failureReported;
			await store.cancel("orders", "o-1");
			cancelled();
			await workReleased;
		});
		await transactionBegan;

		await store.markFailed(committed?.deliveryId ?? "", "poison");
		deadLettered();
		await workCancelled;
		const duringTransaction = await store.due(dueAt, 10);
		releaseWork();
		await transaction;

		expect(duringTransaction).toEqual([]);
	});

	it("returns the attempts that a failure report recorded before the transaction rescheduled the deadline", async () => {
		const store = new InMemoryDeadlineStore({ maxDeliveryAttempts: 5 });
		const scope = new InMemoryTransactionScope([store]);
		await scope.transactional(() =>
			store.schedule({ scope: "orders", key: "o-1", dueAt, payload: 1 }),
		);
		const [committed] = await store.due(dueAt, 10);
		let began!: () => void;
		const transactionBegan = new Promise<void>((resolve) => {
			began = resolve;
		});
		let failed!: () => void;
		const failureReported = new Promise<void>((resolve) => {
			failed = resolve;
		});
		let rescheduled!: () => void;
		const workRescheduled = new Promise<void>((resolve) => {
			rescheduled = resolve;
		});
		let releaseWork!: () => void;
		const workReleased = new Promise<void>((resolve) => {
			releaseWork = resolve;
		});
		const transaction = scope.transactional(async () => {
			began();
			await failureReported;
			await store.schedule({ scope: "orders", key: "o-1", dueAt, payload: 2 });
			rescheduled();
			await workReleased;
		});
		await transactionBegan;

		await store.markFailed(committed?.deliveryId ?? "", "first");
		failed();
		await workRescheduled;
		const duringTransaction = await store.due(dueAt, 10);
		releaseWork();
		await transaction;

		expect(duringTransaction).toMatchObject([
			{ deliveryId: committed?.deliveryId, attempts: 1 },
		]);
	});

	it("stops returning a committed deadline at the attempt ceiling while the transaction is open", async () => {
		const store = new InMemoryDeadlineStore({ maxDeliveryAttempts: 2 });
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

		const polls: number[] = [];
		for (let poll = 0; poll < 3; poll += 1) {
			const due = await store.due(dueAt, 10);
			polls.push(due.length);
			for (const deadline of due) {
				await store.markFailed(deadline.deliveryId, "handler failed");
			}
		}
		releaseWork();
		await transaction;

		expect(polls).toEqual([1, 1, 0]);
	});

	it("keeps returning the live deadline after a schedule that failed before it wrote", async () => {
		const store = new InMemoryDeadlineStore<unknown>({
			maxDeliveryAttempts: 5,
		});
		const scope = new InMemoryTransactionScope([store]);
		await scope.transactional(() =>
			store.schedule({ scope: "orders", key: "o-1", dueAt, payload: 1 }),
		);
		const [committed] = await store.due(dueAt, 10);

		const duringTransaction = await dueWhileOpen(scope, store, async () => {
			await store
				.schedule({ scope: "orders", key: "o-1", dueAt, payload: () => 2 })
				.catch(() => {});
			await store.markFailed(committed?.deliveryId ?? "", "boom");
		});

		expect(duringTransaction).toMatchObject([
			{ deliveryId: committed?.deliveryId, attempts: 1 },
		]);
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
