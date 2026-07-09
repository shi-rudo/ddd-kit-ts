/**
 * Shared construction-time guards for numeric options. `context` names
 * the throwing component so the error reads like the component's own
 * validation ("OutboxDispatcher: pollIntervalMs must be...").
 */

/** Guard for numeric options that must be a non-negative finite number. */
export function assertNonNegativeFinite(
	context: string,
	field: string,
	value: number,
): void {
	if (!Number.isFinite(value) || value < 0) {
		throw new Error(
			`${context}: ${field} must be a non-negative finite number, got ${value}`,
		);
	}
}

/** Guard for count options that must be a whole number of at least 1. */
export function assertPositiveInteger(
	context: string,
	field: string,
	value: number,
): void {
	if (!Number.isInteger(value) || value < 1) {
		throw new Error(
			`${context}: ${field} must be an integer >= 1, got ${value}`,
		);
	}
}
