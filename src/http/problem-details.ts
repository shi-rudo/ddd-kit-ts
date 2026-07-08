import type { PublicIssue, ValidationError } from "@shirudo/base-error";
import {
	type ProblemDetailsResult,
	type ToProblemContext,
	toProblem,
} from "@shirudo/base-error/public-error";

/** Details member carried by a {@link toProblemDetails} body. */
export interface ValidationProblemDetails {
	/** The whitelisted field issues, straight from `publicIssues()`. */
	readonly issues: readonly PublicIssue[];
}

/**
 * Options for {@link toProblemDetails}: the transport members the boundary
 * may set, plus {@link extensions} for extra public body members.
 */
export interface ValidationProblemOptions<
	TExtensions extends object = Record<never, never>,
> {
	/** URI reference identifying the problem type. Defaults to `"about:blank"`. */
	type?: string;
	/** Short, human-readable summary. Default `"Validation Failed"`. */
	title?: string;
	/** HTTP status code. Default `422`. */
	status?: number;
	/** Human-readable explanation specific to this occurrence. */
	detail?: string;
	/** URI reference identifying this specific occurrence. */
	instance?: string;
	/**
	 * Extra public extension members merged alongside the documented body
	 * members. Constrained by base-error's `toProblem` contract: JSON-safe,
	 * string-keyed, and free of the reserved member names, checked at
	 * compile time and re-validated at runtime (a colliding or
	 * non-JSON-safe set is dropped and recorded in `outcome.omitted`).
	 */
	extensions?: ToProblemContext<TExtensions>["extensions"];
}

/**
 * The kit-named result of {@link toProblemDetails}: base-error's
 * `ProblemDetailsResult` specialized to the validation shortcut. Exists so
 * consumers can annotate boundaries from the kit entry alone; importing
 * base-error stays an opt-in, never a prerequisite.
 */
export type ValidationProblemResult<
	TExtensions extends object = Record<never, never>,
> = ProblemDetailsResult<ValidationProblemDetails, string, TExtensions>;

/**
 * Projects a base-error {@link ValidationError} to an RFC 9457 Problem
 * Details result by delegating to base-error's `toProblem` transport stage:
 * one pipeline, one wire profile, one hardening implementation. The body
 * carries the error's public `code`, and the whitelisted issues ride under
 * `details.issues` (`{ message, path, code?, pointer? }`, never raw
 * validator extras), the same shape `toPublicErrorView` uses.
 *
 * All of `toProblem`'s wire-safety guarantees apply: the body is deeply
 * frozen with a null prototype (cannot carry or receive prototype
 * pollution), every member is JSON-safe (a non-serializable value drops
 * that member and records it in `result.outcome.omitted` instead of
 * corrupting the wire), and extensions cannot collide with the reserved
 * members. The result also carries the HTTP `status` and ready-made
 * `headers`, so the boundary does not restate them.
 *
 * This is a presentation/transport concern and ships from the opt-in
 * `@shirudo/ddd-kit/http` entry point: the core kit stays transport-free.
 * For catalog-driven mapping across ALL your public errors use
 * base-error's `definePublicErrors` + `project` + `toProblem` directly;
 * this helper is the narrow validation shortcut.
 *
 * @example
 * ```ts
 * import { toProblemDetails } from "@shirudo/ddd-kit/http";
 *
 * if (result.isErr()) {
 *   const problem = toProblemDetails(result.error);
 *   return Response.json(problem.body, {
 *     status: problem.status,
 *     headers: problem.headers,
 *   });
 * }
 * // body → { type: "about:blank", title: "Validation Failed", status: 422,
 * //          code: "VALIDATION_FAILED",
 * //          details: { issues: [{ message: "must be a valid email", ... }] } }
 * ```
 */
export function toProblemDetails<
	TExtensions extends object = Record<never, never>,
>(
	error: ValidationError,
	options: ValidationProblemOptions<TExtensions> = {},
): ValidationProblemResult<TExtensions> {
	const {
		type = "about:blank",
		title = "Validation Failed",
		status = 422,
		detail,
		instance,
		extensions,
	} = options;

	return toProblem<ValidationProblemDetails, string, TExtensions>(
		{ status, type, title },
		{ code: error.code, details: { issues: error.publicIssues() } },
		{ detail, instance, extensions },
	);
}
