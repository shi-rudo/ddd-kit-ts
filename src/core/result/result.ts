export type Ok<T> = { ok: true; value: T };
export type Err<E> = { ok: false; error: E };
export type Result<T, E> = Ok<T> | Err<E>;

/**
 * Creates an Ok result with a value.
 *
 * @param value - The success value
 * @returns An Ok result containing the value
 *
 * @example
 * ```typescript
 * const result = ok(42);
 * // result is Ok<number>
 * ```
 */
export function ok<T>(value: T): Ok<T>;

/**
 * Creates an Ok result with void (no value).
 *
 * @returns An Ok<void> result
 *
 * @example
 * ```typescript
 * const result = ok();
 * // result is Ok<void>
 * ```
 */
export function ok(): Ok<void>;

export function ok<T>(value?: T): Ok<T> {
	return { ok: true, value: value as T };
}

/**
 * Creates an Err result with an error.
 *
 * @param error - The error value
 * @returns An Err result containing the error
 *
 * @example
 * ```typescript
 * const result = err("Something went wrong");
 * // result is Err<string>
 * ```
 */
export function err<E>(error: E): Err<E>;

/**
 * Creates an Err result with void (no error value).
 *
 * @returns An Err<void> result
 *
 * @example
 * ```typescript
 * const result = err();
 * // result is Err<void>
 * ```
 */
export function err(): Err<void>;

export function err<E>(error?: E): Err<E> {
	return { ok: false, error: error as E };
}

/**
 * Type guard to check if a Result is Ok.
 * Narrows the type to Ok<T> when returning true.
 *
 * @param result - The result to check
 * @returns true if the result is Ok, false otherwise
 *
 * @example
 * ```typescript
 * const result = voWithValidation(data, validator);
 * if (isOk(result)) {
 *   // TypeScript knows result is Ok<ValueObject<T>>
 *   console.log(result.value);
 * }
 * ```
 */
export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
	return result.ok === true;
}

/**
 * Type guard to check if a Result is Err.
 * Narrows the type to Err<E> when returning true.
 *
 * @param result - The result to check
 * @returns true if the result is Err, false otherwise
 *
 * @example
 * ```typescript
 * const result = voWithValidation(data, validator);
 * if (isErr(result)) {
 *   // TypeScript knows result is Err<string>
 *   console.error(result.error);
 * }
 * ```
 */
export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
	return result.ok === false;
}

/**
 * Chains Result operations (flatMap/bind).
 * If the result is Ok, applies the function to the value.
 * If Err, returns the error unchanged.
 *
 * @param result - The result to chain
 * @param fn - Function that takes the Ok value and returns a new Result
 * @returns A new Result
 *
 * @example
 * ```typescript
 * const result = validateUserId("123")
 *   .andThen(userId => validateEmail("test@example.com")
 *     .map(email => ({ id: userId, email }))
 *   );
 * ```
 */
export function andThen<T, E, U>(
	result: Result<T, E>,
	fn: (value: T) => Result<U, E>,
): Result<U, E> {
	if (result.ok) {
		return fn(result.value);
	}
	return result;
}

/**
 * Transforms the Ok value using a function.
 * If the result is Err, returns the error unchanged.
 *
 * @param result - The result to transform
 * @param fn - Function to transform the Ok value
 * @returns A new Result with transformed value
 *
 * @example
 * ```typescript
 * const result = ok(5);
 * const doubled = map(result, x => x * 2); // Ok<10>
 * ```
 */
export function map<T, E, U>(
	result: Result<T, E>,
	fn: (value: T) => U,
): Result<U, E> {
	if (result.ok) {
		return ok(fn(result.value));
	}
	return result;
}

/**
 * Transforms the Err value using a function.
 * If the result is Ok, returns the value unchanged.
 *
 * @param result - The result to transform
 * @param fn - Function to transform the Err value
 * @returns A new Result with transformed error
 *
 * @example
 * ```typescript
 * const result = err("not found");
 * const mapped = mapErr(result, e => `Error: ${e}`); // Err<"Error: not found">
 * ```
 */
export function mapErr<T, E, F>(
	result: Result<T, E>,
	fn: (error: E) => F,
): Result<T, F> {
	if (result.ok) {
		return result;
	}
	return err(fn(result.error));
}

/**
 * Returns the value if Ok, otherwise returns the default value.
 *
 * @param result - The result to unwrap
 * @param defaultValue - Default value to return if Err
 * @returns The Ok value or the default value
 *
 * @example
 * ```typescript
 * const result = validateUserId("123");
 * const userId = unwrapOr(result, "default-id");
 * ```
 */
export function unwrapOr<T, E>(result: Result<T, E>, defaultValue: T): T {
	return result.ok ? result.value : defaultValue;
}

/**
 * Returns the value if Ok, otherwise computes default from error.
 *
 * @param result - The result to unwrap
 * @param fn - Function to compute default from error
 * @returns The Ok value or computed default
 *
 * @example
 * ```typescript
 * const result = validateUserId("");
 * const userId = unwrapOrElse(result, err => `fallback-${Date.now()}`);
 * ```
 */
export function unwrapOrElse<T, E>(
	result: Result<T, E>,
	fn: (error: E) => T,
): T {
	return result.ok ? result.value : fn(result.error);
}

/**
 * Pattern matching for Result.
 * Applies one function if Ok, another if Err.
 *
 * @param result - The result to match
 * @param onOk - Function to apply if Ok
 * @param onErr - Function to apply if Err
 * @returns The result of applying the appropriate function
 *
 * @example
 * ```typescript
 * const message = match(result,
 *   value => `Success: ${value}`,
 *   error => `Error: ${error}`
 * );
 * ```
 */
export function match<T, E, R>(
	result: Result<T, E>,
	onOk: (value: T) => R,
	onErr: (error: E) => R,
): R {
	return result.ok ? onOk(result.value) : onErr(result.error);
}

