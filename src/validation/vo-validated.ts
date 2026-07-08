import { ValidationError } from "@shirudo/base-error";
import { err, ok, type Result } from "@shirudo/result";
import { type VO, vo } from "../value-object/value-object";

/**
 * Builds an immutable value object while collecting **all** validation
 * violations into a single {@link ValidationError}, instead of failing on the
 * first one. This is the Result-first, multi-error counterpart to
 * `voWithValidation` (which returns a single string message).
 *
 * The `validate` callback receives a fresh `ValidationError` to push field
 * issues onto (via `addIssue` / `addIssues`) and the raw input. When no issue
 * was recorded the input is frozen into a `VO<T>` and returned as `Ok`;
 * otherwise the populated `ValidationError` is returned as `Err`.
 *
 * `ValidationError` comes from `@shirudo/base-error`; import it from there to
 * narrow the `Err` branch, exactly as `Result` is imported from
 * `@shirudo/result`. At the HTTP boundary, `toProblemDetails` from
 * `@shirudo/ddd-kit/http` surfaces the issues as an RFC 9457 result.
 *
 * @example
 * ```ts
 * const result = voValidated(
 *   { email, age },
 *   (issues, m) => {
 *     if (!isEmail(m.email))
 *       issues.addIssue({ message: "must be a valid email", path: ["email"] });
 *     if (m.age < 0)
 *       issues.addIssue({ message: "must not be negative", path: ["age"] });
 *   },
 *   "Registration is invalid",
 * );
 * // result.isErr() → result.error.publicIssues() has both violations
 * ```
 */
export function voValidated<T>(
	t: T,
	validate: (issues: ValidationError, value: T) => void,
	message = "Validation failed",
): Result<VO<T>, ValidationError> {
	const issues = new ValidationError(message);
	validate(issues, t);
	return issues.hasIssues() ? err(issues) : ok(vo(t));
}
