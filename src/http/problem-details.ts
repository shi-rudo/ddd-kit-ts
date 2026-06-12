import type {
	ProblemDetails,
	ProblemDetailsOptions,
	ValidationError,
} from "@shirudo/base-error";

/** Extension member that carries the collected field issues. */
export type ValidationProblemMember = "errors" | "invalid-params";

/**
 * Options for {@link toProblemDetails}. Mirrors base-error's
 * `ProblemDetailsOptions` but takes over the `extensions` member to attach the
 * collected field issues, and adds {@link member} to choose the wire key.
 */
export interface ValidationProblemOptions
	extends Omit<ProblemDetailsOptions, "extensions"> {
	/**
	 * Extension member that carries the field issues. Default `"errors"`
	 * (`{ message, path, code?, pointer? }` entries). RFC 9457 does not
	 * standardize a multi-error member; `errors` is the common convention.
	 */
	member?: ValidationProblemMember;
	/** Extra public extension members merged alongside the issues. */
	extensions?: Record<string, unknown>;
}

/**
 * Projects a base-error {@link ValidationError} to an RFC 9457 Problem Details
 * object with the collected field issues attached under an extension member.
 *
 * base-error is **safe by default**: `ValidationError.toProblemDetails()` does
 * not expose the issues on its own: they only cross to a client through the
 * `publicIssues()` whitelist. This helper performs that explicit projection and
 * applies sensible validation defaults (`422`, `"Validation Failed"`), so the
 * common boundary case is a one-liner instead of a footgun.
 *
 * This is a presentation/transport concern and ships from the opt-in
 * `@shirudo/ddd-kit/http` entry point: the core kit stays transport-free.
 *
 * @example
 * ```ts
 * import { toProblemDetails } from "@shirudo/ddd-kit/http";
 *
 * if (result.isErr()) {
 *   return Response.json(toProblemDetails(result.error), { status: 422 });
 * }
 * // → { type, title: "Validation Failed", status: 422,
 * //     errors: [{ message: "must be a valid email", path: ["email"], pointer: "email" }] }
 * ```
 */
export function toProblemDetails(
	error: ValidationError,
	options: ValidationProblemOptions = {},
): ProblemDetails {
	const { member = "errors", extensions, ...rest } = options;
	return error.toProblemDetails({
		title: "Validation Failed",
		status: 422,
		...rest,
		extensions: { ...extensions, [member]: error.publicIssues() },
	});
}
