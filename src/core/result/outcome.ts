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

/**
 * Base class for Result with method chaining support.
 * Provides common methods for both Ok and Err classes.
 */
abstract class ResultBase<T, E> {
	protected readonly _result: Result<T, E>;

	protected constructor(result: Result<T, E>) {
		this._result = result;
	}

	/**
	 * Returns the value if Ok, otherwise throws an error.
	 * If error is an Error instance, throws it directly.
	 * Otherwise, wraps the error in a new Error.
	 *
	 * @throws Error if the result is Err
	 */
	unwrap(): T {
		if (this._result.ok) {
			return this._result.value;
		}
		if (this._result.error instanceof Error) {
			throw this._result.error;
		}
		throw new Error(String(this._result.error));
	}

	/**
	 * Returns the value if Ok, otherwise returns the default value.
	 */
	unwrapOr(defaultValue: T): T {
		return unwrapOr(this._result, defaultValue);
	}

	/**
	 * Returns the value if Ok, otherwise computes default from error.
	 */
	unwrapOrElse(fn: (error: E) => T): T {
		return unwrapOrElse(this._result, fn);
	}

	/**
	 * Pattern matching for Result.
	 * Applies one function if Ok, another if Err.
	 *
	 * @example
	 * ```typescript
	 * outcome.match(
	 *   value => `Success: ${value}`,
	 *   error => `Error: ${error}`
	 * );
	 * ```
	 *
	 * @example Using object syntax
	 * ```typescript
	 * outcome.match({
	 *   ok: value => `Success: ${value}`,
	 *   err: error => `Error: ${error}`
	 * });
	 * ```
	 */
	match<R>(
		onOk: (value: T) => R,
		onErr: (error: E) => R,
	): R;
	match<R>(
		handlers: { ok: (value: T) => R; err: (error: E) => R },
	): R;
	match<R>(
		onOkOrHandlers: ((value: T) => R) | { ok: (value: T) => R; err: (error: E) => R },
		onErr?: (error: E) => R,
	): R {
		if (typeof onOkOrHandlers === "function") {
			return match(this._result, onOkOrHandlers, onErr!);
		}
		return match(this._result, onOkOrHandlers);
	}

	/**
	 * Async pattern matching for Result.
	 * Applies one async function if Ok, another if Err.
	 *
	 * @example
	 * ```typescript
	 * await outcome.matchAsync(
	 *   async (value) => `Success: ${value}`,
	 *   async (error) => `Error: ${error}`
	 * );
	 * ```
	 *
	 * @example Using object syntax
	 * ```typescript
	 * await outcome.matchAsync({
	 *   ok: async (value) => `Success: ${value}`,
	 *   err: async (error) => `Error: ${error}`
	 * });
	 * ```
	 */
	matchAsync<R>(
		onOk: (value: T) => Promise<R>,
		onErr: (error: E) => Promise<R>,
	): Promise<R>;
	matchAsync<R>(
		handlers: { ok: (value: T) => Promise<R>; err: (error: E) => Promise<R> },
	): Promise<R>;
	async matchAsync<R>(
		onOkOrHandlers:
			| ((value: T) => Promise<R>)
			| { ok: (value: T) => Promise<R>; err: (error: E) => Promise<R> },
		onErr?: (error: E) => Promise<R>,
	): Promise<R> {
		if (typeof onOkOrHandlers === "function") {
			return matchAsync(this._result, onOkOrHandlers, onErr!);
		}
		return matchAsync(this._result, onOkOrHandlers);
	}

	/**
	 * Type guard to check if the result is Ok.
	 */
	isOk(): this is Success<T> {
		return isOk(this._result);
	}

	/**
	 * Type guard to check if the result is Err.
	 */
	isErr(): this is Erroneous<E> {
		return isErr(this._result);
	}

	/**
	 * Gets the underlying Result value.
	 */
	get result(): Result<T, E> {
		return this._result;
	}
}

/**
 * Class representing a successful result with method chaining support.
 * Use this for class-based API with method chaining.
 *
 * @example
 * ```typescript
 * const okResult = Ok(1);
 * const doubled = okResult.map(x => x * 2).unwrap(); // 2
 *
 * const chained = Ok(5)
 *   .andThen(x => Ok(x * 2))
 *   .map(x => x + 1)
 *   .unwrap(); // 11
 * ```
 */
class Success<T> extends ResultBase<T, never> {
	constructor(value: T) {
		super(ok(value));
	}

	/**
	 * Factory function to create an Ok instance.
	 * Can be called with or without `new`.
	 */
	static of<T>(value: T): Success<T> {
		return new Success(value);
	}

	/**
	 * Chains Result operations (flatMap/bind).
	 * If the result is Ok, applies the function to the value.
	 * If Err, returns the error unchanged.
	 */
	andThen<U, E>(fn: (value: T) => Result<U, E>): Success<U> | Erroneous<E> {
		const result = andThen(this._result, fn);
		if (result.ok) {
			return new Success(result.value);
		}
		return new Erroneous(result.error);
	}

	/**
	 * Transforms the Ok value using a function.
	 * If the result is Err, returns the error unchanged.
	 */
	map<U>(fn: (value: T) => U): Success<U> {
		const result = map(this._result, fn);
		if (result.ok) {
			return new Success(result.value);
		}
		// This should never happen for Success, but TypeScript needs it
		throw new Error("Unexpected error in Success.map");
	}

	/**
	 * Transforms the Err value using a function.
	 * If the result is Ok, returns the value unchanged.
	 */
	mapErr<F>(_fn: (error: never) => F): Success<T> {
		return this;
	}
}

export { Success };

/**
 * Class representing an erroneous result with method chaining support.
 * Use this for class-based API with method chaining.
 *
 * @example
 * ```typescript
 * const errResult = Err(new Error("error"));
 * errResult.map(x => x * 2).unwrap(); // throws Error("error")
 *
 * const mapped = Err("original")
 *   .mapErr(e => `Error: ${e}`)
 *   .unwrap(); // throws Error("Error: original")
 * ```
 */
class Erroneous<E> extends ResultBase<never, E> {
	constructor(error: E) {
		super(err(error));
	}

	/**
	 * Factory function to create an Err instance.
	 * Can be called with or without `new`.
	 */
	static of<E>(error: E): Erroneous<E> {
		return new Erroneous(error);
	}

	/**
	 * Chains Result operations (flatMap/bind).
	 * If the result is Ok, applies the function to the value.
	 * If Err, returns the error unchanged.
	 */
	andThen<U>(_fn: (value: never) => Result<U, E>): Erroneous<E> {
		return this;
	}

	/**
	 * Transforms the Ok value using a function.
	 * If the result is Err, returns the error unchanged.
	 */
	map<U>(_fn: (value: never) => U): Erroneous<E> {
		return this;
	}

	/**
	 * Transforms the Err value using a function.
	 * If the result is Ok, returns the value unchanged.
	 */
	mapErr<F>(fn: (error: E) => F): Erroneous<F> {
		const result = mapErr(this._result, fn);
		if (!result.ok) {
			return new Erroneous(result.error);
		}
		// This should never happen for Erroneous, but TypeScript needs it
		throw new Error("Unexpected ok in Erroneous.mapErr");
	}
}

export { Erroneous };

/**
 * Factory functions for creating Ok and Err instances.
 * These can be called without `new` for a more functional style.
 *
 * @example
 * ```typescript
 * const okResult = Ok(1);
 * const errResult = Err("error");
 * ```
 */
export function Ok<T>(value: T): Success<T> {
	return new Success(value);
}

export function Err<E>(error: E): Erroneous<E> {
	return new Erroneous(error);
}

/**
 * Class-based API for Result with method chaining support.
 * Provides an object-oriented alternative to the functional Result type.
 * Use `Outcome.from()` to wrap an existing Result, or `Outcome.ok()` / `Outcome.err()` to create new instances.
 *
 * @example
 * ```typescript
 * // Wrap an existing Result
 * const result = Outcome.from(ok(1));
 * const doubled = result.map(x => x * 2).unwrap(); // 2
 *
 * // Create directly
 * const outcome = Outcome.ok(42);
 * const value = outcome.map(x => x + 1).unwrap(); // 43
 * ```
 */
export class Outcome<T, E> extends ResultBase<T, E> {
	private constructor(result: Result<T, E>) {
		super(result);
	}

	/**
	 * Creates an Outcome from an Ok value.
	 */
	static ok<T>(value: T): Success<T> {
		return new Success(value);
	}

	/**
	 * Creates an Outcome from an Err value.
	 */
	static err<E>(error: E): Erroneous<E> {
		return new Erroneous(error);
	}

	/**
	 * Creates an Outcome from a Result.
	 */
	static from<T, E>(result: Result<T, E>): Outcome<T, E> {
		return new Outcome(result);
	}

	andThen<U>(fn: (value: T) => Result<U, E>): Outcome<U, E> {
		return Outcome.from(andThen(this._result, fn));
	}

	map<U>(fn: (value: T) => U): Outcome<U, E> {
		return Outcome.from(map(this._result, fn));
	}

	mapErr<F>(fn: (error: E) => F): Outcome<T, F> {
		return Outcome.from(mapErr(this._result, fn));
	}
}

