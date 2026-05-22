import { describe, expect, it } from "vitest";
import { guard } from "./guard";

describe("guard", () => {
	it("should return ok(true) when condition is true", () => {
		const result = guard(true, "should not appear");
		expect(result.isOk()).toBe(true);
		if (result.isOk()) expect(result.value).toBe(true);
	});

	it("should return err with message when condition is false", () => {
		const result = guard(false, "ID cannot be empty");
		expect(result.isErr()).toBe(true);
		if (result.isErr()) expect(result.error).toBe("ID cannot be empty");
	});

	it("should return err with empty string", () => {
		const result = guard(false, "");
		expect(result.isErr()).toBe(true);
		if (result.isErr()) expect(result.error).toBe("");
	});
});
