export interface EventBus<Evt> {
	publish: (events: ReadonlyArray<Evt>) => Promise<void>;
}
export interface Outbox<Evt> {
	add: (events: ReadonlyArray<Evt>) => Promise<void>;
}
export interface Clock {
	now: () => Date;
}
