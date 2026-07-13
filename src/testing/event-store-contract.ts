import type { AnyDomainEvent } from "../aggregate/domain-event";
import type { EventStore, StreamKey } from "../repo/event-store";
import {
	assert,
	bindContractEnvironment,
	type ContractTest,
} from "./contract-assertions";

/** One named contract test for an EventStore adapter. */
export type EventStoreContractTest = ContractTest;

/** One isolated adapter instance. The suite creates one per test. */
export interface EventStoreContractEnvironment<Evt extends AnyDomainEvent> {
	readonly store: EventStore<Evt>;
	teardown?(): Promise<void>;
}

/**
 * Inputs needed to prove the EventStore's qualified-key contract.
 *
 * `createCollidingStreamKeys` must return two valid stream keys with the same
 * raw aggregate id and different aggregate types. `createEvent` must return an
 * event addressed to the supplied key; different sequence values must produce
 * different event ids.
 */
export interface EventStoreContractHarness<Evt extends AnyDomainEvent> {
	createEnvironment(): Promise<EventStoreContractEnvironment<Evt>>;
	createCollidingStreamKeys(): readonly [StreamKey, StreamKey];
	createEvent(stream: StreamKey, sequence: number): Evt;
}

/**
 * Reusable proof that an EventStore adapter treats `(aggregateType,
 * aggregateId)` as the stream identity instead of aliasing on the raw id.
 */
export function createEventStoreContractTests<Evt extends AnyDomainEvent>(
	harness: EventStoreContractHarness<Evt>,
): EventStoreContractTest[] {
	const inEnv = bindContractEnvironment(() => harness.createEnvironment());

	return [
		{
			name: "qualified stream key: equal aggregate ids remain isolated by aggregate type",
			run: inEnv(async ({ store }) => {
				const [firstKey, secondKey] = harness.createCollidingStreamKeys();
				assert(
					firstKey.aggregateId === secondKey.aggregateId,
					"createCollidingStreamKeys must return equal raw aggregate ids",
				);
				assert(
					firstKey.aggregateType !== secondKey.aggregateType,
					"createCollidingStreamKeys must return different aggregate types",
				);

				const firstEvent = harness.createEvent(firstKey, 1);
				const secondEvent = harness.createEvent(secondKey, 2);
				assert(
					firstEvent.eventId !== secondEvent.eventId,
					"createEvent must produce different event ids for different sequence values",
				);

				await store.append(firstKey, [firstEvent], { expectedVersion: 0 });
				await store.append(secondKey, [secondEvent], { expectedVersion: 0 });

				const firstStream = await store.readStream({ ...firstKey });
				const secondStream = await store.readStream({ ...secondKey });
				assert(
					firstStream.length === 1 &&
						firstStream[0]?.eventId === firstEvent.eventId,
					"the first aggregate type must retain only its own event; key objects are value addresses, not identity tokens",
				);
				assert(
					secondStream.length === 1 &&
						secondStream[0]?.eventId === secondEvent.eventId,
					"the second aggregate type must retain only its own event when the raw id collides",
				);
			}),
		},
	];
}
