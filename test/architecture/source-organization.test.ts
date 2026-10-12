// @ts-expect-error Node's fs module exists in the test runtime; the package stays Node-type-free.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

const sourceDirectory = new URL("../../src/", import.meta.url);

/**
 * The areas the source organization rule allows. A ninth needs the kind of
 * argument the `errors` area carries: measured importers, measured
 * dependencies, and a responsibility that states in one sentence.
 */
const ALLOWED_AREAS = [
	"application",
	"domain",
	"errors",
	"internal",
	"messaging",
	"persistence",
	"presentation",
	"testing",
] as const;

/** Names that collect what nobody placed. Banned as directories. */
const BANNED_COLLECTIONS = ["core", "common", "shared", "helpers", "utils"];

// Dotfiles are not source. A Finder artefact must not turn this red.
const entries = readdirSync(sourceDirectory)
	.filter((name: string) => !name.startsWith("."))
	.map((name: string) => ({
		name,
		isDirectory: statSync(new URL(name, sourceDirectory)).isDirectory(),
	}));

const directories = entries
	.filter((entry: { isDirectory: boolean }) => entry.isDirectory)
	.map((entry: { name: string }) => entry.name)
	.sort();

const files = entries
	.filter((entry: { isDirectory: boolean }) => !entry.isDirectory)
	.map((entry: { name: string }) => entry.name)
	.sort();

/** The production modules under `directory`, at any depth. */
function productionModules(directory: URL): URL[] {
	return readdirSync(directory).flatMap((name: string) => {
		const entry = new URL(name, directory);
		if (statSync(entry).isDirectory()) {
			return productionModules(new URL(`${name}/`, directory));
		}
		return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [entry] : [];
	});
}

/** The other areas that the production modules of `area` import from. */
function importedAreas(area: string): string[] {
	const imported = new Set<string>();
	for (const module of productionModules(
		new URL(`${area}/`, sourceDirectory),
	)) {
		const text: string = readFileSync(module, "utf8");
		for (const [, specifier = ""] of text.matchAll(
			/(?:from|import\()\s*"(\.{1,2}\/[^"]+)"/g,
		)) {
			const target = new URL(specifier, module).href.slice(
				sourceDirectory.href.length,
			);
			const [targetArea = ""] = target.split("/");
			if (targetArea !== area) imported.add(targetArea);
		}
	}
	return [...imported].sort();
}

describe("source organization", () => {
	it("keeps every top-level area on the allowed list", () => {
		expect(directories).toEqual([...ALLOWED_AREAS]);
	});

	it("has no directory that collects what nobody placed", () => {
		expect(
			directories.filter((name: string) => BANNED_COLLECTIONS.includes(name)),
		).toEqual([]);
	});

	it("keeps index.ts as the only file directly under src", () => {
		// A root-level proxy is unnecessary: the exports map can name the
		// owning module.
		expect(files).toEqual(["index.ts"]);
	});
});

describe("dependencies between areas", () => {
	it("keeps errors free of imports from another area", () => {
		expect(importedAreas("errors")).toEqual([]);
	});

	it("lets internal import from errors and from no other area", () => {
		expect(
			importedAreas("internal").filter((area) => area !== "errors"),
		).toEqual([]);
	});
});
