import { describe, expect, it } from "vitest";
import { describeValue } from "./errors";
import { currencyScaleFromIntl } from "./factory";
import {
	isMoney,
	isPositiveMoney,
	moneyEquals,
	moneyFromDto,
	moneyOfMinor,
} from "./money";
import { parseMoneyInput } from "./parse";
import { moneyFromSnapshot } from "./snapshot";

// Guard-edge tests grown out of the mutation-testing pass: each case
// below killed at least one surviving mutant, i.e. each pins behavior
// no other test observed.

describe("describeValue diagnostics", () => {
	it("renders short values verbatim through JSON", () => {
		expect(describeValue("abc")).toBe('"abc"');
		expect(describeValue(42)).toBe("42");
		expect(describeValue(null)).toBe("null");
	});

	it("renders bigints itself instead of JSON (which cannot), truncating past 48 digits", () => {
		expect(describeValue(42n)).toBe("42n");
		const big = 10n ** 60n;
		expect(describeValue(big)).toBe(
			`${big.toString().slice(0, 48)}... (truncated bigint)`,
		);
		// The boundary: 48 digits render verbatim, 49 collapse.
		expect(describeValue(10n ** 47n)).toBe(`${10n ** 47n}n`);
		expect(describeValue(10n ** 48n)).toContain("(truncated bigint)");
	});

	it("truncates long strings with the original length preserved", () => {
		const long = "x".repeat(100);
		const rendered = describeValue(long);
		expect(rendered).toContain("truncated, 100 chars");
		expect(rendered).toContain(`"${"x".repeat(48)}"`);
		// The boundary: 48 chars pass untouched.
		expect(describeValue("y".repeat(48))).toBe(`"${"y".repeat(48)}"`);
	});

	it("falls back for values JSON cannot serialize", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(describeValue(cyclic)).toContain("object");
		expect(describeValue(undefined)).toContain("undefined");
	});

	it("truncates long JSON renderings at 64 characters", () => {
		const wide = { key: "z".repeat(100) };
		const rendered = describeValue(wide);
		expect(rendered).toContain("(truncated)");
		expect(rendered.length).toBeLessThan(80);
		// The boundary: a 64-character rendering passes untouched (probed
		// with an object, since long strings take the string branch above).
		const atBound = { k: "b".repeat(56) }; // {"k":"..."} renders as 64 chars
		expect(JSON.stringify(atBound)).toHaveLength(64);
		expect(describeValue(atBound)).toBe(JSON.stringify(atBound));
	});
});

describe("money guard edges", () => {
	it("moneyOfMinor rejects non-bigint amounts loudly", () => {
		// biome-ignore lint/suspicious/noExplicitAny: deliberate misuse
		expect(() => moneyOfMinor(10 as any, "EUR", 2)).toThrow(/bigint/);
	});

	it("isMoney rejects primitives, null, and non-number scales", () => {
		expect(isMoney(null)).toBe(false);
		expect(isMoney(5)).toBe(false);
		expect(isMoney({ amountMinor: 1n, currency: "EUR", scale: "2" })).toBe(
			false,
		);
	});

	it("moneyEquals is false when only the scale differs", () => {
		const a = moneyOfMinor(100n, "EUR", 2);
		const b = moneyOfMinor(100n, "EUR", 3);
		expect(moneyEquals(a, b)).toBe(false);
	});

	it("zero is not positive", () => {
		expect(isPositiveMoney(moneyOfMinor(0n, "EUR", 2))).toBe(false);
	});

	it("moneyFromDto names the offending type in its rejection", () => {
		expect(() => moneyFromDto(null)).toThrow(/got null/);
		expect(() => moneyFromDto(5)).toThrow(/got number/);
	});

	it("accepts a DTO amount at the exact length bound and rejects one past it", () => {
		// The bound is sign + 96 digits; the amount limit is 10^96
		// exclusive, so 96 nines is the largest representable magnitude.
		const atBound = `-${"9".repeat(96)}`;
		const parsed = moneyFromDto({
			amountMinor: atBound,
			currency: "EUR",
			scale: 2,
		});
		expect(parsed.amountMinor).toBe(BigInt(atBound));
		expect(() =>
			moneyFromDto({
				amountMinor: `-0${"9".repeat(96)}`,
				currency: "EUR",
				scale: 2,
			}),
		).toThrow(/amountMinor/);
	});
});

describe("parse guard edges", () => {
	it("accepts input at the exact length bound", () => {
		// 256 characters total: 255 digits and a dot fit the grammar.
		const input = `1.${"0".repeat(254)}`;
		expect(input.length).toBe(256);
		const parsed = parseMoneyInput(input, { currency: "EUR", scale: 2 });
		expect(parsed.amountMinor).toBe(100n);
	});

	it("rejects excess fractions that merely contain or end in zeros", () => {
		// Only ALL-zero excess is lossless; "10" and "01" both carry a
		// non-zero digit and must throw, whichever side the zeros are on.
		expect(() =>
			parseMoneyInput("1.9910", { currency: "EUR", scale: 2 }),
		).toThrow(/precision/);
		expect(() =>
			parseMoneyInput("1.9901", { currency: "EUR", scale: 2 }),
		).toThrow(/precision/);
	});
});

describe("factory guard edges", () => {
	it("the Intl resolver answers undefined for non-strings and non-canonical codes", () => {
		const resolve = currencyScaleFromIntl();
		// biome-ignore lint/suspicious/noExplicitAny: deliberate misuse
		expect(resolve(123 as any)).toBeUndefined();
		expect(resolve("eur")).toBeUndefined();
		// Both regex anchors matter: neither a canonical prefix nor a
		// canonical suffix makes a four-letter code valid.
		expect(resolve("EURX")).toBeUndefined();
		expect(resolve("XEUR")).toBeUndefined();
		// A canonical code resolves (Intl data willing) to a number.
		expect(resolve("EUR")).toBe(2);
	});
});

describe("snapshot guard edges", () => {
	it("names the offending type when the snapshot is not an object", () => {
		expect(() => moneyFromSnapshot(null)).toThrow(/got null/);
		expect(() => moneyFromSnapshot(5)).toThrow(/got number/);
	});

	it("rejects a currency object without any scale source", () => {
		expect(() =>
			moneyFromSnapshot({ amount: 100, currency: { code: "EUR" } }),
		).toThrow(/scale|exponent/);
	});

	it("rejects null and primitive currency shapes", () => {
		expect(() => moneyFromSnapshot({ amount: 100, currency: null })).toThrow(
			/currency/,
		);
	});

	it("rejects non-number, non-bigint scales with the field named", () => {
		expect(() =>
			moneyFromSnapshot({ amount: 100, currency: "EUR", scale: "2" }),
		).toThrow(/scale/);
		expect(() =>
			moneyFromSnapshot({ amount: 100, currency: "EUR", scale: 2.5 }),
		).toThrow(/scale/);
	});
});
