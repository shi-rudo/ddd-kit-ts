import type { ValidationError } from "@shirudo/base-error";
import type { ProblemDetails } from "@shirudo/base-error/public-error";

/** Extension member that carries the collected field issues. */
export type ValidationProblemMember = "errors" | "invalid-params";

/**
 * Options for {@link toProblemDetails}: the standard RFC 9457 members the
 * boundary may set, plus {@link member} to choose the wire key for the issues
 * and {@link extensions} for extra public members merged alongside them.
 */
export interface ValidationProblemOptions<
	TExtensions extends object = Record<string, unknown>,
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
	 * Extension member that carries the field issues. Default `"errors"`
	 * (`{ message, path, code?, pointer? }` entries). RFC 9457 does not
	 * standardize a multi-error member; `errors` is the common convention.
	 */
	member?: ValidationProblemMember;
	/**
	 * Extra public extension members merged alongside the issues. JSON-safe
	 * by contract (RFC 9457 bodies must serialize); a trace id, for example,
	 * is passed here, not as a recognized top-level field.
	 */
	extensions?: TExtensions;
}

/**
 * Projects a base-error {@link ValidationError} to an RFC 9457 Problem Details
 * object with the collected field issues attached under an extension member.
 * The return type is base-error's own
 * {@link ProblemDetails} (from `@shirudo/base-error/public-error`), so the
 * RFC 9457 shape stays a single source of truth across the ecosystem; per
 * that shape the body carries the error's machine-readable public `code`
 * (`"VALIDATION_FAILED"` unless the error overrides it).
 *
 * base-error is **safe by default**: the issues only cross to a client through
 * the `publicIssues()` whitelist (`{ message, path, code?, pointer? }`, never
 * raw validator extras). This helper performs that explicit projection and
 * applies sensible validation defaults (`422`, `"Validation Failed"`), so the
 * common boundary case is a one-liner instead of a footgun. The full-fidelity
 * issues remain available for observability via `error.toLogObject()`.
 *
 * For the general error-to-Problem-Details mapping (a public-code catalog with
 * per-code `type` / `status`), use base-error's `toProblem` over a projected
 * `PublicError` / `LocalizedPublicError`. This helper is the narrow
 * validation shortcut.
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
 * // → { type: "about:blank", title: "Validation Failed", status: 422,
 * //     errors: [{ message: "must be a valid email", path: ["email"], pointer: "email" }] }
 * ```
 */
export function toProblemDetails<
	TExtensions extends object = Record<string, unknown>,
>(
	error: ValidationError,
	options: ValidationProblemOptions<TExtensions> = {},
): ProblemDetails<never, string, TExtensions> {
	const {
		member = "errors",
		extensions,
		type = "about:blank",
		title = "Validation Failed",
		status = 422,
		detail,
		instance,
	} = options;

	const problem: Record<string, unknown> = { type, title, status };
	if (detail !== undefined) problem.detail = detail;
	if (instance !== undefined) problem.instance = instance;
	if (extensions) Object.assign(problem, extensions);
	// The machine-readable public code is a documented ProblemDetails member
	// in base-error 8; the ValidationError names itself after its code.
	problem.code = error.code;
	// `PublicIssue.path` is `ReadonlyArray<PropertyKey>`, so the issue array is
	// not statically a `ProblemDetailsJsonValue`; the wire form only ever
	// carries string/number path segments, so this is JSON-safe in practice.
	problem[member] = error.publicIssues();

	return problem as ProblemDetails<never, string, TExtensions>;
}
