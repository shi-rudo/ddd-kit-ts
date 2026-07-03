import type { IAggregateRoot } from "../aggregate/aggregate";
import type { AnyDomainEvent } from "../aggregate/domain-event";
import type { Id } from "../core/id";
import { deepEqual } from "../utils/array/deep-equal";
import {
	assert,
	assertEqual,
	chainContainsErrorNamed,
	chainContainsErrorNamedAnyOf,
	describeError,
} from "./contract-assertions";

/**
 * The repository surface the event-sourced contract suite exercises.
 * Deliberately smaller than the state-stored `ContractRepository`: pure
 * event-sourced aggregates rarely have a meaningful `delete` (the
 * lifecycle ends with a `Closed` / `Terminated` event in the stream),
 * so the suite does not require one.
 */
export interface EsContractRepository<
	TAgg extends IAggregateRoot<Id<string>, AnyDomainEvent>,
> {
	getById(id: TAgg["id"]): Promise<TAgg | null>;
	save(aggregate: TAgg): Promise<void>;
}

/**
 * One isolated test environment: fresh event store, fresh outbox. The
 * suite creates one per test and tears it down afterwards.
 */
export interface EsRepositoryContractEnvironment<
	TAgg extends IAggregateRoot<Id<string>, Evt>,
	Evt extends AnyDomainEvent = AnyDomainEvent,
> {
	/**
	 * Execute one unit of work against the adapter under test. Wire this
	 * through your real `UnitOfWork` / `withCommit` setup: the commit
	 * boundary IS part of what the suite proves (outbox harvest,
	 * `markPersisted`, rollback purity).
	 */
	run<R>(
		work: (ctx: { repository: EsContractRepository<TAgg> }) => Promise<R>,
	): Promise<R>;

	/**
	 * All events currently persisted in the outbox (committed writes
	 * only; a rolled-back transaction's events must not appear here).
	 */
	committedOutboxEvents(): Promise<ReadonlyArray<Evt>>;

	/**
	 * The COMMITTED stream for the given aggregate id, in stream order,
	 * optionally only the events after `fromVersion` (the snapshot
	 * catch-up read). Implement this through your adapter's
	 * `EventStore.readStream` so the suite's ordering and slicing
	 * assertions exercise your real read path. A rolled-back
	 * transaction's events must not appear here.
	 */
	committedStreamEvents(
		id: TAgg["id"],
		fromVersion?: number,
	): Promise<ReadonlyArray<Evt>>;

	/** Release connections, drop schemas, etc. Called in a finally. */
	teardown?(): Promise<void>;
}

/**
 * What an adapter supplies to run the event-sourced contract suite.
 *
 * The harness MUST provide isolation per environment. **For SQL-backed
 * event stores this must run against a real database** (testcontainers
 * or equivalent): the mandatory two-writer test proves YOUR
 * expectedVersion guard, and an in-memory stand-in proves only itself.
 *
 * Aggregate arithmetic the suite relies on:
 * - `createAggregate()` returns a fresh aggregate with exactly ONE
 *   applied creation event (version 1, `persistedVersion === undefined`).
 * - `mutate()` applies exactly ONE event (+1 version).
 */
export interface EsRepositoryContractHarness<
	TAgg extends IAggregateRoot<Id<string>, Evt>,
	Evt extends AnyDomainEvent = AnyDomainEvent,
> {
	createEnvironment(): Promise<EsRepositoryContractEnvironment<TAgg, Evt>>;

	/**
	 * A brand-new aggregate: exactly one applied creation event, unique
	 * id, version 1, `persistedVersion === undefined`.
	 */
	createAggregate(): TAgg;

	/** Apply exactly ONE domain event via `apply()` (+1 version). */
	mutate(aggregate: TAgg): void;

	/**
	 * Optional: construct a NEW (never-persisted) aggregate carrying a
	 * SPECIFIC id, with its creation event applied. Enables the
	 * duplicate-create conflict test (two creators racing on one stream).
	 */
	createAggregateWithId?(id: TAgg["id"]): TAgg;

	/**
	 * Optional: a plain-data projection of the aggregate's state,
	 * compared with deep equality. Enables the state assertions in the
	 * mandatory and replay-equality tests. Must be roundtrip-stable
	 * across your store (see the state-stored harness JSDoc for the
	 * normalization checklist).
	 */
	snapshotState?(aggregate: TAgg): unknown;
}

/** One named contract test; see the state-stored suite for the binding pattern. */
export interface EsRepositoryContractTest {
	name: string;
	run: () => Promise<void>;
	/** Present when the harness lacks the capability this test needs. */
	skipped?: { capability: string };
}

/**
 * The event-sourced repository contract test suite: the proof that an
 * adapter delivers what the kit's `EventStore` port and Unit of Work
 * document. The kit is store-agnostic: the expectedVersion guard lives
 * in YOUR adapter's append. That makes stream OCC a **repository
 * contract, not a kit guarantee**; an adapter that has not passed this
 * suite (against a real store, for SQL-backed adapters) has not
 * demonstrated it.
 *
 * What each test proves:
 * - The MANDATORY two-writer test proves your append's expectedVersion
 *   guard and its atomicity.
 * - The replay/lifecycle tests prove your read path (fold order,
 *   identity map wiring) and the commit lifecycle (outbox harvest,
 *   `markPersisted`, rollback purity).
 * - The duplicate-create and fromVersion tests prove the create race
 *   and the snapshot catch-up read.
 *
 * Error matching is by NAME along the `cause` chain, not `instanceof`
 * (same rationale as the state-stored suite). Binding:
 *
 * ```ts
 * for (const test of createEsRepositoryContractTests(harness)) {
 *   (test.skipped ? it.skip : it)(test.name, test.run);
 * }
 * ```
 *
 * **Known limitation:** like the state-stored suite, the two-writer
 * test is sequential-deterministic; lock interaction and raw
 * serialization failures (Postgres 40001) need adapter-specific tests
 * on top.
 */
export function createEsRepositoryContractTests<
	TAgg extends IAggregateRoot<Id<string>, Evt>,
	Evt extends AnyDomainEvent = AnyDomainEvent,
>(
	harness: EsRepositoryContractHarness<TAgg, Evt>,
): EsRepositoryContractTest[] {
	type Env = EsRepositoryContractEnvironment<TAgg, Evt>;

	async function withEnvironment(
		body: (env: Env) => Promise<void>,
	): Promise<void> {
		const env = await harness.createEnvironment();
		let bodyFailed = false;
		let bodyError: unknown;
		try {
			await body(env);
		} catch (error) {
			bodyFailed = true;
			bodyError = error;
		}
		try {
			await env.teardown?.();
		} catch (teardownError) {
			if (!bodyFailed) {
				throw teardownError;
			}
		}
		if (bodyFailed) {
			throw bodyError;
		}
	}

	async function loadOrFail(
		repository: EsContractRepository<TAgg>,
		id: TAgg["id"],
	): Promise<TAgg> {
		const loaded = await repository.getById(id);
		assert(
			loaded !== null,
			`getById(${String(id)}) returned null for an aggregate whose stream must exist - broken replay read or a write that did not commit`,
		);
		return loaded;
	}

	/** Seed one aggregate (creation event only, committed). */
	async function seed(env: Env): Promise<TAgg> {
		const aggregate = harness.createAggregate();
		await env.run(async ({ repository }) => {
			await repository.save(aggregate);
		});
		return aggregate;
	}

	async function reload(env: Env, id: TAgg["id"]): Promise<TAgg> {
		return env.run(({ repository }) => loadOrFail(repository, id));
	}

	function captureRejection(promise: Promise<unknown>): Promise<unknown> {
		return promise.then(
			() => undefined,
			(error: unknown) => error,
		);
	}

	// Ordered ids: streams are ordered, so stream assertions compare the
	// exact sequence (unlike the outbox, whose read-back order is not
	// part of the environment contract).
	const orderedIds = (events: ReadonlyArray<Evt>): string[] =>
		events.map((event) => event.eventId);
	const sortedIds = (events: ReadonlyArray<Evt>): string[] =>
		orderedIds(events).sort();

	// Capabilities are captured ONCE at suite creation.
	const snapshotState = harness.snapshotState;
	const createAggregateWithId = harness.createAggregateWithId;

	function skippedTest(
		name: string,
		capability: string,
	): EsRepositoryContractTest {
		return {
			name,
			skipped: { capability },
			run: async () => {
				throw new Error(
					`Repository contract test skipped: harness capability '${capability}' is not provided. ` +
						`Bind skipped tests with it.skip ((test.skipped ? it.skip : it)(test.name, test.run)) ` +
						`or provide the capability.`,
				);
			},
		};
	}

	const tests: EsRepositoryContractTest[] = [
		{
			name: "MANDATORY two-writer conflict: the stale writer's append throws ConcurrencyConflictError and the stream is untouched",
			run: () =>
				withEnvironment(async (env) => {
					const seeded = await seed(env);
					const seedStream = await env.committedStreamEvents(seeded.id);
					assert(
						seedStream.length > 0,
						"seeding must have appended the creation event to the stream",
					);

					// Writer B loads first: its persistedVersion baseline is
					// now fixed at the pre-conflict stream version.
					const staleB = await reload(env, seeded.id);

					// Writer A loads the same version, mutates, commits.
					const committedA = await env.run(async ({ repository }) => {
						const a = await loadOrFail(repository, seeded.id);
						harness.mutate(a);
						await repository.save(a);
						return a;
					});
					const streamAfterA = await env.committedStreamEvents(seeded.id);
					assert(
						streamAfterA.length === seedStream.length + 1,
						"writer A's event must reach the stream on commit",
					);

					// Writer B appends from its stale baseline.
					harness.mutate(staleB);
					const rejection = await captureRejection(
						env.run(async ({ repository }) => {
							await repository.save(staleB);
						}),
					);
					assert(
						rejection !== undefined,
						"the second writer's commit must reject - it appended on a stale expectedVersion instead (append guard missing?)",
					);
					assert(
						chainContainsErrorNamed(rejection, "ConcurrencyConflictError"),
						`the second writer's rejection must be (or wrap, via the cause chain) ConcurrencyConflictError; got: ${describeError(rejection)}`,
					);

					// The stream contains exactly writer A's history, in order:
					// nothing from the stale writer, nothing reordered.
					const finalStream = await env.committedStreamEvents(seeded.id);
					assert(
						deepEqual(orderedIds(finalStream), orderedIds(streamAfterA)),
						"the stream must contain exactly the winning writer's events in order - a rejected append must leave the stream untouched",
					);

					// The reloaded fold equals writer A's aggregate.
					const final = await reload(env, seeded.id);
					assertEqual(
						final.version,
						committedA.version,
						"the reloaded version must equal writer A's committed version (version IS the event count)",
					);
					if (snapshotState) {
						assert(
							deepEqual(
								snapshotState.call(harness, final),
								snapshotState.call(harness, committedA),
							),
							"the reloaded state must fold to writer A's state. Suspects: a partial append survived the rejection, or your snapshotState projection is not roundtrip-stable",
						);
					}

					// The outbox carries the same committed events (as stamped
					// copies with identical eventIds) - nothing from B.
					const outbox = await env.committedOutboxEvents();
					assert(
						deepEqual(sortedIds(outbox), sortedIds(streamAfterA)),
						"the outbox must contain exactly the committed events (compared by eventId) - nothing from the stale writer",
					);
				}),
		},
		{
			name: "replay equality: a reloaded aggregate folds the committed stream in emission order",
			run: () =>
				withEnvironment(async (env) => {
					const aggregate = harness.createAggregate();
					harness.mutate(aggregate);
					harness.mutate(aggregate);
					const emittedIds = orderedIds(aggregate.pendingEvents);
					assertEqual(
						emittedIds.length,
						3,
						"harness contract: createAggregate applies ONE creation event and mutate applies ONE event each",
					);

					await env.run(async ({ repository }) => {
						await repository.save(aggregate);
					});

					// The stream holds the UNSTAMPED originals in emission order.
					const stream = await env.committedStreamEvents(aggregate.id);
					assert(
						deepEqual(orderedIds(stream), emittedIds),
						"the committed stream must contain exactly the emitted events in emission order - reordering breaks every consumer's fold",
					);

					// Post-commit lifecycle on the saved instance.
					assertEqual(
						aggregate.pendingEvents.length,
						0,
						"pending events must be cleared after a successful commit (markPersisted ran)",
					);
					assertEqual(
						aggregate.persistedVersion,
						aggregate.version,
						"after a successful commit, persistedVersion must equal version",
					);

					// The reload folds to the same aggregate.
					const reloaded = await reload(env, aggregate.id);
					assertEqual(
						reloaded.version,
						aggregate.version,
						"the reloaded version must equal the event count",
					);
					assertEqual(
						reloaded.persistedVersion,
						reloaded.version,
						"a reloaded aggregate's persistedVersion must equal its version",
					);
					assertEqual(
						reloaded.pendingEvents.length,
						0,
						"a reloaded aggregate must not carry pending events (replay is not re-recording)",
					);
					if (snapshotState) {
						assert(
							deepEqual(
								snapshotState.call(harness, reloaded),
								snapshotState.call(harness, aggregate),
							),
							"the reloaded aggregate must fold to the same state as the in-memory instance. Suspects: fold order (readStream must return emission order), or a snapshotState projection that is not roundtrip-stable",
						);
					}
				}),
		},
		{
			name: "getById returns null for a stream that does not exist",
			run: () =>
				withEnvironment(async (env) => {
					const never = harness.createAggregate();
					const probe = await env.run(({ repository }) =>
						repository.getById(never.id),
					);
					assert(
						probe === null,
						"getById of a never-persisted id must return null (empty stream = no aggregate)",
					);
				}),
		},
		{
			name: "identity map: two getById calls in one unit of work return the same instance",
			run: () =>
				withEnvironment(async (env) => {
					const seeded = await seed(env);

					await env.run(async ({ repository }) => {
						const first = await repository.getById(seeded.id);
						const second = await repository.getById(seeded.id);
						assert(
							first !== null && first === second,
							"repeated loads within one unit of work must return the SAME instance (identity map) - distinct instances double-harvest events",
						);
					});
				}),
		},
		{
			name: "rollback persists nothing: stream and outbox untouched, pending events survive, first save can be retried",
			run: () =>
				withEnvironment(async (env) => {
					const aggregate = harness.createAggregate();
					harness.mutate(aggregate);
					const pendingBefore = aggregate.pendingEvents.length;

					await captureRejection(
						env.run(async ({ repository }) => {
							await repository.save(aggregate);
							throw new Error("contract rollback probe");
						}),
					);

					assertEqual(
						(await env.committedStreamEvents(aggregate.id)).length,
						0,
						"a rolled-back transaction must not leave events in the stream",
					);
					assertEqual(
						(await env.committedOutboxEvents()).length,
						0,
						"a rolled-back transaction must not leave events in the outbox",
					);
					assertEqual(
						aggregate.pendingEvents.length,
						pendingBefore,
						"pending events must survive a rollback (so the first save can be retried)",
					);
					assert(
						aggregate.persistedVersion === undefined,
						"a rolled-back first save must leave persistedVersion undefined (the stream does not exist)",
					);

					// Retrying the SAME never-persisted instance is the
					// documented carve-out: there is no row/stream to reload.
					await env.run(async ({ repository }) => {
						await repository.save(aggregate);
					});
					assertEqual(
						(await env.committedStreamEvents(aggregate.id)).length,
						pendingBefore,
						"the retried first save must append the full pending history",
					);
					assertEqual(
						aggregate.persistedVersion,
						aggregate.version,
						"after the successful retry, persistedVersion must equal version",
					);
				}),
		},
		{
			name: "readStream honors fromVersion: the snapshot catch-up read returns exactly the events after the position",
			run: () =>
				withEnvironment(async (env) => {
					const aggregate = harness.createAggregate();
					harness.mutate(aggregate);
					harness.mutate(aggregate);
					await env.run(async ({ repository }) => {
						await repository.save(aggregate);
					});

					const full = await env.committedStreamEvents(aggregate.id);
					assertEqual(full.length, 3, "seeding must have committed 3 events");

					const afterOne = await env.committedStreamEvents(aggregate.id, 1);
					assert(
						deepEqual(orderedIds(afterOne), orderedIds(full.slice(1))),
						"fromVersion=1 must return exactly the events after stream position 1, in order - restoreFromSnapshotWithEvents replays exactly this window",
					);

					const afterAll = await env.committedStreamEvents(
						aggregate.id,
						full.length,
					);
					assertEqual(
						afterAll.length,
						0,
						"fromVersion at the stream head must return no events",
					);
				}),
		},
	];

	tests.push(
		createAggregateWithId
			? {
					name: "duplicate create: two creators racing on one stream - the second append conflicts and the stream is untouched",
					run: () =>
						withEnvironment(async (env) => {
							const seeded = await seed(env);
							const seedStream = await env.committedStreamEvents(seeded.id);

							const duplicate = createAggregateWithId.call(
								harness,
								seeded.id,
							);
							const rejection = await captureRejection(
								env.run(async ({ repository }) => {
									await repository.save(duplicate);
								}),
							);
							assert(
								chainContainsErrorNamedAnyOf(rejection, [
									"ConcurrencyConflictError",
									"DuplicateAggregateError",
								]),
								`the duplicate creator's append (expectedVersion 0 on an existing stream) must reject with (or wrap) ConcurrencyConflictError or DuplicateAggregateError; got: ${describeError(rejection)}`,
							);

							const finalStream = await env.committedStreamEvents(seeded.id);
							assert(
								deepEqual(orderedIds(finalStream), orderedIds(seedStream)),
								"the existing stream must be untouched by the rejected duplicate create",
							);
						}),
				}
			: skippedTest(
					"duplicate create: two creators racing on one stream - the second append conflicts and the stream is untouched",
					"createAggregateWithId",
				),
	);

	return tests;
}
