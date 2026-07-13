// @ts-expect-error Node's fs exists in the test runtime; the package stays Node-type-free.
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const workflowPath = ".github/workflows/release.yml";

async function loadReleaseWorkflow(): Promise<string> {
	return readFile(workflowPath, "utf8");
}

function jobSection(
	source: string,
	job: "verify" | "publish",
): string {
	const startMarker = `  ${job}:\n`;
	const start = source.indexOf(startMarker);
	expect(start, `missing ${job} job`).toBeGreaterThanOrEqual(0);
	const nextJob = source.indexOf("\n  publish:\n", start + startMarker.length);
	return nextJob === -1 ? source.slice(start) : source.slice(start, nextJob);
}

function occurrences(source: string, value: string): number {
	return source.split(value).length - 1;
}

describe("release workflow", () => {
	it("runs only for version tags and serializes releases of the same tag", async () => {
		const source = await loadReleaseWorkflow();

		expect(source).toContain('    tags:\n      - "v*"');
		expect(source).not.toMatch(/workflow_dispatch|pull_request/);
		expect(source).toContain("group: release-${{ github.ref }}");
		expect(source).toContain("cancel-in-progress: false");
	});

	it("re-runs every release gate on Node 22 and 24 before publishing", async () => {
		const source = await loadReleaseWorkflow();
		const verify = jobSection(source, "verify");
		const publish = jobSection(source, "publish");

		expect(verify).toContain("node-version: [22, 24]");
		expect(verify).toContain(
			'git merge-base --is-ancestor "$GITHUB_SHA" origin/main',
		);
		for (const command of [
			"pnpm install --frozen-lockfile",
			"pnpm typecheck",
			"pnpm lint",
			"pnpm vitest run",
			"pnpm build",
			"pnpm pack --pack-destination",
		]) {
			expect(verify).toContain(command);
		}
		expect(publish).toContain("needs: verify");
	});

	it("grants short-lived OIDC only to the publish job", async () => {
		const source = await loadReleaseWorkflow();
		const publish = jobSection(source, "publish");

		expect(occurrences(source, "id-token: write")).toBe(1);
		expect(publish).toContain("contents: read\n      id-token: write");
		expect(publish).toContain("environment: npm");
		expect(source).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./);
	});

	it("pins the release toolchain and disables dependency caching", async () => {
		const source = await loadReleaseWorkflow();
		const verify = jobSection(source, "verify");
		const publish = jobSection(source, "publish");

		for (const action of [
			"actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10",
			"pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271",
			"actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
		]) {
			expect(occurrences(source, action)).toBe(2);
		}
		expect(occurrences(source, 'version: "10.32.1"')).toBe(2);
		expect(occurrences(source, "package-manager-cache: false")).toBe(2);
		expect(verify).toContain("node-version: ${{ matrix.node-version }}");
		expect(publish).toContain('node-version: "24.15.0"');
		expect(publish).toContain("registry-url: https://registry.npmjs.org");
		expect(publish).toContain("npm install --global npm@12.0.1");
	});

	it("matches the version tag and keeps prereleases off latest", async () => {
		const source = await loadReleaseWorkflow();
		const publish = jobSection(source, "publish");

		expect(publish).toContain("name: Resolve release metadata\n        id: release");
		expect(publish).toContain('expected_tag="v${version}"');
		expect(publish).toContain('if [[ "$version" == *-* ]]');
		expect(publish).toContain('dist_tag="next"');
		expect(publish).toContain('dist_tag="latest"');
		expect(publish).toContain(
			'echo "dist-tag=$dist_tag" >> "$GITHUB_OUTPUT"',
		);
		expect(publish).toContain(
			'run: npm publish --provenance --access public --tag "${{ steps.release.outputs.dist-tag }}"',
		);
	});
});
