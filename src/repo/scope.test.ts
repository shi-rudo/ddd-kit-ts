import { describe, expect, it } from "vitest";
import type { TransactionScope } from "./scope";

describe("TransactionScope contract", () => {
	it("threads the context handle from `transactional` into the callback", async () => {
		type DrizzleLikeTx = { id: string; isTx: true };
		const tx: DrizzleLikeTx = { id: "tx-42", isTx: true };

		const scope: TransactionScope<DrizzleLikeTx> = {
			transactional: async <T>(fn: (ctx: DrizzleLikeTx) => Promise<T>) =>
				fn(tx),
		};

		let received: DrizzleLikeTx | undefined;
		await scope.transactional(async (ctx) => {
			received = ctx;
			return ctx.id;
		});

		expect(received).toBe(tx);
	});

	it("returns the callback's result to the caller", async () => {
		const scope: TransactionScope<undefined> = {
			transactional: (fn) => fn(undefined),
		};

		const result = await scope.transactional(async () => "result-value");
		expect(result).toBe("result-value");
	});

	it("propagates exceptions thrown by the callback", async () => {
		const scope: TransactionScope<undefined> = {
			transactional: (fn) => fn(undefined),
		};

		await expect(
			scope.transactional(async () => {
				throw new Error("inside transaction");
			}),
		).rejects.toThrow("inside transaction");
	});

	it("context-free scopes use TransactionScope<undefined> as the explicit no-ctx idiom", async () => {
		// No default for TCtx: context-free scopes spell it out so
		// "there is nothing meaningful here" is a conscious statement.
		const scope: TransactionScope<undefined> = {
			transactional: <T>(fn: (_ctx: undefined) => Promise<T>) => fn(undefined),
		};

		const ran = await scope.transactional(async (ctx) => {
			expect(ctx).toBeUndefined();
			return true;
		});

		expect(ran).toBe(true);
	});

	it("a Drizzle-flavoured scope wraps `db.transaction()` and forwards the tx handle", async () => {
		// Simulates the Drizzle / Prisma / Mongo session pattern: the
		// scope opens the persistence-layer's native transaction and
		// hands the tx handle to the callback so the use case can bind
		// its tx-scoped repos to that handle.
		type FakeDrizzleTx = {
			id: string;
			executed: string[];
		};

		class FakeDrizzleDb {
			async transaction<T>(
				fn: (tx: FakeDrizzleTx) => Promise<T>,
			): Promise<T> {
				const tx: FakeDrizzleTx = { id: "drizzle-tx", executed: [] };
				return fn(tx);
			}
		}

		class DrizzleScope implements TransactionScope<FakeDrizzleTx> {
			constructor(private db: FakeDrizzleDb) {}
			async transactional<T>(
				fn: (tx: FakeDrizzleTx) => Promise<T>,
			): Promise<T> {
				return this.db.transaction((tx) => fn(tx));
			}
		}

		const scope = new DrizzleScope(new FakeDrizzleDb());
		const captured = await scope.transactional(async (tx) => {
			tx.executed.push("INSERT order");
			tx.executed.push("INSERT outbox row");
			return tx.executed;
		});

		expect(captured).toEqual(["INSERT order", "INSERT outbox row"]);
	});
});
