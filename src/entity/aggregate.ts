export type Version = number & { readonly __v: true };

export interface DomainEvent<T extends string, P> {
	type: T;
	payload: P;
	occurredAt: Date;
}

export interface Aggregate<State, Evt extends DomainEvent<string, unknown>> {
	state: Readonly<State>;
	version: Version;
	pendingEvents: ReadonlyArray<Evt>;
}

export function aggregate<State, Evt extends DomainEvent<string, unknown>>(
	state: State,
	version: Version = 0 as Version,
): Aggregate<State, Evt> {
	return { state, version, pendingEvents: [] };
}

export function withEvent<S, E extends DomainEvent<string, unknown>>(
	agg: Aggregate<S, E>,
	evt: E,
): Aggregate<S, E> {
	return { ...agg, pendingEvents: [...agg.pendingEvents, evt] };
}

export function bump<S, E extends DomainEvent<string, unknown>>(
	agg: Aggregate<S, E>,
): Aggregate<S, E> {
	return { ...agg, version: (agg.version + 1) as Version };
}
