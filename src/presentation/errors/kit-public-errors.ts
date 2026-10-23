import type { PublicIssue } from "@shirudo/base-error";
import {
	definePublicErrors,
	LocalizedMessageSet,
} from "@shirudo/base-error/public-error";

/** Options for {@link createKitPublicErrors}. */
export interface KitPublicErrorsOptions {
	/**
	 * Adds the `message` of each validation issue to `details.issues`.
	 * Default `false`. Set it only for messages that you wrote: the default
	 * messages of Valibot and ArkType (and of Zod 3 for `enum`) embed the
	 * rejected value.
	 */
	readonly issueMessages?: boolean;
}

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
 * The matcher and the details projection of the validation family for one
 * catalog.
 *
 * The matcher duck-types the base-error validation family by capability,
 * not `instanceof` (duplicate installs), and not by a name whitelist
 * (custom codes): a SCREAMING_SNAKE `name` (base-error names a
 * `ValidationError` after its code), `category === "VALIDATION"` (kit and
 * convention-following consumer errors carry DOMAIN / INFRASTRUCTURE /
 * WIRING, so a structured infrastructure error exposing a
 * `publicIssues()` method is NOT mistaken for one), and a `publicIssues()`
 * that actually returns an array. Reads and the probe call may throw on
 * hostile inputs; `project` contains a throwing matcher as a miss, which
 * keeps the projection total.
 *
 * The match keeps the array that the probe call returned, so the
 * projection reads it instead of calling `publicIssues()` a second time.
 * Each catalog keeps its own arrays, because the probe asks for messages
 * only with `issueMessages`.
 */
function validationErrorProjection(options: {
	readonly issueMessages: boolean;
}) {
	const matchedIssues = new WeakMap<object, unknown[]>();
	return {
		match(error: unknown): error is object {
			if (typeof error !== "object" || error === null) return false;
			const { name, category, publicIssues } = error as {
				name?: unknown;
				category?: unknown;
				publicIssues?: unknown;
			};
			if (
				typeof name !== "string" ||
				!/^[A-Z][A-Z0-9_]*$/.test(name) ||
				category !== "VALIDATION" ||
				typeof publicIssues !== "function"
			) {
				return false;
			}
			const issues: unknown = publicIssues.call(error, {
				messages: options.issueMessages,
			});
			if (!Array.isArray(issues)) return false;
			matchedIssues.set(error, issues);
			return true;
		},
		projectDetails(error: object): PublicErrorViewDetails {
			return {
				issues: sanitizePublicIssues(matchedIssues.get(error) ?? [], options),
			};
		},
	};
}

/**
 * Re-emits a `publicIssues()` result through the {@link PublicIssue}
 * whitelist so only the documented wire fields (`message`, `path`, `code`,
 * `pointer`) can reach a client: a duck-typed implementation must not be
 * able to smuggle arbitrary payloads into the view. Each field crosses only
 * with its documented type, and an entry that is no object is dropped. A
 * `message` crosses only with `issueMessages`, also when a duck-typed
 * `publicIssues()` returns one without the opt-in.
 */
function sanitizePublicIssues(
	result: unknown[],
	options: { readonly issueMessages: boolean },
): readonly PublicIssue[] {
	const issues: PublicIssue[] = [];
	for (const entry of result) {
		if (typeof entry !== "object" || entry === null) continue;
		const { message, path, code, pointer } = entry as Record<string, unknown>;
		const issue: PublicIssue = {};
		if (options.issueMessages && typeof message === "string") {
			issue.message = message;
		}
		const safePath = sanitizeIssuePath(path);
		if (safePath !== undefined) issue.path = safePath;
		if (typeof code === "string") issue.code = code;
		if (typeof pointer === "string") issue.pointer = pointer;
		issues.push(issue);
	}
	return issues;
}

/**
 * Maps each path segment as base-error does: an object segment becomes
 * `{ key }`, and every key that is no property key becomes `null`. A
 * segment keeps its place, so the segments after it still name the field.
 */
function sanitizeIssuePath(path: unknown): PublicIssue["path"] | undefined {
	if (!Array.isArray(path)) return undefined;
	return path.map((segment: unknown) =>
		typeof segment === "object" && segment !== null
			? { key: propertyKeyOrNull((segment as { key?: unknown }).key) }
			: propertyKeyOrNull(segment),
	);
}

function propertyKeyOrNull(value: unknown): PropertyKey | null {
	return typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "symbol"
		? value
		: null;
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
 * import { createKitPublicErrors } from "@shirudo/ddd-kit/public-errors";
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
 * under `details.issues`. The message of an issue crosses only with
 * {@link KitPublicErrorsOptions.issueMessages}. Everything else degrades
 * to the `INTERNAL_ERROR` fallback.
 */
export function createKitPublicErrors(options: KitPublicErrorsOptions = {}) {
	const validation = validationErrorProjection({
		issueMessages: options.issueMessages === true,
	});
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
			// A conflict whose reason is version_unchanged names a defect of the
			// adapter, and the kit marks it not retryable. Telling the client to
			// retry would move the repeated load out of the process instead of
			// stopping it.
			projectRetryable: (error) =>
				(error as { readonly retryable?: unknown }).retryable !== false,
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
			match: validation.match,
			descriptor: {
				publicCode: "VALIDATION_FAILED",
				status: 422,
				userMessages: english("The submitted data is invalid."),
				projectDetails: validation.projectDetails,
			},
		});
}
