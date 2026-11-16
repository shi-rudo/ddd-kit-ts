import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vite-plus/test";

const sourceDirectory = new URL("../src/", import.meta.url);

async function sourcesContaining(text: string): Promise<string[]> {
	const names = (await readdir(sourceDirectory)).filter(
		(name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
	);
	const matches: string[] = [];
	for (const name of names) {
		const source = await readFile(new URL(name, sourceDirectory), "utf8");
		if (source.includes(text)) matches.push(name);
	}
	return matches;
}

describe("the package source", () => {
	it("builds every advisory lock key in advisory-lock-key.ts", async () => {
		expect(await sourcesContaining("hashtextextended")).toEqual([
			"advisory-lock-key.ts",
		]);
	});

	it("replaces NUL bytes only in nul-byte.ts", async () => {
		expect(await sourcesContaining('"\\u0000"')).toEqual(["nul-byte.ts"]);
	});
});
