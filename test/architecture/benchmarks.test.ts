// @ts-expect-error Node's fs module exists in the test runtime; the package stays Node-type-free.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import * as index from "../../src";

const benchmarkDirectory = new URL("../../benchmarks/", import.meta.url);

/**
 * The names that a benchmark imports from the built root entry. The
 * benchmarks are plain `.mjs` files that read `dist/`, so neither the
 * typecheck nor the tests load them, and a renamed export breaks them
 * without an error anywhere else.
 */
function rootEntryImports(source: string): string[] {
	const match = /import\s*\{([^}]*)\}\s*from\s*"\.\.\/dist\/index\.js"/.exec(
		source,
	);
	if (match?.[1] === undefined) return [];
	return match[1]
		.split(",")
		.map((name) => name.trim().split(/\s+as\s+/)[0] ?? "")
		.filter((name) => name.length > 0);
}

describe("benchmarks", () => {
	const files: string[] = readdirSync(benchmarkDirectory).filter(
		(file: string) => file.endsWith(".mjs"),
	);

	it("finds the benchmark scripts", () => {
		expect(files.length).toBeGreaterThan(0);
	});

	it.each(files)(
		"%s imports only names that the root entry exports",
		(file) => {
			const source: string = readFileSync(
				new URL(file, benchmarkDirectory),
				"utf8",
			);
			const imported = rootEntryImports(source);

			expect(imported.length).toBeGreaterThan(0);
			expect(imported.filter((name) => !(name in index))).toEqual([]);
		},
	);
});
