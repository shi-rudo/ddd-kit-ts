import type { PublicIssue } from "@shirudo/base-error";
import {
	definePublicErrors,
	LocalizedMessageSet,
} from "@shirudo/base-error/public-error";

/** Details shape carried by the validation views this catalog projects. */
export interface PublicErrorViewDetails {
	/** Whitelisted field issues, present only for a validation error. */
	readonly issues: readonly PublicIssue[];
}

/** Single-locale message set for the kit's built-in English texts. */
function english(message: string): LocalizedMessageSet {
	return new LocalizedMessageSet({
		baseLocale: "en",
		messages: { en: message },
	});
}

/**
 * Duck-types the base-error validation family by capability, not
 * `instanceof` (duplicate installs), and not by a name whitelist (custom
 * codes): a SCREAMING_SNAKE `name` (base-error names a `ValidationError`
 * after its code), `category === "VALIDATION"` (kit and
 * convention-following consumer errors carry DOMAIN / INFRASTRUCTURE /
 * WIRING, so a structured infrastructure error exposing a
 * `publicIssues()` method is NOT mistaken for one), and a `publicIssues()`
 * that actually returns an array. Reads and the probe call may throw on
 * hostile inputs; `project` contains a throwing matcher as a miss, which
 * keeps the projection total.
 */
function isValidationErrorLike(
	error: unknown,
): error is { publicIssues(): unknown[] } {
	if (typeof error !== "object" || error === null) return false;
	const { name, category, publicIssues } = error as {
		name?: unknown;
		category?: unknown;
		publicIssues?: unknown;
	};
	return (
		typeof name === "string" &&
		/^[A-Z][A-Z0-9_]*$/.test(name) &&
		category === "VALIDATION" &&
		typeof publicIssues === "function" &&
		Array.isArray((error as { publicIssues(): unknown }).publicIssues())
	);
}

/**
 * Re-emits a `publicIssues()` result through the {@link PublicIssue}
 * whitelist so only the documented wire fields (`message`, `path`, `code`,
 * `pointer`) can reach a client: a duck-typed implementation must not be
 * able to smuggle arbitrary payloads into the view. Drops entries without
 * a string `message`.
 */
function sanitizePublicIssues(result: unknown[]): readonly PublicIssue[] {
	const issues: PublicIssue[] = [];
	for (const entry of result) {
		if (typeof entry !== "object" || entry === null) continue;
		const { message, path, code, pointer } = entry as Record<string, unknown>;
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

/**
 * Builds the kit's public-error catalog: one descriptor per public code
 * the kit itself can emit, ready for base-error's `project` / `localize`
 * / `toProblem` pipeline, and the single source of truth behind
 * `toPublicErrorView`. Messages are client-safe and carry no occurrence
 * data (no id, version, or technical detail).
 *
 * A FACTORY, deliberately not a shared instance: base-error's
 * `registerByCode` / `register` widen the TYPE but register into the
 * same underlying catalog, so a shared export would let one consumer's
 * extension leak into every other (and a second registration of the
 * same code throws). Each caller builds its own catalog at its
 * composition root and extends that:
 *
 * ```ts
 * import { createKitPublicErrors } from "@shirudo/ddd-kit/presentation";
 *
 * const catalog = createKitPublicErrors().registerByCode(
 *   "ORDER_ALREADY_SHIPPED",
 *   {
 *     publicCode: "ORDER_ALREADY_SHIPPED",
 *     status: 409,
 *     userMessages: new LocalizedMessageSet({
 *       baseLocale: "en",
 *       messages: { en: "This order has already been shipped." },
 *     }),
 *   },
 * );
 * ```
 *
 * Kit errors resolve by their stable `code` (since v3,
 * `error.name === error.code`); the base-error validation family resolves
 * by capability (see the matcher), with its whitelisted issues projected
 * under `details.issues`. Everything else degrades to the
 * `INTERNAL_ERROR` fallback.
 */
export function createKitPublicErrors() {
	return definePublicErrors({
		fallback: {
			publicCode: "INTERNAL_ERROR",
			status: 500,
			userMessages: english("An unexpected error occurred."),
		},
	})
		.registerByCode("AGGREGATE_NOT_FOUND", {
			publicCode: "AGGREGATE_NOT_FOUND",
			status: 404,
			userMessages: english("The requested resource could not be found."),
		})
		.registerByCode("CONCURRENCY_CONFLICT", {
			publicCode: "CONCURRENCY_CONFLICT",
			status: 409,
			retryable: true,
			userMessages: english(
				"The resource was modified by another request. Please reload and try again.",
			),
		})
		.registerByCode("DUPLICATE_AGGREGATE", {
			publicCode: "DUPLICATE_AGGREGATE",
			status: 409,
			userMessages: english("The resource already exists."),
		})
		.registerByCode("INVALID_MONEY", {
			publicCode: "INVALID_MONEY",
			status: 422,
			userMessages: english(
				"The submitted amount is not a valid monetary value.",
			),
		})
		.registerByCode("MONEY_CURRENCY_MISMATCH", {
			publicCode: "MONEY_CURRENCY_MISMATCH",
			status: 422,
			userMessages: english("The amounts involved use different currencies."),
		})
		.registerByCode("MONEY_SCALE_MISMATCH", {
			publicCode: "MONEY_SCALE_MISMATCH",
			status: 422,
			userMessages: english(
				"The amounts involved use different decimal precisions.",
			),
		})
		.registerByCode("MONEY_PRECISION_LOSS", {
			publicCode: "MONEY_PRECISION_LOSS",
			status: 422,
			userMessages: english(
				"The submitted amount has more decimal places than the currency allows.",
			),
		})
		.registerByCode("UNKNOWN_CURRENCY", {
			publicCode: "UNKNOWN_CURRENCY",
			status: 422,
			userMessages: english("The currency is not supported."),
		})
		.register({
			match: isValidationErrorLike,
			descriptor: {
				publicCode: "VALIDATION_FAILED",
				status: 422,
				userMessages: english("The submitted data is invalid."),
				projectDetails: (error): PublicErrorViewDetails => ({
					issues: sanitizePublicIssues(error.publicIssues()),
				}),
			},
		});
}
