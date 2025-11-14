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

describe("deepEqual – Typ-Mismatches", () => {
	it("unterscheidet klar nach Typen/Tags", () => {
		expect(deepEqual([], {})).toBe(false);
		expect(deepEqual(new Date(), {})).toBe(false);
		expect(deepEqual(new Map(), {})).toBe(false);
		expect(deepEqual(new Set(), {})).toBe(false);
		expect(deepEqual(new Uint8Array(), [])).toBe(false);
	});
});
