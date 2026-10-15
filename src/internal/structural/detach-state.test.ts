// @ts-expect-error Node's VM exists in the test runtime; the package stays Node-type-free.
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vite-plus/test";
import {
	assertFreezableState,
	detachFreezableState,
	detachState,
} from "./detach-state";

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

	it("walks a Map and a Set with their built-in iteration, not an own iterator", () => {
		let iteratorReads = 0;
		const tags = new Map([["a", new OwnerReview(true)]]);
		Object.defineProperty(tags, Symbol.iterator, {
			get() {
				iteratorReads += 1;
				return function* () {};
			},
		});
		const members = new Set([new OwnerReview(false)]);
		Object.defineProperty(members, Symbol.iterator, {
			value: function* () {},
		});

		expect(() => detachState({ tags })).toThrow(/state\.tags<map value #0>/);
		expect(() => detachState({ members })).toThrow(
			/state\.members<set member #0>/,
		);
		expect(iteratorReads).toBe(0);
	});

	it("names a class without running a static name getter", () => {
		let nameReads = 0;
		class Price {
			readonly cents = 100;
			static get name() {
				nameReads += 1;
				return "Price";
			}
		}

		expect(() => detachState({ price: new Price() })).toThrow(TypeError);
		expect(nameReads).toBe(0);
	});

	it("names the subject in its messages", () => {
		expect(() =>
			detachState({ note: () => "x" }, "the event at index 0"),
		).toThrow(/^the event at index 0\.note is a function/);
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

	it.each([
		["a Map", () => Object.assign(new Map(), { 0: "lost" })],
		["a Set", () => Object.assign(new Set(), { 0: "lost" })],
		["a Date", () => Object.assign(new Date(0), { 0: "lost" })],
		["a boxed number", () => Object.assign(Object(1), { 0: "lost" })],
		["an ArrayBuffer", () => Object.assign(new ArrayBuffer(2), { 0: "lost" })],
		[
			"a boxed String after its last character",
			() => Object.assign(new String("ab"), { 5: "lost" }),
		],
	])(
		"rejects an index expando that the clone would drop on %s",
		(_case, make) => {
			expect(() => detachState({ value: make() })).toThrow(TypeError);
		},
	);

	it("rejects an index accessor on a built-in", () => {
		const byId = Object.defineProperty(new Map(), "0", {
			get: () => "computed",
			enumerable: true,
		});

		expect(() => detachState({ byId })).toThrow(TypeError);
	});

	it.each([
		[
			"a Map",
			() =>
				Object.defineProperty(new Map([["a", 1]]), "note", {
					value: "keep me",
				}),
		],
		[
			"a Set, at an index key",
			() => Object.defineProperty(new Set([1]), "0", { value: "x" }),
		],
		[
			"a Date, as an accessor",
			() => Object.defineProperty(new Date(0), "label", { get: () => "x" }),
		],
		[
			"a Date, as a function that is not a frozen mutator",
			() =>
				Object.defineProperty(new Date(0), "toJSON", {
					value: () => "1970-Q1",
				}),
		],
		[
			"a Map, as a function that is not a frozen mutator",
			() =>
				Object.defineProperty(new Map(), "meta", {
					value: () => ({ source: "import" }),
				}),
		],
	])(
		"rejects a non-enumerable property that the clone would drop on %s",
		(_case, make) => {
			expect(() => detachState({ value: make() })).toThrow(TypeError);
		},
	);

	it("keeps the elements of a typed array and the characters of a boxed String", () => {
		const copy = detachState({
			bytes: new Uint8Array([1, 2]),
			label: new String("ab"),
		});

		expect([...copy.bytes]).toEqual([1, 2]);
		expect(String(copy.label)).toBe("ab");
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

describe("detachState and a graph that the walk cannot see", () => {
	it("reads the buffer of a typed array without running an own accessor, and rejects the accessor", () => {
		let runs = 0;
		const bytes = new Uint8Array(2);
		Object.defineProperty(bytes, "buffer", {
			get() {
				runs += 1;
				return new ArrayBuffer(2);
			},
		});

		expect(() => detachState({ bytes })).toThrow(TypeError);
		expect(runs).toBe(0);
	});

	it("rejects an Error in a Map whose prototype was replaced", () => {
		const disguised = Object.setPrototypeOf(
			new Map([["cause", new Error("lost")]]),
			Object.prototype,
		);

		expect(() => detachState({ disguised })).toThrow(TypeError);
	});

	it.each([
		["a Map", () => new Map([["k", 1]])],
		["a Set", () => new Set([1])],
		["an ArrayBuffer", () => new ArrayBuffer(4)],
		["a boxed bigint", () => Object(1n)],
	])(
		"rejects %s whose prototype was replaced and that carries an own property",
		(_case, make) => {
			const disguised = Object.setPrototypeOf(make(), Object.prototype);
			disguised.note = "lost in the copy";

			expect(() => detachState({ disguised })).toThrow(TypeError);
		},
	);

	it.each([
		["a Map", () => new Map([["k", { a: 1 }]])],
		["a Set", () => new Set([{ id: 1 }])],
	])(
		"rejects %s whose prototype was replaced when the record in it balances the lost property in a count",
		(_case, make) => {
			const disguised = Object.setPrototypeOf(make(), Object.prototype);
			disguised.note = "lost in the copy";

			expect(() => detachState({ disguised })).toThrow(TypeError);
		},
	);

	it("rejects a Map whose prototype was replaced and that carries no own property, because the copy is a Map", () => {
		const disguised = Object.setPrototypeOf(
			new Map([["k", 1]]),
			Object.prototype,
		);

		expect(() => detachState({ disguised })).toThrow(TypeError);
	});

	it("rejects an Error that a Proxy trap swaps in during the walk", () => {
		const state: Record<string, unknown> = { a: { ok: true } };
		state.b = new Proxy(
			{},
			{
				ownKeys(target) {
					state.a = new Error("swapped in");
					state.b = "plain";
					return Reflect.ownKeys(target);
				},
			},
		);

		expect(() => detachState(state)).toThrow(TypeError);
	});
});

describe("detachFreezableState", () => {
	it.each([
		["a typed array", () => new Uint8Array(4)],
		["a DataView", () => new DataView(new ArrayBuffer(2))],
		["an ArrayBuffer", () => new ArrayBuffer(8)],
		["a SharedArrayBuffer", () => new SharedArrayBuffer(8)],
	])("rejects %s anywhere in the state", (_case, binaryData) => {
		const state = { parts: [{ data: binaryData() }] };

		expect(() => detachFreezableState(state, "state")).toThrow(TypeError);
	});

	it("rejects a RegExp, which detachState accepts", () => {
		const state = { pattern: /a/g };

		expect(() => detachFreezableState(state, "state")).toThrow(TypeError);
		expect(detachState(state).pattern.source).toBe("a");
	});

	it("copies plain data like detachState", () => {
		const state = { at: new Date(0), tags: new Set(["a"]) };

		const copy = detachFreezableState(state, "state");

		expect(copy).toEqual(state);
		expect(copy).not.toBe(state);
	});
});

describe("assertFreezableState", () => {
	it("rejects binary data in a Map key", () => {
		const state = new Map([[new Uint8Array(1), "a"]]);

		expect(() => assertFreezableState(state, "state")).toThrow(TypeError);
	});

	it("accepts plain data", () => {
		expect(() => assertFreezableState({ a: [1, "b"] }, "state")).not.toThrow();
	});
});
