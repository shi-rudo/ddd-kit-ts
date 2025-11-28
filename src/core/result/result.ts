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
 *
 * @example Using object syntax
 * ```typescript
 * const message = match(result, {
 *   ok: value => `Success: ${value}`,
 *   err: error => `Error: ${error}`
 * });
 * ```
 */
export function match<T, E, R>(
	result: Result<T, E>,
	onOk: (value: T) => R,
	onErr: (error: E) => R,
): R;
export function match<T, E, R>(
	result: Result<T, E>,
	handlers: { ok: (value: T) => R; err: (error: E) => R },
): R;
export function match<T, E, R>(
	result: Result<T, E>,
	onOkOrHandlers: ((value: T) => R) | { ok: (value: T) => R; err: (error: E) => R },
	onErr?: (error: E) => R,
): R {
	if (typeof onOkOrHandlers === "function") {
		// Function syntax: match(result, onOk, onErr)
		return result.ok ? onOkOrHandlers(result.value) : onErr!(result.error);
	}
	// Object syntax: match(result, { ok: ..., err: ... })
	return result.ok
		? onOkOrHandlers.ok(result.value)
		: onOkOrHandlers.err(result.error);
}

/**
 * Async pattern matching for Result.
 * Applies one async function if Ok, another if Err.
 * Both handlers must return Promises.
 *
 * @param result - The result to match
 * @param onOk - Async function to apply if Ok
 * @param onErr - Async function to apply if Err
 * @returns Promise resolving to the result of applying the appropriate function
 *
 * @example
 * ```typescript
 * const message = await matchAsync(result,
 *   async (value) => `Success: ${value}`,
 *   async (error) => `Error: ${error}`
 * );
 * ```
 *
 * @example Using object syntax
 * ```typescript
 * const message = await matchAsync(result, {
 *   ok: async (value) => `Success: ${value}`,
 *   err: async (error) => `Error: ${error}`
 * });
 * ```
 */
export async function matchAsync<T, E, R>(
	result: Result<T, E>,
	onOk: (value: T) => Promise<R>,
	onErr: (error: E) => Promise<R>,
): Promise<R>;
export async function matchAsync<T, E, R>(
	result: Result<T, E>,
	handlers: { ok: (value: T) => Promise<R>; err: (error: E) => Promise<R> },
): Promise<R>;
export async function matchAsync<T, E, R>(
	result: Result<T, E>,
	onOkOrHandlers:
		| ((value: T) => Promise<R>)
		| { ok: (value: T) => Promise<R>; err: (error: E) => Promise<R> },
	onErr?: (error: E) => Promise<R>,
): Promise<R> {
	if (typeof onOkOrHandlers === "function") {
		// Function syntax: matchAsync(result, onOk, onErr)
		return result.ok
			? onOkOrHandlers(result.value)
			: onErr!(result.error);
	}
	// Object syntax: matchAsync(result, { ok: ..., err: ... })
	return result.ok
		? onOkOrHandlers.ok(result.value)
		: onOkOrHandlers.err(result.error);
}

/**
 * Pipes a Result through multiple operations.
 * Each function receives the previous Result and returns a new Result.
 * Stops on first error.
 *
 * @param initial - The initial Result value
 * @param fns - Array of functions that take the previous Result and return a new Result
 * @returns The final Result after all operations
 *
 * @example
 * ```typescript
 * // Instead of nested andThen calls:
 * andThen(
 *   updateCountryCode(code),
 *   () => andThen(updateCurrencyCode(currency), () => updateLanguageCode(lang))
 * )
 *
 * // Use pipe (cleaner and more readable):
 * pipe(
 *   updateCountryCode(code),
 *   () => updateCurrencyCode(currency),
 *   () => updateLanguageCode(lang)
 * )
 * ```
 *
 * @example With void results
 * ```typescript
 * setInitialData(initialData: JobConfigProps["initialData"]): Result<void, JobDomainError> {
 *   return pipe(
 *     this.updateCountryCode(initialData.countryCode),
 *     () => this.updateCurrencyCode(initialData.currencyCode),
 *     () => this.updateLanguageCode(initialData.languageCode)
 *   );
 * }
 * ```
 */
export function pipe<T, E>(
	initial: Result<T, E>,
	...fns: Array<(prev: Result<T, E>) => Result<T, E>>
): Result<T, E> {
	let current = initial;
	for (const fn of fns) {
		current = fn(current);
		if (!current.ok) {
			return current;
		}
	}
	return current;
}

/**
 * Async version of andThen. Chains Result operations with async functions.
 * If the result is Ok, applies the async function to the value.
 * If Err, returns the error unchanged.
 *
 * @param result - The result to chain
 * @param fn - Async function that takes the Ok value and returns a Promise<Result>
 * @returns A Promise resolving to a new Result
 *
 * @example
 * ```typescript
 * const result = await andThenAsync(
 *   ok(userId),
 *   async (id) => {
 *     const user = await fetchUser(id);
 *     return user ? ok(user) : err("User not found");
 *   }
 * );
 * ```
 */
export async function andThenAsync<T, E, U>(
	result: Result<T, E>,
	fn: (value: T) => Promise<Result<U, E>>,
): Promise<Result<U, E>> {
	if (result.ok) {
		return fn(result.value);
	}
	return result;
}

/**
 * Async version of map. Transforms the Ok value using an async function.
 * If the result is Err, returns the error unchanged.
 *
 * @param result - The result to transform
 * @param fn - Async function to transform the Ok value
 * @returns A Promise resolving to a new Result with transformed value
 *
 * @example
 * ```typescript
 * const result = await mapAsync(
 *   ok(userId),
 *   async (id) => await enrichUserData(id)
 * );
 * ```
 */
export async function mapAsync<T, E, U>(
	result: Result<T, E>,
	fn: (value: T) => Promise<U>,
): Promise<Result<U, E>> {
	if (result.ok) {
		return ok(await fn(result.value));
	}
	return result;
}

/**
 * Async version of mapErr. Transforms the Err value using an async function.
 * If the result is Ok, returns the value unchanged.
 *
 * @param result - The result to transform
 * @param fn - Async function to transform the Err value
 * @returns A Promise resolving to a new Result with transformed error
 *
 * @example
 * ```typescript
 * const result = await mapErrAsync(
 *   err("error-code"),
 *   async (code) => await translateErrorCode(code)
 * );
 * ```
 */
export async function mapErrAsync<T, E, F>(
	result: Result<T, E>,
	fn: (error: E) => Promise<F>,
): Promise<Result<T, F>> {
	if (result.ok) {
		return result;
	}
	return err(await fn(result.error));
}

/**
 * Async version of pipe. Pipes a Result through multiple async operations.
 * Each function receives the previous Result and returns a Promise<Result>.
 * Stops on first error.
 *
 * @param initial - The initial Result value
 * @param fns - Array of async functions that take the previous Result and return a Promise<Result>
 * @returns A Promise resolving to the final Result after all operations
 *
 * @example
 * ```typescript
 * const result = await pipeAsync(
 *   ok(initialData),
 *   async (prev) => andThenAsync(prev, async (data) => await validateAsync(data)),
 *   async (prev) => andThenAsync(prev, async (data) => await saveAsync(data))
 * );
 * ```
 */
export async function pipeAsync<T, E>(
	initial: Result<T, E>,
	...fns: Array<(prev: Result<T, E>) => Promise<Result<T, E>>>
): Promise<Result<T, E>> {
	let current = initial;
	for (const fn of fns) {
		current = await fn(current);
		if (!current.ok) {
			return current;
		}
	}
	return current;
}

/**
 * Wraps a function that may throw exceptions into a Result type.
 * Catches any thrown exceptions and converts them to Err results.
 *
 * @param fn - Function that may throw exceptions
 * @param errorMapper - Optional function to transform the caught error
 * @returns A Result containing the function's return value or error
 *
 * @example
 * ```typescript
 * function riskyOperation(): string {
 *   if (Math.random() > 0.5) {
 *     throw new Error("Something went wrong");
 *   }
 *   return "success";
 * }
 *
 * const result = tryCatch(() => riskyOperation());
 * if (result.ok) {
 *   console.log(result.value); // "success"
 * } else {
 *   console.error(result.error.message); // "Something went wrong"
 * }
 * ```
 *
 * @example With custom error mapper
 * ```typescript
 * const result = tryCatch(
 *   () => riskyOperation(),
 *   (error) => `Custom: ${error instanceof Error ? error.message : String(error)}`
 * );
 * ```
 */
export function tryCatch<T, E = Error>(
	fn: () => T,
	errorMapper?: (error: unknown) => E,
): Result<T, E> {
	try {
		return ok(fn());
	} catch (error) {
		if (errorMapper) {
			return err(errorMapper(error));
		}
		return err((error instanceof Error ? error : new Error(String(error))) as E);
	}
}

/**
 * Wraps an async function that may throw exceptions into a Promise<Result>.
 * Catches any thrown exceptions and converts them to Err results.
 *
 * @param fn - Async function that may throw exceptions
 * @param errorMapper - Optional function to transform the caught error
 * @returns A Promise resolving to a Result containing the function's return value or error
 *
 * @example
 * ```typescript
 * async function riskyAsyncOperation(): Promise<string> {
 *   if (Math.random() > 0.5) {
 *     throw new Error("Something went wrong");
 *   }
 *   return "success";
 * }
 *
 * const result = await tryCatchAsync(() => riskyAsyncOperation());
 * if (result.ok) {
 *   console.log(result.value); // "success"
 * } else {
 *   console.error(result.error.message); // "Something went wrong"
 * }
 * ```
 */
export async function tryCatchAsync<T, E = Error>(
	fn: () => Promise<T>,
	errorMapper?: (error: unknown) => E,
): Promise<Result<T, E>> {
	try {
		const value = await fn();
		return ok(value);
	} catch (error) {
		if (errorMapper) {
			return err(errorMapper(error));
		}
		return err((error instanceof Error ? error : new Error(String(error))) as E);
	}
}

