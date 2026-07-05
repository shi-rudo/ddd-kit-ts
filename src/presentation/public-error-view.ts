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
 * `INTERNAL_ERROR` view rather than leaking the technical message or throwing;
 * a throwing accessor or `publicIssues()` implementation degrades the same
 * way instead of crashing the 500 path. The kit's class-based errors match by
 * their pinned `error.name`, so it survives minification and duplicate
 * installs (no `instanceof`). A `ValidationError` is detected by capability:
 * a `publicIssues()` method AND a SCREAMING_SNAKE `name` (base-error names a
 * `ValidationError` after its code), so a class-named infrastructure error
 * that happens to expose a `publicIssues()` method is NOT mistaken for one
 * and nothing it returns reaches the client. Issues that do ride along in
 * `details.issues` are re-emitted through the {@link PublicIssue} whitelist
 * (`message`, `path`, `code`, `pointer`); unknown fields and non-conforming
 * entries are dropped.
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
	// The catch is the totality guarantee itself: a hostile or broken input
	// (throwing `name`/`publicIssues` accessors, a throwing `publicIssues()`
	// body) must degrade to the fallback view, never crash the 500 path.
	try {
		return mapToView(error, locale);
	} catch {
		return fallbackView(locale);
	}
}

function fallbackView(
	locale: string,
): PublicErrorView<PublicErrorViewDetails> {
	return { code: FALLBACK_CODE, message: FALLBACK_MESSAGE, locale };
}

function mapToView(
	error: unknown,
	locale: string,
): PublicErrorView<PublicErrorViewDetails> {
	const name = errorName(error);

	// ValidationError (and subclasses) are detected by capability, not by a
	// name whitelist: base-error names a ValidationError after its CODE
	// ("VALIDATION_FAILED"), so a name match would miss custom codes. The
	// SCREAMING_SNAKE gate keeps the capability check honest: a class-named
	// error (e.g. "PgPoolExhaustedError") that happens to expose a
	// publicIssues() method is not a validation error, and neither its name
	// nor anything it returns may reach the client.
	if (
		name !== undefined &&
		VALIDATION_CODE_PATTERN.test(name) &&
		hasPublicIssues(error)
	) {
		const issues = sanitizePublicIssues(error.publicIssues());
		if (issues !== undefined) {
			return {
				code: name,
				message: VALIDATION_MESSAGE,
				locale,
				details: { issues },
			};
		}
	}

	const message = name ? KIT_PUBLIC_MESSAGES[name] : undefined;
	if (message === undefined) {
		return fallbackView(locale);
	}

	return { code: name as string, message, locale };
}

/**
 * Shape of a `ValidationError` name, which base-error derives from its code
 * (`"VALIDATION_FAILED"` by default, SCREAMING_SNAKE by convention for custom
 * codes). Kit and consumer error CLASSES are PascalCase and never match.
 */
const VALIDATION_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/** Reads a string `name` off a caught value without assuming it is an Error. */
function errorName(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const { name } = error as { name?: unknown };
	return typeof name === "string" ? name : undefined;
}

/**
 * Duck-types base-error's `ValidationError.publicIssues()` accessor. The
 * null/object guard keeps `toPublicErrorView` total: a thrown `null` or
 * `undefined` must degrade to the fallback view, not crash the presenter.
 */
function hasPublicIssues(
	error: unknown,
): error is { publicIssues(): unknown } {
	return (
		typeof error === "object" &&
		error !== null &&
		typeof (error as { publicIssues?: unknown }).publicIssues === "function"
	);
}

/**
 * Re-emits a `publicIssues()` result through the {@link PublicIssue}
 * whitelist so only the documented wire fields (`message`, `path`, `code`,
 * `pointer`) can reach the client: a duck-typed implementation must not be
 * able to smuggle arbitrary payloads into the view. Returns `undefined` when
 * the result is not an array (the capability contract was not met); drops
 * entries without a string `message`.
 */
function sanitizePublicIssues(
	result: unknown,
): readonly PublicIssue[] | undefined {
	if (!Array.isArray(result)) return undefined;
	const issues: PublicIssue[] = [];
	for (const entry of result) {
		if (typeof entry !== "object" || entry === null) continue;
		const { message, path, code, pointer } = entry as Record<
			string,
			unknown
		>;
		if (typeof message !== "string") continue;
		const issue: PublicIssue = { message };
		const safePath = sanitizeIssuePath(path);
		if (safePath !== undefined) issue.path = safePath;
		if (typeof code === "string") issue.code = code;
		if (typeof pointer === "string") issue.pointer = pointer;
		issues.push(issue);
	}
	return issues;
}

/** Keeps only the documented path segments: property keys or `{ key }`. */
function sanitizeIssuePath(path: unknown): PublicIssue["path"] | undefined {
	if (!Array.isArray(path)) return undefined;
	const segments: Array<PropertyKey | { readonly key: PropertyKey }> = [];
	for (const segment of path) {
		if (
			typeof segment === "string" ||
			typeof segment === "number" ||
			typeof segment === "symbol"
		) {
			segments.push(segment);
			continue;
		}
		if (typeof segment === "object" && segment !== null) {
			const { key } = segment as { key?: unknown };
			if (
				typeof key === "string" ||
				typeof key === "number" ||
				typeof key === "symbol"
			) {
				segments.push({ key });
			}
		}
	}
	return segments;
}
