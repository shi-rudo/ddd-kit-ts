import type { PublicIssue } from "@shirudo/base-error";
import type { PublicErrorView } from "@shirudo/base-error/presentation";

/**
 * Safe, client-facing English messages for the kit's known errors. They carry
 * no occurrence data (no id, version, or technical detail), so they never leak
 * across the boundary. This is the transport-neutral *presentation* layer: the
 * technical error classes stay free of these strings (removed from the core in
 * 2.0); here is their opt-in home.
 *
 * Keyed by the kit's pinned `error.name` (stable across minification and
 * duplicate installs), so matching does not depend on `instanceof`.
 */
const KIT_PUBLIC_MESSAGES: Readonly<Record<string, string>> = {
	AggregateNotFoundError: "The requested resource could not be found.",
	ConcurrencyConflictError:
		"The resource was modified by another request. Please reload and try again.",
	DuplicateAggregateError: "The resource already exists.",
};

/** Message for a `ValidationError`, which is detected by capability, not name. */
const VALIDATION_MESSAGE = "The submitted data is invalid.";
/** Public code and message used for any unmapped or non-kit error. */
const FALLBACK_CODE = "INTERNAL_ERROR";
const FALLBACK_MESSAGE = "An unexpected error occurred.";
/** BCP 47 locale the built-in messages are written in. */
const DEFAULT_LOCALE = "en";

/** Details shape carried by the view for a {@link toPublicErrorView} result. */
export interface PublicErrorViewDetails {
	/** Whitelisted field issues, present only for a `ValidationError`. */
	readonly issues: readonly PublicIssue[];
}

/** Options for {@link toPublicErrorView}. */
export interface PublicErrorViewOptions {
	/**
	 * BCP 47 locale tag stamped on the view. The built-in messages are English;
	 * pass a locale only when you supply your own message resolution upstream.
	 * Default `"en"`.
	 */
	locale?: string;
}

/**
 * Maps a kit error (or any caught value) to a base-error
 * {@link PublicErrorView}: a **transport-neutral**, client-safe representation
 * (`code`, `message`, `locale`, optional `details`). It is deliberately *not* a
 * transport adapter: it carries no HTTP status, header, or exit code, because
 * those are the consumer's concern. Feed the view into base-error's
 * `defineProblemDetailsAdapter` (HTTP / RFC 9457), a gRPC status mapper, or a
 * CLI exit-code table, whichever boundary you are at.
 *
 * Total over `unknown`: an unmapped or non-kit value degrades to a generic
 * `INTERNAL_ERROR` view rather than leaking the technical message or throwing.
 * The kit's class-based errors match by their pinned `error.name`, so it
 * survives minification and duplicate installs (no `instanceof`). A
 * `ValidationError` is detected by its `publicIssues()` whitelist (base-error
 * names it after its code), and those issues ride along in `details.issues`.
 *
 * For richer, multi-locale messages, register the kit's errors in a base-error
 * `PublicErrorRegistry` and use `PublicErrorPresenter` instead; this helper is
 * the lean, single-locale default.
 *
 * @example
 * ```ts
 * import { toPublicErrorView } from "@shirudo/ddd-kit/presentation";
 * import { defineProblemDetailsAdapter } from "@shirudo/base-error/problem-details";
 *
 * const adapter = defineProblemDetailsAdapter({
 *   definitions: { AggregateNotFoundError: { type: "about:blank", status: 404 } },
 *   fallback: { type: "about:blank", status: 500 },
 * });
 *
 * const { body, status } = adapter.map(toPublicErrorView(error));
 * return Response.json(body, { status });
 * ```
 */
export function toPublicErrorView(
	error: unknown,
	options: PublicErrorViewOptions = {},
): PublicErrorView<PublicErrorViewDetails> {
	const locale = options.locale ?? DEFAULT_LOCALE;
	const name = errorName(error);

	// ValidationError (and subclasses) are detected by the publicIssues()
	// whitelist, not by name: base-error names a ValidationError after its code
	// ("VALIDATION_FAILED"), so a name match would miss it.
	if (hasPublicIssues(error)) {
		return {
			code: name ?? "VALIDATION_FAILED",
			message: VALIDATION_MESSAGE,
			locale,
			details: { issues: error.publicIssues() },
		};
	}

	const message = name ? KIT_PUBLIC_MESSAGES[name] : undefined;
	if (message === undefined) {
		return { code: FALLBACK_CODE, message: FALLBACK_MESSAGE, locale };
	}

	return { code: name as string, message, locale };
}

/** Reads a string `name` off a caught value without assuming it is an Error. */
function errorName(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const { name } = error as { name?: unknown };
	return typeof name === "string" ? name : undefined;
}

/** Duck-types base-error's `ValidationError.publicIssues()` accessor. */
function hasPublicIssues(
	error: unknown,
): error is { publicIssues(): PublicIssue[] } {
	return (
		typeof (error as { publicIssues?: unknown }).publicIssues === "function"
	);
}
