// @ts-expect-error Node's VM exists in the test runtime; the package stays Node-type-free.
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vite-plus/test";
import {
	deepFreeze,
	ValueObject,
	type ValueObjectOf,
	valueObject,
	valueObjectEquals,
	valueObjectEqualsExcept,
	valueObjectOrError,
} from "./value-object";

describe("value object functions", () => {
	describe("valueObject()", () => {
		it("should create a simple value object", () => {
			const money = valueObject({ amount: 100, currency: "USD" });

			expect(money.amount).toBe(100);
			expect(money.currency).toBe("USD");
		});

		it("should make simple value objects immutable", () => {
			const money = valueObject({ amount: 100, currency: "USD" });

			expect(() => {
				(money as any).amount = 200;
			}).toThrow();
		});

		it("should deep freeze nested objects", () => {
			const address = valueObject({
				street: "Main St",
				city: "Berlin",
				coordinates: { lat: 52.5, lng: 13.4 },
			});

			expect(() => {
				(address.coordinates as any).lat = 99;
			}).toThrow();
		});

		it("should deep freeze deeply nested objects", () => {
			const complex = valueObject({
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
			const list = valueObject({ items: [1, 2, 3] });

			expect(() => {
				list.items.push(4);
			}).toThrow();

			expect(() => {
				list.items[0] = 999;
			}).toThrow();
		});

		it("should freeze nested objects within arrays", () => {
			const complex = valueObject({
				array: [1, 2, { nested: "in array", deep: { value: "very deep" } }],
			});

			expect(() => {
				(complex.array[2] as any).nested = "mutated";
			}).toThrow();

			expect(() => {
				((complex.array[2] as any).deep as any).value = "mutated";
			}).toThrow();
		});

		it("should handle empty objects", () => {
			const empty = valueObject({});

			expect(empty).toEqual({});
			expect(() => {
				(empty as any).newProp = "value";
			}).toThrow();
		});

		it("should handle objects with null values", () => {
			const withNull = valueObject({ value: null, other: "test" });

			expect(withNull.value).toBeNull();
			expect(withNull.other).toBe("test");
		});

		it("should handle objects with undefined values", () => {
			const withUndefined = valueObject({ value: undefined, other: "test" });

			expect(withUndefined.value).toBeUndefined();
			expect(withUndefined.other).toBe("test");
		});

		it("should preserve primitive types", () => {
			const primitives = valueObject({
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
			const array = valueObject({ numbers: [1, 2, 3], strings: ["a", "b"] });

			expect(() => {
				array.numbers.push(4);
			}).toThrow();

			expect(() => {
				array.strings[0] = "x";
			}).toThrow();
		});

		it("should create a new object (not mutate original)", () => {
			const original = { amount: 100, currency: "USD" };
			const created = valueObject(original);

			expect(created).not.toBe(original);
			expect(original.amount).toBe(100); // Original unchanged
		});
	});

	describe("valueObjectEquals()", () => {
		it("should return true for equal simple value objects", () => {
			const money1 = valueObject({ amount: 100, currency: "USD" });
			const money2 = valueObject({ amount: 100, currency: "USD" });

			expect(valueObjectEquals(money1, money2)).toBe(true);
		});

		it("should return false for different simple value objects", () => {
			const money1 = valueObject({ amount: 100, currency: "USD" });
			const money2 = valueObject({ amount: 200, currency: "USD" });

			expect(valueObjectEquals(money1, money2)).toBe(false);
		});

		it("should return false for different currencies", () => {
			const money1 = valueObject({ amount: 100, currency: "USD" });
			const money2 = valueObject({ amount: 100, currency: "EUR" });

			expect(valueObjectEquals(money1, money2)).toBe(false);
		});

		it("should return true for equal nested value objects", () => {
			const address1 = valueObject({
				street: "Main St",
				city: "Berlin",
				coordinates: { lat: 52.5, lng: 13.4 },
			});
			const address2 = valueObject({
				street: "Main St",
				city: "Berlin",
				coordinates: { lat: 52.5, lng: 13.4 },
			});

			expect(valueObjectEquals(address1, address2)).toBe(true);
		});

		it("should return false for different nested value objects", () => {
			const address1 = valueObject({
				street: "Main St",
				city: "Berlin",
				coordinates: { lat: 52.5, lng: 13.4 },
			});
			const address2 = valueObject({
				street: "Main St",
				city: "Berlin",
				coordinates: { lat: 99.9, lng: 13.4 },
			});

			expect(valueObjectEquals(address1, address2)).toBe(false);
		});

		it("should return true for equal arrays", () => {
			const list1 = valueObject({ items: [1, 2, 3] });
			const list2 = valueObject({ items: [1, 2, 3] });

			expect(valueObjectEquals(list1, list2)).toBe(true);
		});

		it("should return false for different arrays", () => {
			const list1 = valueObject({ items: [1, 2, 3] });
			const list2 = valueObject({ items: [1, 2, 4] });

			expect(valueObjectEquals(list1, list2)).toBe(false);
		});

		it("should return true for empty objects", () => {
			const empty1 = valueObject({});
			const empty2 = valueObject({});

			expect(valueObjectEquals(empty1, empty2)).toBe(true);
		});

		it("should handle objects with null values", () => {
			type ObjWithNull = { value: null; other: string };
			type ObjWithString = { value: string; other: string };

			const obj1 = valueObject<ObjWithNull>({ value: null, other: "test" });
			const obj2 = valueObject<ObjWithNull>({ value: null, other: "test" });
			const obj3 = valueObject<ObjWithString>({
				value: "not null",
				other: "test",
			});

			expect(valueObjectEquals(obj1, obj2)).toBe(true);
			// Different types, so not equal
			expect(valueObjectEquals(obj1 as any, obj3 as any)).toBe(false);
		});

		it("should handle objects with undefined values", () => {
			const obj1 = valueObject({ value: undefined, other: "test" });
			const obj2 = valueObject({ value: undefined, other: "test" });
			const obj3 = valueObject({ other: "test" }); // Missing property

			expect(valueObjectEquals(obj1, obj2)).toBe(true);
			// deepEqual correctly distinguishes between undefined property and missing property
			// This is more accurate than JSON.stringify which removes undefined properties
			expect(valueObjectEquals(obj1, obj3)).toBe(false);
		});

		it("should return false when comparing reference equality", () => {
			const money1 = valueObject({ amount: 100, currency: "USD" });
			const money2 = money1; // Same reference

			expect(money1 === money2).toBe(true); // Reference equality
			expect(valueObjectEquals(money1, money2)).toBe(true); // Value equality
		});

		it("compares every admitted built-in category by value", () => {
			const first = valueObject({
				date: new Date(1_000),
				map: new Map([["key", { nested: 1 }]]),
				set: new Set(["a", "b"]),
			});
			const second = valueObject({
				date: new Date(1_000),
				map: new Map([["key", { nested: 1 }]]),
				set: new Set(["a", "b"]),
			});

			expect(valueObjectEquals(first, second)).toBe(true);
		});
	});

	describe("valueObjectEqualsExcept()", () => {
		it("should compare value objects ignoring specified keys", () => {
			const address1 = valueObject({
				street: "Main St",
				city: "Berlin",
				metadata: { createdAt: "2024-01-01", updatedAt: "2024-01-02" },
			});
			const address2 = valueObject({
				street: "Main St",
				city: "Berlin",
				metadata: { createdAt: "2024-01-01", updatedAt: "2024-01-03" },
			});

			// Without except: different updatedAt makes them unequal
			expect(valueObjectEquals(address1, address2)).toBe(false);

			// With except: ignoring updatedAt makes them equal
			expect(
				valueObjectEqualsExcept(address1, address2, {
					ignoreKeys: ["updatedAt"],
				}),
			).toBe(true);
		});

		it("should compare value objects ignoring nested metadata", () => {
			const address1 = valueObject({
				street: "Main St",
				city: "Berlin",
				metadata: { createdAt: "2024-01-01", updatedAt: "2024-01-02" },
			});
			const address2 = valueObject({
				street: "Main St",
				city: "Berlin",
				metadata: { createdAt: "2024-01-01", updatedAt: "2024-01-03" },
			});

			// Ignore all metadata
			expect(
				valueObjectEqualsExcept(address1, address2, {
					ignoreKeyPredicate: (key, path) => path.includes("metadata"),
				}),
			).toBe(true);
		});

		it("should still detect differences in non-ignored fields", () => {
			const address1 = valueObject({
				street: "Main St",
				city: "Berlin",
				metadata: { createdAt: "2024-01-01" },
			});
			const address2 = valueObject({
				street: "Different St",
				city: "Berlin",
				metadata: { createdAt: "2024-01-01" },
			});

			// Even with metadata ignored, different street makes them unequal
			expect(
				valueObjectEqualsExcept(address1, address2, {
					ignoreKeyPredicate: (key, path) => path.includes("metadata"),
				}),
			).toBe(false);
		});

		it("should handle arrays with ignored keys", () => {
			const list1 = valueObject({
				items: [
					{ id: 1, value: "a", timestamp: "2024-01-01" },
					{ id: 2, value: "b", timestamp: "2024-01-02" },
				],
			});
			const list2 = valueObject({
				items: [
					{ id: 1, value: "a", timestamp: "2024-01-03" },
					{ id: 2, value: "b", timestamp: "2024-01-04" },
				],
			});

			// Ignore timestamps in nested items
			expect(
				valueObjectEqualsExcept(list1, list2, {
					ignoreKeyPredicate: (key, path) => key === "timestamp",
				}),
			).toBe(true);
		});
	});

	describe("valueObjectOrError()", () => {
		it("should return ok result when validation passes", () => {
			const result = valueObjectOrError(
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
			const result = valueObjectOrError(
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

			const result = valueObjectOrError(
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
			const result = valueObjectOrError(
				{ amount: -100, currency: "USD" },
				(m) => m.amount >= 0 && m.currency.length === 3,
			);

			expect(result.isErr()).toBe(true);
			if (result.isErr()) {
				expect(result.error).toContain("Validation failed for value object");
			}
		});

		it("should validate nested structures", () => {
			const result = valueObjectOrError(
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
			const result = valueObjectOrError(
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
			const result = valueObjectOrError(
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
			const result = valueObjectOrError(
				{ items: [1, 2, 3] },
				(l) => l.items.length > 0 && l.items.every((i) => i > 0),
			);

			expect(result.isOk()).toBe(true);
			if (result.isOk()) {
				expect(result.value.items).toEqual([1, 2, 3]);
			}
		});

		it("should reject invalid arrays", () => {
			const result = valueObjectOrError(
				{ items: [-1, 2, 3] }, // Contains negative number
				(l) => l.items.length > 0 && l.items.every((i) => i > 0),
			);

			expect(result.isErr()).toBe(true);
		});

		it("should handle complex validation logic", () => {
			type EmailData = { value: string };
			const result = valueObjectOrError(
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

	describe("valueObject() defensive deep-clone", () => {
		it("does not freeze the caller's nested object reference", () => {
			const nested = { lat: 52.5, lng: 13.4 };
			const original = { city: "Berlin", coords: nested };

			const v = valueObject(original);

			// The value object is frozen, both at the top level and at the nested level.
			expect(Object.isFrozen(v)).toBe(true);
			expect(Object.isFrozen(v.coords)).toBe(true);

			// But the caller's nested object reference must stay mutable:
			// valueObject() should not have side-effects on the input graph.
			expect(Object.isFrozen(nested)).toBe(false);
			expect(Object.isFrozen(original.coords)).toBe(false);

			// And mutating the caller's reference must not bleed into the value object.
			nested.lat = 0;
			expect(v.coords.lat).toBe(52.5);
		});

		it("rejects own accessors without invoking them", () => {
			let getterCalls = 0;
			const input = {} as { readonly amount: number };
			Object.defineProperty(input, "amount", {
				enumerable: true,
				get: () => {
					getterCalls += 1;
					return 5;
				},
			});

			expect(() => valueObject(input)).toThrow(/is an accessor property/);
			expect(getterCalls).toBe(0);
		});

		it("rejects array index accessors without invoking them", () => {
			let getterCalls = 0;
			const input: number[] = [];
			Object.defineProperty(input, 0, {
				enumerable: true,
				get: () => {
					getterCalls += 1;
					return 5;
				},
			});

			expect(() => valueObject(input)).toThrow(/is an accessor property/);
			expect(getterCalls).toBe(0);
		});
	});

	describe("symbol-keyed and hidden properties", () => {
		it("rejects an enumerable symbol-keyed property", () => {
			expect(() => valueObject({ amount: 5, [Symbol("tag")]: 1 })).toThrow(
				"valueObject(): props has a symbol-keyed property",
			);
		});

		it("leaves out a non-enumerable symbol-keyed property", () => {
			const input = Object.defineProperty({ amount: 5 }, Symbol("meta"), {
				value: 1,
				enumerable: false,
			});

			const value = valueObject(input);

			expect(Object.getOwnPropertySymbols(value)).toEqual([]);
			expect(value).toEqual({ amount: 5 });
		});

		it("preserves sparse array holes", () => {
			const input = new Array<string>(1);

			const result = valueObject(input);

			expect(0 in result).toBe(false);
		});

		it("rejects a non-enumerable string-keyed property instead of dropping it", () => {
			const input = Object.defineProperty({ amount: 5 }, "meta", {
				value: 1,
				enumerable: false,
			});

			expect(() => valueObject(input)).toThrow(
				"valueObject(): props.meta is not enumerable",
			);
		});
	});

	describe("mutable and reference-compared built-ins", () => {
		it.each([
			["Uint8Array", () => new Uint8Array([1, 2, 3])],
			["empty Uint8Array", () => new Uint8Array(0)],
			["DataView", () => new DataView(new ArrayBuffer(4))],
			["ArrayBuffer", () => new ArrayBuffer(4)],
			["SharedArrayBuffer", () => new SharedArrayBuffer(4)],
			["Error", () => new Error("failure")],
		] as const)(
			"rejects %s because every admitted value must be immutable and value-based",
			(_name, create) => {
				expect(() => valueObject({ value: create() })).toThrow(
					/is binary data|is an Error/,
				);
			},
		);

		it("rejects unsupported values before validation can produce a mutable value object", () => {
			expect(() =>
				valueObjectOrError(
					{ data: new Uint8Array([9]) },
					(value) => value.data.length > 0,
				),
			).toThrow(/is binary data|is an Error/);
		});
	});

	describe("Date/Map/Set internal-slot immutability", () => {
		// Object.freeze does not protect internal slots: a frozen Date can
		// still be setTime()d, a frozen Map still set()s. deepFreeze must
		// block the mutators so the "deeply immutable" guarantee holds.
		it("blocks Date mutators on a frozen value object", () => {
			const v = valueObject({ when: new Date(1000) });

			expect(() => (v.when as Date).setTime(0)).toThrow(TypeError);
			expect(() => (v.when as Date).setFullYear(1999)).toThrow(TypeError);
			expect(v.when.getTime()).toBe(1000);
		});

		it("blocks Map mutators while reads keep working", () => {
			const v = valueObject({ m: new Map([["k", 1]]) });

			expect(() => v.m.set("x", 2)).toThrow(TypeError);
			expect(() => v.m.delete("k")).toThrow(TypeError);
			expect(() => v.m.clear()).toThrow(TypeError);
			expect(v.m.get("k")).toBe(1);
			expect(v.m.size).toBe(1);
		});

		it("blocks Set mutators while reads keep working", () => {
			const v = valueObject({ s: new Set([1]) });

			expect(() => v.s.add(2)).toThrow(TypeError);
			expect(() => v.s.delete(1)).toThrow(TypeError);
			expect(() => v.s.clear()).toThrow(TypeError);
			expect(v.s.has(1)).toBe(true);
		});

		it("deep-freezes objects stored inside Map values", () => {
			const v = valueObject({
				m: new Map([["k", { a: 1 }]]),
			});

			const inMap = v.m.get("k") as { a: number };
			expect(Object.isFrozen(inMap)).toBe(true);
		});

		it("frozen value objects still round-trip through valueObject() and compare equal", () => {
			// The mutator shadows are non-enumerable expandos; structuredClone
			// drops them and spread skips them, so re-wrapping must not throw.
			const a = valueObject({ d: new Date(5), m: new Map([["k", 1]]) });
			const b = valueObject({ ...a });

			expect(valueObjectEquals(a, b)).toBe(true);
		});

		it("skips mutator-blocking on a Date the caller froze beforehand", () => {
			// A pre-frozen Date cannot receive shadow properties, so deepFreeze
			// must not crash on it (best effort, not a hard guarantee).
			const preFrozen = Object.freeze(new Date(42));
			expect(() => valueObject({ d: preFrozen })).not.toThrow();
		});
	});

	describe("boxed primitives", () => {
		it("rejects a boxed primitive and names the primitive value", () => {
			expect(() => valueObject({ value: Object(7n) })).toThrow(
				"valueObject(): props.value is a BigInt; use the primitive value",
			);
		});
	});

	describe("built-in boundary: Map/Set contents go through the valueObject clone", () => {
		it("rejects object Map keys and Set members that cannot preserve value equality", () => {
			expect(() => valueObject({ m: new Map([[{ id: 1 }, "value"]]) })).toThrow(
				/must be a primitive/,
			);
			expect(() => valueObject({ s: new Set([{ id: 1 }]) })).toThrow(
				/must be a primitive/,
			);
		});

		it("rejects functions inside Map values with the documented TypeError", () => {
			expect(() => valueObject({ m: new Map([["f", () => 1]]) })).toThrow(
				/is a function/,
			);
		});

		it("preserves identity for objects shared between the plain graph and a Map value", () => {
			const shared = { n: 1 };
			const v = valueObject({ a: shared, m: new Map([["k", shared]]) });

			expect(v.a).toBe(v.m.get("k"));
		});

		it("preserves cycles that pass through a Map", () => {
			const cfg: { name: string; lookup?: Map<string, unknown> } = {
				name: "a",
			};
			cfg.lookup = new Map([["self", cfg]]);

			const v = valueObject(cfg);

			expect(v.lookup?.get("self")).toBe(v);
		});

		it("rejects Promise/WeakMap/WeakSet with a descriptive TypeError instead of DataCloneError", () => {
			expect(() => valueObject({ p: Promise.resolve(1) })).toThrow(
				/is a (Promise|WeakMap|WeakSet)/,
			);
			expect(() => valueObject({ w: new WeakMap() })).toThrow(
				/is a (Promise|WeakMap|WeakSet)/,
			);
		});

		it("rejects custom class instances instead of creating incomplete clones", () => {
			class Money {
				constructor(readonly amount: number) {}
				double(): number {
					return this.amount * 2;
				}
			}

			expect(() => valueObject({ price: new Money(5) })).toThrow(
				/is a class instance/,
			);
		});

		it("keeps a kit value object instance by reference", () => {
			class Money extends ValueObject<{ amount: number }> {}
			class Points extends ValueObject<{ amount: number }> {}
			const money = new Money({ amount: 5 });

			const priced = valueObject({ price: money });

			expect(priced.price).toBe(money);
			expect(
				valueObjectEquals(
					priced,
					valueObject({ price: new Money({ amount: 5 }) }),
				),
			).toBe(true);
			expect(
				valueObjectEquals(
					priced,
					valueObject({ price: new Money({ amount: 6 }) }),
				),
			).toBe(false);
			expect(
				valueObjectEquals(
					priced,
					valueObject({ price: new Points({ amount: 5 }) } as never),
				),
			).toBe(false);
		});

		it("freezes a kit value object instance in place", () => {
			class Money extends ValueObject<{ amount: number }> {}
			const money = new Money({ amount: 5 });

			const priced = valueObject({ price: money });

			expect(priced.price).toBe(money);
			expect(Object.isFrozen(money)).toBe(true);
		});

		it("rejects a value object as the input itself", () => {
			class Money extends ValueObject<{ amount: number }> {}

			expect(() => valueObject(new Money({ amount: 5 }))).toThrow(
				"valueObject() does not accept a value object as its input: nest the value object under a key, or pass its props",
			);
		});

		it("rejects a nested value object with own fields outside props", () => {
			class TaggedMoney extends ValueObject<{ amount: number }> {
				readonly tags: string[] = [];
			}

			expect(() =>
				valueObject({ price: new TaggedMoney({ amount: 5 }) }),
			).toThrow(/own fields outside props \(tags\)/);
		});

		it("keeps nested value objects class-aware under valueObjectEqualsExcept", () => {
			class Money extends ValueObject<{ amount: number; note: string }> {}
			class Points extends ValueObject<{ amount: number; note: string }> {}
			const money = valueObject({ price: new Money({ amount: 5, note: "a" }) });
			const sameMoney = valueObject({
				price: new Money({ amount: 5, note: "b" }),
			});
			const points = valueObject({
				price: new Points({ amount: 5, note: "a" }),
			});

			expect(
				valueObjectEqualsExcept(money, sameMoney, { ignoreKeys: ["note"] }),
			).toBe(true);
			expect(
				valueObjectEqualsExcept(money, points as never, {
					ignoreKeys: ["note"],
				}),
			).toBe(false);
		});

		it("never ignores the class of a nested value object under valueObjectEqualsExcept", () => {
			class Money extends ValueObject<{ amount: number }> {}
			class Points extends ValueObject<{ amount: number }> {}
			const money = valueObject({ price: new Money({ amount: 5 }) });
			const points = valueObject({ price: new Points({ amount: 5 }) });
			const classKey = Symbol.for("@shirudo/ddd-kit/value-object-class/v1");

			expect(
				valueObjectEqualsExcept(money, points as never, {
					ignoreKeyPredicate: (key) => typeof key === "symbol",
				}),
			).toBe(false);
			expect(
				valueObjectEqualsExcept(money, points as never, {
					ignoreKeys: [classKey],
				}),
			).toBe(false);
		});

		it("continues the valueObjectEqualsExcept path with props inside a nested value object", () => {
			class Money extends ValueObject<{ amount: number; note: string }> {}
			const money = valueObject({ price: new Money({ amount: 5, note: "a" }) });
			const sameMoney = valueObject({
				price: new Money({ amount: 5, note: "b" }),
			});
			const paths: string[] = [];

			const equal = valueObjectEqualsExcept(money, sameMoney, {
				ignoreKeyPredicate: (key, path) => {
					if (key === "note") paths.push(path.join("."));
					return key === "note";
				},
			});

			expect(equal).toBe(true);
			expect(paths).toEqual(["price.props", "price.props"]);
		});

		it("rejects classes with private or non-enumerable constructor state", () => {
			class PrivateValue {
				#value: number;
				constructor(value: number) {
					this.#value = value;
				}
				read(): number {
					return this.#value;
				}
			}
			class HiddenValue {
				constructor(value: number) {
					Object.defineProperty(this, "value", { value, enumerable: false });
				}
			}

			for (const value of [new PrivateValue(5), new HiddenValue(5)]) {
				expect(() => valueObject({ value })).toThrow(/is a class instance/);
			}
		});

		it("rejects boxed Symbol values instead of creating slotless wrappers", () => {
			expect(() => valueObject({ value: Object(Symbol("value")) })).toThrow(
				/is a Symbol; map it to plain data/,
			);
		});

		it("rejects custom subclasses of otherwise supported built-ins", () => {
			class CustomArray extends Array<number> {}
			class CustomDate extends Date {}
			class CustomMap extends Map<string, number> {}
			class CustomError extends Error {}

			for (const value of [
				new CustomArray(1, 2),
				new CustomDate(0),
				new CustomMap([["one", 1]]),
				new CustomError("failure"),
			]) {
				expect(() => valueObject({ value })).toThrow(/is a class instance/);
			}
		});

		it("rejects a built-in subclass after its constructor marker is removed", () => {
			class CustomMap extends Map<string, number> {
				#secret = 1;
				constructor() {
					super();
					void this.#secret;
				}
			}
			Reflect.deleteProperty(CustomMap.prototype, "constructor");

			expect(() => valueObject({ value: new CustomMap() })).toThrow(
				/is a class instance/,
			);
		});

		it("continues to accept cross-realm plain objects", () => {
			const value = runInNewContext("({ nested: { amount: 5 } })") as {
				nested: { amount: number };
			};

			const result = valueObject(value);

			expect(result).toEqual({ nested: { amount: 5 } });
			expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
			expect(Object.getPrototypeOf(result.nested)).toBe(Object.prototype);
			expect(Object.isFrozen(result.nested)).toBe(true);
		});

		it("continues to accept cross-realm arrays and built-ins", () => {
			const value = runInNewContext(
				"({ items: [1, 2], date: new Date(0), map: new Map([['one', 1]]) })",
			) as {
				items: number[];
				date: Date;
				map: Map<string, number>;
			};

			const result = valueObject(value);

			expect(result.items).toEqual([1, 2]);
			expect(Object.getPrototypeOf(result.items)).toBe(Array.prototype);
			expect(result.date.getTime()).toBe(0);
			expect(result.map.get("one")).toBe(1);
		});

		it("preserves null-prototype records", () => {
			const value = Object.assign(Object.create(null) as { amount: number }, {
				amount: 5,
			});

			const result = valueObject(value);

			expect(result.amount).toBe(5);
			expect(Object.getPrototypeOf(result)).toBeNull();
		});
	});

	describe("Symbol.toStringTag spoofing and exotic freeze targets", () => {
		it("deepFreeze does not crash on a sealed (non-extensible, not frozen) Date", () => {
			const d = Object.assign(new Date(42), { note: "x" });
			Object.seal(d);

			// Cannot receive shadow properties, so must be skipped (best
			// effort), not crash with 'object is not extensible'.
			expect(() => deepFreeze({ when: d })).not.toThrow();
		});
	});

	describe("Type safety", () => {
		it("should preserve TypeScript types", () => {
			type Money = ValueObjectOf<{
				amount: number;
				currency: string;
			}>;

			const money: Money = valueObject({ amount: 100, currency: "USD" });

			expect(typeof money.amount).toBe("number");
			expect(typeof money.currency).toBe("string");
		});

		it("should make properties readonly", () => {
			const money = valueObject({ amount: 100, currency: "USD" });

			// TypeScript should prevent this, but runtime should also enforce it
			expect(() => {
				(money as any).amount = 200;
			}).toThrow();
		});
	});

	describe("Edge cases", () => {
		it("should handle objects with Date values", () => {
			const event = valueObject({
				name: "Meeting",
				date: new Date("2024-01-01"),
			});

			expect(event.name).toBe("Meeting");
			expect(event.date).toBeInstanceOf(Date);
		});

		it("rejects function properties (Value Objects are data, not behaviour)", () => {
			// valueObject() deep-clones via structuredClone before freezing so the
			// caller's input graph is not touched as a side-effect.
			// structuredClone refuses to clone function values, which catches
			// the DDD anti-pattern of putting behaviour on a Value Object
			// at construction time.
			expect(() =>
				valueObject({
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
			const created = valueObject(obj);
			expect(created.name).toBe("test");
			// The circular reference is preserved within the copied object
			expect(created.self).toBeDefined();
			expect((created.self as any).name).toBe("test");
		});

		it("should handle very large nested structures", () => {
			const large = valueObject({
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

describe("valueObjectOrError – error path never throws", () => {
	it("returns err for cyclic input when no custom message is given", () => {
		const cyclic: { name: string; self?: unknown } = { name: "a" };
		cyclic.self = cyclic;

		// The default error message used JSON.stringify, which throws on
		// circular structures; the Result contract must hold instead.
		const result = valueObjectOrError(cyclic, () => false);

		expect(result.isErr()).toBe(true);
		if (result.isErr()) {
			expect(result.error).toContain("Validation failed");
		}
	});

	it("returns err for BigInt-bearing input when no custom message is given", () => {
		const result = valueObjectOrError({ big: 1n }, () => false);

		expect(result.isErr()).toBe(true);
	});
});

describe("deepFreeze – mutator shadows are shared module-level functions", () => {
	it("installs the same thrower function instance across freezes", () => {
		const a = valueObject({ d: new Date(1) });
		const b = valueObject({ d: new Date(2) });

		const setTimeA = Object.getOwnPropertyDescriptor(a.d, "setTime")?.value;
		const setTimeB = Object.getOwnPropertyDescriptor(b.d, "setTime")?.value;

		// createDomainEvent freezes a Date per event, so per-instance closures
		// are pure allocation churn on that hot path.
		expect(typeof setTimeA).toBe("function");
		expect(setTimeA).toBe(setTimeB);
	});
});

describe("valueObject() – RegExp", () => {
	it("rejects a RegExp of any flags, because compile() could still change it", () => {
		expect(() => valueObject({ pattern: /ab+c/i })).toThrow(
			"valueObject(): props.pattern is a RegExp; keep its source and flags as strings",
		);
		expect(() => valueObject({ pattern: /ab+c/g })).toThrow(TypeError);
	});
});
