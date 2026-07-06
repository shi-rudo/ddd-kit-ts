import {
	describeValue,
	InvalidMoneyError,
	MoneyPrecisionLossError,
} from "./errors";
import {
	assertValidScale,
	type CurrencyCode,
	type Money,
	moneyOfMinor,
} from "./money";

/** Options for {@link parseMoneyInput}. */
export interface ParseMoneyInputOptions {
	readonly currency: CurrencyCode;
	/** Target scale; the kit ships no currency table, so it is explicit. */
	readonly scale: number;
}

const DECIMAL_INPUT = /^(-?)(\d+)(?:\.(\d+))?$/;

// Rejected before the regex and long before BigInt(): a hostile
// multi-megabyte "amount" must cost O(1), not superlinear conversion
// work. 96 amount digits + 64 fraction digits + sign + dot fit easily.
const MAX_INPUT_LENGTH = 256;

/**
 * Parses a plain decimal string ("10.99") into exact minor units,
 * without ever touching floating point. This is the safe replacement
 * for the classic bugs `Number(input) * 100` and `parseFloat`: no
 * exponents, no `Infinity`, no locale separators, and NO rounding; the
 * kit never rounds.
 *
 * EXACT OR REJECTED: missing fraction digits pad losslessly ("10.5" at
 * scale 2 is 1050n) and all-zero excess digits are accepted ("10.990"
 * at scale 2 is 1099n), but input that cannot be represented exactly
 * at the target scale throws `MONEY_PRECISION_LOSS`. Whether "10.999"
 * should be rejected or become 11.00 is a BUSINESS decision, not a
 * parsing feature: put it in a domain-named policy function (a
 * `normalizeQuotedPrice`, a `calculateVat`) that rounds via your
 * calculation library and returns `Money`.
 *
 * The grammar is deliberately strict (`/^-?\d+(\.\d+)?$/`). Locale
 * input ("10,99", grouping, currency signs) is a UI concern; normalize
 * it to this grammar before calling.
 *
 * Takes `unknown` on purpose: this is the trust boundary for raw
 * request values, so callers pass `req.body.amount` directly instead
 * of coercing (`String([...])` silently joins arrays) or casting.
 */
export function parseMoneyInput(
	input: unknown,
	options: ParseMoneyInputOptions,
): Money {
	const { currency, scale } = options;
	// Validated BEFORE padEnd/BigInt: an out-of-range scale (e.g. from
	// a buggy resolver) must fail fast as INVALID_MONEY, not buy
	// superlinear conversion work or a raw RangeError first.
	assertValidScale(scale);
	if (typeof input !== "string" || input.length > MAX_INPUT_LENGTH) {
		throw new InvalidMoneyError(
			`money input must be a decimal string of at most ${MAX_INPUT_LENGTH} characters; got ${describeValue(input)}`,
		);
	}
	const match = DECIMAL_INPUT.exec(input);
	if (!match) {
		throw new InvalidMoneyError(
			`money input must be a plain decimal string matching /^-?\\d+(\\.\\d+)?$/; got ${describeValue(input)}`,
		);
	}
	const sign = match[1] ?? "";
	const whole = match[2] ?? "";
	const fraction = match[3] ?? "";
	if (fraction.length <= scale) {
		return moneyOfMinor(
			BigInt(sign + whole + fraction.padEnd(scale, "0")),
			currency,
			scale,
		);
	}
	const excess = fraction.slice(scale);
	if (/^0+$/.test(excess)) {
		return moneyOfMinor(
			BigInt(sign + whole + fraction.slice(0, scale)),
			currency,
			scale,
		);
	}
	throw new MoneyPrecisionLossError(
		`parsing ${describeValue(input)} at scale ${scale} would lose precision; accepting over-precise input is a business decision, round it in a domain-named policy function via your calculation library`,
	);
}
