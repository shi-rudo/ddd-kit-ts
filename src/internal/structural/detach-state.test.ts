// @ts-expect-error Node's VM exists in the test runtime; the package stays Node-type-free.
import { runInNewContext } from "node:vm";
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

	it("rejects a subclass of a built-in as a class instance instead of dropping its methods", () => {
		class Tags extends Set<string> {
			has(tag: string): boolean {
				return super.has(tag.toLowerCase());
			}
		}
		class Line extends Array<number> {}
		class Stamp extends Date {}
		class Bytes extends Uint8Array {}

		expect(() => detachState({ tags: new Tags() })).toThrow(
			/state\.tags is a class instance \(Tags\)/,
		);
		expect(() => detachState({ line: new Line() })).toThrow(
			/state\.line is a class instance \(Line\)/,
		);
		expect(() => detachState({ at: new Stamp() })).toThrow(
			/state\.at is a class instance \(Stamp\)/,
		);
		expect(() => detachState({ raw: new Bytes(2) })).toThrow(
			/state\.raw is a class instance \(Bytes\)/,
		);
	});

	it("rejects an accessor property without invoking it", () => {
		let invoked = 0;
		const state = {
			get total() {
				invoked++;
				return 1;
			},
		};

		expect(() => detachState(state)).toThrow(
			/state\.total is an accessor property/,
		);
		expect(invoked).toBe(0);
	});

	it("rejects an expando or a symbol key on a built-in that the clone would drop", () => {
		const byId = Object.assign(new Map([["a", 1]]), { note: "x" });
		const tags = Object.assign(new Set(), { [Symbol("brand")]: 1 });

		expect(() => detachState({ byId })).toThrow(
			/state\.byId\.note is an expando on a Map and the clone would drop it/,
		);
		expect(() => detachState({ tags })).toThrow(
			/state\.tags has a symbol-keyed property/,
		);
	});

	it("walks an array expando as a member and rejects a hidden key on an array", () => {
		const line = Object.assign([1, 2], { owner: new OwnerReview(true) });
		const hidden = Object.defineProperty([1], "hidden", {
			value: 2,
			enumerable: false,
		});

		expect(() => detachState({ line })).toThrow(
			/state\.line\.owner is a class instance \(OwnerReview\)/,
		);
		expect(() => detachState({ hidden })).toThrow(
			/state\.hidden\.hidden is not enumerable and the clone would drop it/,
		);
		expect(detachState({ tagged: Object.assign([1], { note: "x" }) })).toEqual({
			tagged: Object.assign([1], { note: "x" }),
		});
	});

	it("rejects a SharedArrayBuffer and a view over one instead of sharing their memory", () => {
		const shared = new SharedArrayBuffer(8);

		expect(() => detachState({ shared })).toThrow(
			/state\.shared is backed by a SharedArrayBuffer/,
		);
		expect(() => detachState({ view: new Uint8Array(shared) })).toThrow(
			/state\.view is backed by a SharedArrayBuffer/,
		);
	});

	it("rethrows the clone failure of a Proxy as a TypeError that keeps the cause", () => {
		const state = { hidden: new Proxy({ a: 1 }, {}) };

		let caught: unknown;
		try {
			detachState(state);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(TypeError);
		expect((caught as TypeError).message).toMatch(
			/holds a Proxy or a host object that cannot be cloned/,
		);
		expect((caught as TypeError).cause).toBeDefined();
	});

	it("passes a plain object from another realm as a record", () => {
		const foreign = runInNewContext("({ status: 'draft', nested: { n: 1 } })");

		expect(detachState({ foreign })).toEqual({
			foreign: { status: "draft", nested: { n: 1 } },
		});
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
