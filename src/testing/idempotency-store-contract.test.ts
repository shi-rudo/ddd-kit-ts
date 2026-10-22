import { describe, expect, it } from "vite-plus/test";
import { InMemoryIdempotencyStore } from "../application/idempotency/adapters/in-memory-idempotency-store";
import { InMemoryTransactionScope } from "../persistence/repository/adapters/in-memory-transaction-scope";
import type { InMemoryTransaction } from "../persistence/repository/in-memory-transaction";
import {
	createIdempotencyStoreContractTests,
	type IdempotencyStoreContractHarness,
} from "./idempotency-store-contract";

const ROLLBACK = Symbol("rollback");

/** A store whose rollback keeps the writes: the rollback test must reject it. */
class IdempotencyStoreKeepingRolledBackWrites extends InMemoryIdempotencyStore<undefined> {
	override beginTransaction(): InMemoryTransaction {
		const transaction = super.beginTransaction();
		return {
			commit: () => transaction.commit(),
			rollback: () => transaction.commit(),
		};
	}
}

function createInMemoryHarness(
	createStore = () => new InMemoryIdempotencyStore<undefined>(),
): IdempotencyStoreContractHarness<undefined> {
	return {
		createEnvironment: async () => {
			const store = createStore();
			const scope = new InMemoryTransactionScope([store]);
			return {
				store,
				run: (work) => scope.transactional(work),
				runRolledBack: (work) =>
					scope.transactional(async (ctx) => {
						await work(ctx);
						throw ROLLBACK;
					}),
			};
		},
	};
}

describe("idempotency-store contract suite against InMemoryIdempotencyStore", () => {
	const tests = createIdempotencyStoreContractTests(createInMemoryHarness());

	for (const test of tests) {
		(test.skipped ? it.skip : it)(test.name, test.run);
	}

	it("no test is skipped for the in-memory reference", () => {
		expect(tests.filter((test) => test.skipped)).toEqual([]);
	});

	it("the rollback test rejects a store whose rollback keeps the writes", async () => {
		const rollbackTest = createIdempotencyStoreContractTests(
			createInMemoryHarness(
				() => new IdempotencyStoreKeepingRolledBackWrites(),
			),
		).find(
			(test) => test.name === "a rolled-back transaction releases the claim",
		);

		await expect(rollbackTest?.run()).rejects.toThrow(
			"a rolled-back claim and complete must leave the key claimable",
		);
	});
});
