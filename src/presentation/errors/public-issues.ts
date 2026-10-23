import type { PublicIssue } from "@shirudo/base-error";

/**
 * Re-emits a `publicIssues()` result through the {@link PublicIssue}
 * whitelist so only the documented wire fields (`message`, `path`, `code`,
 * `pointer`) can reach a client: a duck-typed implementation must not be
 * able to smuggle arbitrary payloads into the view. Each field crosses only
 * with its documented type, and an entry that is no object is dropped. A
 * `message` crosses only with `issueMessages`, also when a duck-typed
 * `publicIssues()` returns one without the opt-in.
 */
export function sanitizePublicIssues(
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
