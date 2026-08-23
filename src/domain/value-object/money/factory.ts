import { UnknownCurrencyError } from "./errors";
import { type CurrencyCode, type Money, moneyOfMinor } from "./money";
import { parseMoneyInput } from "./parse";

/**
 * Resolves a currency to its scale, or `undefined` for currencies it
 * does not know. The kit ships no currency table; this is the seam
 * where the consumer provides one, once, at the composition root. Any
 * source works as a one-liner: a plain record, the runtime's own data
 * via {@link currencyScaleFromIntl}, or the currency package of a
 * calculation library (`(code) => currencies[code]?.exponent`).
 */
export type CurrencyScaleResolver = (
	currency: CurrencyCode,
) => number | undefined;

/**
 * Currency-aware construction helpers bound to one
 * {@link CurrencyScaleResolver}. Unknown currencies fail loudly with
 * `UNKNOWN_CURRENCY` instead of guessing a scale.
 */
export interface MoneyFactory {
	/** `moneyOfMinor` with the scale resolved from the currency. */
	ofMinor(amountMinor: bigint, currency: CurrencyCode): Money;
	/** `parseMoneyInput` (exact-only) with the scale resolved from the currency. */
	parse(input: unknown, currency: CurrencyCode): Money;
	/** Zero in the given currency at its resolved scale. */
	zero(currency: CurrencyCode): Money;
	/** The resolved scale; throws `UNKNOWN_CURRENCY` when unresolved. */
	scaleOf(currency: CurrencyCode): number;
}

/** Options for {@link createMoneyFactory}. */
export interface CreateMoneyFactoryOptions {
	readonly scaleFor: CurrencyScaleResolver;
}

/**
 * Binds a {@link CurrencyScaleResolver} once and returns construction
 * helpers that no longer need an explicit scale per call.
 *
 * @example
 * ```ts
 * const money = createMoneyFactory({
 *   scaleFor: currencyScaleFromRecord({ EUR: 2, JPY: 0 }),
 * });
 * money.parse("10.99", "EUR"); // { amountMinor: 1099n, currency: "EUR", scale: 2 }
 * ```
 */
export function createMoneyFactory(
	options: CreateMoneyFactoryOptions,
): MoneyFactory {
	const { scaleFor } = options;
	const scaleOf = (currency: CurrencyCode): number => {
		const scale = scaleFor(currency);
		if (scale === undefined) throw new UnknownCurrencyError(currency);
		return scale;
	};
	return Object.freeze({
		ofMinor: (amountMinor: bigint, currency: CurrencyCode) =>
			moneyOfMinor(amountMinor, currency, scaleOf(currency)),
		parse: (input: unknown, currency: CurrencyCode) =>
			parseMoneyInput(input, { currency, scale: scaleOf(currency) }),
		zero: (currency: CurrencyCode) =>
			moneyOfMinor(0n, currency, scaleOf(currency)),
		scaleOf,
	});
}

/**
 * Resolver over a plain currency-to-scale record
 * (`{ EUR: 2, JPY: 0 }`). The record is copied into a `Map` at
 * creation, so later mutation of the input and hostile own keys have
 * no effect.
 */
export function currencyScaleFromRecord(
	record: Readonly<Record<string, number>>,
): CurrencyScaleResolver {
	const scales = new Map(Object.entries(record));
	return (currency) => scales.get(currency);
}

const CANONICAL_ISO_CODE = /^[A-Z]{3}$/;

/**
 * Resolver backed by the runtime's own currency data (ICU via
 * `Intl.NumberFormat`), so no currency table ships with the kit or the
 * consumer. Resolves ONLY canonical uppercase ISO 4217 codes: Intl
 * itself would accept "eur", but a silent alias would let "eur"-Money
 * and "EUR"-Money circulate side by side until an operation throws
 * `MONEY_CURRENCY_MISMATCH`; here "eur" resolves to `undefined` and
 * fails fast as `UNKNOWN_CURRENCY` at the factory.
 *
 * A CONVENIENCE, not an enterprise source of truth: ICU resolves
 * well-formed but UNASSIGNED codes to its default of 2 rather than
 * `undefined`, and the data shifts with the runtime's ICU version.
 * Production money paths should pin a closed, versioned currency map
 * (`currencyScaleFromRecord`) or a calculation library's versioned
 * currency package; use this resolver for demos, prototypes, and
 * internal tooling.
 */
export function currencyScaleFromIntl(): CurrencyScaleResolver {
	const cache = new Map<string, number | undefined>();
	return (currency) => {
		if (typeof currency !== "string" || !CANONICAL_ISO_CODE.test(currency)) {
			return undefined;
		}
		if (cache.has(currency)) return cache.get(currency);
		let scale: number | undefined;
		try {
			scale = new Intl.NumberFormat("en", {
				style: "currency",
				currency,
			}).resolvedOptions().maximumFractionDigits;
		} catch {
			scale = undefined;
		}
		// Bounded: attacker-influenced currency strings must not turn
		// the cache into a leak. The legitimate key population is tiny;
		// past the cap, misses stay correct and simply pay Intl again.
		if (cache.size < CACHE_LIMIT) cache.set(currency, scale);
		return scale;
	};
}

const CACHE_LIMIT = 1_000;
