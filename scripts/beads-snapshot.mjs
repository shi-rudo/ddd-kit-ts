// Keeps .beads/issues.jsonl in one canonical order. `bd export` writes the
// dependencies of an issue in the order the database returns them, and that
// order changes between sessions. A snapshot diff then shows issues that did
// not change.
//
//   node scripts/beads-snapshot.mjs          sorts the snapshot in place
//   node scripts/beads-snapshot.mjs --check  exits 1 if the snapshot is unsorted

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const snapshotPath = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	".beads",
	"issues.jsonl",
);

// bd is written in Go, whose JSON encoder escapes these characters and
// JSON.stringify does not. Without the same escapes, a rewritten line
// differs in more than its dependency order.
function stringifyLikeGo(value) {
	return JSON.stringify(value).replace(
		/[<>&\u2028\u2029]/g,
		(character) =>
			`\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

function compareDependencies(a, b) {
	for (const key of ["depends_on_id", "type", "created_at"]) {
		const left = String(a[key] ?? "");
		const right = String(b[key] ?? "");
		if (left !== right) return left < right ? -1 : 1;
	}
	return 0;
}

/**
 * Returns the line with the dependencies of its issue in canonical order.
 * A line in canonical order comes back unchanged, byte for byte.
 */
export function sortIssueDependencies(line) {
	const issue = JSON.parse(line);
	const { dependencies } = issue;
	if (!Array.isArray(dependencies)) return line;

	const sorted = dependencies.toSorted(compareDependencies);
	if (sorted.every((dependency, index) => dependency === dependencies[index])) {
		return line;
	}
	if (stringifyLikeGo(issue) !== line) {
		throw new Error(
			`beads-snapshot: issue ${issue.id} does not round-trip through the JSON format of bd, so sorting it would change more than its dependency order`,
		);
	}
	return stringifyLikeGo({ ...issue, dependencies: sorted });
}

/** Returns the snapshot text with every issue in canonical order. */
export function sortSnapshot(text) {
	return text
		.split("\n")
		.map((line) => (line === "" ? line : sortIssueDependencies(line)))
		.join("\n");
}

async function main(argv) {
	const text = await readFile(snapshotPath, "utf8");
	const sorted = sortSnapshot(text);
	if (argv.includes("--check")) {
		if (sorted === text) return 0;
		const unsorted = text
			.split("\n")
			.filter((line) => line !== "" && sortIssueDependencies(line) !== line)
			.map((line) => JSON.parse(line).id);
		console.error(
			`beads-snapshot: ${unsorted.length} issues in .beads/issues.jsonl have unsorted dependencies (${unsorted.slice(0, 5).join(", ")}). Run node scripts/beads-snapshot.mjs and commit the result.`,
		);
		return 1;
	}
	if (sorted !== text) await writeFile(snapshotPath, sorted);
	return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	process.exitCode = await main(process.argv.slice(2));
}
