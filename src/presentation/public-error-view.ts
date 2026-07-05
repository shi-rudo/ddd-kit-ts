import {
	localize,
	type LocalizedPublicError,
	project,
	type PublicError,
	type PublicErrorCatalog,
} from "@shirudo/base-error/public-error";
import {
	createKitPublicErrors,
	type PublicErrorViewDetails,
} from "./kit-public-errors";

export type { PublicErrorViewDetails } from "./kit-public-errors";

/** Public code and message used for any unmapped or non-kit error. */
const FALLBACK_CODE = "INTERNAL_ERROR";
const FALLBACK_MESSAGE = "An unexpected error occurred.";
/** BCP 47 locale the built-in messages are written in. */
const DEFAULT_LOCALE = "en";

// Private default instance: never exported and never handed out, so no
// consumer can register into it (extensions go through options.catalog
// on a consumer-built createKitPublicErrors() instance).
const defaultCatalog = createKitPublicErrors();

/** Options for {@link toPublicErrorView}. */
export interface PublicErrorViewOptions {
	/**
	 * PREFERRED BCP 47 locale tag. Resolution follows base-error's
	 * `localize` (RFC 4647 lookup with base-locale fallback), and the view
	 * carries the locale that actually RESOLVED, never a claimed one: with
	 * the kit's built-in English messages a `"de-DE"` preference still
	 * yields `locale: "en"` unless the catalog carries German. Default
	 * `"en"`.
	 */
	locale?: string;
	/**
	 * The public-error catalog to resolve against. Defaults to a private
	 * {@link createKitPublicErrors} instance; pass your own extended
	 * catalog (`createKitPublicErrors().registerByCode(...)`) so your own
	 * codes and locales resolve through the same pipeline.
	 */
	catalog?: PublicErrorCatalog<string>;
}

/**
 * Maps a kit error (or any caught value) to a base-error
 * {@link LocalizedPublicError} by delegating to the public-error pipeline:
 * `project` against a catalog (default {@link createKitPublicErrors}), then
 * `localize` with the catalog's messages. A **transport-neutral**,
 * client-safe representation (`code`, `message`, `locale`, optional
 * `details`); feed it into base-error's `toProblem` (HTTP / RFC 9457), a
 * gRPC status mapper, or a CLI exit-code table, whichever boundary you
 * are at.
 *
 * Total over `unknown`: an unmatched or hostile value (throwing
 * accessors, a throwing or lying `publicIssues()`) degrades to the
 * catalog's fallback view rather than leaking the technical message or
 * crashing the 500 path. Kit errors resolve by their stable `code`
 * (`error.name === error.code`, minification- and duplicate-install-
 * stable); the base-error validation family resolves by capability with
 * its whitelisted issues sanitized under `details.issues` (see the
 * catalog). No base-error adoption is required to consume the view: it
 * is a plain object read with plain property access.
 *
 * @example
 * ```ts
 * import { toPublicErrorView } from "@shirudo/ddd-kit/presentation";
 * import { toProblem } from "@shirudo/base-error/public-error";
 *
 * const { body, status } = toProblem(
 *   { status: 500 }, // or the catalog, for per-code type/status
 *   toPublicErrorView(error),
 * );
 * return Response.json(body, { status });
 * ```
 */
export function toPublicErrorView(
	error: unknown,
	options: PublicErrorViewOptions = {},
): LocalizedPublicError<PublicErrorViewDetails> {
	const locale = options.locale ?? DEFAULT_LOCALE;
	const catalog = options.catalog ?? defaultCatalog;
	// The catch is the totality guarantee's last line: `project` is total
	// by contract, but a hostile catalog or message set handed in via
	// options must still degrade to the fallback view, never crash the
	// 500 path.
	try {
		const view = project(catalog, error) as PublicError<
			PublicErrorViewDetails,
			string
		>;
		const messages = catalog.messagesFor(view.code);
		if (messages !== undefined) {
			return localize(view, messages, { locales: [locale] });
		}
		// A consumer descriptor without userMessages: keep the view, attach
		// the generic fallback text so the type stays LocalizedPublicError.
		return { ...view, message: FALLBACK_MESSAGE, locale: DEFAULT_LOCALE };
	} catch {
		return {
			code: FALLBACK_CODE,
			message: FALLBACK_MESSAGE,
			locale: DEFAULT_LOCALE,
		};
	}
}
