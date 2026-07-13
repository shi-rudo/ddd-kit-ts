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
			name: "unknown stream: read reports explicit absence at version zero",
			run: inEnv(async ({ store }) => {
				const [firstKey] = harness.createCollidingStreamKeys();
				const missing = await store.readStream({ ...firstKey });
				assert(
					!missing.exists &&
						missing.lastVersion === 0 &&
						missing.events.length === 0,
					"an unknown qualified stream must return the explicit missing state",
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
					stored.exists &&
						stored.lastVersion === 1 &&
						stored.events.length === 1 &&
						stored.events[0]?.eventId === event.eventId,
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
					firstStream.exists &&
						firstStream.events.length === 1 &&
						firstStream.events[0]?.eventId === firstEvent.eventId,
					"the first aggregate type must retain only its own event; key objects are value addresses, not identity tokens",
				);
				assert(
					secondStream.exists &&
						secondStream.events.length === 1 &&
						secondStream.events[0]?.eventId === secondEvent.eventId,
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
					whole.exists &&
						whole.lastVersion === 3 &&
						hasSameEventIds(whole.events, events),
					"reads must preserve append order",
				);
				assert(
					afterTwo.exists &&
						afterTwo.lastVersion === 3 &&
						afterTwo.events.length === 1 &&
						afterTwo.events[0]?.eventId === events[2]?.eventId,
					"fromVersion 2 must return exactly the events after the first two positions",
				);
			}),
		},
		{
			name: "bounded read: toVersion is inclusive while lastVersion remains the actual head",
			run: inEnv(async ({ store }) => {
				const [firstKey] = harness.createCollidingStreamKeys();
				const events = [1, 2, 3, 4].map((sequence) =>
					harness.createEvent(firstKey, sequence),
				);
				await store.append(firstKey, events, { expectedVersion: 0 });

				const bounded = await store.readStream(
					{ ...firstKey },
					{ fromVersion: 1, toVersion: 3 },
				);

				assert(
					bounded.exists &&
						bounded.lastVersion === 4 &&
						hasSameEventIds(bounded.events, events.slice(1, 3)),
					"(fromVersion, toVersion] must include positions 2 and 3 while lastVersion reports the actual head at 4",
				);
			}),
		},
		{
			name: "bounded read edges: zero, beyond-head, and inverted ranges are empty or clamped",
			run: inEnv(async ({ store }) => {
				const [firstKey] = harness.createCollidingStreamKeys();
				const events = [1, 2, 3].map((sequence) =>
					harness.createEvent(firstKey, sequence),
				);
				await store.append(firstKey, events, { expectedVersion: 0 });

				const atZero = await store.readStream(
					{ ...firstKey },
					{ toVersion: 0 },
				);
				const beyondHead = await store.readStream(
					{ ...firstKey },
					{ toVersion: 99 },
				);
				const inverted = await store.readStream(
					{ ...firstKey },
					{ fromVersion: 2, toVersion: 1 },
				);
				const equalBounds = await store.readStream(
					{ ...firstKey },
					{ fromVersion: 2, toVersion: 2 },
				);

				assert(
					atZero.exists &&
						atZero.lastVersion === 3 &&
						atZero.events.length === 0,
					"toVersion=0 must return an existing empty window with the actual head",
				);
				assert(
					beyondHead.exists &&
						beyondHead.lastVersion === 3 &&
						hasSameEventIds(beyondHead.events, events),
					"toVersion beyond the head must clamp to the actual stream head",
				);
				assert(
					inverted.exists &&
						inverted.lastVersion === 3 &&
						inverted.events.length === 0 &&
						equalBounds.exists &&
						equalBounds.lastVersion === 3 &&
						equalBounds.events.length === 0,
					"fromVersion >= toVersion describes an empty interval and must not throw",
				);
			}),
		},
		{
			name: "read state: empty and beyond-head windows retain existence and the actual stream head",
			run: inEnv(async ({ store }) => {
				const [firstKey] = harness.createCollidingStreamKeys();
				await store.append(
					firstKey,
					[harness.createEvent(firstKey, 4), harness.createEvent(firstKey, 5)],
					{ expectedVersion: 0 },
				);

				const atHead = await store.readStream(
					{ ...firstKey },
					{
						fromVersion: 2,
					},
				);
				const beyondHead = await store.readStream(
					{ ...firstKey },
					{
						fromVersion: 99,
					},
				);

				for (const result of [atHead, beyondHead]) {
					assert(
						result.exists &&
							result.lastVersion === 2 &&
							result.events.length === 0,
						"an empty read window must retain stream existence and report the actual head, even when fromVersion is beyond it",
					);
				}
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
					firstTail.exists &&
						firstTail.lastVersion === 3 &&
						firstTail.events.length === 2 &&
						firstTail.events[0]?.eventId === firstEvents[1]?.eventId &&
						firstTail.events[1]?.eventId === firstEvents[2]?.eventId,
					"fromVersion must slice only the requested aggregate type's stream",
				);
				assert(
					secondTail.exists &&
						secondTail.lastVersion === 2 &&
						secondTail.events.length === 1 &&
						secondTail.events[0]?.eventId === secondEvents[1]?.eventId,
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
					stored.exists &&
						stored.lastVersion === 2 &&
						stored.events.length === 2 &&
						stored.events[0]?.eventId === seeded[0]?.eventId &&
						stored.events[1]?.eventId === seeded[1]?.eventId,
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
					stored.exists &&
						stored.lastVersion === 1 &&
						stored.events.length === 1 &&
						stored.events[0]?.eventId === seeded.eventId,
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
					stored.exists &&
						stored.lastVersion === 1 &&
						stored.events.length === 1 &&
						stored.events[0]?.eventId === first.eventId,
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
				const callerOwned = (await store.readStream(firstKey)).events as Evt[];
				try {
					callerOwned.push(harness.createEvent(firstKey, 41));
				} catch {
					// A detached frozen array is also valid: the contract forbids exposing
					// mutable live state, not defensive immutability.
				}
				const stored = await store.readStream({ ...firstKey });
				assert(
					stored.exists &&
						stored.events.length === 1 &&
						stored.events[0]?.eventId === seeded.eventId,
					"readStream must return an owned array, never live internal state",
				);
			}),
		},
	];
}
