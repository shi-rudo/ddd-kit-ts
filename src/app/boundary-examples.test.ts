// @ts-expect-error Node's fs module exists in the test runtime; the package stays Node-type-free.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

const examples = [
	new URL("command.ts", import.meta.url),
	new URL("query.ts", import.meta.url),
	new URL("../../docs/guide/cqrs-and-buses.md", import.meta.url),
	new URL("../../docs/guide/edge-runtimes.md", import.meta.url),
];

describe("untrusted-boundary examples", () => {
	it("never claim that a TypeScript assertion validates parsed input", () => {
		const unsafeAssertions = examples.flatMap((url) => {
			const source = readFileSync(url, "utf8");
			return [...source.matchAll(unsafeBoundaryAssertion)].map(
				(match) => `${url.pathname}: ${match[0]}`,
			);
		});

		expect(unsafeAssertions).toEqual([]);
	});
});

const unsafeBoundaryAssertion =
	/(?:JSON\.parse|request\.json)\([^;]{0,500}?\)\s*\)?\s+as\s+\w+(?:Command|Query)/gs;
