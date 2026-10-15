import { describe, expect, it } from "vite-plus/test";
import { installMutatorShadows, isMutatorShadow } from "./shadowed-mutators";

function shadowOn(object: object, key: string): PropertyDescriptor {
	const descriptor = Object.getOwnPropertyDescriptor(object, key);
	if (descriptor === undefined) throw new Error(`no own ${key}`);
	return descriptor;
}

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

describe("isMutatorShadow", () => {
	it("recognizes an installed shadow", () => {
		const map = new Map();
		installMutatorShadows(map, "[object Map]");

		expect(isMutatorShadow("[object Map]", "set", shadowOn(map, "set"))).toBe(
			true,
		);
	});

	it("does not recognize an own function under a mutator name", () => {
		const map = Object.defineProperty(new Map(), "set", {
			value: function set() {},
		});

		expect(isMutatorShadow("[object Map]", "set", shadowOn(map, "set"))).toBe(
			false,
		);
	});

	it("recognizes a shadow by its brand, not by its function name", () => {
		const map = new Map();
		installMutatorShadows(map, "[object Map]");
		const renamed = Object.defineProperty(new Map(), "set", {
			value: function throwFrozenMutation() {},
		});

		expect(isMutatorShadow("[object Map]", "set", shadowOn(map, "set"))).toBe(
			true,
		);
		expect(
			isMutatorShadow("[object Map]", "set", shadowOn(renamed, "set")),
		).toBe(false);
	});

	it("does not recognize a shadow under a key that is not a mutator of the built-in", () => {
		const date = new Date(0);
		installMutatorShadows(date, "[object Date]");
		const shadow = shadowOn(date, "setTime");

		expect(isMutatorShadow("[object Date]", "toJSON", shadow)).toBe(false);
		expect(isMutatorShadow("[object Map]", "setTime", shadow)).toBe(false);
	});
});
