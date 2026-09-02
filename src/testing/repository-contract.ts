import type { Aggregate } from "../domain/aggregate/aggregate";
import type {
	AnyDomainEvent,
	PendingDomainEvent,
} from "../domain/event/domain-event";
import type { Id } from "../domain/identity/id";
import { deepEqual } from "../internal/structural/deep-equal";
import type { CommittedDomainEvent } from "../messaging/committed-event";
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
	recordedPendingEventIds,
	sortedCommittedEventIds,
} from "./contract-assertions";

/** Application-facing state-stored repository exercised by the suite. */
export interface ContractRepository<
	TAggregate extends Aggregate<Id<string>, AnyDomainEvent>,
> {
	findById(id: TAggregate["id"]): Promise<TAggregate | undefined>;
	add(aggregate: TAggregate): void;
	update(aggregate: TAggregate): void;
	/** Physical removal is an optional persistence capability. */
	remove?(aggregate: TAggregate): void;
}

/** One isolated real-adapter environment. `run` must permit overlapping calls. */
export interface RepositoryContractEnvironment<
	TAggregate extends Aggregate<Id<string>, TEvent>,
	TEvent extends AnyDomainEvent = AnyDomainEvent,
> {
	run<R>(
		work: (context: {
			repository: ContractRepository<TAggregate>;
		}) => Promise<R>,
	): Promise<R>;
	committedOutboxEvents(): Promise<ReadonlyArray<CommittedDomainEvent<TEvent>>>;
	/** Makes the next transactional outbox write fail for atomicity proof. */
	failNextOutboxWrite(error: Error): void;
	teardown?(): Promise<void>;
}

/** Fixtures and observable projections supplied by an adapter package. */
export interface RepositoryContractHarness<
	TAggregate extends Aggregate<Id<string>, TEvent>,
	TEvent extends AnyDomainEvent = AnyDomainEvent,
> {
	createEnvironment(): Promise<
		RepositoryContractEnvironment<TAggregate, TEvent>
	>;
	/** A fresh aggregate with a unique id. */
	createAggregate(): TAggregate;
	/** One version-bumping decision that records at least one event. */
	mutate(aggregate: TAggregate): void;
	/** Required for duplicate-add and same-UoW deletion-finality proofs. */
	createAggregateWithId?(id: TAggregate["id"]): TAggregate;
	/**
	 * A version-bumping decision with no event whose resulting state is
	 * deep-equal to the previous state (`setState({ ...state })`). The
	 * deep-equal requirement is load-bearing: it forces a diff-based
	 * `PersistenceModel` to derive an EMPTY change set, so the suite proves
	 * that an adapter persists the bumped version even when
	 * `changes.empty` is true. Skipping that write desyncs the persisted
	 * version and produces false concurrency conflicts later.
	 */
	mutateVersionOnly?(aggregate: TAggregate): void;
	/** A decision that changes a nested collection. */
	mutateChildCollection?(aggregate: TAggregate): void;
	/** Round-trip-stable adapter persistence projection. */
	snapshotState?(aggregate: TAggregate): unknown;
	/** Opt out only for an intentionally upserting add implementation. */
	insertsAreDuplicateChecked?: boolean;
	/** Enables physical-remove behavior and stale-remove OCC tests. */
	removesAreSupported?: boolean;
	/** The remove flush predicates on the version captured at load. */
	removesAreVersionChecked?: boolean;
}

export type RepositoryContractTest = ContractTest;

/**
 * Contract suite for the v3 explicit-intent, commit-time-flush protocol.
 *
 * The harness must use the public `UnitOfWork` with a real adapter. In
 * particular, `run` must create a fresh Unit of Work and transaction for each
 * call and allow two calls to overlap; the mandatory stale-writer proof keeps
 * writer B open while writer A commits. SQL/ORM adapters therefore need a
 * real database and connection pool. An in-memory harness proves only itself.
 *
 * Writes are synchronous registrations. Durable adapter I/O happens after the
 * callback returns, while the transaction is still open. A test that passes
 * because `add` or `update` writes early is not a conforming implementation.
 */
export function createRepositoryContractTests<
	TAggregate extends Aggregate<Id<string>, TEvent>,
	TEvent extends AnyDomainEvent = AnyDomainEvent,
>(
	harness: RepositoryContractHarness<TAggregate, TEvent>,
): RepositoryContractTest[] {
	type Environment = RepositoryContractEnvironment<TAggregate, TEvent>;
	const inEnvironment = bindContractEnvironment(() =>
		harness.createEnvironment(),
	);
	const snapshotState = harness.snapshotState;
	const createAggregateWithId = harness.createAggregateWithId;
	const mutateVersionOnly = harness.mutateVersionOnly;
	const mutateChildCollection = harness.mutateChildCollection;
	const insertsAreDuplicateChecked =
		harness.insertsAreDuplicateChecked !== false;
	const removesAreSupported = harness.removesAreSupported === true;
	const removesAreVersionChecked =
		removesAreSupported && harness.removesAreVersionChecked === true;

	const load = (
		repository: ContractRepository<TAggregate>,
		id: TAggregate["id"],
	): Promise<TAggregate> =>
		loadAggregateOrFail(
			repository,
			id,
			"the adapter did not commit or reconstitute the aggregate",
		);

	async function seed(environment: Environment): Promise<TAggregate> {
		const aggregate = harness.createAggregate();
		harness.mutate(aggregate);
		await environment.run(async ({ repository }) => {
			repository.add(aggregate);
		});
		return aggregate;
	}

	const reload = (environment: Environment, id: TAggregate["id"]) =>
		environment.run(({ repository }) => load(repository, id));

	const eventIds = (
		events: ReadonlyArray<CommittedDomainEvent<TEvent>>,
	): string[] => sortedCommittedEventIds(events);
	const pendingEventIds = (
		events: ReadonlyArray<PendingDomainEvent<TEvent>>,
	): string[] =>
		recordedPendingEventIds(
			events,
			"the harness must record pending events before persistence",
		);

	const tests: RepositoryContractTest[] = [
		{
			name: "add flushes a new aggregate and its exact event batch atomically",
			run: inEnvironment(async (environment) => {
				const aggregate = harness.createAggregate();
				harness.mutate(aggregate);
				const registeredEvents = [...aggregate.pendingEvents];

				await environment.run(async ({ repository }) => {
					repository.add(aggregate);
				});

				const reloaded = await reload(environment, aggregate.id);
				assertEqual(
					reloaded.version,
					aggregate.version,
					"add must store the version registered by the Unit of Work",
				);
				if (snapshotState) {
					assert(
						deepEqual(
							snapshotState.call(harness, reloaded),
							snapshotState.call(harness, aggregate),
						),
						"add must store the adapter's complete persistence projection",
					);
				}
				const outbox = await environment.committedOutboxEvents();
				assert(
					deepEqual(eventIds(outbox), pendingEventIds(registeredEvents).sort()),
					"the outbox must contain exactly the batch registered by add",
				);
				assertEqual(
					aggregate.pendingEvents.length,
					0,
					"only a committed add acknowledges its registered event batch",
				);
			}),
		},
		{
			name: "committed outbox envelopes carry exact position facts",
			run: inEnvironment(async (environment) => {
				// Position facts must be provable through the repository suite
				// alone: OutboxWriter-only adapters (CDC, broker-native) cannot
				// run the outbox suite, and idempotent consumers key their
				// watermarks on (aggregateVersion, commitSequence).
				const aggregate = harness.createAggregate();
				harness.mutate(aggregate);
				harness.mutate(aggregate);
				const batchSize = aggregate.pendingEvents.length;
				const committedVersion = aggregate.version;

				await environment.run(async ({ repository }) => {
					repository.add(aggregate);
				});

				const positions = (await environment.committedOutboxEvents())
					.map(({ position }) => position)
					.sort((a, b) => a.commitSequence - b.commitSequence);
				assertEqual(
					positions.length,
					batchSize,
					"every registered event must commit exactly one envelope",
				);
				positions.forEach((position, index) => {
					assertEqual(
						position.aggregateVersion,
						committedVersion,
						"every envelope must carry the version the commit persisted",
					);
					assertEqual(
						position.commitSequence,
						index,
						"commitSequence must be gapless and zero-based over the batch",
					);
					assertEqual(
						position.commitSize,
						batchSize,
						"commitSize must equal the exact batch length",
					);
				});
			}),
		},
		{
			name: "MANDATORY stale update: writer B conflicts after writer A commits and persists nothing",
			run: inEnvironment(async (environment) => {
				const seeded = await seed(environment);
				let loadedB!: () => void;
				const bLoaded = new Promise<void>((resolve) => {
					loadedB = resolve;
				});
				let releaseB!: () => void;
				const bMayFlush = new Promise<void>((resolve) => {
					releaseB = resolve;
				});

				const writerB = environment.run(async ({ repository }) => {
					const stale = await load(repository, seeded.id);
					loadedB();
					await bMayFlush;
					harness.mutate(stale);
					repository.update(stale);
				});
				await bLoaded;

				const committedA = await environment.run(async ({ repository }) => {
					const current = await load(repository, seeded.id);
					harness.mutate(current);
					repository.update(current);
					return current;
				});
				const outboxAfterA = await environment.committedOutboxEvents();
				releaseB();
				const rejection = await captureRejection(writerB);
				assertChainContainsKitError(
					rejection,
					["CONCURRENCY_CONFLICT"],
					`stale update must reject with ConcurrencyConflictError; got ${describeError(rejection)}`,
				);

				const final = await reload(environment, seeded.id);
				assertEqual(
					final.version,
					committedA.version,
					"the stale writer must not replace writer A's version",
				);
				if (snapshotState) {
					assert(
						deepEqual(
							snapshotState.call(harness, final),
							snapshotState.call(harness, committedA),
						),
						"the stale writer must not replace writer A's state",
					);
				}
				assert(
					deepEqual(
						eventIds(await environment.committedOutboxEvents()),
						eventIds(outboxAfterA),
					),
					"a rejected stale flush must add no outbox records",
				);
			}),
		},
		{
			name: "rollback acknowledges nothing and commits neither state nor outbox",
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
				const absent = await environment.run(({ repository }) =>
					repository.findById(aggregate.id),
				);
				assert(absent === undefined, "a rolled-back add must leave no row");
				assertEqual(
					(await environment.committedOutboxEvents()).length,
					0,
					"a rolled-back add must leave no outbox record",
				);
				assert(
					deepEqual(aggregate.pendingEvents, pending),
					"rollback must acknowledge none of the registered event batch",
				);
			}),
		},
		{
			name: "outbox failure rolls the already-flushed aggregate write back",
			run: inEnvironment(async (environment) => {
				const aggregate = harness.createAggregate();
				harness.mutate(aggregate);
				const pending = [...aggregate.pendingEvents];
				environment.failNextOutboxWrite(new Error("outbox failure probe"));
				const rejection = await captureRejection(
					environment.run(async ({ repository }) => {
						repository.add(aggregate);
					}),
				);
				assert(rejection !== undefined, "the outbox failure must reject");
				const absent = await environment.run(({ repository }) =>
					repository.findById(aggregate.id),
				);
				assert(
					absent === undefined,
					"state flush must roll back when the outbox write fails",
				);
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
			name: "identity map returns one instance for repeated loads in one Unit of Work",
			run: inEnvironment(async (environment) => {
				const seeded = await seed(environment);
				await environment.run(async ({ repository }) => {
					const first = await repository.findById(seeded.id);
					const second = await repository.findById(seeded.id);
					assert(
						first !== undefined && first === second,
						"repeated reads must return the same tracked aggregate instance",
					);
				});
			}),
		},
		{
			name: "an unchanged explicit update is safe and emits no event",
			run: inEnvironment(async (environment) => {
				const seeded = await seed(environment);
				const before = await environment.committedOutboxEvents();
				await environment.run(async ({ repository }) => {
					const aggregate = await load(repository, seeded.id);
					repository.update(aggregate);
				});
				assert(
					deepEqual(
						eventIds(await environment.committedOutboxEvents()),
						eventIds(before),
					),
					"an unchanged update must not manufacture an outbox event",
				);
			}),
		},
	];

	tests.push(
		gatedContractTest(
			{
				capability: createAggregateWithId
					? "insertsAreDuplicateChecked"
					: "createAggregateWithId",
				satisfiedBy:
					Boolean(createAggregateWithId) && insertsAreDuplicateChecked,
			},
			{
				name: "duplicate add rejects and preserves the existing aggregate",
				run: inEnvironment(async (environment) => {
					assert(createAggregateWithId !== undefined, "capability gate");
					const seeded = await seed(environment);
					// Mutated twice so its version differs from the seeded
					// row's: a clobbering insert is then visible in the
					// version check even without a state snapshot.
					const duplicate = createAggregateWithId.call(harness, seeded.id);
					harness.mutate(duplicate);
					harness.mutate(duplicate);
					const rejection = await captureRejection(
						environment.run(async ({ repository }) => {
							repository.add(duplicate);
						}),
					);
					// Exactly DUPLICATE_AGGREGATE, not a retryable conflict:
					// the docs instruct mapping uniqueness violations
					// (Postgres 23505, MySQL 1062, SQLite
					// SQLITE_CONSTRAINT_UNIQUE) to DuplicateAggregateError,
					// and a duplicate add is deterministic and must not be
					// retried unchanged.
					assertChainContainsKitError(
						rejection,
						["DUPLICATE_AGGREGATE"],
						`duplicate add must reject with (or wrap) ` +
							`DuplicateAggregateError; map your driver's ` +
							`unique-violation signal instead of a retryable ` +
							`conflict; got ${describeError(rejection)}`,
					);
					// The existing row is untouched by the rejected insert:
					// version and (capability permitting) state.
					const final = await reload(environment, seeded.id);
					assertEqual(
						final.version,
						seeded.version,
						"the existing row must be untouched by the rejected " +
							"duplicate add; a duplicate check firing after the " +
							"write clobbers it",
					);
					if (snapshotState) {
						assert(
							deepEqual(
								snapshotState.call(harness, final),
								snapshotState.call(harness, seeded),
							),
							"the existing row's state must be untouched by the " +
								"rejected duplicate add",
						);
					}
				}),
			},
		),
	);

	tests.push(
		gatedContractTest(
			{
				capability: "mutateVersionOnly",
				satisfiedBy: Boolean(mutateVersionOnly),
			},
			{
				name: "version-only change still persists (skip-save must not desync the OCC baseline)",
				run: inEnvironment(async (environment) => {
					assert(mutateVersionOnly !== undefined, "capability gate");
					const seeded = await seed(environment);
					const outboxBefore = await environment.committedOutboxEvents();
					await environment.run(async ({ repository }) => {
						const aggregate = await load(repository, seeded.id);
						mutateVersionOnly.call(harness, aggregate);
						repository.update(aggregate);
					});
					const reloaded = await reload(environment, seeded.id);
					// The harness contract keeps the projection deep-equal, so a
					// diff-based model derives an EMPTY change set here: an
					// adapter that skips empty writes fails this reload.
					assertEqual(
						reloaded.version,
						seeded.version + 1,
						"a version-only change (empty change set, bumped version) " +
							"must still be persisted; skipping it desyncs the " +
							"persisted version and produces false concurrency " +
							"conflicts later",
					);
					assert(
						deepEqual(
							eventIds(await environment.committedOutboxEvents()),
							eventIds(outboxBefore),
						),
						"state-only update must not create an outbox event",
					);
				}),
			},
		),
	);

	tests.push(
		gatedContractTest(
			{
				capability: "mutateChildCollection",
				satisfiedBy: Boolean(mutateChildCollection),
			},
			{
				name: "nested collection changes survive the adapter change-set projection",
				run: inEnvironment(async (environment) => {
					assert(mutateChildCollection !== undefined, "capability gate");
					const seeded = await seed(environment);
					await environment.run(async ({ repository }) => {
						const aggregate = await load(repository, seeded.id);
						mutateChildCollection.call(harness, aggregate);
						repository.update(aggregate);
					});
					const reloaded = await reload(environment, seeded.id);
					assertEqual(
						reloaded.version,
						seeded.version + 1,
						"nested collection update must advance the persisted root version",
					);
				}),
			},
		),
	);

	tests.push(
		gatedContractTest(
			{
				capability: "removesAreSupported",
				satisfiedBy: removesAreSupported,
			},
			{
				name: "remove tombstones the identity and physically removes at commit",
				run: inEnvironment(async (environment) => {
					const seeded = await seed(environment);
					await environment.run(async ({ repository }) => {
						assert(repository.remove !== undefined, "remove capability gate");
						const aggregate = await load(repository, seeded.id);
						repository.remove(aggregate);
						assert(
							(await repository.findById(seeded.id)) === undefined,
							"a removed aggregate is immediately absent from the Unit of Work",
						);
					});
					assert(
						(await environment.run(({ repository }) =>
							repository.findById(seeded.id),
						)) === undefined,
						"remove must physically remove the aggregate after commit",
					);
				}),
			},
		),
	);

	tests.push(
		gatedContractTest(
			{
				capability: "removesAreVersionChecked",
				satisfiedBy: removesAreVersionChecked,
			},
			{
				name: "stale remove conflicts and cannot delete a concurrent update",
				run: inEnvironment(async (environment) => {
					const seeded = await seed(environment);
					let loaded!: () => void;
					const staleLoaded = new Promise<void>((resolve) => {
						loaded = resolve;
					});
					let release!: () => void;
					const mayRemove = new Promise<void>((resolve) => {
						release = resolve;
					});
					const staleRemove = environment.run(async ({ repository }) => {
						assert(repository.remove !== undefined, "remove capability gate");
						const stale = await load(repository, seeded.id);
						loaded();
						await mayRemove;
						repository.remove(stale);
					});
					await staleLoaded;
					await environment.run(async ({ repository }) => {
						const current = await load(repository, seeded.id);
						harness.mutate(current);
						repository.update(current);
					});
					release();
					const rejection = await captureRejection(staleRemove);
					assertChainContainsKitError(
						rejection,
						["CONCURRENCY_CONFLICT"],
						`stale remove must reject with ConcurrencyConflictError; got ${describeError(rejection)}`,
					);
					assert(
						(await reload(environment, seeded.id)) !== undefined,
						"stale remove must not delete the concurrent winner",
					);
				}),
			},
		),
	);

	return tests;
}
