import { describe, expect, it } from "vitest";
import { InMemorySnapshotStore } from "../repo/in-memory-snapshot-store";
import { createSnapshotStoreContractTests } from "./snapshot-store-contract";

describe("snapshot-store contract suite against the in-memory reference", () => {
	const tests = createSnapshotStoreContractTests({
		createEnvironment: async () => ({
			store: new InMemorySnapshotStore(),
		}),
	});

	for (const test of tests) {
		(test.skipped ? it.skip : it)(test.name, test.run);
	}

	it("the suite has no capability gates: every guarantee is provable in memory", () => {
		expect(tests.filter((test) => test.skipped)).toEqual([]);
	});
});
