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

	it("rejects a mismatched version tag before installing dependencies", async () => {
		const source = await loadReleaseWorkflow();
		const verify = jobSection(source, "verify");
		const tagCheck = verify.indexOf("name: Verify release tag");
		const install = verify.indexOf("pnpm install --frozen-lockfile");

		expect(tagCheck).toBeGreaterThanOrEqual(0);
		expect(install).toBeGreaterThan(tagCheck);
		expect(verify).toContain('expected_tag="v${version}"');
		expect(verify).toContain('if [[ "$GITHUB_REF_NAME" != "$expected_tag" ]]');
	});

	it("grants short-lived OIDC only to the publish job", async () => {
		const source = await loadReleaseWorkflow();
		const publish = jobSection(source, "publish");

		expect(occurrences(source, "id-token: write")).toBe(1);
		expect(publish).toContain("contents: read\n      id-token: write");
		expect(publish).toContain("environment: npm");
		expect(source).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./);
	});

	it("publishes only the verified tarball without running project code with OIDC", async () => {
		const source = await loadReleaseWorkflow();
		const verify = jobSection(source, "verify");
		const publish = jobSection(source, "publish");

		expect(verify).toContain("actions/upload-artifact@");
		expect(verify).toContain("if: matrix.node-version == 24");
		expect(verify).toContain("name: npm-package");
		expect(verify).toContain("path: /tmp/pack-smoke/package.tgz");
		expect(publish).toContain("actions/download-artifact@");
		expect(publish).toContain("name: npm-package");
		expect(publish).toContain("path: release");
		expect(publish).toContain(
			"version=$(tar -xOf ./release/package.tgz package/package.json",
		);
		expect(publish).toContain('expected_tag="v${version}"');
		expect(publish).toContain('if [[ "$GITHUB_REF_NAME" != "$expected_tag" ]]');
		expect(publish).toContain(
			"npm install --global --ignore-scripts npm@12.0.1",
		);
		expect(publish).toContain(
			'run: npm publish ./release/package.tgz --ignore-scripts --provenance --access public --tag "${{ steps.release.outputs.dist-tag }}"',
		);
		expect(publish).not.toMatch(
			/actions\/checkout|pnpm\/action-setup|pnpm install|npm run|vitest|tsup/,
		);
	});

	it("pins the release toolchain and disables dependency caching", async () => {
		const source = await loadReleaseWorkflow();
		const verify = jobSection(source, "verify");
		const publish = jobSection(source, "publish");

		expect(
			occurrences(
				source,
				"actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10",
			),
		).toBe(1);
		expect(
			occurrences(
				source,
				"pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271",
			),
		).toBe(1);
		expect(
			occurrences(
				source,
				"actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
			),
		).toBe(2);
		expect(
			occurrences(
				source,
				"actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
			),
		).toBe(1);
		expect(
			occurrences(
				source,
				"actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
			),
		).toBe(1);
		expect(occurrences(source, 'version: "10.32.1"')).toBe(1);
		expect(occurrences(source, "package-manager-cache: false")).toBe(2);
		expect(verify).toContain("node-version: ${{ matrix.node-version }}");
		expect(publish).toContain('node-version: "24.15.0"');
		expect(publish).toContain("registry-url: https://registry.npmjs.org");
	});

	it("matches the version tag and keeps prereleases off latest", async () => {
		const source = await loadReleaseWorkflow();
		const publish = jobSection(source, "publish");

		expect(publish).toContain("name: Resolve release metadata\n        id: release");
		expect(publish).toContain('if [[ "$version" == *-* ]]');
		expect(publish).toContain('dist_tag="next"');
		expect(publish).toContain('dist_tag="latest"');
		expect(publish).toContain(
			'echo "dist-tag=$dist_tag" >> "$GITHUB_OUTPUT"',
		);
		expect(publish).toContain(
			'run: npm publish ./release/package.tgz --ignore-scripts --provenance --access public --tag "${{ steps.release.outputs.dist-tag }}"',
		);
	});

	it("pins the package manager for local and CI use", async () => {
		const packageJson = JSON.parse(
			await readFile("package.json", "utf8"),
		) as { packageManager?: string };

		expect(packageJson.packageManager).toBe("pnpm@10.32.1");
	});
});
