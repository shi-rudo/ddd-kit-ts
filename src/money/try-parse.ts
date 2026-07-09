import { err, ok, type Result } from "@shirudo/result";
import { InvalidMoneyError, MoneyPrecisionLossError } from "./errors";
import { type Money, moneyFromDto } from "./money";
import { type ParseMoneyInputOptions, parseMoneyInput } from "./parse";
import { moneyFromSnapshot } from "./snapshot";

/**
 * Result-returning counterparts to the three money boundary parsers,
 * for call sites that process many candidate values in one pass: a
 * CSV import, a batch migration, a message replay. Per-row try/catch
 * reads badly and, hand-rolled, usually catches too much; these
 * wrappers apply the `result-vs-throw` guide's discipline instead.
 *
 * The contract, mirroring `voValidated`: only the parser's DOCUMENTED
 * domain rejections become `Err`. Anything else, an assertion firing,
 * a typo-ed helper, a genuine bug, keeps propagating as a throw,
 * because a bug wrapped in `Err` is a bug silently counted as a bad
 * input row. The `Err` types are exact per parser: the wire parsers
 * reject only with `InvalidMoneyError`, while decimal-string parsing
 * can additionally refuse over-precise input with
 * `MoneyPrecisionLossError`.
 *
 * `Result`, `ok`, and `err` come from `@shirudo/result` (already a
 * peer dependency); import them from there to work with the branches.
 */

function tryCatching<T, E extends Error>(
	parse: () => T,
	isExpected: (error: unknown) => error is E,
): Result<T, E> {
	try {
		return ok(parse());
	} catch (error) {
		if (isExpected(error)) return err(error);
		throw error;
	}
}

/**
 * {@link parseMoneyInput} as a `Result`: `Err` for the documented
 * rejections (malformed input as `InvalidMoneyError`, over-precise
 * input as `MoneyPrecisionLossError`), a throw for everything else.
 */
export function tryParseMoneyInput(
	input: unknown,
	options: ParseMoneyInputOptions,
): Result<Money, InvalidMoneyError | MoneyPrecisionLossError> {
	return tryCatching(
		() => parseMoneyInput(input, options),
		(error): error is InvalidMoneyError | MoneyPrecisionLossError =>
			error instanceof InvalidMoneyError ||
			error instanceof MoneyPrecisionLossError,
	);
}

/**
 * {@link moneyFromDto} as a `Result`: `Err` for the documented
 * rejection (`InvalidMoneyError`), a throw for everything else.
 */
export function tryMoneyFromDto(
	dto: unknown,
): Result<Money, InvalidMoneyError> {
	return tryCatching(
		() => moneyFromDto(dto),
		(error): error is InvalidMoneyError => error instanceof InvalidMoneyError,
	);
}

/**
 * {@link moneyFromSnapshot} as a `Result`: `Err` for the documented
 * rejection (`InvalidMoneyError`), a throw for everything else.
 */
export function tryMoneyFromSnapshot(
	snapshot: unknown,
): Result<Money, InvalidMoneyError> {
	return tryCatching(
		() => moneyFromSnapshot(snapshot),
		(error): error is InvalidMoneyError => error instanceof InvalidMoneyError,
	);
}
