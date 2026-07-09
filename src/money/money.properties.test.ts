import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	addMoney,
	negateMoney,
	rescaleMoney,
	subtractMoney,
} from "./arithmetic";
import { MoneyPrecisionLossError } from "./errors";
import {
	type Money,
	moneyFromDto,
	moneyOfMinor,
	moneyToDecimalString,
	moneyToDto,
} from "./money";
import { parseMoneyInput } from "./parse";
import { moneyFromSnapshot, moneyToSnapshot } from "./snapshot";

// The generators stay far inside the validation bounds (|amount| <
// 10^96, scale <= 64) so headroom, not the guards, is what the
// properties exercise: sums stay exact, and upscaling by the full
// scale range cannot cross the amount limit (10^28 * 10^64 = 10^92).
const currencyArb = fc.constantFrom("EUR", "USD", "JPY", "BHD", "CLF", "XAU");
const scaleArb = fc.integer({ min: 0, max: 12 });
const amountArb = fc.bigInt({ min: -(10n ** 28n), max: 10n ** 28n });

const moneyArb: fc.Arbitrary<Money> = fc
	.tuple(amountArb, currencyArb, scaleArb)
	.map(([amount, currency, scale]) => moneyOfMinor(amount, currency, scale));

/** Two same-unit amounts, the shape the exact arithmetic operates on. */
const sameUnitPairArb = fc
	.tuple(amountArb, amountArb, currencyArb, scaleArb)
	.map(([a, b, currency, scale]) => ({
		a: moneyOfMinor(a, currency, scale),
		b: moneyOfMinor(b, currency, scale),
	}));

function expectSameMoney(actual: Money, expected: Money): void {
	expect(actual.amountMinor).toBe(expected.amountMinor);
	expect(actual.currency).toBe(expected.currency);
	expect(actual.scale).toBe(expected.scale);
}

describe("money properties: parse/render inversion", () => {
	it("parseMoneyInput inverts moneyToDecimalString for every money", () => {
		fc.assert(
			fc.property(moneyArb, (money) => {
				const parsed = parseMoneyInput(moneyToDecimalString(money), {
					currency: money.currency,
					scale: money.scale,
				});
				expectSameMoney(parsed, money);
			}),
		);
	});

	it("zero-only excess fraction digits parse to the same money", () => {
		fc.assert(
			fc.property(
				moneyArb,
				fc.integer({ min: 1, max: 6 }),
				(money, extraZeros) => {
					const rendered = moneyToDecimalString(money);
					const padded =
						money.scale === 0
							? `${rendered}.${"0".repeat(extraZeros)}`
							: rendered + "0".repeat(extraZeros);
					const parsed = parseMoneyInput(padded, {
						currency: money.currency,
						scale: money.scale,
					});
					expectSameMoney(parsed, money);
				},
			),
		);
	});

	it("non-zero excess fraction digits are rejected, never rounded", () => {
		fc.assert(
			fc.property(
				moneyArb,
				fc.integer({ min: 1, max: 9 }),
				(money, excessDigit) => {
					const rendered = moneyToDecimalString(money);
					const overPrecise =
						money.scale === 0
							? `${rendered}.${excessDigit}`
							: `${rendered}${excessDigit}`;
					expect(() =>
						parseMoneyInput(overPrecise, {
							currency: money.currency,
							scale: money.scale,
						}),
					).toThrow(MoneyPrecisionLossError);
				},
			),
		);
	});
});

describe("money properties: exact arithmetic laws", () => {
	it("subtract inverts add: (a + b) - b = a", () => {
		fc.assert(
			fc.property(sameUnitPairArb, ({ a, b }) => {
				expectSameMoney(subtractMoney(addMoney(a, b), b), a);
			}),
		);
	});

	it("add commutes: a + b = b + a", () => {
		fc.assert(
			fc.property(sameUnitPairArb, ({ a, b }) => {
				expectSameMoney(addMoney(a, b), addMoney(b, a));
			}),
		);
	});

	it("add associates: (a + b) + c = a + (b + c)", () => {
		fc.assert(
			fc.property(
				fc
					.tuple(amountArb, amountArb, amountArb, currencyArb, scaleArb)
					.map(([x, y, z, currency, scale]) => ({
						a: moneyOfMinor(x, currency, scale),
						b: moneyOfMinor(y, currency, scale),
						c: moneyOfMinor(z, currency, scale),
					})),
				({ a, b, c }) => {
					expectSameMoney(
						addMoney(addMoney(a, b), c),
						addMoney(a, addMoney(b, c)),
					);
				},
			),
		);
	});

	it("negation is an involution and yields the additive inverse", () => {
		fc.assert(
			fc.property(moneyArb, (money) => {
				expectSameMoney(negateMoney(negateMoney(money)), money);
				const sum = addMoney(money, negateMoney(money));
				expect(sum.amountMinor).toBe(0n);
			}),
		);
	});
});

describe("money properties: lossless rescaling", () => {
	it("rescaling up and back down is the identity", () => {
		fc.assert(
			fc.property(moneyArb, fc.integer({ min: 1, max: 8 }), (money, upBy) => {
				const up = rescaleMoney(money, money.scale + upBy);
				expectSameMoney(rescaleMoney(up, money.scale), money);
			}),
		);
	});

	it("an upscale preserves the rendered value up to trailing zeros", () => {
		fc.assert(
			fc.property(moneyArb, fc.integer({ min: 1, max: 8 }), (money, upBy) => {
				const up = rescaleMoney(money, money.scale + upBy);
				const rendered = moneyToDecimalString(money);
				const expected =
					money.scale === 0
						? `${rendered}.${"0".repeat(upBy)}`
						: rendered + "0".repeat(upBy);
				expect(moneyToDecimalString(up)).toBe(expected);
			}),
		);
	});

	it("a downscale that would drop non-zero digits throws instead of rounding", () => {
		fc.assert(
			fc.property(
				fc.tuple(
					amountArb,
					fc.bigInt({ min: 1n, max: 9n }),
					currencyArb,
					fc.integer({ min: 1, max: 12 }),
				),
				([body, lastDigit, currency, scale]) => {
					// Force a non-zero final digit so the downscale is lossy by
					// construction (sign lives on the body; the digit is appended
					// away from zero).
					const amount =
						body < 0n ? body * 10n - lastDigit : body * 10n + lastDigit;
					const money = moneyOfMinor(amount, currency, scale);
					expect(() => rescaleMoney(money, scale - 1)).toThrow(
						MoneyPrecisionLossError,
					);
				},
			),
		);
	});
});

describe("money properties: wire round-trips", () => {
	it("the DTO round-trips exactly, including through JSON", () => {
		fc.assert(
			fc.property(moneyArb, (money) => {
				expectSameMoney(moneyFromDto(moneyToDto(money)), money);
				expectSameMoney(
					moneyFromDto(JSON.parse(JSON.stringify(moneyToDto(money)))),
					money,
				);
			}),
		);
	});

	it("the snapshot round-trips exactly within its safe-integer domain, including through JSON", () => {
		// The snapshot bridge speaks `number` for calculation libraries,
		// so its documented domain is |amountMinor| <= MAX_SAFE_INTEGER;
		// the property pins the round-trip inside it and the loud guard
		// outside it.
		const safeAmountArb = fc.bigInt({
			min: -BigInt(Number.MAX_SAFE_INTEGER),
			max: BigInt(Number.MAX_SAFE_INTEGER),
		});
		const safeMoneyArb = fc
			.tuple(safeAmountArb, currencyArb, scaleArb)
			.map(([amount, currency, scale]) =>
				moneyOfMinor(amount, currency, scale),
			);
		fc.assert(
			fc.property(safeMoneyArb, (money) => {
				expectSameMoney(moneyFromSnapshot(moneyToSnapshot(money)), money);
				expectSameMoney(
					moneyFromSnapshot(JSON.parse(JSON.stringify(moneyToSnapshot(money)))),
					money,
				);
			}),
		);
	});

	it("amounts past the safe-integer domain are refused by the snapshot bridge, never silently degraded", () => {
		const unsafeAmountArb = fc
			.tuple(fc.bigInt({ min: 1n, max: 10n ** 28n }), fc.constantFrom(1n, -1n))
			.map(
				([excess, sign]) => sign * (BigInt(Number.MAX_SAFE_INTEGER) + excess),
			);
		fc.assert(
			fc.property(
				fc.tuple(unsafeAmountArb, currencyArb, scaleArb),
				([amount, currency, scale]) => {
					const money = moneyOfMinor(amount, currency, scale);
					expect(() => moneyToSnapshot(money)).toThrow(
						/MAX_SAFE_INTEGER|amountMinor/,
					);
				},
			),
		);
	});
});
