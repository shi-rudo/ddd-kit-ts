import { ValidationError } from "@shirudo/base-error";
import { describe, expect, it } from "vitest";
import { toProblemDetails } from "./problem-details";

const invalidRegistration = () =>
	new ValidationError("Registration is invalid").addIssues([
		{ message: "must be a valid email", path: ["email"] },
		{ message: "must not be negative", path: ["age"] },
	]);

describe("toProblemDetails()", () => {
	it("attaches the collected issues under `errors` with 422 defaults", () => {
		const problem = toProblemDetails(invalidRegistration());

		expect(problem.status).toBe(422);
		expect(problem.title).toBe("Validation Failed");
		const errors = problem.errors as Array<Record<string, unknown>>;
		expect(errors).toHaveLength(2);
		expect(errors[0]?.message).toBe("must be a valid email");
	});

	it("honors a custom member key and status override", () => {
		const problem = toProblemDetails(invalidRegistration(), {
			member: "invalid-params",
			status: 400,
		});

		expect(problem.status).toBe(400);
		expect(problem["invalid-params"]).toHaveLength(2);
		expect(problem.errors).toBeUndefined();
	});

	it("merges extra extension members alongside the issues", () => {
		const problem = toProblemDetails(invalidRegistration(), {
			extensions: { traceId: "abc-123" },
		});

		expect(problem.traceId).toBe("abc-123");
		expect(problem.errors).toHaveLength(2);
	});
});
