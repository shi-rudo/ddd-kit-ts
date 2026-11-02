import { createSnapshotStoreContractTests } from "@shirudo/ddd-kit/testing";
import { describe, expect, it } from "vite-plus/test";
import { openIsolatedSchema } from "../test/isolated-schema";
import { fromPgPool } from "./pg-query-executor";
import { PgSnapshotStore } from "./pg-snapshot-store";

describe("PgSnapshotStore contract suite", () => {
	const tests = createSnapshotStoreContractTests({
		createEnvironment: async () => {
			const database = await openIsolatedSchema();
			await database.applySql("snapshot.sql");
			return {
				store: new PgSnapshotStore(fromPgPool(database.pool)),
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
