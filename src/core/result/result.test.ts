import { describe, expect, it } from "vitest";
import {
    andThen,
    err,
    isErr,
    isOk,
    map,
    mapErr,
    match,
    matchAsync,
    ok,
    pipe,
    type Result,
    tryCatch,
    tryCatchAsync,
    unwrapOr,
    unwrapOrElse,
} from "./result";

describe("Result composition utilities", () => {
	describe("andThen", () => {
		it("should chain Ok results", () => {
			const result = ok(5);
			const chained = andThen(result, (value: number) => ok(value * 2));
			expect(isOk(chained)).toBe(true);
			if (isOk(chained)) {
				expect(chained.value).toBe(10);
			}
		});

		it("should return error if first result is Err", () => {
			const result = err("error");
			const chained = andThen(result, (_value: number) => ok(0));
			expect(isErr(chained)).toBe(true);
			if (isErr(chained)) {
				expect(chained.error).toBe("error");
			}
		});

		it("should return error if chained function returns Err", () => {
			const result = ok(5);
			const chained = andThen(result, () => err("chained error"));
			expect(isErr(chained)).toBe(true);
			if (isErr(chained)) {
				expect(chained.error).toBe("chained error");
			}
		});

		it("should chain multiple operations", () => {
			const result = ok(5);
			const chained = andThen(
				andThen(result, (value) => ok(value * 2)),
				(value) => ok(value + 3),
			);
			expect(isOk(chained)).toBe(true);
			if (isOk(chained)) {
				expect(chained.value).toBe(13);
			}
		});
	});

	describe("map", () => {
		it("should transform Ok value", () => {
			const result = ok(5);
			const mapped = map(result, (value: number) => value * 2);
			expect(isOk(mapped)).toBe(true);
			if (isOk(mapped)) {
				expect(mapped.value).toBe(10);
			}
		});

		it("should return error unchanged", () => {
			const result = err("error");
			const mapped = map(result, (_value: number) => 0);
			expect(isErr(mapped)).toBe(true);
			if (isErr(mapped)) {
				expect(mapped.error).toBe("error");
			}
		});

		it("should change value type", () => {
			const result = ok(5);
			const mapped = map(result, (value) => `value: ${value}`);
			expect(isOk(mapped)).toBe(true);
			if (isOk(mapped)) {
				expect(mapped.value).toBe("value: 5");
			}
		});
	});

	describe("mapErr", () => {
		it("should transform error value", () => {
			const result = err("error");
			const mapped = mapErr(result, (error) => `Error: ${error}`);
			expect(isErr(mapped)).toBe(true);
			if (isErr(mapped)) {
				expect(mapped.error).toBe("Error: error");
			}
		});

		it("should return Ok value unchanged", () => {
			const result = ok(5);
			const mapped = mapErr(result, (error) => `Error: ${error}`);
			expect(isOk(mapped)).toBe(true);
			if (isOk(mapped)) {
				expect(mapped.value).toBe(5);
			}
		});
	});

	describe("unwrapOr", () => {
		it("should return value if Ok", () => {
			const result = ok(5);
			const value = unwrapOr(result, 0);
			expect(value).toBe(5);
		});

		it("should return default if Err", () => {
			const result = err("error");
			const value = unwrapOr(result, 0);
			expect(value).toBe(0);
		});
	});

	describe("unwrapOrElse", () => {
		it("should return value if Ok", () => {
			const result = ok(5);
			const value = unwrapOrElse(result, () => 0);
			expect(value).toBe(5);
		});

		it("should compute default from error if Err", () => {
			const result = err("error");
			const value = unwrapOrElse(result, (error) => {
				expect(error).toBe("error");
				return 42;
			});
			expect(value).toBe(42);
		});
	});

	describe("match", () => {
		it("should apply onOk function for Ok result", () => {
			const result = ok(5);
			const value = match(
				result,
				(value) => `Success: ${value}`,
				(error) => `Error: ${error}`,
			);
			expect(value).toBe("Success: 5");
		});

		it("should apply onErr function for Err result", () => {
			const result = err("error");
			const value = match(
				result,
				(value) => `Success: ${value}`,
				(error) => `Error: ${error}`,
			);
			expect(value).toBe("Error: error");
		});

		it("should handle different return types", () => {
			const okResult = ok(5);
			const errResult = err("error");

			const okValue = match(okResult, (v: number) => v * 2, () => 0);
			const errValue = match(errResult, (v: number) => v * 2, () => 0);

			expect(okValue).toBe(10);
			expect(errValue).toBe(0);
		});

		it("should support object syntax", () => {
			const okResult = ok(5);
			const errResult = err("error");

			const okValue = match(okResult, {
				ok: (v: number) => `Success: ${v}`,
				err: () => "Error",
			});
			const errValue = match(errResult, {
				ok: () => "Success",
				err: (e) => `Error: ${e}`,
			});

			expect(okValue).toBe("Success: 5");
			expect(errValue).toBe("Error: error");
		});

		it("should handle different return types with object syntax", () => {
			const okResult = ok(5);
			const errResult = err("error");

			const okValue = match(okResult, {
				ok: (v: number) => v * 2,
				err: () => 0,
			});
			const errValue = match(errResult, {
				ok: () => 0,
				err: () => 0,
			});

			expect(okValue).toBe(10);
			expect(errValue).toBe(0);
		});
	});

	describe("matchAsync", () => {
		it("should apply async onOk function for Ok result", async () => {
			const result = ok(5);
			const value = await matchAsync(
				result,
				async (value) => `Success: ${value}`,
				async (error) => `Error: ${error}`,
			);
			expect(value).toBe("Success: 5");
		});

		it("should apply async onErr function for Err result", async () => {
			const result = err("error");
			const value = await matchAsync(
				result,
				async (value) => `Success: ${value}`,
				async (error) => `Error: ${error}`,
			);
			expect(value).toBe("Error: error");
		});

		it("should support object syntax", async () => {
			const okResult = ok(5);
			const errResult = err("error");

			const okValue = await matchAsync(okResult, {
				ok: async (v: number) => `Success: ${v}`,
				err: async () => "Error",
			});
			const errValue = await matchAsync(errResult, {
				ok: async () => "Success",
				err: async (e) => `Error: ${e}`,
			});

			expect(okValue).toBe("Success: 5");
			expect(errValue).toBe("Error: error");
		});

		it("should handle async operations", async () => {
			const result = ok(5);
			const value = await matchAsync(
				result,
				async (value) => {
					await new Promise((resolve) => setTimeout(resolve, 10));
					return value * 2;
				},
				async () => 0,
			);
			expect(value).toBe(10);
		});
	});

	describe("pipe", () => {
		it("should pipe through multiple operations", () => {
			const result = pipe(
				ok(5),
				(prev: Result<number, never>) => andThen(prev, (v: number) => ok(v * 2)),
				(prev: Result<number, never>) => andThen(prev, (v: number) => ok(v + 3)),
			);
			expect(isOk(result)).toBe(true);
			if (isOk(result)) {
				expect(result.value).toBe(13);
			}
		});

		it("should stop on first error", () => {
			const result = pipe(
				ok(5),
				(prev) => andThen(prev, () => err("first error")),
				(prev) => andThen(prev, (v: number) => ok(v + 3)), // Should not be called
			);
			expect(isErr(result)).toBe(true);
			if (isErr(result)) {
				expect(result.error).toBe("first error");
			}
		});

		it("should work with void results", () => {
			const result = pipe(
				ok(undefined),
				() => ok(undefined),
				() => ok(undefined),
			);
			expect(isOk(result)).toBe(true);
		});

		it("should handle multiple validation operations", () => {
			function validateId(id: string): Result<string, string> {
				return id.length > 0 ? ok(id) : err("ID cannot be empty");
			}

			function validateEmail(email: string): Result<string, string> {
				return email.includes("@") ? ok(email) : err("Invalid email");
			}

			const result = pipe(
				validateId("user-123"),
				() => validateEmail("test@example.com"),
			);

			expect(isOk(result)).toBe(true);
			if (isOk(result)) {
				expect(result.value).toBe("test@example.com");
			}
		});

		it("should stop on first validation error", () => {
			function validateId(id: string): Result<string, string> {
				return id.length > 0 ? ok(id) : err("ID cannot be empty");
			}

			function validateEmail(email: string): Result<string, string> {
				return email.includes("@") ? ok(email) : err("Invalid email");
			}

			const result = pipe(
				validateId(""), // This will fail
				(prev) => {
					// This should not be called if prev is an error
					if (!prev.ok) {
						return prev;
					}
					return validateEmail("test@example.com");
				},
			);

			expect(isErr(result)).toBe(true);
			if (isErr(result)) {
				expect(result.error).toBe("ID cannot be empty");
			}
		});

		it("should handle up to 10 items in pipe", () => {
			const result = pipe(
				ok(1),
				(prev) => andThen(prev, (v) => ok(v + 1)),
				(prev) => andThen(prev, (v) => ok(v + 1)),
				(prev) => andThen(prev, (v) => ok(v + 1)),
				(prev) => andThen(prev, (v) => ok(v + 1)),
				(prev) => andThen(prev, (v) => ok(v + 1)),
				(prev) => andThen(prev, (v) => ok(v + 1)),
				(prev) => andThen(prev, (v) => ok(v + 1)),
				(prev) => andThen(prev, (v) => ok(v + 1)),
				(prev) => andThen(prev, (v) => ok(v + 1)),
				(prev) => andThen(prev, (v) => ok(v + 1)),
			);

			expect(isOk(result)).toBe(true);
			if (isOk(result)) {
				expect(result.value).toBe(11); // 1 + 10 operations
			}
		});

		it("should stop at error in middle of 10-item pipe", () => {
			const result = pipe(
				ok(1),
				(prev) => andThen(prev, (v) => ok(v + 1)),
				(prev) => andThen(prev, (v) => ok(v + 1)),
				(prev) => andThen(prev, () => err("error at step 4")),
				(prev) => andThen(prev, (v) => ok(v + 1)), // Should not be called
				(prev) => andThen(prev, (v) => ok(v + 1)), // Should not be called
				(prev) => andThen(prev, (v) => ok(v + 1)), // Should not be called
				(prev) => andThen(prev, (v) => ok(v + 1)), // Should not be called
				(prev) => andThen(prev, (v) => ok(v + 1)), // Should not be called
				(prev) => andThen(prev, (v) => ok(v + 1)), // Should not be called
			);

			expect(isErr(result)).toBe(true);
			if (isErr(result)) {
				expect(result.error).toBe("error at step 4");
			}
		});
	});

	describe("composition examples", () => {
		it("should chain validation operations", () => {
			function validateId(id: string): Result<string, string> {
				return id.length > 0 ? ok(id) : err("ID cannot be empty");
			}

			function validateEmail(email: string): Result<string, string> {
				return email.includes("@") ? ok(email) : err("Invalid email");
			}

			const result = andThen(validateId("user-123"), (userId) =>
				map(validateEmail("test@example.com"), (email) => ({
					id: userId,
					email,
				})),
			);

			expect(isOk(result)).toBe(true);
			if (isOk(result)) {
				expect(result.value.id).toBe("user-123");
				expect(result.value.email).toBe("test@example.com");
			}
		});

		it("should stop on first error", () => {
			function validateId(id: string): Result<string, string> {
				return id.length > 0 ? ok(id) : err("ID cannot be empty");
			}

			function validateEmail(email: string): Result<string, string> {
				return email.includes("@") ? ok(email) : err("Invalid email");
			}

			const result = andThen(validateId(""), (userId) =>
				map(validateEmail("test@example.com"), (email) => ({
					id: userId,
					email,
				})),
			);

			expect(isErr(result)).toBe(true);
			if (isErr(result)) {
				expect(result.error).toBe("ID cannot be empty");
			}
		});
	});

	describe("tryCatch", () => {
		it("should return Ok when function succeeds", () => {
			const result = tryCatch(() => "success");
			expect(isOk(result)).toBe(true);
			if (isOk(result)) {
				expect(result.value).toBe("success");
			}
		});

		it("should return Err when function throws Error", () => {
			const error = new Error("Something went wrong");
			const result = tryCatch(() => {
				throw error;
			});
			expect(isErr(result)).toBe(true);
			if (isErr(result)) {
				expect(result.error).toBe(error);
			}
		});

		it("should return Err when function throws non-Error", () => {
			const result = tryCatch(() => {
				throw "string error";
			});
			expect(isErr(result)).toBe(true);
			if (isErr(result)) {
				expect(result.error).toBeInstanceOf(Error);
				expect(result.error.message).toBe("string error");
			}
		});

		it("should use error mapper when provided", () => {
			const result = tryCatch(
				() => {
					throw "original error";
				},
				(error) => `Mapped: ${String(error)}`,
			);
			expect(isErr(result)).toBe(true);
			if (isErr(result)) {
				expect(result.error).toBe("Mapped: original error");
			}
		});

		it("should preserve Error instance when error mapper not provided", () => {
			const customError = new Error("Custom error");
			const result = tryCatch(() => {
				throw customError;
			});
			expect(isErr(result)).toBe(true);
			if (isErr(result)) {
				expect(result.error).toBe(customError);
			}
		});

		it("should work with functions returning different types", () => {
			const numberResult = tryCatch(() => 42);
			expect(isOk(numberResult)).toBe(true);
			if (isOk(numberResult)) {
				expect(numberResult.value).toBe(42);
			}

			const objectResult = tryCatch(() => ({ key: "value" }));
			expect(isOk(objectResult)).toBe(true);
			if (isOk(objectResult)) {
				expect(objectResult.value).toEqual({ key: "value" });
			}
		});
	});

	describe("tryCatchAsync", () => {
		it("should return Ok when async function succeeds", async () => {
			const result = await tryCatchAsync(async () => "success");
			expect(isOk(result)).toBe(true);
			if (isOk(result)) {
				expect(result.value).toBe("success");
			}
		});

		it("should return Err when async function throws Error", async () => {
			const error = new Error("Something went wrong");
			const result = await tryCatchAsync(async () => {
				throw error;
			});
			expect(isErr(result)).toBe(true);
			if (isErr(result)) {
				expect(result.error).toBe(error);
			}
		});

		it("should return Err when async function throws non-Error", async () => {
			const result = await tryCatchAsync(async () => {
				throw "string error";
			});
			expect(isErr(result)).toBe(true);
			if (isErr(result)) {
				expect(result.error).toBeInstanceOf(Error);
				expect(result.error.message).toBe("string error");
			}
		});

		it("should use error mapper when provided", async () => {
			const result = await tryCatchAsync(
				async () => {
					throw "original error";
				},
				(error) => `Mapped: ${String(error)}`,
			);
			expect(isErr(result)).toBe(true);
			if (isErr(result)) {
				expect(result.error).toBe("Mapped: original error");
			}
		});

		it("should handle Promise rejections", async () => {
			const error = new Error("Promise rejected");
			const result = await tryCatchAsync(async () => {
				return Promise.reject(error);
			});
			expect(isErr(result)).toBe(true);
			if (isErr(result)) {
				expect(result.error).toBe(error);
			}
		});

		it("should work with async functions returning different types", async () => {
			const numberResult = await tryCatchAsync(async () => 42);
			expect(isOk(numberResult)).toBe(true);
			if (isOk(numberResult)) {
				expect(numberResult.value).toBe(42);
			}

			const objectResult = await tryCatchAsync(async () => ({ key: "value" }));
			expect(isOk(objectResult)).toBe(true);
			if (isOk(objectResult)) {
				expect(objectResult.value).toEqual({ key: "value" });
			}
		});
	});
});

