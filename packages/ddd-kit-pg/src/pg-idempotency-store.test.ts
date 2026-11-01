import {
	type AnyDomainEvent,
	outboxWriterAcceptingEventLoss,
	withIdempotentCommit,
} from "@shirudo/ddd-kit";
import { createIdempotencyStoreContractTests } from "@shirudo/ddd-kit/testing";
import { describe, expect, it } from "vite-plus/test";
import { openIsolatedSchema } from "../test/isolated-schema";
import { PgIdempotencyStore } from "./pg-idempotency-store";
import type { PgQueryExecutor } from "./pg-query-executor";
import { PgTransactionScope } from "./pg-transaction-scope";

const ROLLBACK = new Error("the contract suite asked for a rollback");

async function openStore() {
	const database = await openIsolatedSchema();
	await database.applySql("idempotency.sql");
	return {
		database,
		scope: new PgTransactionScope(database.pool),
		store: new PgIdempotencyStore(),
	};
}

describe("PgIdempotencyStore contract suite", () => {
	const tests = createIdempotencyStoreContractTests<PgQueryExecutor>({
		createEnvironment: async () => {
			const { database, scope, store } = await openStore();
			return {
				store,
				run: (work) => scope.transactional(work),
				runRolledBack: (work) =>
					scope.transactional(async (ctx) => {
						await work(ctx);
						throw ROLLBACK;
					}),
				teardown: database.teardown,
			};
		},
	});

	for (const test of tests) {
		(test.skipped ? it.skip : it)(test.name, test.run);
	}

	it("runs with zero skips", () => {
		expect(tests.filter((test) => test.skipped)).toEqual([]);
	});
});

describe("PgIdempotencyStore", () => {
	const claimAndComplete = (
		{ scope, store }: Awaited<ReturnType<typeof openStore>>,
		key: string,
		outcome: unknown,
	) =>
		scope.transactional(async (ctx) => {
			const claim = await store.claim(ctx, key, "fingerprint");
			if (claim.status !== "claimed") throw new Error("expected a fresh key");
			await store.complete(ctx, claim.claim, outcome);
		});

	it.each([
		["an object", { total: 42 }],
		["null", null],
		["undefined", undefined],
	])("replays %s as the outcome", async (_name, outcome) => {
		const opened = await openStore();
		await claimAndComplete(opened, "key", outcome);

		const replay = await opened.scope.transactional((ctx) =>
			opened.store.claim(ctx, "key", "fingerprint"),
		);

		expect(replay).toStrictEqual({ status: "completed", outcome });
		await opened.database.teardown();
	});

	it("rejects an outcome that JSON does not keep and names the path", async () => {
		const opened = await openStore();

		await expect(
			claimAndComplete(opened, "key", { confirmedAt: new Date(0) }),
		).rejects.toThrow(/outcome of key "key": \$\.confirmedAt is not JSON-safe/);

		await opened.database.teardown();
	});

	describe("a claim while another transaction holds the key", () => {
		/** Holds the claim in an open transaction until the returned function ends it. */
		const holdClaim = async (
			{ scope, store }: Awaited<ReturnType<typeof openStore>>,
			end: "commit" | "roll back",
		) => {
			let claimed!: () => void;
			const hasClaim = new Promise<void>((resolve) => {
				claimed = resolve;
			});
			let release!: () => void;
			const released = new Promise<void>((resolve) => {
				release = resolve;
			});
			const transaction = scope.transactional(async (ctx) => {
				const claim = await store.claim(ctx, "key", "fingerprint");
				if (claim.status !== "claimed") throw new Error("expected a claim");
				await store.complete(ctx, claim.claim, "first");
				claimed();
				await released;
				if (end === "roll back") throw ROLLBACK;
			});
			await hasClaim;
			return async () => {
				release();
				await transaction.catch((error: unknown) => {
					if (error !== ROLLBACK) throw error;
				});
			};
		};

		it("throws IdempotencyInFlightError at once and blocks no connection", async () => {
			const opened = await openStore();
			const { scope, store } = opened;
			const endFirst = await holdClaim(opened, "commit");

			await expect(
				scope.transactional((ctx) => store.claim(ctx, "key", "fingerprint")),
			).rejects.toMatchObject({
				code: "IDEMPOTENCY_IN_FLIGHT",
				retryable: true,
			});

			await endFirst();
			await opened.database.teardown();
		});

		it("replays the outcome after the other transaction committed", async () => {
			const opened = await openStore();
			const { scope, store } = opened;
			const endFirst = await holdClaim(opened, "commit");
			await endFirst();

			const replay = await scope.transactional((ctx) =>
				store.claim(ctx, "key", "fingerprint"),
			);

			expect(replay).toStrictEqual({ status: "completed", outcome: "first" });
			await opened.database.teardown();
		});

		it("claims the key after the other transaction rolled back", async () => {
			const opened = await openStore();
			const { scope, store } = opened;
			const endFirst = await holdClaim(opened, "roll back");
			await endFirst();

			const claim = await scope.transactional((ctx) =>
				store.claim(ctx, "key", "fingerprint"),
			);

			expect(claim.status).toBe("claimed");
			await opened.database.teardown();
		});

		it("does not block another key", async () => {
			const opened = await openStore();
			const { scope, store } = opened;
			const endFirst = await holdClaim(opened, "commit");

			const claim = await scope.transactional((ctx) =>
				store.claim(ctx, "other key", "fingerprint"),
			);

			expect(claim.status).toBe("claimed");
			await endFirst();
			await opened.database.teardown();
		});
	});

	describe("with withIdempotentCommit", () => {
		const confirmOrder = (
			{ scope, store }: Awaited<ReturnType<typeof openStore>>,
			work: (ctx: PgQueryExecutor) => Promise<string>,
		) =>
			withIdempotentCommit(
				{
					scope,
					idempotency: store,
					outbox: outboxWriterAcceptingEventLoss<AnyDomainEvent>(),
				},
				{ key: "confirm-order-1", fingerprint: "fingerprint" },
				(ctx) => work(ctx),
			);

		it("runs the command once and replays its outcome", async () => {
			const opened = await openStore();
			let executions = 0;
			const work = async () => {
				executions += 1;
				return "confirmed";
			};

			const first = await confirmOrder(opened, work);
			const second = await confirmOrder(opened, work);

			expect(executions).toBe(1);
			expect(first).toMatchObject({ replayed: false, result: "confirmed" });
			expect(second).toMatchObject({ replayed: true, result: "confirmed" });
			await opened.database.teardown();
		});

		it("rolls back the write of a failed command together with its claim", async () => {
			const opened = await openStore();
			await opened.database.pool.query("CREATE TABLE confirmation (id int)");

			await expect(
				confirmOrder(opened, async (ctx) => {
					await ctx.query("INSERT INTO confirmation VALUES (1)");
					throw new Error("the command failed");
				}),
			).rejects.toThrow("the command failed");
			const retry = await confirmOrder(opened, async () => "confirmed");

			const { rows } = await opened.database.pool.query(
				"SELECT id FROM confirmation",
			);
			expect(rows).toEqual([]);
			expect(retry).toMatchObject({ replayed: false, result: "confirmed" });
			await opened.database.teardown();
		});
	});

	it("throws IdempotencyInFlightError for a second claim in the same transaction", async () => {
		const { database, scope, store } = await openStore();

		await expect(
			scope.transactional(async (ctx) => {
				await store.claim(ctx, "key", "fingerprint");
				await store.claim(ctx, "key", "fingerprint");
			}),
		).rejects.toMatchObject({ code: "IDEMPOTENCY_IN_FLIGHT" });

		await database.teardown();
	});
});
