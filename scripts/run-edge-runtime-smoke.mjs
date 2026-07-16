import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EdgeRuntime } from "edge-runtime";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const normalizedRoot = root.replaceAll("\\", "/");
const fixtureDirectory = join(root, "scripts", "edge-runtime");
const outputDirectory = await mkdtemp(join(tmpdir(), "ddd-kit-edge-smoke-"));

function assertBuiltPackageWasBundled(metafile) {
	const inputs = Object.keys(metafile.inputs).map((path) =>
		path.replaceAll("\\", "/"),
	);
	for (const entry of ["dist/index.js", "dist/money.js"]) {
		assert(
			inputs.some(
				(path) => path === entry || path === `${normalizedRoot}/${entry}`,
			),
			`edge bundle did not load the built package entry ${entry}`,
		);
	}
	assert(
		!inputs.some(
			(path) =>
				path.startsWith("src/") || path.startsWith(`${normalizedRoot}/src/`),
		),
		"edge bundle loaded package source instead of dist",
	);
}

async function bundle(entry, outfile, format) {
	const result = await build({
		absWorkingDir: root,
		bundle: true,
		conditions: ["browser", "import", "default"],
		entryPoints: [join(fixtureDirectory, entry)],
		format,
		legalComments: "none",
		logLevel: "silent",
		mainFields: ["module", "main"],
		metafile: true,
		outfile,
		platform: "neutral",
		target: "es2022",
	});
	assertBuiltPackageWasBundled(result.metafile);
}

async function readSuccessfulResult(response, expectedRuntime) {
	const body = await response.text();
	assert.equal(response.status, 200, body);
	const result = JSON.parse(body);
	assert.deepEqual(result, {
		aggregateVersion: 1,
		eventType: "EdgeOrderConfirmed",
		money: { amountMinor: "1300", currency: "EUR", scale: 2 },
		ok: true,
		runtime: expectedRuntime,
	});
	return result;
}

try {
	const cloudflareBundle = join(outputDirectory, "cloudflare-worker.mjs");
	const vercelBundle = join(outputDirectory, "vercel-edge.js");
	await bundle("cloudflare-worker.js", cloudflareBundle, "esm");
	await bundle("vercel-edge.js", vercelBundle, "iife");

	const miniflare = new Miniflare({
		compatibilityDate: "2026-07-15",
		modules: true,
		script: await readFile(cloudflareBundle, "utf8"),
	});
	try {
		const response = await miniflare.dispatchFetch("https://edge-smoke.test/");
		await readSuccessfulResult(response, "cloudflare-workerd");
	} finally {
		await miniflare.dispose();
	}

	const runtime = new EdgeRuntime({
		initialCode: await readFile(vercelBundle, "utf8"),
	});
	const response = await runtime.dispatchFetch("https://edge-smoke.test/");
	await readSuccessfulResult(response, "vercel-edge-runtime");
	await response.waitUntil();

	process.stdout.write(
		"Edge runtime smoke passed in Cloudflare workerd and Vercel Edge Runtime.\n",
	);
} finally {
	await rm(outputDirectory, { force: true, recursive: true });
}
