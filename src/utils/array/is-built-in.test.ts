import { describe, expect, it } from "vitest";
import { isBuiltInObject } from "./is-built-in";

function tag(o: object): string {
	return Object.prototype.toString.call(o);
}

describe("isBuiltInObject", () => {
	describe("identifies built-in types", () => {
		const cases: Array<[string, object]> = [
			["Date", new Date()],
			["RegExp", /x/],
			["Map", new Map()],
			["Set", new Set()],
			["WeakMap", new WeakMap()],
			["WeakSet", new WeakSet()],
			["Promise", Promise.resolve()],
			["Error", new Error("x")],
			["ArrayBuffer", new ArrayBuffer(8)],
			["DataView", new DataView(new ArrayBuffer(8))],
			["Int8Array", new Int8Array(2)],
			["Uint8Array", new Uint8Array(2)],
			["Float64Array", new Float64Array(2)],
			["Boolean wrapper", new Boolean(true)],
			["Number wrapper", new Number(1)],
			["String wrapper", new String("x")],
		];

		for (const [name, obj] of cases) {
			it(`returns true for ${name}`, () => {
				expect(isBuiltInObject(obj, tag(obj))).toBe(true);
			});
		}
	});

	describe("rejects user-defined classes (does NOT misclassify as built-in)", () => {
		it("plain user class with constructor is NOT a built-in", () => {
			class Money {
				constructor(public amount: number, public currency: string) {}
			}
			const m = new Money(100, "EUR");
			expect(isBuiltInObject(m, tag(m))).toBe(false);
		});

		it("user class extending another user class is NOT a built-in", () => {
			class A {
				constructor(public x: number) {}
			}
			class B extends A {
				constructor(
					x: number,
					public y: number,
				) {
					super(x);
				}
			}
			const b = new B(1, 2);
			expect(isBuiltInObject(b, tag(b))).toBe(false);
		});

		it("plain object is NOT a built-in", () => {
			const o = { a: 1, b: 2 };
			expect(isBuiltInObject(o, tag(o))).toBe(false);
		});

		it("user class named after a built-in is NOT a built-in", () => {
			// Naming a class 'Date' must not collide with the real Date;
			// the tag-based detection is constructor-name agnostic.
			class Date {
				constructor(public iso: string) {}
			}
			const d = new Date("2026-01-01");
			expect(isBuiltInObject(d, tag(d))).toBe(false);
		});
	});
});
