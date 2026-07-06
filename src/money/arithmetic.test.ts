import { describe, expect, it } from "vitest";
import { DomainError } from "../core/errors";
import {
	addMoney,
	negateMoney,
	rescaleMoney,
	subtractMoney,
} from "./arithmetic";
import {
	InvalidMoneyError,
	MoneyCurrencyMismatchError,
	MoneyPrecisionLossError,
	MoneyScaleMismatchError,
} from "./errors";
import { moneyOfMinor } from "./money";

function expectKitError(
	fn: () => unknown,
	// biome-ignore lint/suspicious/noExplicitAny: test helper accepts any error class
	ctor: new (...args: any[]) => Error,
	code: string,
): void {
	let thrown: unknown;
	try {
		fn();
	} catch (error) {
		thrown = error;
	}
	expect(thrown, `expected the call to throw ${code}`).toBeDefined();
	expect(thrown).toBeInstanceOf(ctor);
	expect((thrown as { code: string }).code).toBe(code);
	expect((thrown as Error).name).toBe(code);
}

describe("lossless arithmetic (contract operations, no rounding involved)", () => {
	it("adds and subtracts same-currency same-scale amounts exactly", () => {
		const a = moneyOfMinor(1099n, "EUR", 2);
		const b = moneyOfMinor(901n, "EUR", 2);
		expect(addMoney(a, b)).toEqual(moneyOfMinor(2000n, "EUR", 2));
		expect(subtractMoney(a, b)).toEqual(moneyOfMinor(198n, "EUR", 2));
	});

	it("returns frozen Money", () => {
		expect(
			Object.isFrozen(
				addMoney(moneyOfMinor(1n, "EUR", 2), moneyOfMinor(1n, "EUR", 2)),
			),
		).toBe(true);
	});

	it("allows negative results (ledger semantics)", () => {
		const a = moneyOfMinor(100n, "EUR", 2);
		const b = moneyOfMinor(250n, "EUR", 2);
		expect(subtractMoney(a, b).amountMinor).toBe(-150n);
	});

	it("throws on adding EUR and USD", () => {
		expectKitError(
			() => addMoney(moneyOfMinor(1n, "EUR", 2), moneyOfMinor(1n, "USD", 2)),
			MoneyCurrencyMismatchError,
			"MONEY_CURRENCY_MISMATCH",
		);
	});

	it("throws on adding EUR scale 2 and EUR scale 3", () => {
		expectKitError(
			() =>
				addMoney(moneyOfMinor(1099n, "EUR", 2), moneyOfMinor(10990n, "EUR", 3)),
			MoneyScaleMismatchError,
			"MONEY_SCALE_MISMATCH",
		);
	});

	it("subtract enforces the same guards", () => {
		expectKitError(
			() =>
				subtractMoney(moneyOfMinor(1n, "EUR", 2), moneyOfMinor(1n, "USD", 2)),
			MoneyCurrencyMismatchError,
			"MONEY_CURRENCY_MISMATCH",
		);
		expectKitError(
			() =>
				subtractMoney(moneyOfMinor(1n, "EUR", 2), moneyOfMinor(1n, "EUR", 3)),
			MoneyScaleMismatchError,
			"MONEY_SCALE_MISMATCH",
		);
	});

	it("negates exactly, zero included", () => {
		expect(negateMoney(moneyOfMinor(1099n, "EUR", 2)).amountMinor).toBe(-1099n);
		expect(negateMoney(moneyOfMinor(-1099n, "EUR", 2)).amountMinor).toBe(1099n);
		expect(negateMoney(moneyOfMinor(0n, "EUR", 2)).amountMinor).toBe(0n);
	});

	it("a sum past the amount bound fails loudly instead of wrapping", () => {
		const nearLimit = moneyOfMinor(10n ** 96n - 1n, "EUR", 2);
		expectKitError(
			() => addMoney(nearLimit, moneyOfMinor(1n, "EUR", 2)),
			InvalidMoneyError,
			"INVALID_MONEY",
		);
	});

	it("mismatch errors are DomainErrors with code === name", () => {
		try {
			addMoney(moneyOfMinor(1n, "EUR", 2), moneyOfMinor(1n, "USD", 2));
			expect.fail("expected a currency mismatch");
		} catch (error) {
			expect(error).toBeInstanceOf(DomainError);
			const structured = error as MoneyCurrencyMismatchError;
			expect(structured.name).toBe(structured.code);
			expect(structured.retryable).toBe(false);
		}
	});
});

describe("rescaleMoney (lossless only: the kit never rounds outside parsing)", () => {
	it("upscaling is lossless", () => {
		expect(rescaleMoney(moneyOfMinor(1099n, "EUR", 2), 3)).toEqual(
			moneyOfMinor(10990n, "EUR", 3),
		);
	});

	it("exact downscaling is lossless", () => {
		expect(rescaleMoney(moneyOfMinor(1100n, "EUR", 2), 1).amountMinor).toBe(
			110n,
		);
	});

	it("inexact downscaling ALWAYS throws; lossy conversion is calculation-library territory", () => {
		expectKitError(
			() => rescaleMoney(moneyOfMinor(1099n, "EUR", 2), 1),
			MoneyPrecisionLossError,
			"MONEY_PRECISION_LOSS",
		);
	});

	it("same-scale rescale returns the value unchanged", () => {
		const money = moneyOfMinor(1099n, "EUR", 2);
		expect(rescaleMoney(money, 2)).toBe(money);
	});

	it("rejects an out-of-bounds target scale before computing", () => {
		expectKitError(
			() => rescaleMoney(moneyOfMinor(1099n, "EUR", 2), 65),
			InvalidMoneyError,
			"INVALID_MONEY",
		);
		expectKitError(
			() => rescaleMoney(moneyOfMinor(1099n, "EUR", 2), -1),
			InvalidMoneyError,
			"INVALID_MONEY",
		);
	});

	it("makes mixed-scale addition reachable losslessly", () => {
		const coarse = moneyOfMinor(1099n, "EUR", 2);
		const fine = moneyOfMinor(10990n, "EUR", 3);
		expect(addMoney(rescaleMoney(coarse, 3), fine).amountMinor).toBe(21980n);
	});
});
