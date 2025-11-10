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
