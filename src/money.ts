// Money contract & boundary helpers. Opt-in entry point
// (`@shirudo/ddd-kit/money`) so the core kit stays money-free. The kit
// ships EXACT operations only: the canonical plain-data shape for
// aggregate state, events, and snapshots (bigint minor units, frozen,
// clone-safe), lossless add/subtract/negate/rescale (mismatch-guarded,
// so domain code needs no third-party import), the JSON-safe DTO
// discipline, exact decimal-string parsing (the safe replacement for
// `Number(input) * 100`; exact or rejected, the kit NEVER rounds), the
// structural snapshot bridge to whatever
// calculation library the consumer uses, the once-wired currency-scale
// seam, and Intl display formatting that never converts to a float.
// Everything that carries a rounding or distribution policy
// (multiplication, ratios, fees, division, lossy rescaling,
// allocation, FX) is deliberately the calculation library's job at the
// use-case boundary; the domain names the policy, the library executes
// it.
export {
	addMoney,
	negateMoney,
	rescaleMoney,
	subtractMoney,
} from "./domain/value-object/money/arithmetic";
export {
	InvalidMoneyError,
	MoneyCurrencyMismatchError,
	MoneyPrecisionLossError,
	MoneyScaleMismatchError,
	UnknownCurrencyError,
} from "./domain/value-object/money/errors";
export {
	type CreateMoneyFactoryOptions,
	type CurrencyScaleResolver,
	createMoneyFactory,
	currencyScaleFromIntl,
	currencyScaleFromRecord,
	type MoneyFactory,
} from "./domain/value-object/money/factory";
export {
	createMoneyFormatter,
	formatMoney,
} from "./domain/value-object/money/format";
export {
	type CurrencyCode,
	isMoney,
	isNegativeMoney,
	isPositiveMoney,
	isZeroMoney,
	type Money,
	type MoneyDto,
	moneyEquals,
	moneyFromDto,
	moneyFromUnknown,
	moneyOfMinor,
	moneyToDecimalString,
	moneyToDto,
} from "./domain/value-object/money/money";
export {
	type ParseMoneyInputOptions,
	parseMoneyInput,
} from "./domain/value-object/money/parse";
export {
	type MoneySnapshot,
	type MoneySnapshotCurrencyLike,
	type MoneySnapshotLike,
	moneyFromSnapshot,
	moneyToSnapshot,
} from "./domain/value-object/money/snapshot";
export {
	tryMoneyFromDto,
	tryMoneyFromSnapshot,
	tryParseMoneyInput,
} from "./domain/value-object/money/try-parse";
