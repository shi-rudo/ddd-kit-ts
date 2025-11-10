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
});

