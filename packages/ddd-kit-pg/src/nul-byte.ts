/**
 * Replaces each NUL byte with U+FFFD. A PostgreSQL text column cannot hold a
 * NUL byte, so a statement that writes one would fail on every attempt.
 */
export function replaceNulBytes(text: string): string {
	return text.replaceAll("\u0000", "\uFFFD");
}
