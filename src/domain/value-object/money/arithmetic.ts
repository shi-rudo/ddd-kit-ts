import {
	MoneyCurrencyMismatchError,
	MoneyPrecisionLossError,
	MoneyScaleMismatchError,
} from "./errors";
import { assertValidScale, type Money, moneyOfMinor } from "./money";

/**
 * Exact operations only. Everything here is closed (Money in, Money
 * out) and cannot lose information, so no rounding decision exists to
 * make. Anything that WOULD need one (multiplication, ratios, fees,
 * division, lossy rescaling) plus everything distributive (allocation:
 * splitting 10.00 EUR three ways must hand out 3.34 + 3.33 + 3.33, not
 * round three times) and rate-based (FX) is deliberately NOT
 * implemented by the kit: rounding timing, order, and remainder policy
 * are domain policy, and a battle-tested calculation library should
 * execute them at the use-case boundary (see the snapshot bridge). The
 * kit NEVER rounds; even over-precise parse input is rejected instead
 * of rounded.
 */
function assertSameUnit(a: Money, b: Money): void {
	if (a.currency !== b.currency) {
		throw new MoneyCurrencyMismatchError(a.currency, b.currency);
	}
	if (a.scale !== b.scale) {
		throw new MoneyScaleMismatchError(a.scale, b.scale);
	}
}

/**
 * Exact addition of same-currency, same-scale amounts. Mismatches
 * throw (`MONEY_CURRENCY_MISMATCH` / `MONEY_SCALE_MISMATCH`); there is
 * no implicit conversion of either. A result past the amount bound
 * fails as `INVALID_MONEY` instead of wrapping.
 */
export function addMoney(a: Money, b: Money): Money {
	assertSameUnit(a, b);
	return moneyOfMinor(a.amountMinor + b.amountMinor, a.currency, a.scale);
}

/** Exact subtraction under the same guards as {@link addMoney}. */
export function subtractMoney(a: Money, b: Money): Money {
	assertSameUnit(a, b);
	return moneyOfMinor(a.amountMinor - b.amountMinor, a.currency, a.scale);
}

/** Exact sign flip; useful for ledger reversals and refunds. */
export function negateMoney(money: Money): Money {
	return moneyOfMinor(-money.amountMinor, money.currency, money.scale);
}

/**
 * Converts to another scale, LOSSLESSLY or not at all: upscaling and
 * exact downscaling succeed; a downscale that would drop non-zero
 * digits throws `MONEY_PRECISION_LOSS`. There is deliberately no
 * rounding parameter; lossy conversions carry a rounding policy and
 * belong to your calculation library. The intended use is aligning
 * mixed-scale amounts for `addMoney`/`subtractMoney` by upscaling the
 * coarser one.
 */
export function rescaleMoney(money: Money, scale: number): Money {
	// Validated BEFORE 10^(scale diff): an unchecked target scale is
	// an amplification vector.
	assertValidScale(scale);
	if (scale === money.scale) return money;
	if (scale > money.scale) {
		return moneyOfMinor(
			money.amountMinor * 10n ** BigInt(scale - money.scale),
			money.currency,
			scale,
		);
	}
	const factor = 10n ** BigInt(money.scale - scale);
	if (money.amountMinor % factor !== 0n) {
		throw new MoneyPrecisionLossError(
			`rescaling from scale ${money.scale} to ${scale} loses precision; lossy conversions belong to your calculation library, where the rounding policy is explicit`,
		);
	}
	return moneyOfMinor(money.amountMinor / factor, money.currency, scale);
}
