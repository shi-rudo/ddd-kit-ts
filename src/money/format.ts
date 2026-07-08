import { assertMoney, type Money, moneyToDecimalString } from "./money";

// Bounded like the resolver cache: attacker-influenced currency/scale
// pairs (any well-formed code formats) must not leak memory. Past the
// cap, formatting stays correct and pays construction again.
const CACHE_LIMIT = 1_000;

function formatterFor(
	locale: string,
	currency: string,
	scale: number,
): Intl.NumberFormat {
	return new Intl.NumberFormat(locale, {
		style: "currency",
		currency,
		minimumFractionDigits: scale,
		maximumFractionDigits: scale,
	});
}

function formatDecimal(formatter: Intl.NumberFormat, money: Money): string {
	// Intl accepts decimal strings since NumberFormat v3; the cast only
	// bridges TS lib types that predate it. A number round-trip instead
	// would silently lose precision past 2^53.
	return formatter.format(moneyToDecimalString(money) as unknown as number);
}

/**
 * Formats for display via `Intl.NumberFormat`, feeding the exact
 * decimal string (never a float), with the money's own scale as the
 * fraction-digit count. Presentation only: the output is
 * locale-dependent text and must never flow back into parsing,
 * storage, or arithmetic. Non-Money input fails loudly with
 * `INVALID_MONEY` before Intl is touched.
 *
 * The currency must be well-formed for `Intl` (ISO alpha-3); for
 * non-ISO codes, format `moneyToDecimalString(money)` yourself.
 */
export function formatMoney(money: Money, locale: string): string {
	assertMoney(money);
	return formatDecimal(
		formatterFor(locale, money.currency, money.scale),
		money,
	);
}

/**
 * Binds the locale once and caches one `Intl.NumberFormat` per
 * currency/scale pair; constructing formatters is expensive, so use
 * this over `formatMoney` anywhere hot (lists, tables, exports).
 */
export function createMoneyFormatter(locale: string): (money: Money) => string {
	const formatters = new Map<string, Intl.NumberFormat>();
	return (money) => {
		assertMoney(money);
		const key = `${money.currency}@${money.scale}`;
		let formatter = formatters.get(key);
		if (!formatter) {
			formatter = formatterFor(locale, money.currency, money.scale);
			if (formatters.size < CACHE_LIMIT) formatters.set(key, formatter);
		}
		return formatDecimal(formatter, money);
	};
}
