import { describe, expect, it } from "vite-plus/test";
import { InvalidVersionError } from "../../errors/kit-errors";
import type { Id } from "../identity/id";
import { sameVersion, toVersion, type Version } from "./aggregate";

describe("Aggregate versions", () => {
	describe("sameVersion()", () => {
		type OrderId = Id<"OrderId">;

		it("should return true for aggregates with same ID and version", () => {
			const agg1 = {
				id: "order-1" as OrderId,
				version: 5 as Version,
			};
			const agg2 = {
				id: "order-1" as OrderId,
				version: 5 as Version,
			};

			expect(sameVersion(agg1, agg2)).toBe(true);
		});

		it("should return false for aggregates with different IDs", () => {
			const agg1 = {
				id: "order-1" as OrderId,
				version: 5 as Version,
			};
			const agg2 = {
				id: "order-2" as OrderId,
				version: 5 as Version,
			};

			expect(sameVersion(agg1, agg2)).toBe(false);
		});

		it("should return false for aggregates with different versions", () => {
			const agg1 = {
				id: "order-1" as OrderId,
				version: 5 as Version,
			};
			const agg2 = {
				id: "order-1" as OrderId,
				version: 6 as Version,
			};

			expect(sameVersion(agg1, agg2)).toBe(false);
		});

		it("should return false for aggregates with different ID and version", () => {
			const agg1 = {
				id: "order-1" as OrderId,
				version: 5 as Version,
			};
			const agg2 = {
				id: "order-2" as OrderId,
				version: 6 as Version,
			};

			expect(sameVersion(agg1, agg2)).toBe(false);
		});
	});

	describe("toVersion()", () => {
		it.each([0, 1, 42, Number.MAX_SAFE_INTEGER])(
			"accepts the non-negative safe integer %s",
			(value) => {
				expect(toVersion(value)).toBe(value);
			},
		);

		it.each([
			["NaN", Number.NaN],
			["a negative number", -1],
			["a fraction", 1.5],
			["Infinity", Number.POSITIVE_INFINITY],
			["a number beyond the safe range", Number.MAX_SAFE_INTEGER + 1],
		])("rejects %s with InvalidVersionError", (_label, value) => {
			expect(() => toVersion(value)).toThrow(InvalidVersionError);
		});

		it("names the rejected value and the wiring code", () => {
			let caught: unknown;
			try {
				toVersion(-3);
			} catch (error) {
				caught = error;
			}

			expect(caught).toBeInstanceOf(InvalidVersionError);
			expect((caught as InvalidVersionError).code).toBe("INVALID_VERSION");
			expect((caught as InvalidVersionError).value).toBe(-3);
		});
	});
});
