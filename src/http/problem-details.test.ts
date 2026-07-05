import { ValidationError } from "@shirudo/base-error";
import { describe, expect, it } from "vitest";
import { toProblemDetails } from "./problem-details";

const invalidRegistration = () =>
	new ValidationError("Registration is invalid").addIssues([
		{ message: "must be a valid email", path: ["email"] },
		{ message: "must not be negative", path: ["age"] },
	]);

describe("toProblemDetails()", () => {
	it("delegates to toProblem: 422 defaults, code member, issues under details", () => {
		const problem = toProblemDetails(invalidRegistration());

		expect(problem.status).toBe(422);
		expect(problem.body.status).toBe(422);
		expect(problem.body.title).toBe("Validation Failed");
		expect(problem.body.type).toBe("about:blank");
		expect(problem.body.code).toBe("VALIDATION_FAILED");
		expect(problem.body.details?.issues).toHaveLength(2);
		expect(problem.body.details?.issues[0]?.message).toBe(
			"must be a valid email",
		);
		expect(problem.headers["content-type"]).toContain("application/problem+json");
	});

	it("honors status, type, detail, and instance overrides", () => {
		const problem = toProblemDetails(invalidRegistration(), {
			status: 400,
			type: "https://api.example/problems/validation",
			detail: "2 fields failed validation",
			instance: "/registrations/42",
		});

		expect(problem.status).toBe(400);
		expect(problem.body.status).toBe(400);
		expect(problem.body.type).toBe("https://api.example/problems/validation");
		expect(problem.body.detail).toBe("2 fields failed validation");
		expect(problem.body.instance).toBe("/registrations/42");
	});

	it("merges extension members alongside the documented body members", () => {
		const problem = toProblemDetails(invalidRegistration(), {
			extensions: { traceId: "abc-123" },
		});

		expect(problem.body.traceId).toBe("abc-123");
		expect(problem.body.details?.issues).toHaveLength(2);
	});

	describe("wire safety (inherited from base-error's toProblem)", () => {
		it("returns a deeply frozen body with a null prototype", () => {
			const problem = toProblemDetails(invalidRegistration());

			expect(Object.getPrototypeOf(problem.body)).toBe(null);
			expect(Object.isFrozen(problem.body)).toBe(true);
			expect(Object.isFrozen(problem.body.details)).toBe(true);
			expect(Object.isFrozen(problem.body.details?.issues)).toBe(true);
			expect(Object.isFrozen(problem.body.details?.issues[0])).toBe(true);
		});

		it("extensions cannot overwrite the reserved body members", () => {
			// A pre-widened extensions bag bypasses the compile-time reserved
			// check; toProblem re-validates at runtime, drops the WHOLE
			// colliding set (stricter than a per-key skip: the collision is a
			// caller bug worth surfacing), and records it in outcome.omitted.
			const hostile = {
				status: "oops",
				type: "https://evil.example",
				traceId: "abc-123",
			} as unknown as Record<string, string>;

			const problem = toProblemDetails<Record<string, string>>(
				invalidRegistration(),
				{ extensions: hostile },
			);

			expect(problem.body.status).toBe(422);
			expect(problem.body.type).toBe("about:blank");
			expect(problem.body.traceId).toBeUndefined();
			expect(problem.outcome.omitted.length).toBeGreaterThan(0);
		});

		it("a non-JSON-safe issue path drops the details member into outcome.omitted instead of corrupting the wire", () => {
			// Symbols inside an array would JSON.stringify to null entries.
			const error = new ValidationError("invalid").addIssues([
				{ message: "bad field", path: [Symbol("secret"), "email"] },
			]);

			const problem = toProblemDetails(error);

			expect(JSON.stringify(problem.body)).not.toContain("null");
			const omittedMembers = problem.outcome.omitted.map((o) =>
				JSON.stringify(o),
			);
			expect(omittedMembers.join()).toContain("details");
		});
	});
});
