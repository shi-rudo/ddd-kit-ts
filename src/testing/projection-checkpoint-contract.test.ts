import { describe, expect, it } from "vitest";
import { InMemoryProjectionCheckpointStore } from "../projections/in-memory-checkpoint-store";
import {
	createProjectionCheckpointStoreContractTests,
	type ProjectionCheckpointStoreContractHarness,
} from "./projection-checkpoint-contract";

function createInMemoryHarness(): ProjectionCheckpointStoreContractHarness<unknown> {
	return {
		createEnvironment: async () => ({
			store: new InMemoryProjectionCheckpointStore(),
			run: (work) => work(undefined),
			// No runRolledBack: the in-memory store is not transaction-aware
			// (documented limitation); the rollback test stays visible as
			// skipped.
		}),
	};
}

describe("projection-checkpoint-store contract suite against the in-memory reference", () => {
	const tests = createProjectionCheckpointStoreContractTests(
		createInMemoryHarness(),
	);

	for (const test of tests) {
		(test.skipped ? it.skip : it)(test.name, test.run);
	}

	it("only the rollback test is skipped for the in-memory reference", () => {
		const skipped = tests.filter((test) => test.skipped);
		expect(skipped.map((test) => test.skipped?.capability)).toEqual([
			"providesRolledBackRuns",
		]);
	});
});
