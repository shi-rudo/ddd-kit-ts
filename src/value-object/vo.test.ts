import { describe, expect, it } from "vitest";
import {
	vo,
	voEquals,
	voEqualsExcept,
	voWithValidation,
	type VO,
} from "./value-object";

describe("VO", () => {
	describe("vo()", () => {
		it("should create a simple value object", () => {
			const money = vo({ amount: 100, currency: "USD" });

			expect(money.amount).toBe(100);
			expect(money.currency).toBe("USD");
		});

		it("should make simple value objects immutable", () => {
			const money = vo({ amount: 100, currency: "USD" });

			expect(() => {
				(money as any).amount = 200;
			}).toThrow();
		});

		it("should deep freeze nested objects", () => {
			const address = vo({
				street: "Main St",
				city: "Berlin",
				coordinates: { lat: 52.5, lng: 13.4 },
			});

			expect(() => {
				(address.coordinates as any).lat = 99;
			}).toThrow();
		});

		it("should deep freeze deeply nested objects", () => {
			const complex = vo({
				name: "Test",
				nested: {
					level1: {
						level2: {
							value: "deep",
						},
					},
				},
			});

			expect(() => {
				(complex.nested.level1.level2 as any).value = "mutated";
			}).toThrow();
		});

		it("should freeze arrays", () => {
			const list = vo({ items: [1, 2, 3] });

			expect(() => {
				list.items.push(4);
			}).toThrow();

			expect(() => {
				list.items[0] = 999;
			}).toThrow();
		});

		it("should freeze nested objects within arrays", () => {
			const complex = vo({
				array: [
					1,
					2,
					{ nested: "in array", deep: { value: "very deep" } },
				],
			});

			expect(() => {
				(complex.array[2] as any).nested = "mutated";
			}).toThrow();

			expect(() => {
				((complex.array[2] as any).deep as any).value = "mutated";
			}).toThrow();
		});

		it("should handle empty objects", () => {
			const empty = vo({});

			expect(empty).toEqual({});
			expect(() => {
				(empty as any).newProp = "value";
			}).toThrow();
		});

		it("should handle objects with null values", () => {
			const withNull = vo({ value: null, other: "test" });

			expect(withNull.value).toBeNull();
			expect(withNull.other).toBe("test");
		});

		it("should handle objects with undefined values", () => {
			const withUndefined = vo({ value: undefined, other: "test" });

			expect(withUndefined.value).toBeUndefined();
			expect(withUndefined.other).toBe("test");
		});

		it("should preserve primitive types", () => {
			const primitives = vo({
				string: "test",
				number: 42,
				boolean: true,
				nullValue: null,
				undefinedValue: undefined,
			});

			expect(typeof primitives.string).toBe("string");
			expect(typeof primitives.number).toBe("number");
			expect(typeof primitives.boolean).toBe("boolean");
		});

		it("should handle arrays of primitives", () => {
			const array = vo({ numbers: [1, 2, 3], strings: ["a", "b"] });

			expect(() => {
				array.numbers.push(4);
			}).toThrow();

			expect(() => {
				array.strings[0] = "x";
			}).toThrow();
		});

		it("should create a new object (not mutate original)", () => {
			const original = { amount: 100, currency: "USD" };
			const valueObject = vo(original);

			expect(valueObject).not.toBe(original);
			expect(original.amount).toBe(100); // Original unchanged
		});
	});

	describe("voEquals()", () => {
		it("should return true for equal simple value objects", () => {
			const money1 = vo({ amount: 100, currency: "USD" });
			const money2 = vo({ amount: 100, currency: "USD" });

			expect(voEquals(money1, money2)).toBe(true);
		});

		it("should return false for different simple value objects", () => {
			const money1 = vo({ amount: 100, currency: "USD" });
			const money2 = vo({ amount: 200, currency: "USD" });

			expect(voEquals(money1, money2)).toBe(false);
		});

		it("should return false for different currencies", () => {
			const money1 = vo({ amount: 100, currency: "USD" });
			const money2 = vo({ amount: 100, currency: "EUR" });

			expect(voEquals(money1, money2)).toBe(false);
		});

		it("should return true for equal nested value objects", () => {
			const address1 = vo({
				street: "Main St",
				city: "Berlin",
				coordinates: { lat: 52.5, lng: 13.4 },
			});
			const address2 = vo({
				street: "Main St",
				city: "Berlin",
				coordinates: { lat: 52.5, lng: 13.4 },
			});

			expect(voEquals(address1, address2)).toBe(true);
		});

		it("should return false for different nested value objects", () => {
			const address1 = vo({
				street: "Main St",
				city: "Berlin",
				coordinates: { lat: 52.5, lng: 13.4 },
			});
			const address2 = vo({
				street: "Main St",
				city: "Berlin",
				coordinates: { lat: 99.9, lng: 13.4 },
			});

			expect(voEquals(address1, address2)).toBe(false);
		});

		it("should return true for equal arrays", () => {
			const list1 = vo({ items: [1, 2, 3] });
			const list2 = vo({ items: [1, 2, 3] });

			expect(voEquals(list1, list2)).toBe(true);
		});

		it("should return false for different arrays", () => {
			const list1 = vo({ items: [1, 2, 3] });
			const list2 = vo({ items: [1, 2, 4] });

			expect(voEquals(list1, list2)).toBe(false);
		});

		it("should return true for empty objects", () => {
			const empty1 = vo({});
			const empty2 = vo({});

			expect(voEquals(empty1, empty2)).toBe(true);
		});

		it("should handle objects with null values", () => {
			type ObjWithNull = { value: null; other: string };
			type ObjWithString = { value: string; other: string };

			const obj1 = vo<ObjWithNull>({ value: null, other: "test" });
			const obj2 = vo<ObjWithNull>({ value: null, other: "test" });
			const obj3 = vo<ObjWithString>({ value: "not null", other: "test" });

			expect(voEquals(obj1, obj2)).toBe(true);
			// Different types, so not equal
			expect(voEquals(obj1 as any, obj3 as any)).toBe(false);
		});

		it("should handle objects with undefined values", () => {
			const obj1 = vo({ value: undefined, other: "test" });
			const obj2 = vo({ value: undefined, other: "test" });
			const obj3 = vo({ other: "test" }); // Missing property

			expect(voEquals(obj1, obj2)).toBe(true);
			// deepEqual correctly distinguishes between undefined property and missing property
			// This is more accurate than JSON.stringify which removes undefined properties
			expect(voEquals(obj1, obj3)).toBe(false);
		});

		it("should return false when comparing reference equality", () => {
			const money1 = vo({ amount: 100, currency: "USD" });
			const money2 = money1; // Same reference

			expect(money1 === money2).toBe(true); // Reference equality
			expect(voEquals(money1, money2)).toBe(true); // Value equality
		});
	});

	describe("voEqualsExcept()", () => {
		it("should compare value objects ignoring specified keys", () => {
			const address1 = vo({
				street: "Main St",
				city: "Berlin",
				metadata: { createdAt: "2024-01-01", updatedAt: "2024-01-02" },
			});
			const address2 = vo({
				street: "Main St",
				city: "Berlin",
				metadata: { createdAt: "2024-01-01", updatedAt: "2024-01-03" },
			});

			// Without except: different updatedAt makes them unequal
			expect(voEquals(address1, address2)).toBe(false);

			// With except: ignoring updatedAt makes them equal
			expect(
				voEqualsExcept(address1, address2, {
					ignoreKeys: ["updatedAt"],
				}),
			).toBe(true);
		});

		it("should compare value objects ignoring nested metadata", () => {
			const address1 = vo({
				street: "Main St",
				city: "Berlin",
				metadata: { createdAt: "2024-01-01", updatedAt: "2024-01-02" },
			});
			const address2 = vo({
				street: "Main St",
				city: "Berlin",
				metadata: { createdAt: "2024-01-01", updatedAt: "2024-01-03" },
			});

			// Ignore all metadata
			expect(
				voEqualsExcept(address1, address2, {
					ignoreKeyPredicate: (key, path) => path.includes("metadata"),
				}),
			).toBe(true);
		});

		it("should still detect differences in non-ignored fields", () => {
			const address1 = vo({
				street: "Main St",
				city: "Berlin",
				metadata: { createdAt: "2024-01-01" },
			});
			const address2 = vo({
				street: "Different St",
				city: "Berlin",
				metadata: { createdAt: "2024-01-01" },
			});

			// Even with metadata ignored, different street makes them unequal
			expect(
				voEqualsExcept(address1, address2, {
					ignoreKeyPredicate: (key, path) => path.includes("metadata"),
				}),
			).toBe(false);
		});

		it("should handle arrays with ignored keys", () => {
			const list1 = vo({
				items: [
					{ id: 1, value: "a", timestamp: "2024-01-01" },
					{ id: 2, value: "b", timestamp: "2024-01-02" },
				],
			});
			const list2 = vo({
				items: [
					{ id: 1, value: "a", timestamp: "2024-01-03" },
					{ id: 2, value: "b", timestamp: "2024-01-04" },
				],
			});

			// Ignore timestamps in nested items
			expect(
				voEqualsExcept(list1, list2, {
					ignoreKeyPredicate: (key, path) => key === "timestamp",
				}),
			).toBe(true);
		});
	});

	describe("voWithValidation()", () => {
		it("should return ok result when validation passes", () => {
			const result = voWithValidation(
				{ amount: 100, currency: "USD" },
				(m) => m.amount >= 0 && m.currency.length === 3,
			);

			expect(result.isOk()).toBe(true);
			if (result.isOk()) {
				expect(result.value.amount).toBe(100);
				expect(result.value.currency).toBe("USD");
			}
		});

		it("should return error result when validation fails", () => {
			const result = voWithValidation(
				{ amount: -100, currency: "USD" },
				(m) => m.amount >= 0 && m.currency.length === 3,
			);

			expect(result.isErr()).toBe(true);
			if (result.isErr()) {
				expect(result.error).toBeDefined();
			}
		});

		it("should use custom error message when validation fails", () => {
			const customMessage = "Amount must be non-negative";

			const result = voWithValidation(
				{ amount: -100, currency: "USD" },
				(m) => m.amount >= 0 && m.currency.length === 3,
				customMessage,
			);

			expect(result.isErr()).toBe(true);
			if (result.isErr()) {
				expect(result.error).toBe(customMessage);
			}
		});

		it("should use default error message when no custom message provided", () => {
			const result = voWithValidation(
				{ amount: -100, currency: "USD" },
				(m) => m.amount >= 0 && m.currency.length === 3,
			);

			expect(result.isErr()).toBe(true);
			if (result.isErr()) {
				expect(result.error).toContain("Validation failed for value object");
			}
		});

		it("should validate nested structures", () => {
			const result = voWithValidation(
				{
					street: "Main St",
					city: "Berlin",
					coordinates: { lat: 52.5, lng: 13.4 },
				},
				(a) =>
					a.street.length > 0 &&
					a.city.length > 0 &&
					a.coordinates.lat >= -90 &&
					a.coordinates.lat <= 90 &&
					a.coordinates.lng >= -180 &&
					a.coordinates.lng <= 180,
			);

			expect(result.isOk()).toBe(true);
			if (result.isOk()) {
				expect(result.value.street).toBe("Main St");
				expect(result.value.coordinates.lat).toBe(52.5);
			}
		});

		it("should reject invalid nested structures", () => {
			const result = voWithValidation(
				{
					street: "Main St",
					city: "Berlin",
					coordinates: { lat: 999, lng: 13.4 }, // Invalid lat
				},
				(a) =>
					a.street.length > 0 &&
					a.city.length > 0 &&
					a.coordinates.lat >= -90 &&
					a.coordinates.lat <= 90 &&
					a.coordinates.lng >= -180 &&
					a.coordinates.lng <= 180,
			);

			expect(result.isErr()).toBe(true);
		});

		it("should create deeply frozen value object after validation", () => {
			const result = voWithValidation(
				{ amount: 100, currency: "USD" },
				(m) => m.amount >= 0 && m.currency.length === 3,
			);

			expect(result.isOk()).toBe(true);
			if (result.isOk()) {
				expect(() => {
					(result.value as any).amount = 200;
				}).toThrow();
			}
		});

		it("should validate arrays", () => {
			const result = voWithValidation(
				{ items: [1, 2, 3] },
				(l) => l.items.length > 0 && l.items.every((i) => i > 0),
			);

			expect(result.isOk()).toBe(true);
			if (result.isOk()) {
				expect(result.value.items).toEqual([1, 2, 3]);
			}
		});

		it("should reject invalid arrays", () => {
			const result = voWithValidation(
				{ items: [-1, 2, 3] }, // Contains negative number
				(l) => l.items.length > 0 && l.items.every((i) => i > 0),
			);

			expect(result.isErr()).toBe(true);
		});

		it("should handle complex validation logic", () => {
			type EmailData = { value: string };
			const result = voWithValidation(
				{ value: "user@example.com" },
				(e: EmailData) => {
					const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
					return emailRegex.test(e.value);
				},
				"Invalid email format",
			);

			expect(result.isOk()).toBe(true);
			if (result.isOk()) {
				expect(result.value.value).toBe("user@example.com");
			}
		});
	});

	describe("vo() defensive deep-clone", () => {
		it("does not freeze the caller's nested object reference", () => {
			const nested = { lat: 52.5, lng: 13.4 };
			const original = { city: "Berlin", coords: nested };

			const v = vo(original);

			// The VO is frozen — both at the top level and at the nested level.
			expect(Object.isFrozen(v)).toBe(true);
			expect(Object.isFrozen(v.coords)).toBe(true);

			// But the caller's nested object reference must stay mutable —
			// vo() should not have side-effects on the input graph.
			expect(Object.isFrozen(nested)).toBe(false);
			expect(Object.isFrozen(original.coords)).toBe(false);

			// And mutating the caller's reference must not bleed into the VO.
			nested.lat = 0;
			expect(v.coords.lat).toBe(52.5);
		});
	});

	describe("deepFreeze symbol-key handling", () => {
		it("freezes properties whose key is a Symbol, not only string keys", () => {
			const tag = Symbol("tag");
			const v = vo({ [tag]: { nested: 1 } } as Record<symbol, unknown>);

			const nested = (v as unknown as Record<symbol, { nested: number }>)[
				tag
			];
			expect(Object.isFrozen(nested)).toBe(true);
		});
	});

	describe("TypedArray and DataView handling", () => {
		it("creates a VO containing a non-empty TypedArray without throwing", () => {
			// Object.freeze on an ArrayBuffer view with elements throws per
			// spec — deepFreeze must skip views instead of crashing.
			const v = vo({ data: new Uint8Array([1, 2, 3]) });

			expect(Array.from(v.data)).toEqual([1, 2, 3]);
		});

		it("still freezes the surrounding object graph when a TypedArray is present", () => {
			const v = vo({ data: new Float64Array([1.5]), label: "raw" });

			expect(Object.isFrozen(v)).toBe(true);
			expect(() => {
				(v as any).label = "changed";
			}).toThrow();
		});

		it("handles TypedArrays nested below the top level", () => {
			const v = vo({ chunk: { bytes: new Int32Array([7, 8]) } });

			expect(Object.isFrozen(v.chunk)).toBe(true);
			expect(Array.from(v.chunk.bytes)).toEqual([7, 8]);
		});

		it("handles empty TypedArrays and DataView", () => {
			const v = vo({
				empty: new Uint8Array(0),
				view: new DataView(new ArrayBuffer(4)),
			});

			expect(v.empty.length).toBe(0);
			expect(v.view.byteLength).toBe(4);
		});

		it("voWithValidation succeeds for valid input containing a TypedArray", () => {
			const result = voWithValidation(
				{ data: new Uint8Array([9]) },
				(t) => t.data.length > 0,
			);

			expect(result.isOk()).toBe(true);
		});
	});

	describe("Date/Map/Set internal-slot immutability", () => {
		// Object.freeze does not protect internal slots — a frozen Date can
		// still be setTime()d, a frozen Map still set()s. deepFreeze must
		// block the mutators so the "deeply immutable" guarantee holds.
		it("blocks Date mutators on a frozen VO", () => {
			const v = vo({ when: new Date(1000) });

			expect(() => (v.when as Date).setTime(0)).toThrow(TypeError);
			expect(() => (v.when as Date).setFullYear(1999)).toThrow(TypeError);
			expect(v.when.getTime()).toBe(1000);
		});

		it("blocks Map mutators while reads keep working", () => {
			const v = vo({ m: new Map([["k", 1]]) });

			expect(() => v.m.set("x", 2)).toThrow(TypeError);
			expect(() => v.m.delete("k")).toThrow(TypeError);
			expect(() => v.m.clear()).toThrow(TypeError);
			expect(v.m.get("k")).toBe(1);
			expect(v.m.size).toBe(1);
		});

		it("blocks Set mutators while reads keep working", () => {
			const v = vo({ s: new Set([1]) });

			expect(() => v.s.add(2)).toThrow(TypeError);
			expect(() => v.s.delete(1)).toThrow(TypeError);
			expect(() => v.s.clear()).toThrow(TypeError);
			expect(v.s.has(1)).toBe(true);
		});

		it("deep-freezes objects stored inside Map values and Set members", () => {
			const v = vo({
				m: new Map([["k", { a: 1 }]]),
				s: new Set([{ b: 2 }]),
			});

			const inMap = v.m.get("k") as { a: number };
			expect(Object.isFrozen(inMap)).toBe(true);
			const [inSet] = v.s;
			expect(Object.isFrozen(inSet)).toBe(true);
		});

		it("frozen VOs still round-trip through vo() and compare equal", () => {
			// The mutator shadows are non-enumerable expandos; structuredClone
			// drops them and spread skips them — re-wrapping must not throw.
			const a = vo({ d: new Date(5), m: new Map([["k", 1]]) });
			const b = vo({ ...a });

			expect(voEquals(a, b)).toBe(true);
		});

		it("skips mutator-blocking on a Date the caller froze beforehand", () => {
			// A pre-frozen Date cannot receive shadow properties — deepFreeze
			// must not crash on it (best effort, not a hard guarantee).
			const preFrozen = Object.freeze(new Date(42));
			expect(() => vo({ d: preFrozen })).not.toThrow();
		});
	});

	describe("Type safety", () => {
		it("should preserve TypeScript types", () => {
			type Money = VO<{
				amount: number;
				currency: string;
			}>;

			const money: Money = vo({ amount: 100, currency: "USD" });

			expect(typeof money.amount).toBe("number");
			expect(typeof money.currency).toBe("string");
		});

		it("should make properties readonly", () => {
			const money = vo({ amount: 100, currency: "USD" });

			// TypeScript should prevent this, but runtime should also enforce it
			expect(() => {
				(money as any).amount = 200;
			}).toThrow();
		});
	});

	describe("Edge cases", () => {
		it("should handle objects with Date values", () => {
			const event = vo({
				name: "Meeting",
				date: new Date("2024-01-01"),
			});

			expect(event.name).toBe("Meeting");
			expect(event.date).toBeInstanceOf(Date);
		});

		it("rejects function properties (Value Objects are data, not behaviour)", () => {
			// vo() deep-clones via structuredClone before freezing so the
			// caller's input graph is not touched as a side-effect.
			// structuredClone refuses to clone function values, which catches
			// the DDD anti-pattern of putting behaviour on a Value Object
			// at construction time.
			expect(() =>
				vo({
					data: "test",
					fn: () => "hello",
				}),
			).toThrow();
		});

		it("should handle circular references gracefully", () => {
			// Note: Circular references are handled by tracking visited objects
			const obj: any = { name: "test" };
			obj.self = obj; // Circular reference

			// This should not throw during creation (no stack overflow)
			const valueObject = vo(obj);
			expect(valueObject.name).toBe("test");
			// The circular reference is preserved within the copied object
			expect(valueObject.self).toBeDefined();
			expect((valueObject.self as any).name).toBe("test");
		});

		it("should handle very large nested structures", () => {
			const large = vo({
				level1: {
					level2: {
						level3: {
							level4: {
								level5: {
									value: "deep",
								},
							},
						},
					},
				},
			});

			expect(() => {
				(large.level1.level2.level3.level4.level5 as any).value = "mutated";
			}).toThrow();
		});
	});
});

