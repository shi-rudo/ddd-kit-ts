import { describe, expect, it } from "vite-plus/test";
import { InMemoryProjectionCheckpointStore } from "../application/projections/adapters/in-memory-checkpoint-store";
import { InMemoryTransactionScope } from "../persistence/repository/adapters/in-memory-transaction-scope";
import {
	createProjectionCheckpointStoreContractTests,
	type ProjectionCheckpointStoreContractHarness,
} from "./projection-checkpoint-contract";

const ROLLBACK = Symbol("rollback");

function createInMemoryHarness(): ProjectionCheckpointStoreContractHarness<unknown> {
	return {
		createEnvironment: async () => {
			const store = new InMemoryProjectionCheckpointStore();
			const scope = new InMemoryTransactionScope([store]);
			return {
				store,
				run: (work) => scope.transactional(work),
				// The scope runs one transaction at a time, so concurrent runs
				// bypass it.
				runConcurrently: (works) =>
					Promise.all(works.map((work) => work(undefined))),
				runRolledBack: async (work) => {
					let result: Awaited<ReturnType<typeof work>> | undefined;
					await scope
						.transactional(async (ctx) => {
							result = await work(ctx);
							throw ROLLBACK;
						})
						.catch((error: unknown) => {
							if (error !== ROLLBACK) throw error;
						});
					return result as Awaited<ReturnType<typeof work>>;
				},
			};
		},
		providesConcurrentRuns: true,
		providesRolledBackRuns: true,
	};
}

describe("projection-checkpoint-store contract suite against the in-memory reference", () => {
	const tests = createProjectionCheckpointStoreContractTests(
		createInMemoryHarness(),
	);

	for (const test of tests) {
		(test.skipped ? it.skip : it)(test.name, test.run);
	}

	it("no test is skipped for the in-memory reference", () => {
		expect(tests.filter((test) => test.skipped)).toEqual([]);
	});
});
