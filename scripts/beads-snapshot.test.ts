import { describe, expect, it } from "vite-plus/test";
import { sortIssueDependencies, sortSnapshot } from "./beads-snapshot.mjs";

const blocks = (dependsOn: string, createdAt: string) =>
	`{"issue_id":"kit-a","depends_on_id":"${dependsOn}","type":"blocks","created_at":"${createdAt}"}`;

describe("beads snapshot order", () => {
	it("puts the dependencies of an issue in order of the issue they depend on", () => {
		const line = `{"id":"kit-a","dependencies":[${blocks("kit-c", "2026-01-01")},${blocks("kit-b", "2026-02-01")}]}`;

		const sorted = sortIssueDependencies(line);

		expect(sorted).toBe(
			`{"id":"kit-a","dependencies":[${blocks("kit-b", "2026-02-01")},${blocks("kit-c", "2026-01-01")}]}`,
		);
	});

	it("returns a sorted line unchanged, byte for byte", () => {
		const line = `{"id":"kit-a","title":"v1 -\\u003e v2","dependencies":[${blocks("kit-b", "2026-02-01")}]}`;

		expect(sortIssueDependencies(line)).toBe(line);
	});

	it("keeps the escapes that bd writes when it rewrites a line", () => {
		const line = `{"id":"kit-a","title":"a \\u0026 b \\u003c c","dependencies":[${blocks("kit-c", "2026-01-01")},${blocks("kit-b", "2026-02-01")}]}`;

		const sorted = sortIssueDependencies(line);

		expect(sorted).toContain(`"title":"a \\u0026 b \\u003c c"`);
	});

	it("refuses to rewrite a line that bd would not have written", () => {
		const line = `{"id": "kit-a", "dependencies": [${blocks("kit-c", "2026-01-01")}, ${blocks("kit-b", "2026-02-01")}]}`;

		expect(() => sortIssueDependencies(line)).toThrow(/kit-a/);
	});

	it("leaves an issue without dependencies unchanged", () => {
		const line = `{"id":"kit-a","title":"no dependencies"}`;

		expect(sortIssueDependencies(line)).toBe(line);
	});

	it("keeps the final newline of the snapshot", () => {
		const snapshot = `{"id":"kit-a"}\n{"id":"kit-b"}\n`;

		expect(sortSnapshot(snapshot)).toBe(snapshot);
	});
});
