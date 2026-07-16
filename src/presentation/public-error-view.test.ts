import { ValidationError } from "@shirudo/base-error";
import { describe, expect, it } from "vite-plus/test";
import {
	AggregateNotFoundError,
	ConcurrencyConflictError,
	DuplicateAggregateError,
} from "../core/errors";
import { toPublicErrorView } from "./public-error-view";

describe("toPublicErrorView()", () => {
	it("maps AggregateNotFoundError to a safe view that does NOT leak the id", () => {
		const view = toPublicErrorView(new AggregateNotFoundError({ aggregateType: "Order", id: "o-1" }));

		expect(view.code).toBe("AGGREGATE_NOT_FOUND");
		expect(view.locale).toBe("en");
		expect(view.message).not.toContain("o-1");
		expect(view.message).not.toContain("Order");
		expect(view.details).toBeUndefined();
	});

	it("maps the conflict and duplicate errors to safe messages", () => {
		expect(toPublicErrorView(new ConcurrencyConflictError({ aggregateType: "Order", aggregateId: "o-1", expectedVersion: 3, actualVersion: 5 })).code).toBe(
			"CONCURRENCY_CONFLICT",
		);
		expect(
			toPublicErrorView(new DuplicateAggregateError({ aggregateType: "Order", aggregateId: "o-1" })).message,
		).toContain("already exists");
	});

	it("carries a ValidationError's whitelisted issues in details", () => {
		const error = new ValidationError("Registration is invalid").addIssues([
			{ message: "must be a valid email", path: ["email"] },
			{ message: "must not be negative", path: ["age"] },
		]);

		const view = toPublicErrorView(error);

		expect(view.code).toBe("VALIDATION_FAILED");
		expect(view.details?.issues).toHaveLength(2);
		expect(view.details?.issues[0]?.message).toBe("must be a valid email");
	});

	it("is total over unknown: unmapped and non-kit values degrade to a generic view", () => {
		const fromForeign = toPublicErrorView(new Error("boom"));
		expect(fromForeign.code).toBe("INTERNAL_ERROR");
		expect(fromForeign.message).toBe("An unexpected error occurred.");

		const fromPrimitive = toPublicErrorView("nope");
		expect(fromPrimitive.code).toBe("INTERNAL_ERROR");
		expect(fromPrimitive.details).toBeUndefined();
	});

	it("is total over thrown null and undefined: degrades instead of throwing", () => {
		// `throw null` and `reject(undefined)` occur in real systems; the
		// presenter crashing in the 500 path would turn a handled failure
		// into an unhandled one.
		const fromNull = toPublicErrorView(null);
		expect(fromNull.code).toBe("INTERNAL_ERROR");
		expect(fromNull.message).toBe("An unexpected error occurred.");
		expect(fromNull.details).toBeUndefined();

		const fromUndefined = toPublicErrorView(undefined);
		expect(fromUndefined.code).toBe("INTERNAL_ERROR");
		expect(fromUndefined.details).toBeUndefined();

		expect(toPublicErrorView(42).code).toBe("INTERNAL_ERROR");
	});

	it("the locale option is a PREFERENCE; the view carries the locale that resolved", () => {
		// The built-in messages are English only, so a de-DE preference
		// resolves to the base locale instead of claiming a locale the
		// message is not actually in.
		const view = toPublicErrorView(new AggregateNotFoundError({ aggregateType: "Order", id: "o-1" }), {
			locale: "de-DE",
		});
		expect(view.locale).toBe("en");
		expect(view.message).toBe("The requested resource could not be found.");
	});

	describe("hardening against hostile or accidental publicIssues()", () => {
		it("degrades to the fallback view when publicIssues() throws, instead of crashing the 500 path", () => {
			const hostile = {
				name: "VALIDATION_FAILED",
				category: "VALIDATION",
				publicIssues() {
					throw new Error("secret pool state: 10.0.0.5:5432");
				},
			};

			const view = toPublicErrorView(hostile, { locale: "de-DE" });

			expect(view.code).toBe("INTERNAL_ERROR");
			expect(view.message).toBe("An unexpected error occurred.");
			expect(view.locale).toBe("en");
			expect(view.details).toBeUndefined();
		});

		it("does not misclassify a SCREAMING_SNAKE structured error that exposes publicIssues()", () => {
			// Since the StructuredError migration every kit and
			// convention-following consumer error name is SCREAMING_SNAKE, so
			// the name shape alone cannot separate validation errors from the
			// rest; the category must be "VALIDATION".
			const structuredInfra = {
				name: "PG_POOL_EXHAUSTED",
				code: "PG_POOL_EXHAUSTED",
				category: "INFRASTRUCTURE",
				retryable: true,
				publicIssues: () => [{ message: "conn 10.0.0.5:5432 refused" }],
			};

			const view = toPublicErrorView(structuredInfra);

			expect(view.code).toBe("INTERNAL_ERROR");
			expect(view.details).toBeUndefined();
			expect(JSON.stringify(view)).not.toContain("PG_POOL_EXHAUSTED");
			expect(JSON.stringify(view)).not.toContain("10.0.0.5");
		});

		it("does not leak a class-style name as code nor issues from an accidental publicIssues() method", () => {
			// A non-kit infrastructure error that happens to expose a
			// publicIssues() method must not have its raw name emitted as the
			// client-facing code, nor its return value shipped to the client.
			const accidental = {
				name: "PgPoolExhaustedError",
				publicIssues: () => [{ message: "conn 10.0.0.5:5432 refused" }],
			};

			const view = toPublicErrorView(accidental);

			expect(view.code).toBe("INTERNAL_ERROR");
			expect(view.message).toBe("An unexpected error occurred.");
			expect(view.details).toBeUndefined();
			expect(JSON.stringify(view)).not.toContain("10.0.0.5");
		});

		it("ignores a publicIssues() that does not return an array", () => {
			const broken = {
				name: "VALIDATION_FAILED",
				category: "VALIDATION",
				publicIssues: () => ({ message: "not an array" }),
			};

			const view = toPublicErrorView(broken);

			expect(view.code).toBe("INTERNAL_ERROR");
			expect(view.details).toBeUndefined();
		});

		it("whitelists issue fields and drops non-conforming entries", () => {
			// Simulates a genuine ValidationError from a duplicate base-error
			// install: right name shape AND category, matched structurally.
			const oversharing = {
				name: "VALIDATION_FAILED",
				category: "VALIDATION",
				publicIssues: () => [
					{
						message: "must be a valid email",
						path: ["email"],
						code: "EMAIL",
						pointer: "email",
						stack: "at connectPg (10.0.0.5:5432)",
						driver: { host: "10.0.0.5" },
					},
					"raw string",
					null,
					{ message: 42 },
				],
			};

			const view = toPublicErrorView(oversharing);

			expect(view.code).toBe("VALIDATION_FAILED");
			expect(view.details?.issues).toEqual([
				{
					message: "must be a valid email",
					path: ["email"],
					code: "EMAIL",
					pointer: "email",
				},
			]);
			expect(JSON.stringify(view)).not.toContain("10.0.0.5");
		});

		it("stays total when name or publicIssues are throwing accessors", () => {
			const throwingName = {
				get name(): string {
					throw new Error("gotcha");
				},
			};
			const throwingCapability = {
				name: "VALIDATION_FAILED",
				get publicIssues(): () => unknown[] {
					throw new Error("gotcha");
				},
			};

			expect(toPublicErrorView(throwingName).code).toBe("INTERNAL_ERROR");
			expect(toPublicErrorView(throwingCapability).code).toBe(
				"INTERNAL_ERROR",
			);
		});
	});
});
