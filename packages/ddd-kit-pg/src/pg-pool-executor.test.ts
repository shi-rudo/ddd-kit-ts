import { describe, expect, it } from "vite-plus/test";
import { openIsolatedSchema } from "../test/isolated-schema";
import { fromPgPool } from "./pg-pool-executor";

describe("fromPgPool", () => {
	it("runs a statement with a context at READ COMMITTED, whatever the default of the database", async () => {
		const serializable = await openIsolatedSchema({
			defaultTransactionIsolation: "serializable",
		});

		const { rows } = await fromPgPool(serializable.pool).query<{
			level: string;
		}>("SELECT current_setting('transaction_isolation') AS level", [], {
			signal: new AbortController().signal,
			deadlineAt: Date.now() + 5_000,
		});

		expect(rows[0]?.level).toBe("read committed");
		await serializable.teardown();
	});
});
