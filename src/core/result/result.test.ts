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
	type Result,
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
});

