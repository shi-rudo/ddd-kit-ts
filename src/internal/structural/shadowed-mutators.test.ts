import { describe, expect, it } from "vite-plus/test";
import { isShadowedMutator } from "./shadowed-mutators";

describe("isShadowedMutator", () => {
	it("names the mutators of a Date, a Map, and a Set", () => {
		expect(isShadowedMutator("[object Date]", "setTime")).toBe(true);
		expect(isShadowedMutator("[object Map]", "set")).toBe(true);
		expect(isShadowedMutator("[object Set]", "add")).toBe(true);
	});

	it("does not name another method or another built-in", () => {
		expect(isShadowedMutator("[object Date]", "toJSON")).toBe(false);
		expect(isShadowedMutator("[object Map]", "add")).toBe(false);
		expect(isShadowedMutator("[object RegExp]", "set")).toBe(false);
	});
});
