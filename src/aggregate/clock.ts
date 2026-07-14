/**
 * Clock function producing a valid `Date` for the current instant.
 * Event and snapshot reads throw `TypeError` when the result is invalid.
 */
export type ClockFactory = () => Date;

/** Immutable library default captured by the default domain-event factory. */
export const defaultClockFactory: ClockFactory = () => new Date();

/** Internal defensive read shared by events and aggregate snapshots. */
export function readClock(factory: ClockFactory): Date {
	const reading = factory();
	const value = reading instanceof Date ? reading.getTime() : Number.NaN;
	if (!Number.isFinite(value)) {
		throw new TypeError("domain-event clock must return a valid Date");
	}
	return new Date(value);
}
