import { describe, expect, it } from "vite-plus/test";
import * as api from "../src/index";

describe("the public API of the package", () => {
	it("exports exactly the pinned runtime names", () => {
		expect(Object.keys(api).sort()).toEqual([
			"PgCommitRolledBackError",
			"PgEventDecodeError",
			"PgEventStore",
			"PgEventStreamCorruptError",
			"PgIdempotencyStore",
			"PgOutbox",
			"PgRetryableTransactionFailureError",
			"PgRollbackFailedError",
			"PgTransactionScope",
			"PgUnsupportedIsolationLevelError",
			"fromPg",
			"fromPgPool",
		]);
	});
});
