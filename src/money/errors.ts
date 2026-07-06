import { DomainError } from "../core/errors";

/**
 * Renders a value for a diagnostic message with a hard size ceiling:
 * error messages must never carry attacker-sized payloads into logs.
 * Total: never throws, whatever the value (JSON.stringify alone would
 * crash on bigint and circular input, replacing the documented kit
 * error with a raw TypeError). Module-internal, not part of the
 * package entry.
 */
export function describeValue(value: unknown): string {
	if (typeof value === "bigint") {
		const digits = value.toString();
		return digits.length > 48
			? `${digits.slice(0, 48)}... (truncated bigint)`
			: `${digits}n`;
	}
	if (typeof value === "string" && value.length > 48) {
		return `${JSON.stringify(value.slice(0, 48))} (truncated, ${value.length} chars)`;
	}
	let rendered: string | undefined;
	try {
		rendered = JSON.stringify(value);
	} catch {
		rendered = undefined;
	}
	if (rendered === undefined) {
		try {
			rendered = String(value);
		} catch {
			rendered = `[unserializable ${typeof value}]`;
		}
	}
	if (rendered.length > 64) {
		return `${rendered.slice(0, 64)} (truncated)`;
	}
	return rendered;
}

export class InvalidMoneyError extends DomainError<"INVALID_MONEY"> {
	constructor(message: string) {
		super({ code: "INVALID_MONEY", message });
	}
}

export class MoneyCurrencyMismatchError extends DomainError<"MONEY_CURRENCY_MISMATCH"> {
	constructor(left: string, right: string) {
		super({
			code: "MONEY_CURRENCY_MISMATCH",
			message: `money operations require the same currency; got ${describeValue(left)} and ${describeValue(right)}`,
		});
	}
}

export class MoneyScaleMismatchError extends DomainError<"MONEY_SCALE_MISMATCH"> {
	constructor(left: number, right: number) {
		super({
			code: "MONEY_SCALE_MISMATCH",
			message: `money operations require the same scale; got ${left} and ${right} (rescaleMoney is the explicit conversion)`,
		});
	}
}

export class MoneyPrecisionLossError extends DomainError<"MONEY_PRECISION_LOSS"> {
	constructor(message: string) {
		super({ code: "MONEY_PRECISION_LOSS", message });
	}
}

export class UnknownCurrencyError extends DomainError<"UNKNOWN_CURRENCY"> {
	constructor(currency: string) {
		super({
			code: "UNKNOWN_CURRENCY",
			message: `The currency scale resolver has no entry for ${describeValue(currency)}`,
		});
	}
}
