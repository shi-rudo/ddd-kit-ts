import { describe, expect, it } from "vitest";
import { Err, Ok, Outcome, Success } from "./outcome";
import { err, ok } from "./result";

describe("Ok/Err Classes - Method Chaining", () => {
	describe("Ok.map", () => {
		it("should chain map operations", () => {
			const okResult = Ok(1);
			const doubled = okResult.map((num: number) => num + 1).unwrap();
			expect(doubled).toBe(2);
		});

		it("should chain map and mapErr", () => {
			const okResult = Ok(1);
			const result = okResult
				.map((num: number) => num + 1)
				.mapErr((err: never) => new Error("mapped"))
				.unwrap();
			expect(result).toBe(2);
		});
	});

	describe("Err.map", () => {
		it("should throw error when unwrapping Err", () => {
			const errResult = Err(new Error("something went wrong"));
			expect(() => {
				errResult.map((num: never) => num).unwrap();
			}).toThrow("something went wrong");
		});

		it("should map error when result is Err", () => {
			const errResult = Err(new Error("original"));
			expect(() => {
				errResult
					.map((num: never) => num)
					.mapErr((err: Error) => new Error("mapped"))
					.unwrap();
			}).toThrow("mapped");
		});
	});

	describe("Ok.andThen", () => {
		it("should chain andThen operations", () => {
			const okResult = Ok(1);
			const result = okResult
				.andThen((num: number) => ok(num + 1))
				.unwrap();
			expect(result).toBe(2);
		});

		it("should propagate error from andThen", () => {
			const okResult = Ok(1);
			expect(() => {
				okResult
					.andThen((num: number) => err("2nd error"))
					.unwrap();
			}).toThrow();
		});

		it("should chain andThen with mapErr", () => {
			const okResult = Ok(1);
			const result = okResult
				.andThen((num: number) => ok(num + 1));
			if (result instanceof Success) {
				expect(result.unwrap()).toBe(2);
			} else {
				throw new Error("Expected Success");
			}
		});
	});

	describe("Err.andThen", () => {
		it("should stop on first error", () => {
			const errResult = Err(new Error("something went wrong"));
			expect(() => {
				errResult
					.andThen((num: never) => err(new Error("2nd error")))
					.unwrap();
			}).toThrow("something went wrong");
		});

		it("should map error after andThen error", () => {
			const errResult = Err(new Error("original"));
			expect(() => {
				errResult
					.andThen((num: never) => err(new Error("2nd error")))
					.mapErr((err: Error) => new Error("mapped"))
					.unwrap();
			}).toThrow("mapped");
		});
	});

	describe("unwrap", () => {
		it("should unwrap Ok value", () => {
			const result = Ok(42);
			expect(result.unwrap()).toBe(42);
		});

		it("should throw Error instance directly", () => {
			const error = new Error("test error");
			const result = Err(error);
			expect(() => result.unwrap()).toThrow(error);
		});

		it("should wrap string error in Error", () => {
			const result = Err("string error");
			expect(() => result.unwrap()).toThrow("string error");
		});
	});

	describe("Ok.andThenAsync", () => {
		it("should chain async andThen operations", async () => {
			const okResult = Ok(1);
			const result = await okResult.andThenAsync(async (num: number) => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				return ok(num + 1);
			});
			expect(result.unwrap()).toBe(2);
		});

		it("should propagate error from async andThen", async () => {
			const okResult = Ok(1);
			const result = await okResult.andThenAsync(async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				return err("async error");
			});
			expect(() => result.unwrap()).toThrow("async error");
		});
	});

	describe("Ok.mapAsync", () => {
		it("should chain async map operations", async () => {
			const okResult = Ok(1);
			const result = await okResult.mapAsync(async (num: number) => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				return num + 1;
			});
			expect(result.unwrap()).toBe(2);
		});
	});

	describe("Ok.mapErrAsync", () => {
		it("should return the same Success", async () => {
			const okResult = Ok(1);
			const result = await okResult.mapErrAsync(async (_err: never) => "mapped");
			expect(result.unwrap()).toBe(1);
		});
	});

	describe("Err.andThenAsync", () => {
		it("should stop on first error", async () => {
			const errResult = Err(new Error("something went wrong"));
			const result = await errResult.andThenAsync(async (_num: never) => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				return ok(1);
			});
			expect(() => result.unwrap()).toThrow("something went wrong");
		});
	});

	describe("Err.mapAsync", () => {
		it("should return the same Erroneous", async () => {
			const errResult = Err(new Error("error"));
			const result = await errResult.mapAsync(async (_num: never) => 1);
			expect(() => result.unwrap()).toThrow("error");
		});
	});

	describe("Err.mapErrAsync", () => {
		it("should transform error with async function", async () => {
			const errResult = Err("original");
			const result = await errResult.mapErrAsync(async (e) => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				return `Mapped: ${e}`;
			});
			expect(() => result.unwrap()).toThrow("Mapped: original");
		});
	});
});

describe("Outcome - Class-based API", () => {
	describe("from", () => {
		it("should create from Result", () => {
			const result = ok(5);
			const outcome = Outcome.from(result);
			expect(outcome.unwrap()).toBe(5);
		});
	});

	describe("static methods", () => {
		it("should create Ok via Outcome.ok", () => {
			const result = Outcome.ok(42);
			expect(result.unwrap()).toBe(42);
		});

		it("should create Err via Outcome.err", () => {
			const result = Outcome.err("error");
			expect(() => result.unwrap()).toThrow("error");
		});
	});

	describe("method chaining", () => {
		it("should chain map operations", () => {
			const outcome = Outcome.ok(1);
			const result = outcome.map((x: number) => x + 1).map((x: number) => x * 2).unwrap();
			expect(result).toBe(4);
		});

		it("should chain andThen operations", () => {
			const outcome = Outcome.ok(1);
			const step1 = outcome.andThen((x: number) => ok(x + 1));
			if (step1 instanceof Success) {
				const step2 = step1.andThen((x: number) => ok(x * 2));
				if (step2 instanceof Success) {
					expect(step2.unwrap()).toBe(4);
				} else {
					throw new Error("Expected Success");
				}
			} else {
				throw new Error("Expected Success");
			}
		});
	});

	describe("match with object syntax", () => {
		it("should support object syntax", () => {
			const outcome = Outcome.ok(42);
			const value = outcome.match({
				ok: (v: number) => `Success: ${v}`,
				err: () => "Error",
			});
			expect(value).toBe("Success: 42");
		});

		it("should handle errors with object syntax", () => {
			const outcome = Outcome.err("error");
			const value = outcome.match({
				ok: () => "Success",
				err: (e) => `Error: ${e}`,
			});
			expect(value).toBe("Error: error");
		});
	});

	describe("matchAsync", () => {
		it("should support async operations", async () => {
			const outcome = Outcome.ok(42);
			const value = await outcome.matchAsync(
				async (v: number) => {
					await new Promise((resolve) => setTimeout(resolve, 10));
					return `Success: ${v}`;
				},
				async () => "Error",
			);
			expect(value).toBe("Success: 42");
		});

		it("should support object syntax with async", async () => {
			const outcome = Outcome.ok(42);
			const value = await outcome.matchAsync({
				ok: async (v: number) => {
					await new Promise((resolve) => setTimeout(resolve, 10));
					return `Success: ${v}`;
				},
				err: async () => "Error",
			});
			expect(value).toBe("Success: 42");
		});

		it("should handle errors with async", async () => {
			const outcome = Outcome.err("error");
			const value = await outcome.matchAsync({
				ok: async () => "Success",
				err: async (e) => `Error: ${e}`,
			});
			expect(value).toBe("Error: error");
		});
	});

	describe("andThenAsync", () => {
		it("should chain async andThen operations", async () => {
			const outcome = Outcome.from(ok(1));
			const result = await outcome.andThenAsync(async (num: number) => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				return ok(num + 1);
			});
			expect(result.unwrap()).toBe(2);
		});

		it("should propagate error from async andThen", async () => {
			const outcome = Outcome.from(ok(1));
			const result = await outcome.andThenAsync(async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				return err("async error");
			});
			expect(() => result.unwrap()).toThrow("async error");
		});

		it("should stop on first error in Err outcome", async () => {
			const outcome = Outcome.from(err("first error"));
			const result = await outcome.andThenAsync(async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				return ok(1);
			});
			expect(() => result.unwrap()).toThrow("first error");
		});
	});

	describe("mapAsync", () => {
		it("should transform Ok value with async function", async () => {
			const outcome = Outcome.from(ok(5));
			const result = await outcome.mapAsync(async (value: number) => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				return value * 2;
			});
			expect(result.unwrap()).toBe(10);
		});

		it("should return error unchanged", async () => {
			const outcome = Outcome.from(err("error"));
			const result = await outcome.mapAsync(async (_value: number) => 0);
			expect(() => result.unwrap()).toThrow("error");
		});
	});

	describe("mapErrAsync", () => {
		it("should transform Err value with async function", async () => {
			const outcome = Outcome.from(err("error"));
			const result = await outcome.mapErrAsync(async (e) => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				return `Mapped: ${e}`;
			});
			expect(() => result.unwrap()).toThrow("Mapped: error");
		});

		it("should return Ok value unchanged", async () => {
			const outcome = Outcome.from(ok(5));
			const result = await outcome.mapErrAsync(async (e) => `Mapped: ${e}`);
			expect(result.unwrap()).toBe(5);
		});
	});
});

