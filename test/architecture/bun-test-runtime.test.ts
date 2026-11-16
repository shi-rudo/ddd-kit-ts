import { describe, expect, it } from "vite-plus/test";

const requestedRuntime = (
	globalThis as { process?: { env?: Record<string, string | undefined> } }
).process?.env?.KIT_TEST_RUNTIME;

describe("the test runtime", () => {
	// `pnpm test:bun` sets KIT_TEST_RUNTIME. A runner that starts its workers
	// with Node, as `vp test` does under `bun --bun`, would pass the Bun job
	// without a single test in Bun.
	it("is Bun exactly when KIT_TEST_RUNTIME asks for Bun", () => {
		expect("Bun" in globalThis).toBe(requestedRuntime === "bun");
	});
});
