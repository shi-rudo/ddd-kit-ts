import { describeValue, InvalidMoneyError } from "./errors";

/**
 * Currency identifier for {@link Money}. The kit deliberately ships no
 * currency table: which codes exist and which scale they use is the
 * consumer's decision (see `createMoneyFactory` for wiring a resolver
 * once). ISO 4217 alpha-3 codes are the recommended convention.
 */
export type CurrencyCode = string;

/**
 * The canonical money representation for domain state, domain events,
 * and snapshots: an exact integer amount in minor units plus the
 * explicit scale that maps minor to major units.
 *
 * Plain data by design: values created by `moneyOfMinor` are frozen,
 * carry no methods or library internals, and survive `structuredClone`,
 * deep-freeze, and the kit's state diffing. The kit ships exact
 * operations only (lossless `addMoney`/`subtractMoney`/`negateMoney`
 * and lossless `rescaleMoney`); everything that carries a rounding or
 * distribution policy (multiplication, ratios, fees, division, lossy
 * rescaling, allocation, FX) is domain policy executed by your
 * calculation library at the use-case boundary (see
 * `moneyFromSnapshot` / `moneyToSnapshot`).
 *
 * Never `number`, never a decimal string, never `amountCents`: `10.99`
 * EUR is `{ amountMinor: 1099n, currency: "EUR", scale: 2 }`, and JPY
 * has scale 0, not an assumed 2.
 */
export interface Money {
	/**
	 * Exact integer amount in minor units AT THIS VALUE'S SCALE. The
	 * scale may deliberately differ from the currency's default
	 * exponent (intermediate precision; the snapshot interop honors
	 * the same distinction), so the reference unit is always
	 * `this.scale`, never an assumed per-currency constant.
	 */
	readonly amountMinor: bigint;
	/** Required currency identifier; operations never mix currencies. */
	readonly currency: CurrencyCode;
	/** Number of minor-unit digits per major unit (EUR 2, JPY 0). */
	readonly scale: number;
	/**
	 * Type-level brand: a NON-EXPORTED unique symbol, never present at
	 * runtime. A string key ("__brand") could be spelled out by any
	 * caller; the module-private symbol cannot, so only the module's
	 * constructors mint the type. Convert foreign plain shapes with
	 * `moneyFromUnknown` (validates, copies, freezes) or `moneyFromDto`.
	 */
	readonly [MONEY_BRAND]: true;
}

declare const MONEY_BRAND: unique symbol;

/**
 * Wire shape for {@link Money}: `amountMinor` travels as a string
 * because JSON numbers are floats (silent precision loss past 2^53) and
 * `JSON.stringify` throws on bigint. Validate with `moneyFromDto`
 * immediately after deserialization; emit with `moneyToDto` right
 * before serialization.
 */
export interface MoneyDto {
	/** Integer string matching `/^-?\d+$/`. */
	readonly amountMinor: string;
	readonly currency: string;
	readonly scale: number;
}

const INTEGER_STRING = /^-?\d+$/;

/**
 * Hard bounds, enforced at the single construction door so hostile
 * input cannot buy unbounded CPU (BigInt conversion is superlinear in
 * digit count) or memory (cache keys, padded strings, log echoes):
 *
 * - amounts: fewer than 97 digits (uint256 is 78 digits; headroom)
 * - scale: at most 64 (ETH wei is 18)
 * - currency: at most 32 characters (ISO 4217 needs 3)
 *
 * Everything past a bound is `INVALID_MONEY` by construction, and the
 * DTO/parse boundaries reject oversized strings before converting them.
 */
const MONEY_AMOUNT_LIMIT = 10n ** 96n;
const MAX_MONEY_SCALE = 64;
const MAX_CURRENCY_LENGTH = 32;
const MAX_DTO_AMOUNT_LENGTH = 97; // sign + 96 digits

function isValidAmount(amountMinor: unknown): amountMinor is bigint {
	return (
		typeof amountMinor === "bigint" &&
		amountMinor < MONEY_AMOUNT_LIMIT &&
		amountMinor > -MONEY_AMOUNT_LIMIT
	);
}

function isValidCurrency(currency: unknown): currency is string {
	return (
		typeof currency === "string" &&
		currency.length > 0 &&
		currency.length <= MAX_CURRENCY_LENGTH &&
		!/\s/.test(currency)
	);
}

/**
 * Scale guard for operations that must validate a TARGET scale before
 * computing with it (10^scale on an unchecked value is an attack
 * surface). Module-internal export, not part of the package entry.
 */
export function assertValidScale(scale: number): void {
	if (!isValidScale(scale)) {
		throw new InvalidMoneyError(
			`scale must be an integer between 0 and ${MAX_MONEY_SCALE}; got ${describeValue(scale)}`,
		);
	}
}

/**
 * Currency counterpart to {@link assertValidScale}, for call sites
 * that must reject a wiring-provided currency before any input work.
 * Module-internal export, not part of the package entry.
 */
export function assertValidCurrency(currency: unknown): void {
	if (!isValidCurrency(currency)) {
		throw new InvalidMoneyError(
			`currency must be a non-empty string without whitespace, at most ${MAX_CURRENCY_LENGTH} characters; got ${describeValue(currency)}`,
		);
	}
}

/**
 * Validates an unknown plain shape and mints a FRESH, frozen
 * {@link Money} from it: the result shares no reference with the
 * input, so later mutation of the input cannot reach domain state.
 * The door for re-hydrating foreign minor-units data (rows already
 * mapped by an ORM, caches, deserialized snapshots); wire strings go
 * through `moneyFromDto` instead.
 */
export function moneyFromUnknown(value: unknown): Money {
	assertMoney(value);
	return moneyOfMinor(value.amountMinor, value.currency, value.scale);
}

function isValidScale(scale: unknown): scale is number {
	return (
		typeof scale === "number" &&
		Number.isSafeInteger(scale) &&
		scale >= 0 &&
		scale <= MAX_MONEY_SCALE
	);
}

/**
 * Constructs a frozen {@link Money} from an exact minor-unit amount.
 * The only door into the shape: rejects `number` amounts (floats have
 * no place in stored money), invalid scales, and empty or
 * whitespace-carrying currency codes with `InvalidMoneyError`.
 */
export function moneyOfMinor(
	amountMinor: bigint,
	currency: CurrencyCode,
	scale: number,
): Money {
	if (typeof amountMinor !== "bigint") {
		throw new InvalidMoneyError(
			`amountMinor must be a bigint in minor units; got ${typeof amountMinor}`,
		);
	}
	if (!isValidAmount(amountMinor)) {
		throw new InvalidMoneyError(
			"amountMinor must stay below 97 digits (uint256 fits with headroom)",
		);
	}
	assertValidCurrency(currency);
	assertValidScale(scale);
	return Object.freeze({ amountMinor, currency, scale }) as Money;
}

/**
 * Validates a {@link MoneyDto} fresh off the wire and converts it to
 * {@link Money}. Takes `unknown` on purpose: this IS the trust
 * boundary, so callers never cast before validating. `amountMinor`
 * must be a plain integer string (`/^-?\d+$/`); anything `Number()`
 * would tolerate but bigint arithmetic cannot represent exactly
 * ("1e5", "10.99", "0x10") is rejected with `InvalidMoneyError`.
 */
export function moneyFromDto(dto: unknown): Money {
	if (dto === null || typeof dto !== "object") {
		throw new InvalidMoneyError(
			`MoneyDto must be an object; got ${dto === null ? "null" : typeof dto}`,
		);
	}
	const { amountMinor, currency, scale } = dto as Partial<
		Record<keyof MoneyDto, unknown>
	>;
	// The length ceiling runs BEFORE BigInt(): converting a hostile
	// multi-megabyte digit string is superlinear CPU.
	if (
		typeof amountMinor !== "string" ||
		amountMinor.length > MAX_DTO_AMOUNT_LENGTH ||
		!INTEGER_STRING.test(amountMinor)
	) {
		throw new InvalidMoneyError(
			`MoneyDto.amountMinor must be an integer string matching /^-?\\d+$/ with at most 96 digits; got ${describeValue(amountMinor)}`,
		);
	}
	// moneyOfMinor validates currency and scale.
	return moneyOfMinor(
		BigInt(amountMinor),
		currency as CurrencyCode,
		scale as number,
	);
}

/**
 * Converts {@link Money} to its JSON-safe wire shape. Guards the input
 * so untyped callers cannot leak a number-amount object onto the wire.
 */
export function moneyToDto(money: Money): MoneyDto {
	assertMoney(money);
	return {
		amountMinor: money.amountMinor.toString(),
		currency: money.currency,
		scale: money.scale,
	};
}

/**
 * Narrows an unknown value to the canonical {@link Money} shape. A
 * CHECK, not a door: narrowing neither copies nor freezes, so an
 * external alias can still mutate the underlying object after the
 * check. For anything entering domain state, mint a fresh frozen
 * value with {@link moneyFromUnknown} instead.
 */
export function isMoney(value: unknown): value is Money {
	if (value === null || typeof value !== "object") return false;
	const candidate = value as Partial<Money>;
	return (
		isValidAmount(candidate.amountMinor) &&
		isValidCurrency(candidate.currency) &&
		isValidScale(candidate.scale)
	);
}

/**
 * Loud form of {@link isMoney} for boundary functions. Module-internal
 * export, not part of the package entry.
 */
export function assertMoney(value: unknown): asserts value is Money {
	if (!isMoney(value)) {
		throw new InvalidMoneyError(
			"expected a Money value ({ amountMinor: bigint, currency: string, scale: number })",
		);
	}
}

/**
 * REPRESENTATION equality, deliberately: amount, currency, AND scale.
 * `10.0` EUR at scale 1 and `10.00` EUR at scale 2 denote the same
 * monetary value but are NOT equal here, because silently conflating
 * scales is how precision bugs hide. For monetary-value comparison,
 * align the scales explicitly first (lossless `rescaleMoney` upscales
 * the coarser side) and then compare.
 */
export function moneyEquals(a: Money, b: Money): boolean {
	return (
		a.amountMinor === b.amountMinor &&
		a.currency === b.currency &&
		a.scale === b.scale
	);
}

/** True when the amount is exactly zero. */
export function isZeroMoney(money: Money): boolean {
	return money.amountMinor === 0n;
}

/** True when the amount is strictly greater than zero. */
export function isPositiveMoney(money: Money): boolean {
	return money.amountMinor > 0n;
}

/** True when the amount is strictly less than zero. */
export function isNegativeMoney(money: Money): boolean {
	return money.amountMinor < 0n;
}

/**
 * Renders the exact decimal representation ("10.99", "-0.05", "10").
 * The inverse of `parseMoneyInput` and the precision-safe input for
 * display formatting; never feed the result back into arithmetic.
 * Guards its input like the wire emitters do: a non-Money value fails
 * loudly instead of rendering garbage.
 */
export function moneyToDecimalString(money: Money): string {
	assertMoney(money);
	const negative = money.amountMinor < 0n;
	const digits = (negative ? -money.amountMinor : money.amountMinor).toString();
	const sign = negative ? "-" : "";
	if (money.scale === 0) return sign + digits;
	const padded = digits.padStart(money.scale + 1, "0");
	const whole = padded.slice(0, -money.scale);
	const fraction = padded.slice(-money.scale);
	return `${sign}${whole}.${fraction}`;
}
