/** Clock function producing a `Date` for the current instant. */
export type ClockFactory = () => Date;

/** Immutable library default captured by the default domain-event factory. */
export const defaultClockFactory: ClockFactory = () => new Date();

/** Internal defensive read shared by events and aggregate snapshots. */
export function readClock(factory: ClockFactory): Date {
	return new Date(factory().getTime());
}
