import { describe, expect, it } from "vitest";
import { InvalidMoneyError, MoneyPrecisionLossError } from "./errors";
import { moneyOfMinor, moneyToDto } from "./money";
import { moneyToSnapshot } from "./snapshot";
import {
	tryMoneyFromDto,
	tryMoneyFromSnapshot,
	tryParseMoneyInput,
} from "./try-parse";

describe("tryParseMoneyInput", () => {
	it("returns Ok with the parsed money on valid input", () => {
		const result = tryParseMoneyInput("10.99", { currency: "EUR", scale: 2 });
		expect(result.isOk()).toBe(true);
		if (result.isOk()) {
			expect(result.value.amountMinor).toBe(1099n);
			expect(result.value.currency).toBe("EUR");
			expect(result.value.scale).toBe(2);
		}
	});

	it("returns Err(InvalidMoneyError) for malformed input", () => {
		const result = tryParseMoneyInput("10,99", { currency: "EUR", scale: 2 });
		expect(result.isErr()).toBe(true);
		if (result.isErr()) {
			expect(result.error).toBeInstanceOf(InvalidMoneyError);
		}
	});

	it("returns Err(MoneyPrecisionLossError) for over-precise input", () => {
		const result = tryParseMoneyInput("10.999", { currency: "EUR", scale: 2 });
		expect(result.isErr()).toBe(true);
		if (result.isErr()) {
			expect(result.error).toBeInstanceOf(MoneyPrecisionLossError);
		}
	});

	it("wraps even wiring misuse, because the parsers are total: every documented rejection is a domain error", () => {
		// An invalid options scale is answered with InvalidMoneyError by
		// the parser itself, so it lands in Err like any bad input.
		const result = tryParseMoneyInput("10.99", {
			currency: "EUR",
			// biome-ignore lint/suspicious/noExplicitAny: deliberate misuse
			scale: "2" as any,
		});
		expect(result.isErr() && result.error).toBeInstanceOf(InvalidMoneyError);
	});

	it("lets non-domain failures keep throwing: a bug is not a bad row", () => {
		// The parsers themselves are total, so a foreign throw needs a
		// hostile input shape: a getter that explodes is a bug in the
		// CALLER's data pipeline and must not be laundered into Err.
		const hostile = {
			amountMinor: "1099",
			currency: "EUR",
			get scale(): number {
				throw new Error("hostile getter");
			},
		};
		expect(() => tryMoneyFromDto(hostile)).toThrow("hostile getter");
	});
});

describe("tryMoneyFromDto", () => {
	it("round-trips a DTO as Ok", () => {
		const money = moneyOfMinor(1099n, "EUR", 2);
		const result = tryMoneyFromDto(moneyToDto(money));
		expect(result.isOk() && result.value.amountMinor === 1099n).toBe(true);
	});

	it("returns Err(InvalidMoneyError) for malformed DTOs", () => {
		for (const bad of [
			null,
			5,
			{ amountMinor: 1099, currency: "EUR", scale: 2 },
		]) {
			const result = tryMoneyFromDto(bad);
			expect(result.isErr()).toBe(true);
			if (result.isErr()) {
				expect(result.error).toBeInstanceOf(InvalidMoneyError);
			}
		}
	});
});

describe("tryMoneyFromSnapshot", () => {
	it("round-trips a snapshot as Ok", () => {
		const money = moneyOfMinor(1099n, "EUR", 2);
		const result = tryMoneyFromSnapshot(moneyToSnapshot(money));
		expect(result.isOk() && result.value.amountMinor === 1099n).toBe(true);
	});

	it("returns Err(InvalidMoneyError) for malformed snapshots", () => {
		for (const bad of [null, { amount: 1, currency: { code: "EUR" } }]) {
			const result = tryMoneyFromSnapshot(bad);
			expect(result.isErr()).toBe(true);
			if (result.isErr()) {
				expect(result.error).toBeInstanceOf(InvalidMoneyError);
			}
		}
	});
});

describe("batch usage shape", () => {
	it("partitions a batch into parsed rows and rejects without a try/catch in sight", () => {
		const rows = ["10.99", "not-money", "3.50", "1.999"];
		const results = rows.map((row) =>
			tryParseMoneyInput(row, { currency: "EUR", scale: 2 }),
		);

		const parsed = results.filter((r) => r.isOk()).map((r) => r.value);
		const rejected = results.filter((r) => r.isErr()).map((r) => r.error);

		expect(parsed.map((m) => m.amountMinor)).toEqual([1099n, 350n]);
		expect(rejected).toHaveLength(2);
		expect(rejected[0]).toBeInstanceOf(InvalidMoneyError);
		expect(rejected[1]).toBeInstanceOf(MoneyPrecisionLossError);
	});
});
