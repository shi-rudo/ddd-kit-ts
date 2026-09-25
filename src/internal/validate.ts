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

/**
 * The largest delay that `setTimeout` honors. A larger delay does not wait
 * longer: the runtime fires the timer after about 1 ms.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Guard for time options that a timer waits for, in milliseconds. */
export function assertTimerDelay(
	context: string,
	field: string,
	value: number,
): void {
	if (!Number.isFinite(value) || value < 0 || value > MAX_TIMER_DELAY_MS) {
		throw new RangeError(
			`${context}: ${field} must be a finite number of milliseconds from 0 ` +
				`to ${MAX_TIMER_DELAY_MS}, got ${value}`,
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

/** Guard for retained-record capacities that must fit exact JS integers. */
export function assertPositiveSafeInteger(
	context: string,
	field: string,
	value: number,
): void {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new RangeError(
			`${context}: ${field} must be a positive safe integer, got ${value}`,
		);
	}
}

/** Guard for stream positions that must fit exact JS integers. */
export function assertNonNegativeSafeInteger(
	context: string,
	field: string,
	value: number,
): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new RangeError(
			`${context}: ${field} must be a non-negative safe integer, got ${value}`,
		);
	}
}
