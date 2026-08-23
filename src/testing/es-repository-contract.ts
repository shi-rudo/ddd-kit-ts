import type { IAggregateRoot } from "../aggregate/aggregate";
import type { AggregateAddress } from "../aggregate/aggregate-address";
import {
	type AnyDomainEvent,
	type PendingDomainEvent,
} from "../aggregate/domain-event";
import type { Id } from "../core/id";
import type { CommittedDomainEvent } from "../events/ports";
import type { ReadStreamOptions, StreamReadResult } from "../repo/event-store";
import { deepEqual } from "../utils/array/deep-equal";
import {
	assert,
	assertChainContainsKitError,
	assertEqual,
	bindContractEnvironment,
	type ContractTest,
	captureRejection,
	describeError,
	gatedContractTest,
	loadAggregateOrFail,
	mintedPendingEventIds,
	sortedCommittedEventIds,
} from "./contract-assertions";

/** Event-sourced repositories normally expose no physical removal. */
export interface EsContractRepository<
	TAggregate extends IAggregateRoot<Id<string>, AnyDomainEvent>,
> {
	findById(id: TAggregate["id"]): Promise<TAggregate | undefined>;
	add(aggregate: TAggregate): void;
	update(aggregate: TAggregate): void;
}

export interface EsRepositoryContractEnvironment<
	TAggregate extends IAggregateRoot<Id<string>, TEvent>,
	TEvent extends AnyDomainEvent = AnyDomainEvent,
> {
	run<R>(
		work: (context: {
			repository: EsContractRepository<TAggregate>;
		}) => Promise<R>,
	): Promise<R>;
	committedOutboxEvents(): Promise<ReadonlyArray<CommittedDomainEvent<TEvent>>>;
	failNextOutboxWrite(error: Error): void;
	committedStreamEvents(
		stream: AggregateAddress<TAggregate["id"]>,
		options: ReadStreamOptions,
	): Promise<StreamReadResult<TEvent>>;
	teardown?(): Promise<void>;
}

export interface EsRepositoryContractHarness<
	TAggregate extends IAggregateRoot<Id<string>, TEvent>,
	TEvent extends AnyDomainEvent = AnyDomainEvent,
> {
	createEnvironment(): Promise<
		EsRepositoryContractEnvironment<TAggregate, TEvent>
	>;
	/** Fresh aggregate with exactly one recorded creation event. */
	createAggregate(): TAggregate;
	createAggregateWithId?(id: TAggregate["id"]): TAggregate;
	streamKeyFor(id: TAggregate["id"]): AggregateAddress<TAggregate["id"]>;
	/** Applies exactly one event and advances the aggregate version by one. */
	mutate(aggregate: TAggregate): void;
	snapshotState?(aggregate: TAggregate): unknown;
}

export type EsRepositoryContractTest = ContractTest;

/**
 * Contract suite for event-stream adapters using v3 Unit-of-Work receipts.
 *
 * `add` and `update` register intent only. At commit, the adapter appends the
 * receipt's exact event batch with the Unit of Work's expected version, in the
 * same transaction as the outbox. `run` must support overlapping calls so the
 * mandatory stale-writer proof exercises a real stream OCC predicate.
 */
export function createEsRepositoryContractTests<
	TAggregate extends IAggregateRoot<Id<string>, TEvent>,
	TEvent extends AnyDomainEvent = AnyDomainEvent,
>(
	harness: EsRepositoryContractHarness<TAggregate, TEvent>,
): EsRepositoryContractTest[] {
	type Environment = EsRepositoryContractEnvironment<TAggregate, TEvent>;
	const inEnvironment = bindContractEnvironment(() =>
		harness.createEnvironment(),
	);
	const readAll = { limit: 100 } as const;
	const createAggregateWithId = harness.createAggregateWithId;
	const snapshotState = harness.snapshotState;

	const load = (
		repository: EsContractRepository<TAggregate>,
		id: TAggregate["id"],
	): Promise<TAggregate> =>
		loadAggregateOrFail(
			repository,
			id,
			"the stream was not appended or replayed correctly",
		);
	const streamFor = (id: TAggregate["id"]) => harness.streamKeyFor(id);
	// Pre-flush identities: the in-memory batch must be recorded (minted)
	// before the adapter may flush it.
	const recordedIds = (
		events: ReadonlyArray<PendingDomainEvent<TEvent>>,
	): string[] =>
		mintedPendingEventIds(
			events,
			"pending events must be recorded before flush",
		);
	// Read-back identities: adapters may serialize committed events to rows
	// and decode them on read. A decoded event does not carry the in-memory
	// mint brand, and no contract demands re-minting on read, so only the
	// persisted identity is asserted here.
	const ids = (events: ReadonlyArray<TEvent>): string[] =>
		events.map((event) => {
			assert(
				typeof event.eventId === "string" && event.eventId.length > 0,
				"committed events must carry their persisted eventId",
			);
			return event.eventId;
		});
	const outboxIds = (
		events: ReadonlyArray<CommittedDomainEvent<TEvent>>,
	): string[] => sortedCommittedEventIds(events);

	async function seed(environment: Environment): Promise<TAggregate> {
		const aggregate = harness.createAggregate();
		await environment.run(async ({ repository }) => {
			repository.add(aggregate);
		});
		return aggregate;
	}

	const tests: EsRepositoryContractTest[] = [
		{
			name: "add appends the exact creation batch to stream and outbox",
			run: inEnvironment(async (environment) => {
				const aggregate = harness.createAggregate();
				const expectedIds = recordedIds(aggregate.pendingEvents);
				assertEqual(
					expectedIds.length,
					1,
					"createAggregate must record exactly one creation event",
				);
				await environment.run(async ({ repository }) => {
					repository.add(aggregate);
				});
				const stream = await environment.committedStreamEvents(
					streamFor(aggregate.id),
					readAll,
				);
				assert(
					stream.exists && deepEqual(ids(stream.events), expectedIds),
					"the stream must contain exactly the registered creation batch",
				);
				assert(
					deepEqual(
						outboxIds(await environment.committedOutboxEvents()),
						[...expectedIds].sort(),
					),
					"the outbox must contain the same exact creation batch",
				);
				assertEqual(
					aggregate.pendingEvents.length,
					0,
					"successful commit must acknowledge the creation batch",
				);
			}),
		},
		{
			name: "MANDATORY stale append: writer B conflicts after writer A commits and appends no prefix",
			run: inEnvironment(async (environment) => {
				const seeded = await seed(environment);
				let loaded!: () => void;
				const bLoaded = new Promise<void>((resolve) => {
					loaded = resolve;
				});
				let release!: () => void;
				const mayAppend = new Promise<void>((resolve) => {
					release = resolve;
				});
				const writerB = environment.run(async ({ repository }) => {
					const stale = await load(repository, seeded.id);
					loaded();
					await mayAppend;
					harness.mutate(stale);
					harness.mutate(stale);
					repository.update(stale);
				});
				await bLoaded;

				const winner = await environment.run(async ({ repository }) => {
					const current = await load(repository, seeded.id);
					harness.mutate(current);
					repository.update(current);
					return current;
				});
				const streamAfterWinner = await environment.committedStreamEvents(
					streamFor(seeded.id),
					readAll,
				);
				release();
				const rejection = await captureRejection(writerB);
				assertChainContainsKitError(
					rejection,
					["CONCURRENCY_CONFLICT"],
					`stale append must reject with ConcurrencyConflictError; got ${describeError(rejection)}`,
				);
				const finalStream = await environment.committedStreamEvents(
					streamFor(seeded.id),
					readAll,
				);
				assert(
					finalStream.exists &&
						deepEqual(ids(finalStream.events), ids(streamAfterWinner.events)),
					"a rejected multi-event append must leave no prefix in the stream",
				);
				const reloaded = await environment.run(({ repository }) =>
					load(repository, seeded.id),
				);
				assertEqual(
					reloaded.version,
					winner.version,
					"replay must end at the winning stream version",
				);
				if (snapshotState) {
					assert(
						deepEqual(
							snapshotState.call(harness, reloaded),
							snapshotState.call(harness, winner),
						),
						"replay must fold to writer A's state",
					);
				}
			}),
		},
		{
			name: "replay preserves emission order and returns no pending events",
			run: inEnvironment(async (environment) => {
				const aggregate = harness.createAggregate();
				harness.mutate(aggregate);
				harness.mutate(aggregate);
				const expectedIds = recordedIds(aggregate.pendingEvents);
				await environment.run(async ({ repository }) => {
					repository.add(aggregate);
				});
				const reloaded = await environment.run(({ repository }) =>
					load(repository, aggregate.id),
				);
				assertEqual(
					reloaded.version,
					expectedIds.length,
					"event-sourced version must equal the folded event count",
				);
				assertEqual(
					reloaded.pendingEvents.length,
					0,
					"replay must not re-record historical events",
				);
				if (snapshotState) {
					assert(
						deepEqual(
							snapshotState.call(harness, reloaded),
							snapshotState.call(harness, aggregate),
						),
						"replay must fold to the same state in emission order",
					);
				}
				const stream = await environment.committedStreamEvents(
					streamFor(aggregate.id),
					readAll,
				);
				assert(
					stream.exists && deepEqual(ids(stream.events), expectedIds),
					"the committed stream must preserve emission order",
				);
			}),
		},
		{
			name: "rollback leaves stream and outbox absent and acknowledges nothing",
			run: inEnvironment(async (environment) => {
				const aggregate = harness.createAggregate();
				harness.mutate(aggregate);
				const pending = [...aggregate.pendingEvents];
				await captureRejection(
					environment.run(async ({ repository }) => {
						repository.add(aggregate);
						throw new Error("rollback probe");
					}),
				);
				const stream = await environment.committedStreamEvents(
					streamFor(aggregate.id),
					readAll,
				);
				assert(!stream.exists, "rollback must leave the stream absent");
				assertEqual(
					(await environment.committedOutboxEvents()).length,
					0,
					"rollback must leave the outbox empty",
				);
				assert(
					deepEqual(aggregate.pendingEvents, pending),
					"rollback must retain the exact pending batch",
				);
			}),
		},
		{
			name: "retrying the same never-persisted instance after rollback creates the full stream",
			run: inEnvironment(async (environment) => {
				const aggregate = harness.createAggregate();
				harness.mutate(aggregate);
				const expectedIds = recordedIds(aggregate.pendingEvents);
				await captureRejection(
					environment.run(async ({ repository }) => {
						repository.add(aggregate);
						throw new Error("rollback probe");
					}),
				);
				// The documented retry carve-out: a never-persisted instance has
				// no row or stream to reload, so the caller re-adds the SAME
				// instance with its retained pending batch.
				await environment.run(async ({ repository }) => {
					repository.add(aggregate);
				});
				const stream = await environment.committedStreamEvents(
					streamFor(aggregate.id),
					readAll,
				);
				assert(
					stream.exists && deepEqual(ids(stream.events), expectedIds),
					"the retried add must create the stream with the full pending history",
				);
				assertEqual(
					aggregate.pendingEvents.length,
					0,
					"the successful retry must acknowledge the whole batch",
				);
			}),
		},
		{
			name: "outbox failure rolls the already-appended stream batch back",
			run: inEnvironment(async (environment) => {
				const aggregate = harness.createAggregate();
				const pending = [...aggregate.pendingEvents];
				environment.failNextOutboxWrite(new Error("outbox failure probe"));
				const rejection = await captureRejection(
					environment.run(async ({ repository }) => {
						repository.add(aggregate);
					}),
				);
				assert(rejection !== undefined, "the outbox failure must reject");
				const stream = await environment.committedStreamEvents(
					streamFor(aggregate.id),
					readAll,
				);
				assert(!stream.exists, "stream append must roll back with the outbox");
				assertEqual(
					(await environment.committedOutboxEvents()).length,
					0,
					"failed outbox write must commit no envelope",
				);
				assert(
					deepEqual(aggregate.pendingEvents, pending),
					"failed commit must acknowledge none of the event batch",
				);
			}),
		},
		{
			name: "read windows preserve absence, actual head, and point-in-time bounds",
			run: inEnvironment(async (environment) => {
				const missingAggregate = harness.createAggregate();
				const missing = await environment.committedStreamEvents(
					streamFor(missingAggregate.id),
					readAll,
				);
				assert(
					!missing.exists && missing.lastVersion === 0,
					"a missing stream must report exists=false and head 0",
				);
				const aggregate = harness.createAggregate();
				harness.mutate(aggregate);
				harness.mutate(aggregate);
				await environment.run(async ({ repository }) => {
					repository.add(aggregate);
				});
				const afterOne = await environment.committedStreamEvents(
					streamFor(aggregate.id),
					{ limit: 100, fromVersion: 1 },
				);
				const asOfTwo = await environment.committedStreamEvents(
					streamFor(aggregate.id),
					{ limit: 100, toVersion: 2 },
				);
				assert(
					afterOne.exists &&
						afterOne.lastVersion === 3 &&
						afterOne.events.length === 2,
					"fromVersion is exclusive and preserves the actual stream head",
				);
				assert(
					asOfTwo.exists &&
						asOfTwo.lastVersion === 3 &&
						asOfTwo.events.length === 2,
					"toVersion is inclusive and preserves the actual stream head",
				);
			}),
		},
		{
			name: "identity map returns one replayed instance per Unit of Work",
			run: inEnvironment(async (environment) => {
				const seeded = await seed(environment);
				await environment.run(async ({ repository }) => {
					const first = await repository.findById(seeded.id);
					const second = await repository.findById(seeded.id);
					assert(
						first !== undefined && first === second,
						"repeated stream loads must return the same tracked instance",
					);
				});
			}),
		},
	];

	tests.push(
		gatedContractTest(
			{
				capability: "createAggregateWithId",
				satisfiedBy: Boolean(createAggregateWithId),
			},
			{
				name: "duplicate add conflicts and leaves the existing stream untouched",
				run: inEnvironment(async (environment) => {
					assert(createAggregateWithId !== undefined, "capability gate");
					const seeded = await seed(environment);
					const before = await environment.committedStreamEvents(
						streamFor(seeded.id),
						readAll,
					);
					const duplicate = createAggregateWithId.call(harness, seeded.id);
					const rejection = await captureRejection(
						environment.run(async ({ repository }) => {
							repository.add(duplicate);
						}),
					);
					assertChainContainsKitError(
						rejection,
						["CONCURRENCY_CONFLICT", "DUPLICATE_AGGREGATE"],
						`duplicate stream creation must reject with a mapped kit error; got ${describeError(rejection)}`,
					);
					const after = await environment.committedStreamEvents(
						streamFor(seeded.id),
						readAll,
					);
					assert(
						deepEqual(ids(after.events), ids(before.events)),
						"duplicate add must not modify the existing stream",
					);
				}),
			},
		),
	);

	return tests;
}
