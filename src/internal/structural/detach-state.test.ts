import { describe, expect, it } from "vite-plus/test";
import { detachState } from "./detach-state";

class OwnerReview {
	constructor(readonly requested: boolean) {}
	invalidated(): boolean {
		return !this.requested;
	}
}

describe("detachState", () => {
	it("returns a copy that shares no object with the state", () => {
		const state = {
			items: [{ sku: "a", price: 10n }],
			tags: new Set(["x"]),
			byId: new Map([["a", { qty: 1 }]]),
			placedAt: new Date("2026-09-06T10:00:00.000Z"),
		};

		const detached = detachState(state);

		expect(detached).toEqual(state);
		expect(detached).not.toBe(state);
		expect(detached.items[0]).not.toBe(state.items[0]);
		expect(detached.byId.get("a")).not.toBe(state.byId.get("a"));
		expect(detached.placedAt).not.toBe(state.placedAt);
	});

	it("rejects a class instance with its path and class name instead of dropping its methods", () => {
		const state = { review: { owner: new OwnerReview(true) } };

		expect(() => detachState(state)).toThrow(
			/state\.review\.owner is a class instance \(OwnerReview\); map it to plain data/,
		);
	});

	it("rejects a class instance inside an array, a Map, and a Set with the container path", () => {
		const instance = new OwnerReview(true);

		expect(() => detachState({ list: [instance] })).toThrow(/state\.list\[0\]/);
		expect(() => detachState({ byId: new Map([["a", instance]]) })).toThrow(
			/state\.byId<map value #0>/,
		);
		expect(() => detachState({ set: new Set([instance]) })).toThrow(
			/state\.set<set member #0>/,
		);
	});

	const undetachable: ReadonlyArray<readonly [string, unknown, RegExp]> = [
		[
			"a function",
			{ nested: { total: () => 1 } },
			/state\.nested\.total is a function/,
		],
		[
			"a symbol value",
			{ status: Symbol("draft") },
			/state\.status is a symbol/,
		],
		["a symbol key", { [Symbol("secret")]: 1 }, /symbol-keyed property/],
		[
			"a non-enumerable property",
			Object.defineProperty({ visible: 1 }, "hidden", {
				value: 2,
				enumerable: false,
			}),
			/state\.hidden is not enumerable and the clone would drop it/,
		],
		["an Error", { nested: new Error("broken") }, /state\.nested is an Error/],
		[
			"a Promise",
			{ nested: Promise.resolve(1) },
			/is a Promise and cannot be detached/,
		],
		[
			"a WeakMap",
			{ nested: new WeakMap() },
			/is a WeakMap and cannot be detached/,
		],
		[
			"a WeakSet",
			{ nested: new WeakSet() },
			/is a WeakSet and cannot be detached/,
		],
	];
	it.each(undetachable)("rejects %s with its path", (_kind, state, message) => {
		expect(() => detachState(state)).toThrow(message);
	});

	it("names the root when the state itself is a class instance", () => {
		expect(() => detachState(new OwnerReview(true))).toThrow(
			/^detachState: state is a class instance \(OwnerReview\)/,
		);
	});

	it("passes a non-enumerable symbol key as hidden metadata", () => {
		const state = Object.defineProperty({ status: "draft" }, Symbol("brand"), {
			value: true,
			enumerable: false,
		});

		expect(detachState(state)).toEqual({ status: "draft" });
	});

	it("passes a RegExp, a null-prototype object, a typed array, and a cycle", () => {
		const cyclic: { self?: unknown; pattern: RegExp } = { pattern: /sku-\d+/g };
		cyclic.self = cyclic;
		const state = {
			cyclic,
			bare: Object.assign(Object.create(null), { a: 1 }),
			bytes: new Uint8Array([1, 2]),
		};

		const detached = detachState(state);

		expect(detached.cyclic.self).toBe(detached.cyclic);
		expect(detached.cyclic.pattern.source).toBe("sku-\\d+");
		expect(detached.bare.a).toBe(1);
		expect(Array.from(detached.bytes)).toEqual([1, 2]);
	});

	it("leaves the original open when the caller freezes the copy", () => {
		const state = { status: "draft" };

		Object.freeze(detachState(state));

		expect(Object.isFrozen(state)).toBe(false);
	});
});
