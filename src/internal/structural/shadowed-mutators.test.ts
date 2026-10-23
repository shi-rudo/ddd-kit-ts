import { describe, expect, it } from "vite-plus/test";
import { installMutatorShadows } from "./shadowed-mutators";

describe("installMutatorShadows", () => {
	it("makes the mutators of a Date, a Map, and a Set throw", () => {
		const date = new Date(0);
		const map = new Map();
		const set = new Set();

		installMutatorShadows(date, "[object Date]");
		installMutatorShadows(map, "[object Map]");
		installMutatorShadows(set, "[object Set]");

		expect(() => date.setTime(1)).toThrow(TypeError);
		expect(() => map.set("k", 1)).toThrow(TypeError);
		expect(() => set.add(1)).toThrow(TypeError);
	});

	it("installs nothing on another built-in or on a non-extensible one", () => {
		expect(installMutatorShadows(/x/, "[object RegExp]")).toBe(false);
		expect(
			installMutatorShadows(Object.freeze(new Date(0)), "[object Date]"),
		).toBe(false);
	});
});
