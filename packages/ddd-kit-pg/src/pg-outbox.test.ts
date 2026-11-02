import {
	createDomainEvent,
	type DomainEvent,
	type EventCommitCandidate,
	OutboxDispatcher,
	type OutboxDispatcherObservers,
} from "@shirudo/ddd-kit";
import { createOutboxContractTests } from "@shirudo/ddd-kit/testing";
import type { Pool } from "pg";
import { describe, expect, it } from "vite-plus/test";
import { openIsolatedSchema } from "../test/isolated-schema";
import type { PgEventCodec } from "./pg-event-codec";
import { PgOutbox } from "./pg-outbox";
import type { PgQueryExecutor } from "./pg-query-executor";
import { PgTransactionScope } from "./pg-transaction-scope";

type ThingHappened = DomainEvent<"ThingHappened", unknown>;

const ATTEMPT_CEILING = 3;
const ROLLBACK = new Error("the contract suite asked for a rollback");

function eventNamed(eventId: string, payload: unknown = {}): ThingHappened {
	return createDomainEvent("ThingHappened", payload, { eventId });
}

function candidate(
	event: ThingHappened,
	aggregateVersion = 1,
	aggregateId = "a-1",
): EventCommitCandidate<ThingHappened> {
	return {
		event,
		source: { aggregateType: "Thing", aggregateId },
		position: { aggregateVersion, commitSequence: 0, commitSize: 1 },
	};
}

async function openOutbox(
	options: {
		claim?: { leaseMs: number };
		codec?: PgEventCodec<ThingHappened>;
	} = {},
) {
	const database = await openIsolatedSchema();
	await database.applySql("outbox.sql");
	const scope = new PgTransactionScope(database.pool);
	const outbox = new PgOutbox<ThingHappened>({
		pool: database.pool,
		maxDeliveryAttempts: ATTEMPT_CEILING,
		...options,
	});
	return {
		database,
		scope,
		outbox,
		add: (candidates: ReadonlyArray<EventCommitCandidate<ThingHappened>>) =>
			scope.transactional((tx) => outbox.add(candidates, tx)),
		teardown: database.teardown,
	};
}

describe.each([
	["without claiming", undefined],
	["with claiming", { leaseMs: 60_000 }],
])("PgOutbox contract suite %s", (_name, claim) => {
	const tests = createOutboxContractTests<ThingHappened>({
		createEnvironment: async () => {
			const { scope, outbox, teardown } = await openOutbox({ claim });
			const rolledBack = (write: (tx: PgQueryExecutor) => Promise<void>) =>
				scope
					.transactional(async (tx) => {
						await write(tx);
						throw ROLLBACK;
					})
					.catch((error: unknown) => {
						if (error !== ROLLBACK) throw error;
					});
			return {
				outbox,
				addCommitted: (events) =>
					scope.transactional((tx) => outbox.add(events, tx)),
				addRolledBack: (events) => rolledBack((tx) => outbox.add(events, tx)),
				endEventSourcesCommitted: (sources) =>
					scope.transactional((tx) => outbox.endEventSources(sources, tx)),
				endEventSourcesRolledBack: (sources) =>
					rolledBack((tx) => outbox.endEventSources(sources, tx)),
				teardown,
			};
		},
		createEvent: (seed) => eventNamed(`event-${seed}`, { seed }),
		failuresToDeadLetter: ATTEMPT_CEILING,
		dedupesOnEventId: true,
		providesRolledBackAdds: true,
		providesRolledBackEnds: true,
		claimsOnGetPending: claim !== undefined,
	});

	for (const test of tests) {
		(test.skipped ? it.skip : it)(test.name, test.run);
	}

	it("skips only the tests that a claiming adapter cannot run", () => {
		expect(
			tests.flatMap((test) => (test.skipped ? [test.skipped.capability] : [])),
		).toEqual(
			claim === undefined ? [] : Array(4).fill("non-claiming getPending"),
		);
	});
});

describe("PgOutbox", () => {
	it("rejects a payload that JSON does not keep and writes nothing", async () => {
		const { add, outbox, teardown } = await openOutbox();

		await expect(
			add([candidate(eventNamed("event-1", { at: new Date(0) }))]),
		).rejects.toThrow(/payload: \$\.at is not JSON-safe/);

		expect(await outbox.getPending()).toEqual([]);
		await teardown();
	});

	it("maps a payload with the codec on the write and on the read", async () => {
		const at = new Date("2026-01-05T10:20:30.456Z");
		const { add, database, outbox, teardown } = await openOutbox({
			codec: {
				encode: (event) => ({
					...event,
					payload: { at: (event.payload as { at: Date }).at.toISOString() },
				}),
				decode: (stored) => ({
					...stored,
					type: "ThingHappened",
					payload: { at: new Date((stored.payload as { at: string }).at) },
				}),
			},
		});

		await add([candidate(eventNamed("event-1", { at }))]);

		const [record] = await outbox.getPending();
		expect(record?.event.payload).toEqual({ at });
		const { rows } = await database.pool.query(
			"SELECT payload FROM ddd_kit_outbox",
		);
		expect(rows[0].payload).toEqual({ at: at.toISOString() });
		await teardown();
	});

	it("rejects an event id that another source already holds", async () => {
		const { add, outbox, teardown } = await openOutbox();
		await add([candidate(eventNamed("event-1"))]);

		await expect(
			add([candidate(eventNamed("event-1"), 1, "a-2")]),
		).rejects.toMatchObject({ code: "EVENT_COLLECTION_FAILED" });

		expect(await outbox.getPending()).toHaveLength(1);
		await teardown();
	});

	it("rejects an event below the head of its source", async () => {
		const { add, teardown } = await openOutbox();
		await add([candidate(eventNamed("event-1"), 5)]);

		await expect(
			add([candidate(eventNamed("event-2"), 4)]),
		).rejects.toMatchObject({ code: "EVENT_COLLECTION_FAILED" });

		await teardown();
	});

	it("rejects another commit size at one aggregate version", async () => {
		const { add, teardown } = await openOutbox();
		await add([candidate(eventNamed("event-1"), 1)]);

		await expect(
			add([
				{
					...candidate(eventNamed("event-2"), 1),
					position: { aggregateVersion: 1, commitSequence: 1, commitSize: 2 },
				},
			]),
		).rejects.toMatchObject({ code: "EVENT_COLLECTION_FAILED" });

		await teardown();
	});

	it("serializes two transactions of one source, so both link to their predecessor", async () => {
		const { add, outbox, teardown } = await openOutbox();

		const results = await Promise.allSettled(
			Array.from({ length: 10 }, (_, index) =>
				add([candidate(eventNamed(`event-${index + 1}`), index + 1)]),
			),
		);

		const pending = await outbox.getPending();
		const versions = pending.map(({ position }) => position.aggregateVersion);
		const committed = results.filter((result) => result.status === "fulfilled");
		expect(committed.length).toBeGreaterThan(0);
		expect(pending).toHaveLength(committed.length);
		// A commit below the head rejects, so the commit order is ascending.
		expect(versions).toEqual([...versions].sort((a, b) => a - b));
		pending.forEach(({ position }, index) => {
			expect(position.previousEventfulAggregateVersion).toBe(
				index === 0 ? null : (versions[index - 1] ?? null),
			);
		});
		await teardown();
	});

	it("delivers through OutboxDispatcher and stops returning delivered records", async () => {
		const { add, outbox, teardown } = await openOutbox();
		await add([candidate(eventNamed("event-1"))]);
		const delivered: string[] = [];
		const silent: OutboxDispatcherObservers<ThingHappened> = {
			onPollError: () => {},
			onDispatchError: () => {},
			onDeadLetter: () => {},
		};
		const dispatcher = new OutboxDispatcher<ThingHappened>({
			outbox,
			sink: {
				publish: async (record) => {
					delivered.push(record.event.eventId);
				},
			},
			observers: silent,
		});

		await dispatcher.drainOnce();

		expect(delivered).toEqual(["event-1"]);
		expect(await outbox.getPending()).toEqual([]);
		await teardown();
	});

	it("stops waiting for a hanging poll when the signal aborts", async () => {
		const outbox = new PgOutbox<ThingHappened>({
			pool: {
				query: () => new Promise(() => {}),
				connect: () => new Promise(() => {}),
			} as unknown as Pool,
		});
		const controller = new AbortController();
		const reason = new Error("the deadline passed");

		const poll = outbox.getPending(1, {
			signal: controller.signal,
			deadlineAt: Date.now() + 1_000,
		});
		controller.abort(reason);

		await expect(poll).rejects.toBe(reason);
	});

	describe("competing dispatchers", () => {
		it("hands a record to one dispatcher only", async () => {
			const { add, outbox, teardown } = await openOutbox({
				claim: { leaseMs: 60_000 },
			});
			await add([candidate(eventNamed("event-1"))]);

			const first = await outbox.getPending(10);
			const second = await outbox.getPending(10);

			expect(first.map((r) => r.dispatchId)).toEqual(["event-1"]);
			expect(second).toEqual([]);
			await teardown();
		});

		it("holds back a later event of a source while an earlier one is claimed", async () => {
			const { add, outbox, teardown } = await openOutbox({
				claim: { leaseMs: 60_000 },
			});
			await add([candidate(eventNamed("event-1"), 1)]);
			await add([candidate(eventNamed("event-2"), 2)]);
			await add([candidate(eventNamed("event-3"), 1, "a-2")]);

			const first = await outbox.getPending(1);
			const second = await outbox.getPending(10);

			expect(first.map((r) => r.dispatchId)).toEqual(["event-1"]);
			expect(second.map((r) => r.dispatchId)).toEqual(["event-3"]);
			await outbox.markDispatched(["event-1"]);
			const third = await outbox.getPending(10);
			expect(third.map((r) => r.dispatchId)).toEqual(["event-2"]);
			await teardown();
		});

		it("keeps the order of a source across many concurrent polls", {
			repeats: 20,
			timeout: 30_000,
		}, async () => {
			const { add, outbox, teardown } = await openOutbox({
				claim: { leaseMs: 60_000 },
			});
			for (let version = 1; version <= 20; version += 1) {
				await add([candidate(eventNamed(`event-${version}`), version)]);
			}
			const delivered: number[] = [];
			const stopAt = Date.now() + 4_000;
			const poller = async () => {
				while (delivered.length < 20 && Date.now() < stopAt) {
					const records = await outbox.getPending(1);
					for (const record of records) {
						delivered.push(record.position.aggregateVersion);
						await outbox.markDispatched([record.dispatchId]);
					}
				}
			};

			await Promise.all([poller(), poller(), poller(), poller()]);

			expect(delivered).toEqual(
				Array.from({ length: 20 }, (_, index) => index + 1),
			);
			await teardown();
		});

		it("gives a record to another dispatcher after the lease of a crashed one ends", async () => {
			const { add, outbox, teardown } = await openOutbox({
				claim: { leaseMs: 1 },
			});
			await add([candidate(eventNamed("event-1"))]);
			await outbox.getPending(10);
			await new Promise((resolve) => setTimeout(resolve, 20));

			const reclaimed = await outbox.getPending(10);

			expect(reclaimed.map((r) => r.dispatchId)).toEqual(["event-1"]);
			await teardown();
		});

		it("releases the claim of a failed record, so the next poll retries it", async () => {
			const { add, outbox, teardown } = await openOutbox({
				claim: { leaseMs: 60_000 },
			});
			await add([candidate(eventNamed("event-1"))]);
			await outbox.getPending(10);

			await outbox.markFailed("event-1", new Error("the broker is down"));

			const retried = await outbox.getPending(10);
			expect(retried).toMatchObject([{ dispatchId: "event-1", attempts: 1 }]);
			await teardown();
		});
	});
});
