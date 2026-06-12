// deepEqual.test.ts
import { describe, expect, it } from "vitest";
import { deepEqual } from "./deep-equal";

describe("deepEqual – Primitive", () => {
	it("vergleicht Zahlen korrekt", () => {
		expect(deepEqual(1, 1)).toBe(true);
		expect(deepEqual(1, 2)).toBe(false);
		expect(deepEqual(0, -0)).toBe(true); // SameValueZero
	});

	it("vergleicht Strings korrekt", () => {
		expect(deepEqual("a", "a")).toBe(true);
		expect(deepEqual("a", "b")).toBe(false);
	});

	it("vergleicht Booleans korrekt", () => {
		expect(deepEqual(true, true)).toBe(true);
		expect(deepEqual(true, false)).toBe(false);
	});

	it("vergleicht null und undefined korrekt", () => {
		expect(deepEqual(null, null)).toBe(true);
		expect(deepEqual(undefined, undefined)).toBe(true);
		expect(deepEqual(null, undefined)).toBe(false);
	});

	it("behandelt NaN als gleich", () => {
		expect(deepEqual(NaN, NaN)).toBe(true);
		expect(deepEqual(NaN, 1)).toBe(false);
	});

	it("vergleicht BigInt korrekt", () => {
		expect(deepEqual(1n, 1n)).toBe(true);
		expect(deepEqual(1n, 2n)).toBe(false);
	});

	it("vergleicht Funktionen nur referenzbasiert", () => {
		const fn1 = () => {};
		const fn2 = () => {};
		expect(deepEqual(fn1, fn1)).toBe(true);
		expect(deepEqual(fn1, fn2)).toBe(false);
	});
});

describe("deepEqual – Plain Objects", () => {
	it("vergleicht einfache Objekte", () => {
		expect(deepEqual({ a: 1 }, { a: 1 })).toBe(true);
		expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
	});

	it("ignoriert Property-Reihenfolge", () => {
		const a = { a: 1, b: 2 };
		const b = { b: 2, a: 1 };
		expect(deepEqual(a, b)).toBe(true);
	});

	it("erkennt zusätzliche oder fehlende Properties", () => {
		expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
		expect(deepEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false);
	});

	it("unterstützt Object.create(null)", () => {
		const a = Object.create(null);
		const b = Object.create(null);
		a.x = 1;
		b.x = 1;
		expect(deepEqual(a, b)).toBe(true);
	});

	it("behandelt unterschiedliche Prototypen mit gleichen Keys als gleich (wie implementiert)", () => {
		const a = { x: 1 };
		const b = Object.create(null) as any;
		b.x = 1;
		expect(deepEqual(a, b)).toBe(true);
	});
});

describe("deepEqual – Arrays", () => {
	it("vergleicht Arrays elementweise", () => {
		expect(deepEqual([1, 2, 3], [1, 2, 3])).toBe(true);
		expect(deepEqual([1, 2, 3], [1, 2, 4])).toBe(false);
	});

	it("erkennt unterschiedliche Längen", () => {
		expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
	});

	it("unterscheidet Array und Objekt", () => {
		const arr = [1, 2];
		const obj = { 0: 1, 1: 2, length: 2 };
		expect(deepEqual(arr, obj)).toBe(false);
	});

	it("vergleicht verschachtelte Arrays und Objekte", () => {
		const a = [{ x: 1 }, { y: [2, 3] }];
		const b = [{ x: 1 }, { y: [2, 3] }];
		expect(deepEqual(a, b)).toBe(true);

		const c = [{ x: 1 }, { y: [2, 4] }];
		expect(deepEqual(a, c)).toBe(false);
	});
});

describe("deepEqual – Date, RegExp, Wrapper", () => {
	it("vergleicht Date-Objekte nach Zeitstempel", () => {
		const a = new Date("2020-01-01T00:00:00Z");
		const b = new Date("2020-01-01T00:00:00Z");
		const c = new Date("2021-01-01T00:00:00Z");

		expect(deepEqual(a, b)).toBe(true);
		expect(deepEqual(a, c)).toBe(false);
	});

	it("vergleicht RegExp-Objekte nach source und flags", () => {
		expect(deepEqual(/abc/i, /abc/i)).toBe(true);
		expect(deepEqual(/abc/i, /abc/g)).toBe(false);
		expect(deepEqual(/abc/, /abcd/)).toBe(false);
	});

	it("vergleicht Wrapper-Objekte (Number/String/Boolean)", () => {
		expect(deepEqual(new Number(1), new Number(1))).toBe(true);
		expect(deepEqual(new Number(1), new Number(2))).toBe(false);
		expect(deepEqual(new String("a"), new String("a"))).toBe(true);
		expect(deepEqual(new Boolean(true), new Boolean(false))).toBe(false);
	});
});

describe("deepEqual – Map", () => {
	it("vergleicht Maps mit primitiven Keys und Values", () => {
		const a = new Map<string, number>([
			["a", 1],
			["b", 2],
		]);
		const b = new Map<string, number>([
			["a", 1],
			["b", 2],
		]);
		const c = new Map<string, number>([
			["a", 1],
			["b", 3],
		]);

		expect(deepEqual(a, b)).toBe(true);
		expect(deepEqual(a, c)).toBe(false);
	});

	it("vergleicht Maps mit Objekt-Values tief", () => {
		const keyObj = { id: 1 };
		const a = new Map<unknown, unknown>([
			["x", { foo: "bar" }],
			[keyObj, { nested: [1, 2, 3] }],
		]);
		const b = new Map<unknown, unknown>([
			["x", { foo: "bar" }],
			[keyObj, { nested: [1, 2, 3] }],
		]);
		const c = new Map<unknown, unknown>([
			["x", { foo: "bar" }],
			[keyObj, { nested: [1, 2, 4] }],
		]);

		expect(deepEqual(a, b)).toBe(true);
		expect(deepEqual(a, c)).toBe(false);
	});

	it("nutzt Referenzgleichheit für Map-Keys (JS-Semantik)", () => {
		const k1 = { id: 1 };
		const k2 = { id: 1 };
		const a = new Map<unknown, number>([[k1, 1]]);
		const b = new Map<unknown, number>([[k2, 1]]);

		// Map keys are compared by reference (JS semantics), not by deep equality
		// k1 and k2 are different object references, so Map.has() returns false
		// This is expected behavior: values are deep-compared, but keys use reference equality
		expect(deepEqual(a, b)).toBe(false);
	});
});

describe("deepEqual – Set", () => {
	it("vergleicht Sets mit primitiven Werten", () => {
		const a = new Set([1, 2, 3]);
		const b = new Set([3, 2, 1]);
		const c = new Set([1, 2, 4]);

		expect(deepEqual(a, b)).toBe(true);
		expect(deepEqual(a, c)).toBe(false);
	});

	it("nutzt Referenzgleichheit für Set-Elemente", () => {
		const v1 = { id: 1 };
		const v2 = { id: 1 };
		const a = new Set([v1]);
		const b = new Set([v2]);

		expect(deepEqual(a, b)).toBe(false);
	});
});

describe("deepEqual – Typed Arrays und DataView", () => {
	it("vergleicht Typed Arrays elementweise", () => {
		const a = new Uint8Array([1, 2, 3]);
		const b = new Uint8Array([1, 2, 3]);
		const c = new Uint8Array([1, 2, 4]);

		expect(deepEqual(a, b)).toBe(true);
		expect(deepEqual(a, c)).toBe(false);
	});

	it("vergleicht DataView byteweise", () => {
		const buf1 = new ArrayBuffer(4);
		const buf2 = new ArrayBuffer(4);
		const buf3 = new ArrayBuffer(4);

		const v1 = new DataView(buf1);
		const v2 = new DataView(buf2);
		const v3 = new DataView(buf3);

		v1.setUint8(0, 1);
		v2.setUint8(0, 1);
		v3.setUint8(0, 2);

		expect(deepEqual(v1, v2)).toBe(true);
		expect(deepEqual(v1, v3)).toBe(false);
	});
});

describe("deepEqual – Zirkuläre Referenzen", () => {
	it("handhabt einfache Selbstreferenzen", () => {
		const a: any = { value: 1 };
		a.self = a;
		const b: any = { value: 1 };
		b.self = b;

		expect(deepEqual(a, b)).toBe(true);
	});

	it("erkennt Unterschiede in zirkulären Strukturen", () => {
		const a: any = { value: 1 };
		a.self = a;

		const b: any = { value: 2 };
		b.self = b;

		expect(deepEqual(a, b)).toBe(false);
	});

	it("erkennt asymmetrische Zyklen", () => {
		const a: any = {};
		a.self = a;

		const b: any = { self: {} };

		expect(deepEqual(a, b)).toBe(false);
	});
});

describe("deepEqual – Pair-tracking edge cases", () => {
	it("compares the same shared sub-graph at multiple positions without poisoning the cache", () => {
		const shared = { v: 1 };
		const a = { l: shared, r: shared, x: { v: 2 } };
		const b = { l: shared, r: shared, x: { v: 3 } };

		// Difference is in `x`, not in the shared sub-graph; the pair-cache must
		// not short-circuit the unrelated x sub-tree.
		expect(deepEqual(a, b)).toBe(false);
	});

	it("two-cycle (A↔A') vs self-cycle (B→B) with otherwise identical fields", () => {
		const a1: any = { tag: "n" };
		const a2: any = { tag: "n" };
		a1.next = a2;
		a2.next = a1;

		const b: any = { tag: "n" };
		b.next = b;

		// Both structures look identical at every node, so the pair-set cycle
		// hypothesis treats them as equal once the pair (aN, b) has been
		// visited.
		expect(deepEqual(a1, b)).toBe(true);
	});
});

describe("deepEqual – Symbol-keyed properties", () => {
	const TAG = Symbol("tag");

	it("compares symbol-keyed values like string-keyed ones", () => {
		expect(deepEqual({ [TAG]: 1 }, { [TAG]: 1 })).toBe(true);
		expect(deepEqual({ [TAG]: 1 }, { [TAG]: 2 })).toBe(false);
	});

	it("fails fast when one side has an extra symbol key", () => {
		const a: Record<symbol, number> = { [TAG]: 1 };
		const b: Record<symbol, number> = {};
		expect(deepEqual(a, b)).toBe(false);
	});

	it("fails fast when sides have different symbol keys with the same count", () => {
		const OTHER = Symbol("other");
		const a: Record<symbol, number> = { [TAG]: 1 };
		const b: Record<symbol, number> = { [OTHER]: 1 };
		expect(deepEqual(a, b)).toBe(false);
	});
});

describe("deepEqual – Error comparison", () => {
	it("returns false for two distinct Error instances with the same message", () => {
		// Error has no Symbol.toStringTag default override beyond "Error";
		// the Object.prototype.toString tag covers it via the built-in
		// allow-list. The library treats unhandled built-ins by reference,
		// so two distinct Error instances are NOT equal even if their
		// message is the same. Documenting the behaviour.
		const a = new Error("oops");
		const b = new Error("oops");
		expect(deepEqual(a, b)).toBe(false);
	});

	it("returns true when both sides reference the same Error instance", () => {
		const err = new Error("oops");
		expect(deepEqual(err, err)).toBe(true);
	});
});

describe("deepEqual – Plain object vs class instance with identical keys", () => {
	it("compares structurally on the tag = [object Object] (constructor not checked at the deepEqual level)", () => {
		class Money {
			constructor(
				public amount: number,
				public currency: string,
			) {}
		}
		const lhs = new Money(100, "EUR");
		const rhs = { amount: 100, currency: "EUR" };

		// Both have tag "[object Object]"; deepEqual is structurally
		// equal even though the constructor differs. Consumers who need
		// constructor-aware identity should use ValueObject.equals (which
		// adds a constructor check on top of deepEqual).
		expect(deepEqual(lhs, rhs)).toBe(true);
	});

	it("returns false when constructors AND structure differ", () => {
		class A {
			constructor(public x: number) {}
		}
		expect(deepEqual(new A(1), { x: 2 })).toBe(false);
	});
});

describe("deepEqual – Typ-Mismatches", () => {
	it("unterscheidet klar nach Typen/Tags", () => {
		expect(deepEqual([], {})).toBe(false);
		expect(deepEqual(new Date(), {})).toBe(false);
		expect(deepEqual(new Map(), {})).toBe(false);
		expect(deepEqual(new Set(), {})).toBe(false);
		expect(deepEqual(new Uint8Array(), [])).toBe(false);
	});
});

describe("deepEqual – Symbol.toStringTag spoofing", () => {
	// Type detection is tag-based (cross-realm safe), but a plain object can
	// set Symbol.toStringTag to any built-in name. Spoofed objects must be
	// brand-checked and fall back to plain-object comparison, not crash.
	it("does not crash on plain objects spoofing the Date tag", () => {
		const a = { [Symbol.toStringTag]: "Date" };
		const b = { [Symbol.toStringTag]: "Date" };

		// Treated as plain objects: same keys/values → equal.
		expect(deepEqual(a, b)).toBe(true);
	});

	it("compares spoofed objects by their actual content, not the spoofed type", () => {
		const a = { [Symbol.toStringTag]: "Map", x: 1 };
		const b = { [Symbol.toStringTag]: "Map", x: 2 };

		expect(deepEqual(a, b)).toBe(false);
	});

	it("does not crash on spoofed Map/Set/DataView/Number tags", () => {
		for (const tagName of ["Map", "Set", "DataView", "Number", "Boolean", "String", "RegExp"]) {
			const a = { [Symbol.toStringTag]: tagName, v: 1 };
			const b = { [Symbol.toStringTag]: tagName, v: 1 };
			expect(deepEqual(a, b)).toBe(true);
		}
	});

	it("a real Date never equals a spoofed Date", () => {
		expect(deepEqual(new Date(0), { [Symbol.toStringTag]: "Date" })).toBe(
			false,
		);
	});

	it("a real Map never equals a spoofed Map", () => {
		expect(deepEqual(new Map(), { [Symbol.toStringTag]: "Map" })).toBe(false);
	});

	it("plain objects spoofing the Array tag are not compared as arrays", () => {
		// Without a brand check both sides have length undefined and the
		// element loop never runs, so everything would compare equal.
		const a = { [Symbol.toStringTag]: "Array", x: 1 };
		const b = { [Symbol.toStringTag]: "Array", x: 2 };

		expect(deepEqual(a, b)).toBe(false);
	});

	it("real arrays with a spoofed tag still compare element-wise", () => {
		const a = Object.assign([1, 2], { [Symbol.toStringTag]: "Date" });
		const b = Object.assign([1, 2], { [Symbol.toStringTag]: "Date" });
		const c = Object.assign([1, 3], { [Symbol.toStringTag]: "Date" });

		expect(deepEqual(a, b)).toBe(true);
		expect(deepEqual(a, c)).toBe(false);
	});

	it("real built-ins still compare by value (regression guard)", () => {
		expect(deepEqual(new Date(5), new Date(5))).toBe(true);
		expect(deepEqual(new Map([["k", 1]]), new Map([["k", 1]]))).toBe(true);
		expect(deepEqual(new Number(5), new Number(5))).toBe(true);
	});
});

describe("deepEqual – NaN consistency across containers", () => {
	// deepEqual(NaN, NaN) is true for primitives; the same SameValueZero
	// semantics must hold wherever numbers are compared.
	it("treats NaN elements in TypedArrays as equal", () => {
		expect(
			deepEqual(new Float64Array([1, NaN]), new Float64Array([1, NaN])),
		).toBe(true);
		expect(
			deepEqual(new Float64Array([NaN]), new Float64Array([1])),
		).toBe(false);
	});

	it("treats two invalid Dates as equal", () => {
		expect(deepEqual(new Date(NaN), new Date(NaN))).toBe(true);
		expect(deepEqual(new Date(NaN), new Date(0))).toBe(false);
	});

	it("treats two NaN Number wrappers as equal", () => {
		expect(deepEqual(new Number(NaN), new Number(NaN))).toBe(true);
		expect(deepEqual(new Number(NaN), new Number(1))).toBe(false);
	});
});
