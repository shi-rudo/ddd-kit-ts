import { DeadlineProcessor } from "@shirudo/ddd-kit";
import {
	createDeadlineStoreContractTests,
	type DeadlineStoreContractPayload,
} from "@shirudo/ddd-kit/testing";
import { describe, expect, it } from "vite-plus/test";
import { openIsolatedSchema } from "../test/isolated-schema";
import { PgDeadlineStore } from "./pg-deadline-store";
import { fromPgPool, type PgQueryExecutor } from "./pg-query-executor";
import { PgTransactionScope } from "./pg-transaction-scope";

const ATTEMPT_CEILING = 3;
const ROLLBACK = new Error("the contract suite asked for a rollback");

describe("PgDeadlineStore contract suite", () => {
	const tests = createDeadlineStoreContractTests({
		createEnvironment: async () => {
			const database = await openIsolatedSchema();
			await database.applySql("deadline.sql");
			const scope = new PgTransactionScope(database.pool);
			const poll = fromPgPool(database.pool);
			const options = { maxDeliveryAttempts: ATTEMPT_CEILING };
			const pollStore = new PgDeadlineStore<DeadlineStoreContractPayload>(
				poll,
				options,
			);
			// The suite calls one store inside and outside its transactions, so the
			// write side of this harness follows the transaction that is open.
			let transaction: PgQueryExecutor | undefined;
			const writeStore = () =>
				new PgDeadlineStore<DeadlineStoreContractPayload>(
					transaction ?? poll,
					options,
				);
			const inTransaction = <R>(work: () => Promise<R>) =>
				scope.transactional(async (tx) => {
					transaction = tx;
					try {
						return await work();
					} finally {
						transaction = undefined;
					}
				});
			return {
				store: {
					schedule: (deadline) => writeStore().schedule(deadline),
					cancel: (processName, key) => writeStore().cancel(processName, key),
					due: (now, limit, context) => pollStore.due(now, limit, context),
					markDelivered: (ids, context) =>
						pollStore.markDelivered(ids, context),
					markFailed: (id, error, context) =>
						pollStore.markFailed(id, error, context),
					deadLetters: () => pollStore.deadLetters(),
				},
				run: inTransaction,
				runRolledBack: async (work) => {
					await inTransaction(async () => {
						await work();
						throw ROLLBACK;
					}).catch((error: unknown) => {
						if (error !== ROLLBACK) throw error;
					});
					return undefined as never;
				},
				teardown: database.teardown,
			};
		},
		failuresToDeadLetter: ATTEMPT_CEILING,
		providesRolledBackRuns: true,
	});

	for (const test of tests) {
		(test.skipped ? it.skip : it)(test.name, test.run);
	}

	it("runs with zero skips", () => {
		expect(tests.filter((test) => test.skipped)).toEqual([]);
	});
});

describe("PgDeadlineStore", () => {
	const openStore = async () => {
		const database = await openIsolatedSchema();
		await database.applySql("deadline.sql");
		return {
			database,
			scope: new PgTransactionScope(database.pool),
			store: new PgDeadlineStore<unknown>(fromPgPool(database.pool)),
		};
	};
	const at = new Date("2026-03-01T10:00:00.000Z");

	it.each([
		["an object", { kind: "timeout" }],
		["null", null],
		["undefined", undefined],
	])("delivers %s as the payload", async (_name, payload) => {
		const { database, store } = await openStore();

		await store.schedule({
			processName: "saga",
			key: "order-1",
			dueAt: at,
			payload,
		});

		const [due] = await store.due(at, 1);
		expect(due).toHaveProperty("payload");
		expect(due?.payload).toStrictEqual(payload);
		await database.teardown();
	});

	it("rejects a payload that JSON does not keep and schedules nothing", async () => {
		const { database, store } = await openStore();

		await expect(
			store.schedule({
				processName: "saga",
				key: "order-1",
				dueAt: at,
				payload: { at: new Date(0) },
			}),
		).rejects.toThrow(/payload: \$\.at is not JSON-safe/);

		expect(await store.due(at, 1)).toEqual([]);
		await database.teardown();
	});

	it("joins the transaction of the store that the callback built", async () => {
		const { database, scope, store } = await openStore();

		await expect(
			scope.transactional(async (tx) => {
				await new PgDeadlineStore(tx).schedule({
					processName: "saga",
					key: "order-1",
					dueAt: at,
					payload: {},
				});
				expect(await store.due(at, 1)).toEqual([]);
				throw ROLLBACK;
			}),
		).rejects.toBe(ROLLBACK);

		expect(await store.due(at, 1)).toEqual([]);
		await database.teardown();
	});

	it("delivers through DeadlineProcessor and stops returning a delivered deadline", async () => {
		const { database, store } = await openStore();
		await store.schedule({
			processName: "saga",
			key: "order-1",
			dueAt: at,
			payload: { kind: "timeout" },
		});
		const delivered: unknown[] = [];
		const processor = new DeadlineProcessor<unknown>({
			store,
			deliveryTimeoutMs: 5_000,
			storageTimeoutMs: 5_000,
			handler: async (deadline) => {
				delivered.push(deadline.payload);
			},
			observers: {
				onDeliveryError: () => {},
				onPollError: () => {},
				onDeadLetter: () => {},
			},
		});

		await processor.drainOnce();

		expect(delivered).toEqual([{ kind: "timeout" }]);
		expect(await store.due(at, 1)).toEqual([]);
		await database.teardown();
	});

	it("keeps the scheduling order for an equal due time", async () => {
		const { database, store } = await openStore();
		for (const key of ["c", "a", "b"]) {
			await store.schedule({
				processName: "saga",
				key,
				dueAt: at,
				payload: {},
			});
		}

		const due = await store.due(at, 10);

		expect(due.map(({ key }) => key)).toEqual(["c", "a", "b"]);
		await database.teardown();
	});

	it("stops waiting for a hanging poll when the signal aborts", async () => {
		const hanging: PgQueryExecutor = { query: () => new Promise(() => {}) };
		const controller = new AbortController();
		const reason = new Error("the deadline passed");

		const poll = new PgDeadlineStore(hanging).due(at, 1, {
			signal: controller.signal,
			deadlineAt: Date.now() + 1_000,
		});
		controller.abort(reason);

		await expect(poll).rejects.toBe(reason);
	});
});
