import { describe, expect, it } from "vite-plus/test";
import { InvalidMoneyError } from "./errors";
import { moneyOfMinor } from "./money";
import { moneyFromSnapshot, moneyToSnapshot } from "./snapshot";

describe("calculation-library snapshot interop (structural, no dependency)", () => {
	it("maps a number-calculator snapshot onto Money", () => {
		const money = moneyFromSnapshot({
			amount: 1099,
			currency: { code: "EUR", base: 10, exponent: 2 },
			scale: 2,
		});
		expect(money).toEqual(moneyOfMinor(1099n, "EUR", 2));
	});

	it("maps a bigint-calculator snapshot onto Money", () => {
		const money = moneyFromSnapshot({
			amount: 9007199254740993n,
			currency: { code: "USD", base: 10n, exponent: 2n },
			scale: 2n,
		});
		expect(money).toEqual(moneyOfMinor(9007199254740993n, "USD", 2));
	});

	it("accepts a bare currency code with an explicit scale", () => {
		expect(
			moneyFromSnapshot({ amount: 10, currency: "JPY", scale: 0 }),
		).toEqual(moneyOfMinor(10n, "JPY", 0));
	});

	it("falls back to the currency exponent when the scale is absent", () => {
		const money = moneyFromSnapshot({
			amount: 1099,
			currency: { code: "EUR", base: 10, exponent: 2 },
		});
		expect(money.scale).toBe(2);
	});

	it("honors a snapshot scale that differs from the currency exponent", () => {
		const money = moneyFromSnapshot({
			amount: 10994,
			currency: { code: "USD", base: 10, exponent: 2 },
			scale: 3,
		});
		expect(money.scale).toBe(3);
		expect(money.amountMinor).toBe(10994n);
	});

	it("rejects non-decimal currencies (currency packages model MGA/MRU with base 5)", () => {
		expect(() =>
			moneyFromSnapshot({
				amount: 13,
				currency: { code: "MGA", base: 5, exponent: 1 },
				scale: 1,
			}),
		).toThrow(InvalidMoneyError);
	});

	it("rejects bigint-calculator non-decimal bases with InvalidMoneyError, never a raw TypeError", () => {
		expect(() =>
			moneyFromSnapshot({
				amount: 13n,
				currency: { code: "MGA", base: 5n, exponent: 1n },
				scale: 1n,
			}),
		).toThrow(InvalidMoneyError);
	});

	it("rejects multi-base currencies (modeled as base arrays)", () => {
		expect(() =>
			moneyFromSnapshot({
				amount: 10,
				currency: { code: "GBP", base: [20, 12], exponent: 2 },
				scale: 2,
			}),
		).toThrow(InvalidMoneyError);
	});

	it("rejects a snapshot without scale and exponent", () => {
		expect(() => moneyFromSnapshot({ amount: 10, currency: "EUR" })).toThrow(
			InvalidMoneyError,
		);
	});

	it("accepts unknown at the trust boundary", () => {
		expect(() => moneyFromSnapshot(undefined)).toThrow(InvalidMoneyError);
		expect(() => moneyFromSnapshot("not a snapshot")).toThrow(
			InvalidMoneyError,
		);
	});

	it("rejects fractional and unsafe number amounts", () => {
		expect(() =>
			moneyFromSnapshot({
				amount: 10.99,
				currency: { code: "EUR", base: 10, exponent: 2 },
				scale: 2,
			}),
		).toThrow(InvalidMoneyError);
		expect(() =>
			moneyFromSnapshot({
				amount: 2 ** 53,
				currency: { code: "EUR", base: 10, exponent: 2 },
				scale: 2,
			}),
		).toThrow(InvalidMoneyError);
	});

	it("produces a constructor-compatible snapshot from Money", () => {
		expect(moneyToSnapshot(moneyOfMinor(1099n, "EUR", 2))).toEqual({
			amount: 1099,
			currency: { code: "EUR", base: 10, exponent: 2 },
			scale: 2,
		});
	});

	it("round-trips Money -> snapshot -> Money", () => {
		const money = moneyOfMinor(-1099n, "EUR", 2);
		expect(moneyFromSnapshot(moneyToSnapshot(money))).toEqual(money);
	});

	it("refuses to emit number amounts past Number.MAX_SAFE_INTEGER", () => {
		let thrown: unknown;
		try {
			moneyToSnapshot(moneyOfMinor(9007199254740993n, "USD", 2));
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(InvalidMoneyError);
		expect((thrown as Error).message).toContain("bigint calculator");
	});

	it("guards against non-Money input", () => {
		expect(() =>
			moneyToSnapshot(
				// @ts-expect-error boundary guard against untyped callers
				{ amountMinor: 1099, currency: "EUR", scale: 2 },
			),
		).toThrow(InvalidMoneyError);
	});
});
