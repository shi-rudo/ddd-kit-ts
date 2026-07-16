import { describe, expect, it } from "vite-plus/test";
import { DomainError } from "../core/errors";
import { InvalidMoneyError, MoneyPrecisionLossError } from "./errors";
import {
	isMoney,
	isNegativeMoney,
	isPositiveMoney,
	isZeroMoney,
	type Money,
	moneyEquals,
	moneyFromDto,
	moneyFromUnknown,
	moneyOfMinor,
	moneyToDecimalString,
	moneyToDto,
} from "./money";
import { parseMoneyInput } from "./parse";

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

describe("moneyOfMinor", () => {
	it("creates the canonical shape with a bigint minor amount", () => {
		const money = moneyOfMinor(1099n, "EUR", 2);
		expect(money.amountMinor).toBe(1099n);
		expect(money.currency).toBe("EUR");
		expect(money.scale).toBe(2);
		expect(typeof money.amountMinor).toBe("bigint");
	});

	it("freezes the value object", () => {
		expect(Object.isFrozen(moneyOfMinor(1099n, "EUR", 2))).toBe(true);
	});

	it("survives the plain-data boundary the kit's state handling relies on", () => {
		const money = moneyOfMinor(1099n, "EUR", 2);
		expect(structuredClone(money)).toEqual(money);
	});

	it("supports zero-decimal currencies", () => {
		const money = moneyOfMinor(10n, "JPY", 0);
		expect(money.amountMinor).toBe(10n);
		expect(money.scale).toBe(0);
	});

	it("rejects a number amount", () => {
		expectKitError(
			// @ts-expect-error the domain model never carries number amounts
			() => moneyOfMinor(10.99, "EUR", 2),
			InvalidMoneyError,
			"INVALID_MONEY",
		);
	});

	it("rejects negative and fractional scales", () => {
		expectKitError(
			() => moneyOfMinor(1099n, "EUR", -1),
			InvalidMoneyError,
			"INVALID_MONEY",
		);
		expectKitError(
			() => moneyOfMinor(1099n, "EUR", 1.5),
			InvalidMoneyError,
			"INVALID_MONEY",
		);
	});

	it("rejects empty or whitespace-carrying currency codes", () => {
		expectKitError(
			() => moneyOfMinor(1099n, "", 2),
			InvalidMoneyError,
			"INVALID_MONEY",
		);
		expectKitError(
			() => moneyOfMinor(1099n, "E UR", 2),
			InvalidMoneyError,
			"INVALID_MONEY",
		);
	});
});

describe("Money DTO boundary", () => {
	it("serializes amountMinor as a string, never a JSON number", () => {
		const dto = moneyToDto(moneyOfMinor(1099n, "EUR", 2));
		expect(dto).toEqual({ amountMinor: "1099", currency: "EUR", scale: 2 });
		expect(typeof dto.amountMinor).toBe("string");
		expect(JSON.parse(JSON.stringify(dto))).toEqual(dto);
	});

	it("round-trips through fromDto/toDto", () => {
		const money = moneyOfMinor(-1099n, "EUR", 2);
		expect(moneyFromDto(moneyToDto(money))).toEqual(money);
	});

	it("accepts only integer strings for amountMinor", () => {
		expect(
			moneyFromDto({ amountMinor: "-1099", currency: "EUR", scale: 2 })
				.amountMinor,
		).toBe(-1099n);
		for (const bad of ["10.99", "1e5", "", " 1099", "+1099", "0x10", "NaN"]) {
			expectKitError(
				() => moneyFromDto({ amountMinor: bad, currency: "EUR", scale: 2 }),
				InvalidMoneyError,
				"INVALID_MONEY",
			);
		}
	});

	it("rejects a numeric amountMinor at runtime", () => {
		expectKitError(
			() => moneyFromDto({ amountMinor: 1099, currency: "EUR", scale: 2 }),
			InvalidMoneyError,
			"INVALID_MONEY",
		);
	});

	it("accepts unknown at the trust boundary, without lying casts", () => {
		expectKitError(
			() => moneyFromDto(null),
			InvalidMoneyError,
			"INVALID_MONEY",
		);
		expectKitError(
			() => moneyFromDto("not a dto"),
			InvalidMoneyError,
			"INVALID_MONEY",
		);
		expectKitError(
			() => parseMoneyInput(42, { currency: "EUR", scale: 2 }),
			InvalidMoneyError,
			"INVALID_MONEY",
		);
	});

	it("moneyToDto rejects values that are not Money", () => {
		expectKitError(
			() =>
				moneyToDto(
					// @ts-expect-error boundary guard against untyped callers
					{ amountMinor: 1099, currency: "EUR", scale: 2 },
				),
			InvalidMoneyError,
			"INVALID_MONEY",
		);
	});
});

describe("parseMoneyInput", () => {
	it("parses EUR '10.99' to 1099n at scale 2", () => {
		expect(parseMoneyInput("10.99", { currency: "EUR", scale: 2 })).toEqual(
			moneyOfMinor(1099n, "EUR", 2),
		);
	});

	it("parses JPY '10' to 10n at scale 0", () => {
		expect(parseMoneyInput("10", { currency: "JPY", scale: 0 })).toEqual(
			moneyOfMinor(10n, "JPY", 0),
		);
	});

	it("pads missing fraction digits losslessly", () => {
		expect(
			parseMoneyInput("10.5", { currency: "EUR", scale: 2 }).amountMinor,
		).toBe(1050n);
		expect(
			parseMoneyInput("10", { currency: "EUR", scale: 2 }).amountMinor,
		).toBe(1000n);
	});

	it("parses negative amounts", () => {
		expect(
			parseMoneyInput("-10.99", { currency: "EUR", scale: 2 }).amountMinor,
		).toBe(-1099n);
	});

	it("rejects EUR '10.999': exact parse or rejection, never rounding", () => {
		expectKitError(
			() => parseMoneyInput("10.999", { currency: "EUR", scale: 2 }),
			MoneyPrecisionLossError,
			"MONEY_PRECISION_LOSS",
		);
	});

	it("treats excess zero fraction digits as lossless", () => {
		expect(
			parseMoneyInput("10.990", { currency: "EUR", scale: 2 }).amountMinor,
		).toBe(1099n);
	});

	it("rejects everything Number/parseFloat would silently accept", () => {
		for (const bad of [
			"10,99",
			"abc",
			"10.",
			".99",
			"1e3",
			"Infinity",
			"10.99 ",
			" 10.99",
			"+10.99",
			"",
		]) {
			expectKitError(
				() => parseMoneyInput(bad, { currency: "EUR", scale: 2 }),
				InvalidMoneyError,
				"INVALID_MONEY",
			);
		}
	});
});

describe("hard bounds (hostile input cannot buy unbounded CPU or memory)", () => {
	it("caps amountMinor at 96 digits (uint256 with headroom)", () => {
		const limit = 10n ** 96n;
		expect(moneyOfMinor(limit - 1n, "EUR", 2).amountMinor).toBe(limit - 1n);
		expect(moneyOfMinor(1n - limit, "EUR", 2).amountMinor).toBe(1n - limit);
		expectKitError(
			() => moneyOfMinor(limit, "EUR", 2),
			InvalidMoneyError,
			"INVALID_MONEY",
		);
		expectKitError(
			() => moneyOfMinor(-limit, "EUR", 2),
			InvalidMoneyError,
			"INVALID_MONEY",
		);
	});

	it("caps the scale at 64", () => {
		expect(moneyOfMinor(1n, "EUR", 64).scale).toBe(64);
		expectKitError(
			() => moneyOfMinor(1n, "EUR", 65),
			InvalidMoneyError,
			"INVALID_MONEY",
		);
	});

	it("caps the currency length at 32", () => {
		expect(moneyOfMinor(1n, "C".repeat(32), 2).currency).toHaveLength(32);
		expectKitError(
			() => moneyOfMinor(1n, "C".repeat(33), 2),
			InvalidMoneyError,
			"INVALID_MONEY",
		);
	});

	it("isMoney mirrors the bounds", () => {
		expect(
			isMoney({ amountMinor: 10n ** 96n, currency: "EUR", scale: 2 }),
		).toBe(false);
		expect(isMoney({ amountMinor: 1n, currency: "EUR", scale: 65 })).toBe(
			false,
		);
		expect(
			isMoney({ amountMinor: 1n, currency: "C".repeat(33), scale: 2 }),
		).toBe(false);
	});

	it("round-trips the largest representable amount through the DTO", () => {
		const money = moneyOfMinor(10n ** 96n - 1n, "EUR", 2);
		expect(moneyFromDto(moneyToDto(money))).toEqual(money);
	});

	it("rejects oversized DTO amount strings before converting them", () => {
		expectKitError(
			() =>
				moneyFromDto({
					amountMinor: "9".repeat(100_000),
					currency: "EUR",
					scale: 2,
				}),
			InvalidMoneyError,
			"INVALID_MONEY",
		);
	});

	it("rejects oversized parse input outright, without echoing it back", () => {
		let thrown: unknown;
		try {
			parseMoneyInput(`1.${"9".repeat(100_000)}`, {
				currency: "EUR",
				scale: 2,
			});
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(InvalidMoneyError);
		expect((thrown as InvalidMoneyError).code).toBe("INVALID_MONEY");
		expect((thrown as Error).message.length).toBeLessThan(256);
	});

	it("rejects a bigint scale with INVALID_MONEY, never a raw TypeError", () => {
		expectKitError(
			() => moneyOfMinor(1099n, "EUR", 2n as unknown as number),
			InvalidMoneyError,
			"INVALID_MONEY",
		);
	});

	it("diagnostics survive circular input instead of crashing JSON.stringify", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expectKitError(
			() => parseMoneyInput(cyclic, { currency: "EUR", scale: 2 }),
			InvalidMoneyError,
			"INVALID_MONEY",
		);
	});

	it("rejects an out-of-bounds scale before any conversion work", () => {
		expectKitError(
			() => parseMoneyInput("10.99", { currency: "EUR", scale: 10_000_000 }),
			InvalidMoneyError,
			"INVALID_MONEY",
		);
	});

	it("truncates what error messages echo for merely-invalid long input", () => {
		let thrown: unknown;
		try {
			parseMoneyInput(`x${"y".repeat(200)}`, { currency: "EUR", scale: 2 });
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(InvalidMoneyError);
		expect((thrown as Error).message.length).toBeLessThan(256);
	});
});

describe("predicates and equality", () => {
	it("isZero, isPositive, isNegative", () => {
		expect(isZeroMoney(moneyOfMinor(0n, "EUR", 2))).toBe(true);
		expect(isZeroMoney(moneyOfMinor(1099n, "EUR", 2))).toBe(false);
		expect(isPositiveMoney(moneyOfMinor(1099n, "EUR", 2))).toBe(true);
		expect(isPositiveMoney(moneyOfMinor(-1099n, "EUR", 2))).toBe(false);
		expect(isNegativeMoney(moneyOfMinor(-1099n, "EUR", 2))).toBe(true);
		expect(isNegativeMoney(moneyOfMinor(0n, "EUR", 2))).toBe(false);
	});

	it("moneyEquals compares amount, currency, and scale strictly", () => {
		const money = moneyOfMinor(1099n, "EUR", 2);
		expect(moneyEquals(money, moneyOfMinor(1099n, "EUR", 2))).toBe(true);
		expect(moneyEquals(money, moneyOfMinor(1099n, "USD", 2))).toBe(false);
		expect(moneyEquals(money, moneyOfMinor(1100n, "EUR", 2))).toBe(false);
		// same numeric value at a different scale is NOT equal
		expect(moneyEquals(money, moneyOfMinor(10990n, "EUR", 3))).toBe(false);
	});

	it("Money is branded with a unique symbol: structural literals do not type-check", () => {
		// @ts-expect-error only the module's constructors mint Money
		const forged: Money = { amountMinor: 1n, currency: "EUR", scale: 2 };
		expect(isMoney(forged)).toBe(true);
	});

	it("even spelling out a __brand-style property cannot forge Money", () => {
		const forged: Money = {
			amountMinor: 1n,
			currency: "EUR",
			scale: 2,
			// @ts-expect-error the brand is a non-exported unique symbol, not a string key
			__brand: "Money",
		};
		expect(isMoney(forged)).toBe(true);
	});

	it("moneyFromUnknown mints a fresh frozen value the input cannot reach", () => {
		const raw = { amountMinor: 100n, currency: "EUR", scale: 2 };
		const money = moneyFromUnknown(raw);
		raw.amountMinor = 999n;
		expect(money.amountMinor).toBe(100n);
		expect(Object.isFrozen(money)).toBe(true);
		expect(money).not.toBe(raw);
	});

	it("moneyFromUnknown rejects invalid shapes loudly", () => {
		expectKitError(
			() => moneyFromUnknown({ amountMinor: 100, currency: "EUR", scale: 2 }),
			InvalidMoneyError,
			"INVALID_MONEY",
		);
		expectKitError(
			() => moneyFromUnknown(null),
			InvalidMoneyError,
			"INVALID_MONEY",
		);
	});

	it("isMoney narrows the canonical shape", () => {
		expect(isMoney(moneyOfMinor(1099n, "EUR", 2))).toBe(true);
		expect(isMoney({ amountMinor: 1099n, currency: "EUR", scale: 2 })).toBe(
			true,
		);
		expect(isMoney({ amountMinor: 1099, currency: "EUR", scale: 2 })).toBe(
			false,
		);
		expect(isMoney({ amountMinor: 1099n, scale: 2 })).toBe(false);
		expect(isMoney({ amountMinor: 1099n, currency: "EUR", scale: 1.5 })).toBe(
			false,
		);
		expect(isMoney(null)).toBe(false);
		expect(isMoney("10.99")).toBe(false);
	});
});

describe("moneyToDecimalString", () => {
	it("renders the exact decimal representation", () => {
		expect(moneyToDecimalString(moneyOfMinor(1099n, "EUR", 2))).toBe("10.99");
		expect(moneyToDecimalString(moneyOfMinor(-1099n, "EUR", 2))).toBe("-10.99");
		expect(moneyToDecimalString(moneyOfMinor(-5n, "EUR", 2))).toBe("-0.05");
		expect(moneyToDecimalString(moneyOfMinor(0n, "EUR", 2))).toBe("0.00");
		expect(moneyToDecimalString(moneyOfMinor(10n, "JPY", 0))).toBe("10");
	});

	it("inverts parseMoneyInput", () => {
		const money = parseMoneyInput("-10.05", { currency: "EUR", scale: 2 });
		expect(moneyToDecimalString(money)).toBe("-10.05");
	});

	it("rejects values that are not Money, like the wire emitters do", () => {
		expectKitError(
			() =>
				moneyToDecimalString({
					amountMinor: 10.99,
					currency: "EUR",
					scale: 2,
				} as unknown as Money),
			InvalidMoneyError,
			"INVALID_MONEY",
		);
	});
});

describe("error taxonomy", () => {
	it("money errors are DomainErrors with code === name", () => {
		try {
			moneyOfMinor(1099n, "", 2);
			expect.fail("expected an invalid money error");
		} catch (error) {
			expect(error).toBeInstanceOf(DomainError);
			const structured = error as InvalidMoneyError;
			expect(structured.code).toBe("INVALID_MONEY");
			expect(structured.name).toBe(structured.code);
			expect(structured.retryable).toBe(false);
		}
	});
});
