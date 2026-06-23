import { ValidationError } from "@shirudo/base-error";
import { describe, expect, it } from "vitest";
import {
	AggregateNotFoundError,
	ConcurrencyConflictError,
	DuplicateAggregateError,
} from "../core/errors";
import { toPublicErrorView } from "./public-error-view";

describe("toPublicErrorView()", () => {
	it("maps AggregateNotFoundError to a safe view that does NOT leak the id", () => {
		const view = toPublicErrorView(new AggregateNotFoundError({ aggregateType: "Order", id: "o-1" }));

		expect(view.code).toBe("AggregateNotFoundError");
		expect(view.locale).toBe("en");
		expect(view.message).not.toContain("o-1");
		expect(view.message).not.toContain("Order");
		expect(view.details).toBeUndefined();
	});

	it("maps the conflict and duplicate errors to safe messages", () => {
		expect(toPublicErrorView(new ConcurrencyConflictError({ aggregateType: "Order", aggregateId: "o-1", expectedVersion: 3, actualVersion: 5 })).code).toBe(
			"ConcurrencyConflictError",
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

	it("stamps an explicit locale when provided", () => {
		const view = toPublicErrorView(new AggregateNotFoundError({ aggregateType: "Order", id: "o-1" }), {
			locale: "de-DE",
		});
		expect(view.locale).toBe("de-DE");
	});
});
