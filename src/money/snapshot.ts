import { describeValue, InvalidMoneyError } from "./errors";
import {
	assertMoney,
	type CurrencyCode,
	type Money,
	moneyOfMinor,
} from "./money";

/**
 * The currency part of {@link MoneySnapshotLike}: either a bare code or
 * a currency object as calculation libraries model it (code, numeric
 * base, exponent). Structural on purpose; the kit depends on no
 * calculation library.
 */
export type MoneySnapshotCurrencyLike =
	| string
	| {
			readonly code: string;
			readonly base?: number | bigint | ReadonlyArray<number | bigint>;
			readonly exponent?: number | bigint;
	  };

/**
 * The `{ amount, currency, scale }` shape that calculation libraries
 * expose when serializing their money objects (a `toJSON()` result,
 * typically). `scale` falls back to the currency's `exponent` when
 * absent; number and bigint calculators are both accepted.
 */
export interface MoneySnapshotLike {
	readonly amount: number | bigint;
	readonly currency: MoneySnapshotCurrencyLike;
	readonly scale?: number | bigint;
}

/**
 * The canonical snapshot {@link moneyToSnapshot} emits: number-based
 * with an explicit base-10 currency object, which is exactly what the
 * common calculation-library constructors accept.
 */
export interface MoneySnapshot {
	readonly amount: number;
	readonly currency: {
		readonly code: CurrencyCode;
		readonly base: 10;
		readonly exponent: number;
	};
	readonly scale: number;
}

function toScaleNumber(value: unknown, what: string): number {
	const scale = typeof value === "bigint" ? Number(value) : value;
	if (typeof scale !== "number" || !Number.isSafeInteger(scale)) {
		throw new InvalidMoneyError(
			`snapshot ${what} must be an integer; got ${describeValue(value)}`,
		);
	}
	return scale;
}

/**
 * Converts a calculation-library snapshot into canonical {@link Money}.
 * The anti-corruption checks live here so they run exactly once, at
 * the boundary:
 *
 * - non-decimal currencies are rejected (`base` other than 10; some
 *   library currency packages model MGA/MRU with base 5, and pre-1971
 *   GBP with a base array): their minor units do not map onto a
 *   power-of-ten scale
 * - number amounts must be safe integers; fractional or beyond-2^53
 *   amounts are rejected instead of silently corrupted
 * - bigint amounts pass through exactly
 *
 * Takes `unknown` on purpose: this is the trust boundary for foreign
 * library data, so callers never cast before validating (the
 * {@link MoneySnapshotLike} type documents the expected shape).
 */
export function moneyFromSnapshot(snapshot: unknown): Money {
	if (snapshot === null || typeof snapshot !== "object") {
		throw new InvalidMoneyError(
			`money snapshot must be an object; got ${snapshot === null ? "null" : typeof snapshot}`,
		);
	}
	const { amount, currency, scale } = snapshot as Partial<
		Record<keyof MoneySnapshotLike, unknown>
	>;
	const currencyObject = (
		typeof currency === "string" ? { code: currency } : currency
	) as
		| Partial<Record<"code" | "base" | "exponent", unknown>>
		| null
		| undefined;
	if (currencyObject === null || typeof currencyObject !== "object") {
		throw new InvalidMoneyError(
			`snapshot currency must be a code or a currency object; got ${typeof currency}`,
		);
	}
	const { base } = currencyObject;
	if (base !== undefined && base !== 10 && base !== 10n) {
		throw new InvalidMoneyError(
			`only base-10 currencies map onto Money; got base ${describeValue(base)} for ${describeValue(currencyObject.code)}`,
		);
	}
	const scaleSource = scale ?? currencyObject.exponent;
	if (scaleSource === undefined) {
		throw new InvalidMoneyError(
			"money snapshot carries neither a scale nor a currency exponent",
		);
	}
	// moneyOfMinor validates the currency code.
	return moneyOfMinor(
		toBigIntAmount(amount),
		currencyObject.code as CurrencyCode,
		toScaleNumber(scaleSource, "scale"),
	);
}

function toBigIntAmount(amount: unknown): bigint {
	if (typeof amount === "bigint") return amount;
	if (typeof amount === "number" && Number.isSafeInteger(amount)) {
		return BigInt(amount);
	}
	throw new InvalidMoneyError(
		`snapshot amount must be a bigint or a safe integer; got ${describeValue(amount)}`,
	);
}

/**
 * Converts {@link Money} into the snapshot shape the common
 * calculation-library constructors accept. Number-based by design (the
 * libraries' default calculators are), so amounts past
 * `Number.MAX_SAFE_INTEGER` are rejected loudly; wire such amounts
 * into a bigint calculator directly from `money.amountMinor` instead.
 */
export function moneyToSnapshot(money: Money): MoneySnapshot {
	assertMoney(money);
	const amount = Number(money.amountMinor);
	if (!Number.isSafeInteger(amount)) {
		throw new InvalidMoneyError(
			`amountMinor ${money.amountMinor} exceeds Number.MAX_SAFE_INTEGER; use your library's bigint calculator and pass amountMinor directly`,
		);
	}
	return {
		amount,
		currency: { code: money.currency, base: 10, exponent: money.scale },
		scale: money.scale,
	};
}
