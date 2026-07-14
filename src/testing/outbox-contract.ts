import type { AggregateAddress } from "../aggregate/aggregate-address";
import type { AnyDomainEvent } from "../aggregate/domain-event";
import type {
	DispatchTrackingOutbox,
	EventCommitCandidate,
	Outbox,
	OutboxRecord,
} from "../events/ports";
import { isDispatchTrackingOutbox } from "../events/ports";
import { deepEqual } from "../utils/array/deep-equal";
import {
	assert,
	assertEqual,
	bindContractEnvironment,
	captureRejection,
	type ContractTest,
	describeError,
	gatedContractTest,
} from "./contract-assertions";

/** One contract test; bind with `(test.skipped ? it.skip : it)(test.name, test.run)`. */
export type OutboxContractTest = ContractTest;

/**
 * One isolated test environment: a fresh outbox store. The suite
 * creates one per test and tears it down afterwards.
 */
export interface OutboxContractEnvironment<Evt extends AnyDomainEvent> {
	/** The adapter under test. */
	outbox: Outbox<Evt> | DispatchTrackingOutbox<Evt>;

	/**
	 * Runs `outbox.add(candidates)` inside a transaction that COMMITS, the
	 * way `withCommit` calls it in production. The suite supplies complete
	 * candidates with explicit source, aggregate version, zero-based commit
	 * sequence, and commit size. For a non-transactional store this is simply
	 * `outbox.add(candidates)`.
	 */
	addCommitted(events: ReadonlyArray<EventCommitCandidate<Evt>>): Promise<void>;

	/**
	 * Optional capability: runs `outbox.add(candidates)` inside a
	 * transaction that ROLLS BACK. Enables the rollback-purity test: a
	 * rolled-back add must leave nothing behind. Transactional adapters
	 * should always provide this; it is the half of the outbox promise
	 * that in-memory fakes cannot keep.
	 */
	addRolledBack?(
		events: ReadonlyArray<EventCommitCandidate<Evt>>,
	): Promise<void>;

	/** Release connections, drop schemas, etc. Called in a finally. */
	teardown?(): Promise<void>;
}

/**
 * What an adapter supplies to run the outbox contract suite.
 *
 * For SQL adapters, run against a real database (testcontainers or
 * equivalent): the commit-order and rollback tests prove YOUR schema
 * and transaction wiring, not the kit's.
 *
 * Note on claiming: multi-instance safety (`getPending` claiming via
 * `FOR UPDATE SKIP LOCKED` or equivalent) is part of the port contract
 * for competing dispatchers but is not covered here; concurrency
 * cannot be proven portably by a generic suite. Test it in your
 * adapter's own suite if you run more than one dispatcher.
 */
export interface OutboxContractHarness<Evt extends AnyDomainEvent> {
	createEnvironment(): Promise<OutboxContractEnvironment<Evt>>;

	/**
	 * Deterministic event factory: the same `seed` yields an event with
	 * the SAME `eventId` (the suite uses this for the dedupe test), and
	 * different seeds yield distinct `eventId`s.
	 */
	createEvent(seed: number): Evt;

	/**
	 * For a `DispatchTrackingOutbox` adapter: how many `markFailed`
	 * reports move a record to the dead-letter set (the adapter's
	 * configured attempt ceiling). Omit for plain `Outbox` adapters;
	 * the dispatch-tracking tests are then marked skipped. With a
	 * ceiling of 1 the attempts-surfacing test is marked skipped too:
	 * observing attempts on a PENDING record needs a record that
	 * survives one failure.
	 */
	failuresToDeadLetter?: number;

	/**
	 * Declare `true` when environments provide {@link
	 * OutboxContractEnvironment.addRolledBack}. Without it, the
	 * rollback-purity test is marked skipped: the honest state of an
	 * in-memory fake, and a loud gap for a transactional adapter.
	 */
	providesRolledBackAdds?: boolean;

	/**
	 * Declare `true` when the adapter's `getPending` CLAIMS the returned
	 * records for competing dispatchers (lease, visibility timeout,
	 * `FOR UPDATE SKIP LOCKED`), as the port sanctions. Every test that
	 * re-polls records a previous poll returned without resolving them
	 * (head stability, re-ack non-disturbance, attempts surfacing)
	 * assumes a non-claiming read and is marked skipped for claiming
	 * adapters; prove your claim/expiry semantics in your own suite.
	 */
	claimsOnGetPending?: boolean;

	/**
	 * Declare `true` when `add()` dedupes on `eventId` (the unique-key
	 * constraint the port RECOMMENDS). The dedupe test is gated on this:
	 * an adapter without the constraint satisfies the port's normative
	 * requirements and must not fail the suite, but the skip stays
	 * visible as the unproven recommendation it is.
	 */
	dedupesOnEventId?: boolean;
}

/**
 * The outbox contract test suite: the proof that an adapter delivers
 * the guarantees `withCommit` and `OutboxDispatcher` document. The kit
 * is store-agnostic, so commit-order reads, qualified source-position
 * identity, eventful-predecessor linkage, idempotent acks, and rollback
 * purity are an **adapter contract, not a kit guarantee**; this suite is how
 * an adapter demonstrates them. Its source-law tests also prove that colliding
 * raw ids stay isolated by aggregate type and aggregate id.
 *
 * Framework-agnostic: bind with
 * `(test.skipped ? it.skip : it)(test.name, test.run)`.
 */
export function createOutboxContractTests<Evt extends AnyDomainEvent>(
	harness: OutboxContractHarness<Evt>,
): OutboxContractTest[] {
	type Env = OutboxContractEnvironment<Evt>;
	const inEnv = bindContractEnvironment(() => harness.createEnvironment());
	const defaultSource: AggregateAddress = {
		aggregateType: "ContractAggregate",
		aggregateId: "contract-aggregate",
	};
	const commit = (
		events: ReadonlyArray<Evt>,
		aggregateVersion = 1,
		source: AggregateAddress = defaultSource,
	): ReadonlyArray<EventCommitCandidate<Evt>> =>
		events.map((event, commitSequence) => ({
			event,
			source,
			position: {
				aggregateVersion,
				commitSequence,
				commitSize: events.length,
			},
		}));
	const takeAndAck = async (
		env: Env,
		count: number,
	): Promise<ReadonlyArray<OutboxRecord<Evt>>> => {
		const records: Array<OutboxRecord<Evt>> = [];
		for (let index = 0; index < count; index += 1) {
			const [record] = await env.outbox.getPending(1);
			assert(
				record !== undefined,
				`expected committed outbox record ${index + 1} of ${count}`,
			);
			records.push(record);
			await env.outbox.markDispatched([record.dispatchId]);
		}
		return records;
	};

	const tests: OutboxContractTest[] = [
		{
			name: "finalizes complete commit receipts and links the next eventful commit",
			run: inEnv(async (env) => {
				await env.addCommitted(
					commit([harness.createEvent(1), harness.createEvent(2)], 1),
				);
				// Version 2 may have been a state-only save; the event-source
				// predecessor is still the previous EVENTFUL version 1.
				await env.addCommitted(commit([harness.createEvent(3)], 3));
				const records = await takeAndAck(env, 3);

				assert(
					deepEqual(
						records.map(({ position }) => position),
						[
							{
								aggregateVersion: 1,
								commitSequence: 0,
								commitSize: 2,
								previousEventfulAggregateVersion: null,
							},
							{
								aggregateVersion: 1,
								commitSequence: 1,
								commitSize: 2,
								previousEventfulAggregateVersion: null,
							},
							{
								aggregateVersion: 3,
								commitSequence: 0,
								commitSize: 1,
								previousEventfulAggregateVersion: 1,
							},
						],
					),
					"the source must preserve zero-based commit completeness and link the next eventful commit to version 1",
				);
			}),
		},
		{
			name: "rejects different event identities at one qualified source position",
			run: inEnv(async (env) => {
				const original = commit([harness.createEvent(1)], 1);
				const collision = commit([harness.createEvent(2)], 1);
				await env.addCommitted(original);
				const rejection = await captureRejection(env.addCommitted(collision));
				assert(
					rejection !== undefined,
					"a different eventId at one qualified source position must reject",
				);

				const [record] = await takeAndAck(env, 1);
				assertEqual(
					record?.event.eventId,
					original[0]?.event.eventId,
					"the rejected collision must not replace the original record",
				);
				await env.addCommitted(commit([harness.createEvent(3)], 2));
				const [next] = await takeAndAck(env, 1);
				assertEqual(
					next?.position.previousEventfulAggregateVersion,
					1,
					"the rejected collision must not change the source head",
				);
			}),
		},
		{
			name: "keeps event-source heads isolated by aggregate type and id",
			run: inEnv(async (env) => {
				const sources: ReadonlyArray<AggregateAddress> = [
					{ aggregateType: "Order", aggregateId: "1" },
					{ aggregateType: "Payment", aggregateId: "1" },
					{ aggregateType: "Order", aggregateId: "2" },
				];
				for (const [index, source] of sources.entries()) {
					await env.addCommitted(
						commit([harness.createEvent(index + 1)], 1, source),
					);
				}
				const records = await takeAndAck(env, sources.length);
				assert(
					records.every(
						(record, index) =>
							record.source.aggregateType === sources[index]?.aggregateType &&
							record.source.aggregateId === sources[index]?.aggregateId &&
							record.position.previousEventfulAggregateVersion === null,
					),
					"colliding raw ids or aggregate types must each retain an independent genesis head",
				);
			}),
		},
		{
			name: "getPending returns records in commit order, across separate committed adds",
			run: inEnv(async (env) => {
				await env.addCommitted(
					commit([harness.createEvent(1), harness.createEvent(2)], 1),
				);
				await env.addCommitted(commit([harness.createEvent(3)], 2));
				// Explicit limit: the port leaves the no-argument page size to
				// the implementation, so the suite never relies on it.
				const pending = await env.outbox.getPending(10);
				// "Up to limit": short pages are port-legal, so the assertion
				// is a non-empty PREFIX of commit order, not the full page.
				const expectedIds = [1, 2, 3].map(
					(seed) => harness.createEvent(seed).eventId,
				);
				assert(
					pending.length >= 1,
					"a non-empty backlog must surface at least one record",
				);
				assert(
					deepEqual(
						pending.map((record) => record.event.eventId),
						expectedIds.slice(0, pending.length),
					),
					"records must come back in the order add() persisted them",
				);
			}),
		},
		{
			name: "getPending respects the limit",
			run: inEnv(async (env) => {
				await env.addCommitted(
					commit([1, 2, 3, 4].map((s) => harness.createEvent(s))),
				);
				const firstPage = await env.outbox.getPending(2);
				// The port promises UP TO `limit` records; a shorter page is
				// legal, an empty one against a non-empty backlog is not (the
				// dispatcher would spin without progress).
				assert(
					firstPage.length >= 1 && firstPage.length <= 2,
					"limit must bound the page: up to `limit` records, at least one while the backlog is non-empty",
				);
			}),
		},
		// Head stability assumes a non-claiming read; the port sanctions
		// claiming reads (lease, visibility timeout, FOR UPDATE SKIP
		// LOCKED) for competing dispatchers, and for those an un-acked
		// head legitimately stays invisible until the claim expires.
		gatedContractTest(
			{
				capability: "non-claiming getPending",
				satisfiedBy: !harness.claimsOnGetPending,
			},
			{
				name: "an un-acked head comes back on the next poll (no silent skipping)",
				run: inEnv(async (env) => {
					await env.addCommitted(
						commit([1, 2, 3, 4].map((s) => harness.createEvent(s))),
					);
					const firstPage = await env.outbox.getPending(2);
					const again = await env.outbox.getPending(2);
					// Short pages are port-legal ("up to limit"), so compare
					// the overlapping prefix: what head stability forbids is
					// silently SKIPPING an un-acked record, not short pages.
					const overlap = Math.min(firstPage.length, again.length);
					assert(
						overlap >= 1,
						"a non-empty backlog must surface at least one record on every poll",
					);
					assert(
						deepEqual(
							again.slice(0, overlap).map((r) => r.dispatchId),
							firstPage.slice(0, overlap).map((r) => r.dispatchId),
						),
						"an un-acked head must come back on the next poll (no silent skipping)",
					);
				}),
			},
		),
		{
			name: "markDispatched removes records; re-acks and unknown acks are accepted",
			run: inEnv(async (env) => {
				await env.addCommitted(
					commit([harness.createEvent(1), harness.createEvent(2)]),
				);
				const [first] = await env.outbox.getPending(1);
				assert(first !== undefined, "expected a pending record");
				await env.outbox.markDispatched([first.dispatchId]);
				// Idempotency: re-acking and acking unknown ids must be no-ops.
				await env.outbox.markDispatched([first.dispatchId]);
				await env.outbox.markDispatched(["no-such-dispatch-id"]);
				// Membership, not count: claiming adapters may hold back the
				// still-pending second record, but a dispatched record must
				// never come back for anyone.
				const remaining = await env.outbox.getPending(10);
				assert(
					!remaining.some((r) => r.dispatchId === first.dispatchId),
					"a dispatched record must never come back",
				);
			}),
		},
		// Observing that OTHER records survive a re-ack needs a re-poll of
		// records an earlier poll already returned un-acked; claiming
		// adapters legitimately hold those back until the claim expires.
		gatedContractTest(
			{
				capability: "non-claiming getPending",
				satisfiedBy: !harness.claimsOnGetPending,
			},
			{
				name: "idempotent re-acks do not disturb other pending records",
				run: inEnv(async (env) => {
					await env.addCommitted(
						commit([harness.createEvent(1), harness.createEvent(2)]),
					);
					const [first] = await env.outbox.getPending(1);
					assert(first !== undefined, "expected a pending record");
					await env.outbox.markDispatched([first.dispatchId]);
					await env.outbox.markDispatched([first.dispatchId]);
					await env.outbox.markDispatched(["no-such-dispatch-id"]);
					assertEqual(
						(await env.outbox.getPending(10)).length,
						1,
						"idempotent re-acks must not disturb other records",
					);
				}),
			},
		),
		// Dedupe on eventId is the port's RECOMMENDATION, not a normative
		// requirement; only adapters that declare the unique-key constraint
		// are held to it.
		gatedContractTest(
			{
				capability: "dedupesOnEventId",
				satisfiedBy: harness.dedupesOnEventId === true,
			},
			{
				name: "re-adding an event with the same eventId is deduped, not duplicated",
				run: inEnv(async (env) => {
					const original = commit([harness.createEvent(1)]);
					await env.addCommitted(original);
					try {
						await env.addCommitted(original);
					} catch (error) {
						// A bare UNIQUE(eventId) constraint makes the duplicate
						// INSERT throw; the contract wants an idempotent add.
						throw new Error(
							"Contract violated: add() must swallow a duplicate eventId, not throw. " +
								"Dedupe means an idempotent add (INSERT ... ON CONFLICT DO NOTHING or " +
								`equivalent), not a raised unique violation. Got: ${describeError(error)}`,
						);
					}
					const pending = await env.outbox.getPending(10);
					assertEqual(
						pending.length,
						1,
						"the same eventId must yield one record (unique-key dedupe)",
					);
				}),
			},
		),
	];

	// Rollback purity: capability-gated (in-memory fakes cannot keep it).
	tests.push(
		gatedContractTest(
			{
				capability: "providesRolledBackAdds",
				satisfiedBy: harness.providesRolledBackAdds === true,
			},
			{
				name: "a rolled-back add leaves nothing behind (transactional participation)",
				run: inEnv(async (env) => {
					if (!env.addRolledBack) {
						throw new Error(
							"Contract violated: harness declared providesRolledBackAdds but the environment lacks addRolledBack",
						);
					}
					await env.addRolledBack(commit([harness.createEvent(1)], 1));
					assertEqual(
						(await env.outbox.getPending(10)).length,
						0,
						"events added in a rolled-back transaction must not appear",
					);
					await env.addCommitted(commit([harness.createEvent(2)], 2));
					const [afterRollback] = await takeAndAck(env, 1);
					assertEqual(
						afterRollback?.position.previousEventfulAggregateVersion,
						null,
						"a rolled-back add must not advance the event-source head",
					);
				}),
			},
		),
	);

	// Dispatch tracking: gated on the harness declaring the ceiling.
	// `attemptCeiling` is only ever read inside enabled tests, where the
	// gate guarantees the harness declared it.
	const trackingEnabled = harness.failuresToDeadLetter !== undefined;
	const attemptCeiling = harness.failuresToDeadLetter ?? 0;
	const trackingGate = (test: ContractTest): ContractTest =>
		gatedContractTest(
			{
				capability: "failuresToDeadLetter (DispatchTrackingOutbox)",
				satisfiedBy: trackingEnabled,
			},
			test,
		);
	tests.push(
		trackingGate(
			// Observing attempts needs the record back on a re-poll after an
			// un-acked poll (a claiming adapter may hold it until the claim
			// expires) AND a record that survives one failure (with a
			// ceiling of 1, the single markFailed dead-letters it before
			// the re-poll, exactly as the port requires).
			gatedContractTest(
				{
					capability: "non-claiming getPending",
					satisfiedBy: !harness.claimsOnGetPending,
				},
				gatedContractTest(
					{
						capability: "failuresToDeadLetter >= 2",
						satisfiedBy: attemptCeiling >= 2,
					},
					{
						name: "markFailed increments attempts surfaced on pending records",
						run: inEnv(async (env) => {
							const outbox = env.outbox;
							assert(
								isDispatchTrackingOutbox(outbox),
								"harness declared a tracking outbox",
							);
							await env.addCommitted(commit([harness.createEvent(1)]));
							const [record] = await outbox.getPending(1);
							assert(record !== undefined, "expected a pending record");
							await outbox.markFailed(record.dispatchId, new Error("boom"));
							const [after] = await outbox.getPending(1);
							assertEqual(
								after?.attempts,
								1,
								"attempts must be surfaced on the record after markFailed",
							);
						}),
					},
				),
			),
		),
		trackingGate({
			name: "reaching the attempt ceiling dead-letters the record and unblocks getPending",
			run: inEnv(async (env) => {
				const outbox = env.outbox;
				assert(
					isDispatchTrackingOutbox(outbox),
					"harness declared a tracking outbox",
				);
				await env.addCommitted(
					commit([harness.createEvent(1), harness.createEvent(2)]),
				);
				const [poison] = await outbox.getPending(1);
				assert(poison !== undefined, "expected a pending record");
				for (let i = 0; i < attemptCeiling; i++) {
					await outbox.markFailed(poison.dispatchId, new Error("poison"));
				}
				const pending = await outbox.getPending(10);
				assertEqual(
					pending.length,
					1,
					"the dead-lettered record must stop coming back; successors must flow",
				);
				assert(
					pending[0]?.dispatchId !== poison.dispatchId,
					"the surviving record must be the successor, not the poison one",
				);
				const dead = await outbox.deadLetters();
				assertEqual(dead.length, 1, "the record must appear in deadLetters()");
				assertEqual(
					dead[0]?.attempts,
					attemptCeiling,
					"the dead-letter record must carry its attempt count",
				);
			}),
		}),
		trackingGate({
			name: "markFailed on unknown or dispatched ids never resurrects a record",
			run: inEnv(async (env) => {
				const outbox = env.outbox;
				assert(
					isDispatchTrackingOutbox(outbox),
					"harness declared a tracking outbox",
				);
				await env.addCommitted(commit([harness.createEvent(1)]));
				const [record] = await outbox.getPending(1);
				assert(record !== undefined, "expected a pending record");
				await outbox.markDispatched([record.dispatchId]);
				await outbox.markFailed(record.dispatchId, new Error("late report"));
				await outbox.markFailed("no-such-id", new Error("unknown"));
				assertEqual(
					(await outbox.getPending(10)).length,
					0,
					"late or unknown failure reports must not resurrect records",
				);
				assertEqual(
					(await outbox.deadLetters()).length,
					0,
					"late or unknown failure reports must not dead-letter anything",
				);
			}),
		}),
		trackingGate({
			name: "markDispatched clears a dead-lettered record (manual redelivery then ack)",
			run: inEnv(async (env) => {
				const outbox = env.outbox;
				assert(
					isDispatchTrackingOutbox(outbox),
					"harness declared a tracking outbox",
				);
				await env.addCommitted(commit([harness.createEvent(1)]));
				const [record] = await outbox.getPending(1);
				assert(record !== undefined, "expected a pending record");
				for (let i = 0; i < attemptCeiling; i++) {
					await outbox.markFailed(record.dispatchId, new Error("poison"));
				}
				await outbox.markDispatched([record.dispatchId]);
				assertEqual(
					(await outbox.deadLetters()).length,
					0,
					"acking a dead-lettered record must clear it",
				);
			}),
		}),
	);

	return tests;
}
