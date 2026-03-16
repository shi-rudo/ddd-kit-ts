import { describe, expect, it } from "vitest";
import { guard } from "./guard";

describe("guard", () => {
	it("should return ok(true) when condition is true", () => {
		const result = guard(true, "should not appear");
		expect(result).toEqual({ ok: true, value: true });
	});

	it("should return err with message when condition is false", () => {
		const result = guard(false, "ID cannot be empty");
		expect(result).toEqual({ ok: false, error: "ID cannot be empty" });
	});

	it("should return err with empty string", () => {
		const result = guard(false, "");
		expect(result).toEqual({ ok: false, error: "" });
	});
});
