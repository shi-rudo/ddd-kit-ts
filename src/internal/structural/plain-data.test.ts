// @ts-expect-error Node's VM exists in the test runtime; the package stays Node-type-free.
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { PrototypePollutionError } from "../../errors/kit-errors";
import { copyPlainData } from "./plain-data";

const options = { subject: "state" };

describe("copyPlainData", () => {
	it("keeps primitives", () => {
		const value = {
			text: "a",
			count: 1,
			flag: true,
			big: 1n,
			missing: undefined,
			empty: null,
		};

		expect(copyPlainData(value, options)).toEqual(value);
	});

	it("copies records and arrays without sharing an object with the original", () => {
		const value = { lines: [{ sku: "A", quantity: 2 }], note: { text: "x" } };

		const copy = copyPlainData(value, options);

		expect(copy).toEqual(value);
		expect(copy).not.toBe(value);
		expect(copy.lines).not.toBe(value.lines);
		expect(copy.lines[0]).not.toBe(value.lines[0]);
		expect(copy.note).not.toBe(value.note);
	});

	it("keeps a record without a prototype without a prototype", () => {
		const value = Object.assign(Object.create(null), { a: 1 });

		const copy = copyPlainData(value, options);

		expect(Object.getPrototypeOf(copy)).toBeNull();
		expect(copy.a).toBe(1);
	});

	it("copies a record and an array of another realm into the local realm", () => {
		const value = runInNewContext("({ lines: [{ sku: 'A' }] })");

		const copy = copyPlainData(value, options);

		expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
		expect(Object.getPrototypeOf(copy.lines)).toBe(Array.prototype);
		expect(copy).toEqual({ lines: [{ sku: "A" }] });
	});

	it("keeps the holes and the other own keys of an array", () => {
		const value = Object.assign(new Array<unknown>(3), {
			0: 1,
			2: 3,
			total: 2,
		});

		const copy = copyPlainData(value, options);

		expect(copy).toHaveLength(3);
		expect(1 in copy).toBe(false);
		expect(copy.total).toBe(2);
	});

	it("copies a Date with its time", () => {
		const value = new Date("2026-10-21T10:00:00.000Z");

		const copy = copyPlainData(value, options);

		expect(copy).not.toBe(value);
		expect(copy.getTime()).toBe(value.getTime());
	});

	describe("a Date that fake timers create", () => {
		afterEach(() => {
			vi.useRealTimers();
		});

		it("copies it to a plain Date with its time", () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date("2026-10-21T10:00:00.000Z"));
			const value = { at: new Date() };

			const copy = copyPlainData(value, options);

			expect(copy.at.toISOString()).toBe("2026-10-21T10:00:00.000Z");
		});
	});

	it("copies a Date subclass to a plain Date", () => {
		class BusinessDate extends Date {}

		const copy = copyPlainData(
			{ at: new BusinessDate("2026-10-21T10:00:00.000Z") },
			options,
		);

		expect(Object.getPrototypeOf(copy.at)).toBe(Date.prototype);
		expect(copy.at.toISOString()).toBe("2026-10-21T10:00:00.000Z");
	});

	it("copies a Map and a Set with primitive keys and members", () => {
		const value = {
			prices: new Map([["A", { amount: 1 }]]),
			tags: new Set(["new", "sale"]),
		};

		const copy = copyPlainData(value, options);

		expect(copy.prices).not.toBe(value.prices);
		expect(copy.prices.get("A")).toEqual({ amount: 1 });
		expect(copy.prices.get("A")).not.toBe(value.prices.get("A"));
		expect([...copy.tags]).toEqual(["new", "sale"]);
	});

	it("rejects a Map key or a Set member that is an object", () => {
		expect(() =>
			copyPlainData({ prices: new Map([[{ sku: "A" }, 1]]) }, options),
		).toThrow("state.prices<map key #0> is an object");
		expect(() =>
			copyPlainData({ tags: new Set([{ name: "new" }]) }, options),
		).toThrow("state.tags<set member #0> is an object");
	});

	it("keeps a cycle and a shared reference", () => {
		const shared = { text: "x" };
		const value: Record<string, unknown> = { first: shared, second: shared };
		value.self = value;

		const copy = copyPlainData(value, options);

		expect(copy.first).toBe(copy.second);
		expect(copy.self).toBe(copy);
	});

	it("keeps an object by reference when the caller says so", () => {
		const kept = { frozen: true };

		const copy = copyPlainData(
			{ kept },
			{ ...options, keepByReference: (value) => value === kept },
		);

		expect(copy.kept).toBe(kept);
	});

	it("rejects a function and a symbol with the path", () => {
		expect(() => copyPlainData({ a: { run: () => {} } }, options)).toThrow(
			"state.a.run is a function",
		);
		expect(() => copyPlainData({ items: [Symbol("x")] }, options)).toThrow(
			"state.items[0] is a symbol",
		);
	});

	it("rejects a class instance and a subclass of a built-in", () => {
		class Review {
			readonly stars = 5;
		}
		class Tags extends Set<string> {}

		expect(() => copyPlainData({ review: new Review() }, options)).toThrow(
			"state.review is a class instance (Review)",
		);
		expect(() => copyPlainData({ tags: new Tags() }, options)).toThrow(
			"state.tags is a class instance (Tags)",
		);
	});

	it("rejects other built-ins", () => {
		expect(() => copyPlainData({ pattern: /a/ }, options)).toThrow(
			"state.pattern is a RegExp",
		);
		expect(() => copyPlainData({ bytes: new Uint8Array(1) }, options)).toThrow(
			"state.bytes is binary data",
		);
		expect(() => copyPlainData({ failure: new Error("x") }, options)).toThrow(
			"state.failure is an Error",
		);
		expect(() => copyPlainData({ done: Promise.resolve() }, options)).toThrow(
			"state.done is a Promise",
		);
		expect(() =>
			copyPlainData({ boxed: Object("text") as object }, options),
		).toThrow("state.boxed is a String");
	});

	it("rejects an accessor, an enumerable symbol key, and a non-enumerable string key", () => {
		const accessor = {
			get total() {
				return 1;
			},
		};
		const symbolKeyed = { [Symbol("meta")]: 1 };
		const hidden = Object.defineProperty({}, "secret", {
			value: 1,
			enumerable: false,
		});

		expect(() => copyPlainData({ accessor }, options)).toThrow(
			"state.accessor.total is an accessor property",
		);
		expect(() => copyPlainData({ symbolKeyed }, options)).toThrow(
			"state.symbolKeyed has a symbol-keyed property",
		);
		expect(() => copyPlainData({ hidden }, options)).toThrow(
			"state.hidden.secret is not enumerable",
		);
	});

	it("leaves out a non-enumerable symbol key", () => {
		const meta = Symbol("meta");
		const value = Object.defineProperty({ a: 1 }, meta, {
			value: 1,
			enumerable: false,
		});

		const copy = copyPlainData(value, options);

		expect(Object.getOwnPropertySymbols(copy)).toEqual([]);
		expect(copy).toEqual({ a: 1 });
	});

	it("rejects an own __proto__ key at any depth", () => {
		const value = JSON.parse(
			'{ "nested": { "__proto__": { "polluted": 1 } } }',
		);

		expect(() => copyPlainData(value, options)).toThrow(
			PrototypePollutionError,
		);
		expect(() => copyPlainData(value, options)).toThrow("state.nested");
	});
});
