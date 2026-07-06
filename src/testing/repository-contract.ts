import type { IAggregateRoot } from "../aggregate/aggregate";
import type { AnyDomainEvent } from "../aggregate/domain-event";
import type { Id } from "../core/id";
import { deepEqual } from "../utils/array/deep-equal";
import {
	assert,
	assertEqual,
	captureRejection,
	assertChainContainsKitError,
	describeError,
	loadAggregateOrFail,
	runInContractEnvironment,
	skippedContractTest,
} from "./contract-assertions";

/**
 * The repository surface the contract suite exercises: the minimal
 * structural subset of the canonical `IUnitOfWorkRepository` (exported
 * from the main entry) that the tests need. `getById` is typed over
 * the aggregate's own branded id (`TAgg["id"]`), so concrete adapters,
 * including arrow-function-property style repositories, which are
 * checked contravariantly, match without casts.
 */
export interface ContractRepository<
	TAgg extends IAggregateRoot<Id<string>, AnyDomainEvent>,
> {
	getById(id: TAgg["id"]): Promise<TAgg | null>;
	save(aggregate: TAgg): Promise<void>;
	delete(aggregate: TAgg): Promise<void>;
}

/**
 * One isolated test environment: fresh storage, fresh outbox. The
 * suite creates one per test via {@link RepositoryContractHarness} and
 * tears it down afterwards (a teardown failure never masks an
 * in-flight contract violation).
 */
export interface RepositoryContractEnvironment<
	TAgg extends IAggregateRoot<Id<string>, Evt>,
	Evt extends AnyDomainEvent = AnyDomainEvent,
> {
	/**
	 * Execute one unit of work against the adapter under test: open the
	 * transaction, hand the suite a tx-bound repository, commit on
	 * resolve, roll back on throw, and run the post-commit lifecycle
	 * (event harvest into the outbox, `markPersisted`). Wire this
	 * through your real `UnitOfWork` / `withCommit` setup: the commit
	 * boundary IS part of what the suite proves.
	 */
	run<R>(
		work: (ctx: { repository: ContractRepository<TAgg> }) => Promise<R>,
	): Promise<R>;

	/**
	 * All events currently persisted in the outbox (committed writes
	 * only; a rolled-back transaction's events must not appear here).
	 */
	committedOutboxEvents(): Promise<ReadonlyArray<Evt>>;

	/** Release connections, drop schemas, etc. Called in a finally. */
	teardown?(): Promise<void>;
}

/**
 * What an adapter supplies to run the contract suite.
 *
 * The harness MUST provide isolation per environment (fresh
 * tables/keyspace or a truncate); tests assume they see only their
 * own writes. **For SQL/ORM adapters this must run against a real
 * database** (testcontainers or equivalent), not an in-memory fake:
 * the mandatory two-writer test proves YOUR `WHERE version = ?`
 * predicate, and an in-memory stand-in proves only itself.
 *
 * Optional capabilities widen the suite: tests for an absent
 * capability come back **marked `skipped`** with a `run()` that
 * rejects loudly: bind them with `it.skip` so the gap stays visible
 * in every report (see {@link RepositoryContractTest}); a naive
 * binding fails instead of green-no-op'ing. Capabilities are captured
 * once at suite creation. Provide every capability your adapter can
 * support; each one closes a real OCC hole.
 */
export interface RepositoryContractHarness<
	TAgg extends IAggregateRoot<Id<string>, Evt>,
	Evt extends AnyDomainEvent = AnyDomainEvent,
> {
	createEnvironment(): Promise<RepositoryContractEnvironment<TAgg, Evt>>;

	/**
	 * A brand-new aggregate (never persisted, unique id,
	 * `persistedVersion === undefined`).
	 */
	createAggregate(): TAgg;

	/**
	 * Apply exactly ONE version-bumping domain mutation that records at
	 * least one domain event (a `commit()`-style state change). The
	 * suite relies on the +1-per-call arithmetic and on the event for
	 * its outbox assertions.
	 */
	mutate(aggregate: TAgg): void;

	/**
	 * Optional: a version-bumping mutation whose state is deep-equal to
	 * the previous state (`setState({...state})`). Enables the
	 * version-only-change-still-persists test: the skip-save/OCC-desync
	 * trap.
	 */
	mutateVersionOnly?(aggregate: TAgg): void;

	/**
	 * Optional: a mutation that changes ONLY a child collection (a
	 * non-root-row `changedKeys` entry). Enables the
	 * child-change-bumps-root-version test for partial-write
	 * repositories.
	 */
	mutateChildCollection?(aggregate: TAgg): void;

	/**
	 * Optional: construct a NEW (never-persisted) aggregate instance
	 * carrying a SPECIFIC id. Enables TWO tests: deletion-is-final-
	 * across-instances (resurrection via a factory after delete) and
	 * the duplicate-insert test (see
	 * {@link insertsAreDuplicateChecked} to opt out of the latter
	 * independently).
	 */
	createAggregateWithId?(id: TAgg["id"]): TAgg;

	/**
	 * Semantic opt-OUT (default `true`): whether `save()`'s INSERT path
	 * rejects an existing id with `DuplicateAggregateError` (mapping the
	 * driver's unique-violation: Postgres `23505`, MySQL `1062`, SQLite
	 * `SQLITE_CONSTRAINT_UNIQUE`). This is the near-mandatory contract:
	 * `save()` is insert-or-update, never upsert. Create-idempotency
	 * belongs in the USE CASE (load, then decide), not in the save path.
	 * Set `false` ONLY for a deliberately upserting adapter
	 * (idempotent-create design); the duplicate-insert test is then
	 * reported as skipped under this capability name, without costing
	 * the deletion-finality coverage that `createAggregateWithId` also
	 * gates.
	 */
	insertsAreDuplicateChecked?: boolean;

	/**
	 * Optional: a plain-data projection of the aggregate's persisted
	 * state, compared with deep equality. Enables the mandatory test's
	 * state assertion (without it, only the version and the outbox are
	 * compared, and an adapter whose predicate guards the version write
	 * but not the state write would slip through).
	 *
	 * **The projection must be roundtrip-stable**: it compares a
	 * DB-reloaded aggregate against an in-memory one, so normalize
	 * anything your store changes in transit: dates to ISO strings at
	 * your store's precision (MySQL DATETIME truncates millis), no
	 * `undefined`-valued keys (JSON columns drop them), decimals/bigints
	 * to one consistent representation. A mismatch here fails the
	 * mandatory test; the message names the projection as a suspect.
	 */
	snapshotState?(aggregate: TAgg): unknown;

	/**
	 * Optional flag: declare it when your `delete(aggregate)` runs an
	 * OCC predicate (`DELETE … WHERE id = ? AND version = ?`). Enables
	 * the stale-delete conflict test. Unpredicated deletes are
	 * last-write-wins by construction: acceptable for GC-style
	 * cleanup, rarely for user-initiated deletion of contended
	 * aggregates (see the repository guide).
	 */
	deletesAreVersionChecked?: boolean;
}

/**
 * One named contract test; `run` rejects with a descriptive Error on
 * violation. When the harness lacks the capability a test needs, the
 * entry is still returned with {@link skipped} set and a `run` that
 * REJECTS with an explanatory error: bind it with your runner's skip
 * (`(test.skipped ? it.skip : it)(test.name, test.run)`) so the gap is
 * visible in every test report: a missing capability must never look
 * like green coverage, and a naive binding that ignores `skipped`
 * fails loud instead of passing silently.
 */
export interface RepositoryContractTest {
	name: string;
	run: () => Promise<void>;
	/** Present when the harness lacks the capability this test needs. */
	skipped?: { capability: string };
}

/**
 * The repository contract test suite: the proof that an adapter
 * actually delivers the guarantees the kit's Unit of Work documents.
 *
 * The kit is ORM-agnostic: the OCC version predicate lives in YOUR
 * repository's SQL. That makes optimistic concurrency a **repository
 * contract, not a kit guarantee**: the kit ships the boundary, the
 * `persistedVersion` baseline, `ConcurrencyConflictError`, and this
 * suite; your adapter must pass it. An adapter that has not passed the
 * suite (against a real database, for SQL adapters) has not
 * demonstrated OCC.
 *
 * Framework-agnostic: assertions throw plain `Error`s, so the suite
 * binds to vitest, jest, or `node:test` the same way:
 *
 * ```ts
 * import { describe, it } from "vitest";
 * import { createRepositoryContractTests } from "@shirudo/ddd-kit/testing";
 *
 * const harness: RepositoryContractHarness<Order, OrderEvent> = {
 *   createEnvironment: async () => {
 *     const schema = await provisionTestSchema(); // testcontainers etc.
 *     const uowDeps = {
 *       scope: schema.scope,
 *       outbox: schema.outbox,
 *       repositories: {
 *         orders: (tx, session) => new DrizzleOrderRepository(tx, session),
 *       },
 *     };
 *     return {
 *       run: (work) =>
 *         new UnitOfWork(uowDeps).run(({ repositories }) =>
 *           work({ repository: repositories.orders })),
 *       committedOutboxEvents: () => schema.readOutboxEvents(),
 *       teardown: () => schema.drop(),
 *     };
 *   },
 *   createAggregate: () => Order.draft(orderIds.next()),
 *   mutate: (order) => order.changeNote(`note-${counter++}`), // ONE bump + event
 *   // provide every optional capability your adapter supports:
 *   createAggregateWithId: (id) => Order.draft(id),
 *   snapshotState: (order) => normalizeForRoundtrip(order.state),
 *   deletesAreVersionChecked: true,
 * };
 *
 * describe("DrizzleOrderRepository: repository contract", () => {
 *   for (const test of createRepositoryContractTests(harness)) {
 *     (test.skipped ? it.skip : it)(test.name, test.run);
 *   }
 * });
 * ```
 *
 * **`env.run` must provide unit-of-work semantics.** Three core tests
 * (identity-map sameness, getById-null-after-delete, deletion
 * finality) exercise the session machinery: `session.identityMap`,
 * the `isDeleted` probe, the deleted-gate. Wiring `run` through the
 * kit's `UnitOfWork` gives you all of it; a hand-rolled `withCommit`
 * wiring must provide equivalents or those tests will fail. A
 * `withCommit`-only setup that deliberately makes no identity-map /
 * deletion-finality claims is outside this suite's scope; the suite
 * is the compliance bar for unit-of-work repositories.
 *
 * **Error matching is by NAME along the `cause` chain, not by
 * `instanceof`.** The suite ships in its own bundle entry; comparing
 * class identity would spuriously fail whenever the adapter's errors
 * come from a different copy of the kit (the main entry's bundle, or a
 * second installed version). `error.name === "CONCURRENCY_CONFLICT"`
 * anywhere in the chain is the contract.
 *
 * **What each test proves.** The OCC, routing, rollback, and outbox
 * tests prove YOUR adapter's SQL and transaction wiring. The
 * identity-map, deletion-finality, and event-lifecycle tests prove
 * your READ-PATH and unit-of-work WIRING (they exercise kit-provided
 * machinery, namely `session.identityMap`, the deleted-gate, and
 * `withCommit`'s harvest, and fail when your repository bypasses or
 * mis-wires it).
 * A deletion-finality failure usually means a missing
 * `identityMap.isDeleted` check or an `enrollSaved` placed after the
 * row write, not a broken DELETE statement.
 *
 * **Known limitation: no truly concurrent runs.** The mandatory
 * two-writer test is deliberately sequential-deterministic: writer B
 * loads, writer A loads/mutates/commits, then B commits its stale
 * instance. The stale `persistedVersion` baseline travels with B's
 * instance, so the version predicate is exercised exactly as in a true
 * race, without depending on lock timing, pool sizes, or
 * engine-specific blocking. The flip side: lock interaction is NOT
 * covered. A `SELECT … FOR UPDATE`-style repository that blocks
 * instead of conflicting, or a SERIALIZABLE engine surfacing raw
 * serialization failures (Postgres 40001) your adapter must map to
 * `ConcurrencyConflictError`, needs adapter-specific tests on top of
 * this suite.
 */
export function createRepositoryContractTests<
	TAgg extends IAggregateRoot<Id<string>, Evt>,
	Evt extends AnyDomainEvent = AnyDomainEvent,
>(harness: RepositoryContractHarness<TAgg, Evt>): RepositoryContractTest[] {
	type Env = RepositoryContractEnvironment<TAgg, Evt>;

	// Runner plumbing shared with the event-sourced suite; see
	// ./contract-assertions for the teardown-never-masks rule.
	const withEnvironment = (body: (env: Env) => Promise<void>): Promise<void> =>
		runInContractEnvironment(() => harness.createEnvironment(), body);

	const loadOrFail = (
		repository: ContractRepository<TAgg>,
		id: TAgg["id"],
	): Promise<TAgg> =>
		loadAggregateOrFail(
			repository,
			id,
			"broken hydration or a write that did not commit",
		);

	/** Seed one aggregate with a single committed mutation; returns it persisted. */
	async function seed(env: Env): Promise<TAgg> {
		const aggregate = harness.createAggregate();
		harness.mutate(aggregate);
		await env.run(async ({ repository }) => {
			await repository.save(aggregate);
		});
		return aggregate;
	}

	async function reload(env: Env, id: TAgg["id"]): Promise<TAgg> {
		return env.run(({ repository }) => loadOrFail(repository, id));
	}

	// Sorted: eventIds are unique, so this is a multiset comparison. The
	// environment contract guarantees WHICH events are persisted, not the
	// order a `SELECT` without `ORDER BY` happens to return them in.
	const eventIds = (events: ReadonlyArray<Evt>): string[] =>
		events.map((event) => event.eventId).sort();

	// Capabilities are captured ONCE at suite creation: a harness mutated
	// between createRepositoryContractTests() and the run must not flip a
	// test's behavior mid-flight.
	const snapshotState = harness.snapshotState;
	const mutateVersionOnly = harness.mutateVersionOnly;
	const mutateChildCollection = harness.mutateChildCollection;
	const createAggregateWithId = harness.createAggregateWithId;
	const deletesAreVersionChecked = harness.deletesAreVersionChecked === true;
	// Semantic opt-OUT, default true (the contract is near-mandatory).
	const insertsAreDuplicateChecked =
		harness.insertsAreDuplicateChecked !== false;

	const skippedTest = (
		name: string,
		capability: string,
	): RepositoryContractTest => skippedContractTest(name, capability);

	const tests: RepositoryContractTest[] = [
		{
			name: "MANDATORY two-writer conflict: the stale writer throws ConcurrencyConflictError and persists nothing",
			run: () =>
				withEnvironment(async (env) => {
					const seeded = await seed(env);
					const seedEvents = await env.committedOutboxEvents();
					const seedEventIds = new Set(seedEvents.map((e) => e.eventId));

					// Writer B loads first - its persistedVersion baseline is
					// now fixed at the pre-conflict version.
					const staleB = await reload(env, seeded.id);

					// Writer A loads the same version, mutates, commits.
					const committedA = await env.run(async ({ repository }) => {
						const a = await loadOrFail(repository, seeded.id);
						harness.mutate(a);
						await repository.save(a);
						return a;
					});
					const outboxAfterA = await env.committedOutboxEvents();
					assert(
						outboxAfterA.length > seedEvents.length,
						"writer A's events must reach the outbox on commit",
					);
					// Writer A's NEW events must carry A's ACTUAL committed
					// version - not merely some number. A wrong value here
					// (hardcoded, schema version, persistedVersion) would
					// poison every consumer's ordering/idempotency watermark.
					const newSinceSeed = outboxAfterA.filter(
						(event) => !seedEventIds.has(event.eventId),
					);
					assert(
						newSinceSeed.length > 0 &&
							newSinceSeed.every(
								(event) => event.aggregateVersion === committedA.version,
							),
						`writer A's committed outbox events must carry aggregateVersion === ${committedA.version} (A's commit version). ` +
							`Suspect #1: your outbox read-back (committedOutboxEvents) reconstructs events from an explicit column list ` +
							`and drops or string-types the aggregateVersion field. Suspect #2: a hand-rolled orchestration that does not ` +
							`stamp aggregateVersion = aggregate.version at harvest (withCommit does this automatically).`,
					);
					// ...and a gapless zero-based commitSequence: the pair
					// (aggregateVersion, commitSequence) is the consumer's
					// total order and compact idempotency watermark.
					const sequences = newSinceSeed
						.map((event) => event.commitSequence)
						.sort((a, b) => (a ?? -1) - (b ?? -1));
					assert(
						sequences.every((sequence, index) => sequence === index),
						`writer A's committed outbox events must carry a gapless zero-based commitSequence (got: ${sequences.join(", ")}). ` +
							`Same suspects as the aggregateVersion assertion above: a column list dropping the field, or a hand-rolled ` +
							`orchestration that does not stamp the harvest index (withCommit does this automatically).`,
					);

					// Writer B mutates its stale instance and tries to commit.
					harness.mutate(staleB);
					const rejection = await captureRejection(
						env.run(async ({ repository }) => {
							await repository.save(staleB);
						}),
					);
					assert(
						rejection !== undefined,
						"the second writer's commit must reject - it committed on a stale version instead (OCC predicate missing?)",
					);
					assertChainContainsKitError(
						rejection,
						["CONCURRENCY_CONFLICT"],
						`the second writer's rejection must be (or wrap, via the cause chain) ConcurrencyConflictError; got: ${describeError(rejection)}`,
					);

					// Final persisted state equals writer A's.
					const final = await reload(env, seeded.id);
					assertEqual(
						final.version,
						committedA.version,
						"the persisted version must equal writer A's committed version",
					);
					if (snapshotState) {
						assert(
							deepEqual(
								snapshotState.call(harness, final),
								snapshotState.call(harness, committedA),
							),
							"the persisted STATE must equal writer A's. Two suspects: " +
								"(a) a predicate that guards only the version write lets the stale writer's state survive; " +
								"(b) your snapshotState projection is not roundtrip-stable (date precision, undefined-valued keys, decimal representation) - see its JSDoc",
						);
					}

					// Outbox contains exactly the events it contained after A's
					// commit - same records, not merely the same count.
					const outboxFinal = await env.committedOutboxEvents();
					assert(
						deepEqual(eventIds(outboxFinal), eventIds(outboxAfterA)),
						"the outbox must contain exactly the winning writer's events (compared by eventId) - nothing from the stale writer, nothing replaced",
					);
				}),
		},
		{
			name: "insert routing: a never-persisted aggregate INSERTs even after pre-save mutations",
			run: () =>
				withEnvironment(async (env) => {
					const aggregate = harness.createAggregate();
					assert(
						aggregate.persistedVersion === undefined,
						"harness contract: createAggregate() must return a never-persisted aggregate (persistedVersion === undefined)",
					);
					// Mutate BEFORE the first save: version moves past zero in
					// memory while no row exists. Routing on version === 0
					// would attempt an UPDATE that affects zero rows.
					harness.mutate(aggregate);
					harness.mutate(aggregate);

					await env.run(async ({ repository }) => {
						await repository.save(aggregate);
					});

					const loaded = await reload(env, aggregate.id);
					assertEqual(
						loaded.version,
						aggregate.version,
						"the INSERT must persist the in-memory version (route on persistedVersion === undefined, not version === 0)",
					);
				}),
		},
		{
			name: "update writes the in-memory version and predicates on persistedVersion",
			run: () =>
				withEnvironment(async (env) => {
					const seeded = await seed(env);
					const baseline = seeded.version;

					await env.run(async ({ repository }) => {
						const loaded = await loadOrFail(repository, seeded.id);
						harness.mutate(loaded);
						harness.mutate(loaded);
						await repository.save(loaded);
					});

					const final = await reload(env, seeded.id);
					assertEqual(
						final.version,
						baseline + 2,
						"two mutations must persist as baseline + 2 (version is a mutation sequence)",
					);
					assertEqual(
						final.persistedVersion,
						final.version,
						"a reloaded aggregate's persistedVersion must equal its version",
					);
				}),
		},
		{
			name: "rollback persists nothing: state, version, and outbox untouched",
			run: () =>
				withEnvironment(async (env) => {
					const seeded = await seed(env);
					const versionBefore = seeded.version;
					const outboxBefore = (await env.committedOutboxEvents()).length;
					const probe = new Error("contract rollback probe");

					const rejection = await captureRejection(
						env.run(async ({ repository }) => {
							const loaded = await loadOrFail(repository, seeded.id);
							harness.mutate(loaded);
							await repository.save(loaded);
							throw probe;
						}),
					);
					assert(
						rejection !== undefined,
						"a throwing unit of work must reject",
					);

					const final = await reload(env, seeded.id);
					assertEqual(
						final.version,
						versionBefore,
						"a rolled-back write must not change the persisted version",
					);
					assertEqual(
						(await env.committedOutboxEvents()).length,
						outboxBefore,
						"a rolled-back transaction must not leave events in the outbox",
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
			name: "delete: getById returns null in the same unit of work and after the commit",
			run: () =>
				withEnvironment(async (env) => {
					const seeded = await seed(env);

					await env.run(async ({ repository }) => {
						const loaded = await loadOrFail(repository, seeded.id);
						await repository.delete(loaded);
						const probe = await repository.getById(seeded.id);
						assert(
							probe === null,
							"after delete, getById in the SAME unit of work must return null (isDeleted check), even if the physical delete is deferred",
						);
					});

					await env.run(async ({ repository }) => {
						const probe = await repository.getById(seeded.id);
						assert(
							probe === null,
							"after the deleting unit of work committed, the aggregate must be gone",
						);
					});
				}),
		},
		{
			name: "deletion is final: saving the deleted aggregate in the same unit of work throws AggregateDeletedError",
			run: () =>
				withEnvironment(async (env) => {
					const seeded = await seed(env);

					const rejection = await captureRejection(
						env.run(async ({ repository }) => {
							const loaded = await loadOrFail(repository, seeded.id);
							harness.mutate(loaded);
							await repository.delete(loaded);
							await repository.save(loaded);
						}),
					);
					assertChainContainsKitError(
						rejection,
						["AGGREGATE_DELETED"],
						`save-after-delete must reject with (or wrap) AggregateDeletedError; got: ${describeError(rejection)}. ` +
							`If you see ConcurrencyConflictError here instead, your save() probably enrolls AFTER the row write - enroll first.`,
					);
				}),
		},
		{
			name: "events are cleared after a committed unit of work and kept after a rollback",
			run: () =>
				withEnvironment(async (env) => {
					const committed = harness.createAggregate();
					harness.mutate(committed);
					assert(
						committed.pendingEvents.length > 0,
						"harness contract: mutate() must record at least one domain event",
					);
					await env.run(async ({ repository }) => {
						await repository.save(committed);
					});
					assertEqual(
						committed.pendingEvents.length,
						0,
						"pending events must be cleared after a successful commit",
					);

					const rolledBack = harness.createAggregate();
					harness.mutate(rolledBack);
					const pendingBefore = rolledBack.pendingEvents.length;
					await captureRejection(
						env.run(async ({ repository }) => {
							await repository.save(rolledBack);
							throw new Error("contract rollback probe");
						}),
					);
					assertEqual(
						rolledBack.pendingEvents.length,
						pendingBefore,
						"pending events must survive a rollback (so a fresh load + retry can re-emit them)",
					);
				}),
		},
		{
			name: "persistedVersion syncs only after a successful commit",
			run: () =>
				withEnvironment(async (env) => {
					// Re-saving the SAME instance after the rollback is the
					// documented carve-out from "don't reuse aggregates after a
					// rollback": a NEVER-persisted aggregate has no row and its
					// baseline is still undefined, so there is nothing to
					// reload - retrying its first save is the only path.
					const aggregate = harness.createAggregate();
					harness.mutate(aggregate);

					await captureRejection(
						env.run(async ({ repository }) => {
							await repository.save(aggregate);
							throw new Error("contract rollback probe");
						}),
					);
					assert(
						aggregate.persistedVersion === undefined,
						"a rolled-back first save must leave persistedVersion undefined (the aggregate is still unpersisted)",
					);

					await env.run(async ({ repository }) => {
						await repository.save(aggregate);
					});
					assertEqual(
						aggregate.persistedVersion,
						aggregate.version,
						"after a successful commit, persistedVersion must equal version (markPersisted ran)",
					);
				}),
		},
	];

	// Capability-gated tests: when the harness lacks the capability, the
	// entry is returned WITH `skipped` set and a loudly-rejecting run() -
	// the gap stays visible in every test report (it.skip) and a naive
	// binding fails instead of green-no-op'ing.
	tests.push(
		mutateVersionOnly
			? {
					name: "version-only change still persists (skip-save must not desync the OCC baseline)",
					run: () =>
						withEnvironment(async (env) => {
							const seeded = await seed(env);
							const baseline = seeded.version;

							await env.run(async ({ repository }) => {
								const loaded = await loadOrFail(repository, seeded.id);
								mutateVersionOnly.call(harness, loaded);
								await repository.save(loaded);
							});

							const final = await reload(env, seeded.id);
							assertEqual(
								final.version,
								baseline + 1,
								"a version-only change (empty changedKeys, bumped version) must still be persisted - skipping it desyncs persistedVersion and produces false ConcurrencyConflictErrors later",
							);
						}),
				}
			: skippedTest(
					"version-only change still persists (skip-save must not desync the OCC baseline)",
					"mutateVersionOnly",
				),
	);
	tests.push(
		mutateChildCollection
			? {
					name: "a child-collection-only change bumps the persisted root version",
					run: () =>
						withEnvironment(async (env) => {
							const seeded = await seed(env);
							const baseline = seeded.version;

							await env.run(async ({ repository }) => {
								const loaded = await loadOrFail(repository, seeded.id);
								mutateChildCollection.call(harness, loaded);
								await repository.save(loaded);
							});

							const final = await reload(env, seeded.id);
							assert(
								final.version > baseline,
								"a child-collection-only change must advance the persisted ROOT version - otherwise concurrent writers interleave with collection writes undetected",
							);
						}),
				}
			: skippedTest(
					"a child-collection-only change bumps the persisted root version",
					"mutateChildCollection",
				),
	);
	tests.push(
		createAggregateWithId
			? {
					name: "deletion is final across instances: a re-created aggregate with the same id cannot be saved",
					run: () =>
						withEnvironment(async (env) => {
							const seeded = await seed(env);

							const rejection = await captureRejection(
								env.run(async ({ repository }) => {
									const loaded = await loadOrFail(repository, seeded.id);
									await repository.delete(loaded);
									const resurrected = createAggregateWithId.call(
										harness,
										seeded.id,
									);
									harness.mutate(resurrected);
									await repository.save(resurrected);
								}),
							);
							assertChainContainsKitError(
								rejection,
								["AGGREGATE_DELETED"],
								`saving a re-created instance of a deleted aggregate must reject with (or wrap) AggregateDeletedError; got: ${describeError(rejection)}`,
							);
						}),
				}
			: skippedTest(
					"deletion is final across instances: a re-created aggregate with the same id cannot be saved",
					"createAggregateWithId",
				),
	);
	tests.push(
		createAggregateWithId && insertsAreDuplicateChecked
			? {
					name: "duplicate insert: a second never-persisted aggregate with an existing id throws DuplicateAggregateError",
					run: () =>
						withEnvironment(async (env) => {
							const seeded = await seed(env);

							// A second NEVER-persisted instance with the same id:
							// two concurrent creators racing on a business-derived
							// id, or an id-generator collision. The INSERT must
							// surface as the kit's error class, not a raw driver
							// error. Mutated TWICE so its version differs from the
							// seeded row's - a clobbering insert is then visible
							// in the version check below even without a state
							// snapshot.
							const duplicate = createAggregateWithId.call(
								harness,
								seeded.id,
							);
							harness.mutate(duplicate);
							harness.mutate(duplicate);
							const rejection = await captureRejection(
								env.run(async ({ repository }) => {
									await repository.save(duplicate);
								}),
							);
							assertChainContainsKitError(
								rejection,
								["DUPLICATE_AGGREGATE"],
								`inserting a second aggregate with an existing id must reject with (or wrap) DuplicateAggregateError - ` +
									`map your driver's unique-violation signal (Postgres 23505, MySQL 1062, SQLite SQLITE_CONSTRAINT_UNIQUE) ` +
									`instead of letting the raw driver error escape; got: ${describeError(rejection)}`,
							);

							// The existing row is untouched by the rejected insert:
							// version AND (capability permitting) state.
							const final = await reload(env, seeded.id);
							assertEqual(
								final.version,
								seeded.version,
								"the existing row must be untouched by the rejected duplicate insert - a duplicate check that fires AFTER the write (or outside the transaction) clobbers the existing row",
							);
							if (snapshotState) {
								assert(
									deepEqual(
										snapshotState.call(harness, final),
										snapshotState.call(harness, seeded),
									),
									"the existing row's STATE must be untouched by the rejected duplicate insert",
								);
							}
						}),
				}
			: skippedTest(
					"duplicate insert: a second never-persisted aggregate with an existing id throws DuplicateAggregateError",
					// Name the capability that is actually missing: the
					// mechanical one (cannot build the duplicate) or the
					// semantic opt-out (deliberately upserting adapter).
					createAggregateWithId
						? "insertsAreDuplicateChecked"
						: "createAggregateWithId",
				),
	);
	tests.push(
		deletesAreVersionChecked
			? {
					name: "stale delete conflicts: deleting from a stale instance throws ConcurrencyConflictError",
					run: () =>
						withEnvironment(async (env) => {
							const seeded = await seed(env);

							// Writer B loads, writer A commits an update, B deletes
							// from its stale baseline - the predicated DELETE must
							// affect zero rows and conflict, not destroy A's write.
							const staleB = await reload(env, seeded.id);
							const versionAfterA = await env.run(
								async ({ repository }) => {
									const a = await loadOrFail(repository, seeded.id);
									harness.mutate(a);
									await repository.save(a);
									return a.version;
								},
							);

							const rejection = await captureRejection(
								env.run(async ({ repository }) => {
									await repository.delete(staleB);
								}),
							);
							assertChainContainsKitError(
								rejection,
								["CONCURRENCY_CONFLICT"],
								`a stale delete must reject with (or wrap) ConcurrencyConflictError; got: ${describeError(rejection)} - an unpredicated DELETE silently destroys the concurrent writer's update`,
							);

							// A's write survived - load nullable on purpose: the
							// rejected delete must not have destroyed the row.
							const final = await env.run(({ repository }) =>
								repository.getById(seeded.id),
							);
							assert(
								final !== null,
								"the row must still exist after the stale delete was rejected - the predicate must PREVENT the destructive delete, not merely report it",
							);
							assertEqual(
								final.version,
								versionAfterA,
								"the surviving row must carry writer A's version",
							);
						}),
				}
			: skippedTest(
					"stale delete conflicts: deleting from a stale instance throws ConcurrencyConflictError",
					"deletesAreVersionChecked",
				),
	);

	return tests;
}

// assert / assertEqual / chainContainsErrorNamed / describeError live in
// ./contract-assertions, shared with the event-sourced contract suite.
