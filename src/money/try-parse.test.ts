import { partition } from "@shirudo/result";
import { describe, expect, it } from "vite-plus/test";
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

	it("throws on options misuse instead of counting every row as bad", () => {
		// A broken scale resolver or currency lookup is a bug in the
		// caller's WIRING, not a property of the row; wrapping it would
		// report the whole batch as bad input.
		expect(() =>
			tryParseMoneyInput("10.99", {
				currency: "EUR",
				// biome-ignore lint/suspicious/noExplicitAny: deliberate misuse
				scale: "2" as any,
			}),
		).toThrow(InvalidMoneyError);
		expect(() =>
			tryParseMoneyInput("10.99", { currency: "", scale: 2 }),
		).toThrow(InvalidMoneyError);
	});
});

describe("rethrow discipline: a bug is not a bad row", () => {
	// The parsers answer every malformed VALUE with a domain error, so
	// a foreign throw needs a hostile shape: a getter that explodes is
	// a bug in the caller's data pipeline and must not become Err. One
	// proof per wrapper, so no predicate can quietly broaden.
	it("tryParseMoneyInput lets a hostile options object keep throwing", () => {
		const options = {
			currency: "EUR",
			get scale(): number {
				throw new Error("hostile options getter");
			},
		};
		expect(() => tryParseMoneyInput("10.99", options)).toThrow(
			"hostile options getter",
		);
	});

	it("tryMoneyFromDto lets a hostile DTO keep throwing", () => {
		const hostile = {
			amountMinor: "1099",
			currency: "EUR",
			get scale(): number {
				throw new Error("hostile dto getter");
			},
		};
		expect(() => tryMoneyFromDto(hostile)).toThrow("hostile dto getter");
	});

	it("tryMoneyFromSnapshot lets a hostile snapshot keep throwing", () => {
		const hostile = {
			amount: 100,
			currency: "EUR",
			get scale(): number {
				throw new Error("hostile snapshot getter");
			},
		};
		expect(() => tryMoneyFromSnapshot(hostile)).toThrow(
			"hostile snapshot getter",
		);
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

		const [parsed, rejected] = partition(results);

		expect(parsed.map((m) => m.amountMinor)).toEqual([1099n, 350n]);
		expect(rejected).toHaveLength(2);
		expect(rejected[0]).toBeInstanceOf(InvalidMoneyError);
		expect(rejected[1]).toBeInstanceOf(MoneyPrecisionLossError);
	});
});
