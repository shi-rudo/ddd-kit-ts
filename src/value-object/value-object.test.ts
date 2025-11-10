import { describe, expect, it } from "vitest";
import {
	vo,
	voEquals,
	voWithValidation,
	voWithValidationUnsafe,
	type ValueObject,
} from "./value-object";

describe("ValueObject", () => {
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
			// Note: JSON.stringify removes undefined properties, so obj1 and obj3 are equal
			// This is expected behavior of JSON.stringify
			expect(voEquals(obj1, obj3)).toBe(true);
		});

		it("should return false when comparing reference equality", () => {
			const money1 = vo({ amount: 100, currency: "USD" });
			const money2 = money1; // Same reference

			expect(money1 === money2).toBe(true); // Reference equality
			expect(voEquals(money1, money2)).toBe(true); // Value equality
		});
	});

	describe("voWithValidation()", () => {
		it("should return ok result when validation passes", () => {
			const result = voWithValidation(
				{ amount: 100, currency: "USD" },
				(m) => m.amount >= 0 && m.currency.length === 3,
			);

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.amount).toBe(100);
				expect(result.value.currency).toBe("USD");
			}
		});

		it("should return error result when validation fails", () => {
			const result = voWithValidation(
				{ amount: -100, currency: "USD" },
				(m) => m.amount >= 0 && m.currency.length === 3,
			);

			expect(result.ok).toBe(false);
			if (!result.ok) {
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

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toBe(customMessage);
			}
		});

		it("should use default error message when no custom message provided", () => {
			const result = voWithValidation(
				{ amount: -100, currency: "USD" },
				(m) => m.amount >= 0 && m.currency.length === 3,
			);

			expect(result.ok).toBe(false);
			if (!result.ok) {
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

			expect(result.ok).toBe(true);
			if (result.ok) {
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

			expect(result.ok).toBe(false);
		});

		it("should create deeply frozen value object after validation", () => {
			const result = voWithValidation(
				{ amount: 100, currency: "USD" },
				(m) => m.amount >= 0 && m.currency.length === 3,
			);

			expect(result.ok).toBe(true);
			if (result.ok) {
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

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.items).toEqual([1, 2, 3]);
			}
		});

		it("should reject invalid arrays", () => {
			const result = voWithValidation(
				{ items: [-1, 2, 3] }, // Contains negative number
				(l) => l.items.length > 0 && l.items.every((i) => i > 0),
			);

			expect(result.ok).toBe(false);
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

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.value).toBe("user@example.com");
			}
		});
	});

	describe("voWithValidationUnsafe()", () => {
		it("should create value object when validation passes", () => {
			const money = voWithValidationUnsafe(
				{ amount: 100, currency: "USD" },
				(m) => m.amount >= 0 && m.currency.length === 3,
			);

			expect(money.amount).toBe(100);
			expect(money.currency).toBe("USD");
		});

		it("should throw error when validation fails", () => {
			expect(() => {
				voWithValidationUnsafe(
					{ amount: -100, currency: "USD" },
					(m) => m.amount >= 0 && m.currency.length === 3,
				);
			}).toThrow();
		});

		it("should use custom error message when validation fails", () => {
			const customMessage = "Amount must be non-negative";

			expect(() => {
				voWithValidationUnsafe(
					{ amount: -100, currency: "USD" },
					(m) => m.amount >= 0 && m.currency.length === 3,
					customMessage,
				);
			}).toThrow(customMessage);
		});

		it("should use default error message when no custom message provided", () => {
			expect(() => {
				voWithValidationUnsafe(
					{ amount: -100, currency: "USD" },
					(m) => m.amount >= 0 && m.currency.length === 3,
				);
			}).toThrow(/Validation failed for value object/);
		});

		it("should validate nested structures", () => {
			const address = voWithValidationUnsafe(
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

			expect(address.street).toBe("Main St");
			expect(address.coordinates.lat).toBe(52.5);
		});

		it("should reject invalid nested structures", () => {
			expect(() => {
				voWithValidationUnsafe(
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
			}).toThrow();
		});

		it("should create deeply frozen value object after validation", () => {
			const money = voWithValidationUnsafe(
				{ amount: 100, currency: "USD" },
				(m) => m.amount >= 0 && m.currency.length === 3,
			);

			expect(() => {
				(money as any).amount = 200;
			}).toThrow();
		});

		it("should validate arrays", () => {
			const list = voWithValidationUnsafe(
				{ items: [1, 2, 3] },
				(l) => l.items.length > 0 && l.items.every((i) => i > 0),
			);

			expect(list.items).toEqual([1, 2, 3]);
		});

		it("should reject invalid arrays", () => {
			expect(() => {
				voWithValidationUnsafe(
					{ items: [-1, 2, 3] }, // Contains negative number
					(l) => l.items.length > 0 && l.items.every((i) => i > 0),
				);
			}).toThrow();
		});

		it("should handle complex validation logic", () => {
			type EmailData = { value: string };
			const email = voWithValidationUnsafe(
				{ value: "user@example.com" },
				(e: EmailData) => {
					const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
					return emailRegex.test(e.value);
				},
				"Invalid email format",
			);

			expect(email.value).toBe("user@example.com");
		});
	});

	describe("Type safety", () => {
		it("should preserve TypeScript types", () => {
			type Money = ValueObject<{
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

		it("should handle objects with function properties (functions are not frozen)", () => {
			// Note: Functions are not frozen by Object.freeze
			const obj = vo({
				data: "test",
				fn: () => "hello",
			});

			expect(typeof obj.fn).toBe("function");
			// Functions can still be called
			expect((obj.fn as any)()).toBe("hello");
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

