// @ts-expect-error Node's fs module exists in the test runtime; the package stays Node-type-free.
import { existsSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

const moduleDirectory = new URL(".", import.meta.url);

describe("domain state machine module architecture", () => {
	it.each([
		"analyzer.ts",
		"contracts.ts",
		"errors.ts",
		"machine-data.ts",
		"definition.ts",
		"snapshot.ts",
		"transition.ts",
	])("keeps %s as a focused internal module", (fileName) => {
		expect(existsSync(new URL(fileName, moduleDirectory))).toBe(true);
	});
});
