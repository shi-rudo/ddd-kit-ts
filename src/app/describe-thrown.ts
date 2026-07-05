/**
 * Renders a thrown value into the buses' string error channel without
 * destroying diagnostics: an `Error` contributes its message; anything
 * else (driver SDKs commonly throw structured objects like
 * `{ code: "DB_CONN" }`) is JSON-serialised so the fields stay readable;
 * `String(error)` would collapse it to `"[object Object]"`.
 */
export function describeThrown(error: unknown): string {
	try {
		if (error instanceof Error) return error.message;
	} catch {
		// A revoked Proxy makes `instanceof` itself throw, and a hostile
		// `message` getter can throw on an Error subclass: fall through to
		// the serialisation attempts below.
	}
	try {
		const json = JSON.stringify(error);
		// JSON.stringify yields undefined for undefined/functions/symbols.
		if (json !== undefined) return json;
	} catch {
		// Cyclic or BigInt-bearing values cannot be JSON-serialised.
	}
	try {
		return String(error);
	} catch {
		// String() itself throws for a null-prototype object (no toString)
		// whose Symbol.toPrimitive chain is absent; the default bus mapper
		// must stay total.
		return "[unrepresentable thrown value]";
	}
}
