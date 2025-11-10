import { err, ok, type Result } from "./result";

/**
 * Guard function that validates a condition and returns a Result.
 * Returns `ok(true)` if the condition is met, otherwise `err(error)`.
 *
 * @param cond - The condition to check
 * @param error - Error message if condition fails
 * @returns Result<true, string>
 *
 * @example
 * ```typescript
 * const result = guard(id.length > 0, "ID cannot be empty");
 * if (!result.ok) {
 *   return err(result.error);
 * }
 * ```
 */
export function guard(cond: boolean, error: string): Result<true, string> {
	return cond ? ok(true) : err(error);
}
