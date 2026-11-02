import { describe, expect, it } from "vite-plus/test";
import * as api from "../src/index";

describe("the public API of the package", () => {
	it("exports exactly the pinned runtime names", () => {
		expect(Object.keys(api).sort()).toEqual([
			"PgCommitRolledBackError",
			"PgDeadlineStore",
			"PgEventStore",
			"PgEventStreamCorruptError",
			"PgIdempotencyStore",
			"PgOutbox",
			"PgProjectionCheckpointStore",
			"PgRetryableTransactionFailureError",
			"PgRollbackFailedError",
			"PgSnapshotStore",
			"PgTransactionScope",
			"fromPg",
			"fromPgPool",
		]);
	});
});
