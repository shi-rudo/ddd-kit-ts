/**
 * Renders a thrown value into the buses' string error channel without
 * destroying diagnostics: an `Error` contributes its message; anything
 * else (driver SDKs commonly throw structured objects like
 * `{ code: "DB_CONN" }`) is JSON-serialised so the fields stay readable;
 * `String(error)` would collapse it to `"[object Object]"`.
 */
export function describeThrown(error: unknown): string {
	if (error instanceof Error) return error.message;
	try {
		const json = JSON.stringify(error);
		// JSON.stringify yields undefined for undefined/functions/symbols.
		if (json !== undefined) return json;
	} catch {
		// Cyclic or BigInt-bearing values cannot be JSON-serialised.
	}
	return String(error);
}
