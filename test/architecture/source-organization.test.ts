// @ts-expect-error Node's fs module exists in the test runtime; the package stays Node-type-free.
import { readdirSync, statSync } from "node:fs";
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
