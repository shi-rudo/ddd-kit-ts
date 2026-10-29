// @ts-expect-error Node's fs module exists in the test runtime; the package stays Node-type-free.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { parse } from "yaml";

interface WorkflowJob {
	readonly if?: string;
	readonly needs?: string | ReadonlyArray<string>;
}

interface Workflow {
	readonly jobs: Readonly<Record<string, WorkflowJob>>;
}

const MERGE_GATE_JOB = "ci-passed";

const ciWorkflow: Workflow = parse(
	readFileSync(
		new URL("../../.github/workflows/ci.yml", import.meta.url),
		"utf8",
	),
);

const neededJobs = (job: WorkflowJob | undefined): string[] => {
	const needs = job?.needs ?? [];
	return typeof needs === "string" ? [needs] : [...needs];
};

describe("the required check of main", () => {
	it("needs every other job of the CI workflow", () => {
		const otherJobs = Object.keys(ciWorkflow.jobs).filter(
			(name) => name !== MERGE_GATE_JOB,
		);

		expect(neededJobs(ciWorkflow.jobs[MERGE_GATE_JOB]).sort()).toEqual(
			otherJobs.sort(),
		);
	});

	it("runs after a failed job, because GitHub counts a skipped required check as passed", () => {
		expect(ciWorkflow.jobs[MERGE_GATE_JOB]?.if).toBe("always()");
	});
});
