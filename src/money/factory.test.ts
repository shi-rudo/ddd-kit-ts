import { describe, expect, it } from "vite-plus/test";
import {
	InvalidMoneyError,
	MoneyPrecisionLossError,
	UnknownCurrencyError,
} from "./errors";
import {
	createMoneyFactory,
	currencyScaleFromIntl,
	currencyScaleFromRecord,
} from "./factory";
import { createMoneyFormatter, formatMoney } from "./format";
import type { Money } from "./money";
import { moneyOfMinor } from "./money";

describe("createMoneyFactory", () => {
	const factory = createMoneyFactory({
		scaleFor: currencyScaleFromRecord({ EUR: 2, JPY: 0 }),
	});

	it("binds the currency scale once: parse", () => {
		expect(factory.parse("10.99", "EUR")).toEqual(
			moneyOfMinor(1099n, "EUR", 2),
		);
		expect(factory.parse("10", "JPY")).toEqual(moneyOfMinor(10n, "JPY", 0));
	});

	it("binds the currency scale once: ofMinor and zero", () => {
		expect(factory.ofMinor(1099n, "EUR")).toEqual(
			moneyOfMinor(1099n, "EUR", 2),
		);
		expect(factory.zero("JPY")).toEqual(moneyOfMinor(0n, "JPY", 0));
	});

	it("exposes the resolved scale", () => {
		expect(factory.scaleOf("EUR")).toBe(2);
	});

	it("parse is exact-only: over-precise input is rejected, never rounded", () => {
		expect(() => factory.parse("10.999", "EUR")).toThrow(
			MoneyPrecisionLossError,
		);
	});

	it("throws UNKNOWN_CURRENCY when the resolver has no entry", () => {
		let thrown: unknown;
		try {
			factory.parse("1.00", "CHF");
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(UnknownCurrencyError);
		expect((thrown as UnknownCurrencyError).code).toBe("UNKNOWN_CURRENCY");
	});

	it("accepts a hand-rolled resolver (library currency packages are a one-liner)", () => {
		const currencies: Record<
			string,
			{ code: string; base: number; exponent: number }
		> = {
			EUR: { code: "EUR", base: 10, exponent: 2 },
			IQD: { code: "IQD", base: 10, exponent: 3 },
		};
		const fromCurrencyPackage = createMoneyFactory({
			scaleFor: (currency) => currencies[currency]?.exponent,
		});
		expect(fromCurrencyPackage.parse("10.994", "IQD").amountMinor).toBe(10994n);
		expect(fromCurrencyPackage.scaleOf("EUR")).toBe(2);
	});
});

describe("currencyScaleFromIntl", () => {
	const scaleFor = currencyScaleFromIntl();

	it("resolves scales from the runtime's own currency data", () => {
		expect(scaleFor("EUR")).toBe(2);
		expect(scaleFor("JPY")).toBe(0);
		expect(scaleFor("KWD")).toBe(3);
	});

	it("returns undefined for ill-formed codes instead of throwing", () => {
		expect(scaleFor("EURO")).toBeUndefined();
		expect(scaleFor("")).toBeUndefined();
	});

	it("resolves only canonical uppercase ISO codes ('eur' is not a silent alias)", () => {
		expect(scaleFor("eur")).toBeUndefined();
		expect(scaleFor("Eur")).toBeUndefined();
		expect(scaleFor("EUR")).toBe(2);
	});

	it("wires straight into the factory", () => {
		const factory = createMoneyFactory({ scaleFor });
		expect(factory.parse("10.99", "EUR").amountMinor).toBe(1099n);
		expect(factory.parse("10", "JPY").scale).toBe(0);
	});
});

describe("formatting (presentation only)", () => {
	it("formats via Intl without ever converting to a float", () => {
		expect(formatMoney(moneyOfMinor(1099n, "USD", 2), "en-US")).toBe("$10.99");
	});

	it("keeps precision beyond Number.MAX_SAFE_INTEGER", () => {
		expect(
			formatMoney(moneyOfMinor(9007199254740993n, "USD", 2), "en-US"),
		).toBe("$90,071,992,547,409.93");
	});

	it("respects the money's own scale over the currency default", () => {
		expect(formatMoney(moneyOfMinor(10994n, "USD", 3), "en-US")).toBe(
			"$10.994",
		);
	});

	it("formats locale-correctly", () => {
		const formatted = formatMoney(moneyOfMinor(1099n, "EUR", 2), "de-DE");
		expect(formatted).toContain("10,99");
		expect(formatted).toContain("€");
	});

	it("createMoneyFormatter binds the locale once", () => {
		const format = createMoneyFormatter("en-US");
		expect(format(moneyOfMinor(1099n, "USD", 2))).toBe("$10.99");
		expect(format(moneyOfMinor(1234n, "JPY", 0))).toBe("¥1,234");
	});

	it("rejects values that are not Money before touching Intl", () => {
		expect(() =>
			formatMoney(
				{ amountMinor: 10.99, currency: "EUR", scale: 2 } as unknown as Money,
				"en-US",
			),
		).toThrow(InvalidMoneyError);
		expect(() =>
			createMoneyFormatter("en-US")({
				amountMinor: 10.99,
				currency: "EUR",
				scale: 2,
			} as unknown as Money),
		).toThrow(InvalidMoneyError);
	});

	it("propagates Intl's RangeError for valid Money with a non-Intl currency", () => {
		// "EU" is a legal CurrencyCode for the contract (the kit ships no
		// table) but ill-formed for Intl; formatting is documented to
		// require an Intl-well-formed code.
		expect(() => formatMoney(moneyOfMinor(1n, "EU", 2), "en-US")).toThrow(
			RangeError,
		);
	});

	it("stays correct past the formatter cache bound", () => {
		const format = createMoneyFormatter("en-US");
		const letter = (n: number) => String.fromCharCode(65 + (n % 26));
		for (let i = 0; i < 1100; i++) {
			const code = `${letter(Math.floor(i / 676))}${letter(Math.floor(i / 26))}${letter(i)}`;
			format(moneyOfMinor(100n, code, 2));
		}
		expect(format(moneyOfMinor(1099n, "USD", 2))).toBe("$10.99");
	});

	it("currencyScaleFromIntl stays correct past its cache bound", () => {
		const scaleFor = currencyScaleFromIntl();
		for (let i = 0; i < 1100; i++) {
			scaleFor(`garbage-${i}`);
		}
		expect(scaleFor("EUR")).toBe(2);
		expect(scaleFor("garbage-0")).toBeUndefined();
	});
});
