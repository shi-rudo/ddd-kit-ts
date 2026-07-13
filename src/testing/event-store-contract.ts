import type { AggregateAddress } from "../aggregate/aggregate-address";
import type { AnyDomainEvent } from "../aggregate/domain-event";
import type { EventStore } from "../repo/event-store";
import {
	assert,
	assertChainContainsKitError,
	bindContractEnvironment,
	type ContractTest,
	captureRejection,
} from "./contract-assertions";

/** One named contract test for an EventStore adapter. */
export type EventStoreContractTest = ContractTest;

/** One isolated adapter instance. The suite creates one per test. */
export interface EventStoreContractEnvironment<Evt extends AnyDomainEvent> {
	readonly store: EventStore<Evt>;
	teardown?(): Promise<void>;
}

/**
 * Inputs needed to prove the EventStore's observable port contract.
 *
 * `createCollidingStreamKeys` must return two valid stream keys with the same
 * raw aggregate id and different aggregate types. `createEvent` must return an
 * event addressed to the supplied key; different sequence values must produce
 * different event ids.
 */
export interface EventStoreContractHarness<Evt extends AnyDomainEvent> {
	createEnvironment(): Promise<EventStoreContractEnvironment<Evt>>;
	createCollidingStreamKeys(): readonly [AggregateAddress, AggregateAddress];
	createEvent(stream: AggregateAddress, sequence: number): Evt;
}

/**
 * Reusable proof of an EventStore adapter's portable semantics: qualified
 * value identity, ordered reads and slicing, OCC error mapping and atomicity,
 * no-op empty appends, and detached return arrays. Physical-position
 * corruption needs adapter-specific fixture support and is tested there.
 */
export function createEventStoreContractTests<Evt extends AnyDomainEvent>(
	harness: EventStoreContractHarness<Evt>,
): EventStoreContractTest[] {
	const inEnv = bindContractEnvironment(() => harness.createEnvironment());
	const hasSameEventIds = (
		actual: ReadonlyArray<Evt>,
		expected: ReadonlyArray<Evt>,
	): boolean =>
		actual.length === expected.length &&
		actual.every((event, index) => event.eventId === expected[index]?.eventId);

	return [
		{
			name: "unknown stream: read returns an empty owned array",
			run: inEnv(async ({ store }) => {
				const [firstKey] = harness.createCollidingStreamKeys();
				const missing = await store.readStream({ ...firstKey });
				assert(
					missing.length === 0,
					"an unknown qualified stream must read as an empty array",
				);
			}),
		},
		{
			name: "empty append: no version check and no stream creation",
			run: inEnv(async ({ store }) => {
				const [firstKey] = harness.createCollidingStreamKeys();
				await store.append(firstKey, [], { expectedVersion: 999 });
				const event = harness.createEvent(firstKey, 1);
				await store.append({ ...firstKey }, [event], { expectedVersion: 0 });
				const stored = await store.readStream(firstKey);
				assert(
					stored.length === 1 && stored[0]?.eventId === event.eventId,
					"an empty append must not check OCC or create an empty stream",
				);
			}),
		},
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
		{
			name: "append/read: event order and fromVersion slicing are preserved",
			run: inEnv(async ({ store }) => {
				const [firstKey] = harness.createCollidingStreamKeys();
				const events = [1, 2, 3].map((sequence) =>
					harness.createEvent(firstKey, sequence),
				);
				await store.append(firstKey, events, { expectedVersion: 0 });
				const whole = await store.readStream({ ...firstKey });
				const afterTwo = await store.readStream(
					{ ...firstKey },
					{
						fromVersion: 2,
					},
				);
				assert(
					hasSameEventIds(whole, events),
					"reads must preserve append order",
				);
				assert(
					afterTwo.length === 1 && afterTwo[0]?.eventId === events[2]?.eventId,
					"fromVersion 2 must return exactly the events after the first two positions",
				);
			}),
		},
		{
			name: "qualified fromVersion: slicing one type cannot observe a colliding raw id",
			run: inEnv(async ({ store }) => {
				const [firstKey, secondKey] = harness.createCollidingStreamKeys();
				const firstEvents = [10, 11, 12].map((sequence) =>
					harness.createEvent(firstKey, sequence),
				);
				const secondEvents = [20, 21].map((sequence) =>
					harness.createEvent(secondKey, sequence),
				);
				await store.append(firstKey, firstEvents, { expectedVersion: 0 });
				await store.append(secondKey, secondEvents, { expectedVersion: 0 });
				const firstTail = await store.readStream(
					{ ...firstKey },
					{
						fromVersion: 1,
					},
				);
				const secondTail = await store.readStream(
					{ ...secondKey },
					{
						fromVersion: 1,
					},
				);
				assert(
					firstTail.length === 2 &&
						firstTail[0]?.eventId === firstEvents[1]?.eventId &&
						firstTail[1]?.eventId === firstEvents[2]?.eventId,
					"fromVersion must slice only the requested aggregate type's stream",
				);
				assert(
					secondTail.length === 1 &&
						secondTail[0]?.eventId === secondEvents[1]?.eventId,
					"a colliding raw id under another type must retain its independent version window",
				);
			}),
		},
		{
			name: "OCC: a rejected multi-event append is atomic and maps to ConcurrencyConflictError",
			run: inEnv(async ({ store }) => {
				const [firstKey] = harness.createCollidingStreamKeys();
				const seeded = [
					harness.createEvent(firstKey, 30),
					harness.createEvent(firstKey, 31),
				];
				await store.append(firstKey, seeded, { expectedVersion: 0 });
				const rejection = await captureRejection(
					store.append(
						{ ...firstKey },
						[
							harness.createEvent(firstKey, 32),
							harness.createEvent(firstKey, 33),
						],
						{ expectedVersion: 1 },
					),
				);
				assertChainContainsKitError(
					rejection,
					["CONCURRENCY_CONFLICT"],
					"a stale append must map the adapter conflict to ConcurrencyConflictError",
				);
				const stored = await store.readStream(firstKey);
				assert(
					stored.length === 2 &&
						stored[0]?.eventId === seeded[0]?.eventId &&
						stored[1]?.eventId === seeded[1]?.eventId,
					"a rejected multi-event append must leave the stream untouched",
				);
			}),
		},
		{
			name: "OCC: duplicate create is rejected atomically with a sanctioned kit error",
			run: inEnv(async ({ store }) => {
				const [firstKey] = harness.createCollidingStreamKeys();
				const seeded = harness.createEvent(firstKey, 50);
				await store.append(firstKey, [seeded], { expectedVersion: 0 });
				const rejection = await captureRejection(
					store.append(
						{ ...firstKey },
						[
							harness.createEvent(firstKey, 51),
							harness.createEvent(firstKey, 52),
						],
						{ expectedVersion: 0 },
					),
				);
				assertChainContainsKitError(
					rejection,
					["CONCURRENCY_CONFLICT", "DUPLICATE_AGGREGATE"],
					"a duplicate create must map to ConcurrencyConflictError or the sanctioned DuplicateAggregateError",
				);
				const stored = await store.readStream(firstKey);
				assert(
					stored.length === 1 && stored[0]?.eventId === seeded.eventId,
					"a rejected duplicate-create batch must leave the existing stream untouched",
				);
			}),
		},
		{
			name: "OCC: an expectedVersion ahead of an unknown stream conflicts without creating it",
			run: inEnv(async ({ store }) => {
				const [firstKey] = harness.createCollidingStreamKeys();
				const rejection = await captureRejection(
					store.append(firstKey, [harness.createEvent(firstKey, 60)], {
						expectedVersion: 3,
					}),
				);
				assertChainContainsKitError(
					rejection,
					["CONCURRENCY_CONFLICT"],
					"an expectedVersion ahead of the stream must map to ConcurrencyConflictError",
				);
				const first = harness.createEvent(firstKey, 61);
				await store.append({ ...firstKey }, [first], { expectedVersion: 0 });
				const stored = await store.readStream(firstKey);
				assert(
					stored.length === 1 && stored[0]?.eventId === first.eventId,
					"the rejected append must not leave an empty stream or partial events behind",
				);
			}),
		},
		{
			name: "read ownership: a mutation attempt cannot mutate the stream",
			run: inEnv(async ({ store }) => {
				const [firstKey] = harness.createCollidingStreamKeys();
				const seeded = harness.createEvent(firstKey, 40);
				await store.append(firstKey, [seeded], { expectedVersion: 0 });
				const callerOwned = (await store.readStream(firstKey)) as Evt[];
				try {
					callerOwned.push(harness.createEvent(firstKey, 41));
				} catch {
					// A detached frozen array is also valid: the contract forbids exposing
					// mutable live state, not defensive immutability.
				}
				const stored = await store.readStream({ ...firstKey });
				assert(
					stored.length === 1 && stored[0]?.eventId === seeded.eventId,
					"readStream must return an owned array, never live internal state",
				);
			}),
		},
	];
}
