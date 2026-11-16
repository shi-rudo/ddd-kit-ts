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
import {
	type IsolatedSchema,
	openIsolatedSchema,
} from "../test/isolated-schema";
import { PgEventDecodeError } from "./pg-errors";
import type { PgEventCodec } from "./pg-event-codec";
import { PgOutbox } from "./pg-outbox";
import { fromPg, type PgQueryExecutor } from "./pg-query-executor";
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

async function openOutbox({
	defaultTransactionIsolation,
	...options
}: {
	claim?: { leaseMs: number };
	codec?: PgEventCodec<ThingHappened>;
	defaultTransactionIsolation?: string;
} = {}) {
	const database = await openIsolatedSchema({ defaultTransactionIsolation });
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

	it("names the stored event that the codec cannot decode", async () => {
		const { add, outbox, teardown } = await openOutbox({
			codec: {
				encode: (event) => event,
				decode: () => {
					throw new Error("unknown schema version");
				},
			},
		});
		await add([candidate(eventNamed("event-1"))]);

		const failure = await outbox
			.getPending(10)
			.catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(PgEventDecodeError);
		expect(failure).toMatchObject({
			code: "PG_EVENT_DECODE_FAILED",
			eventId: "event-1",
			identity: { aggregateType: "Thing", aggregateId: "a-1" },
			cause: { message: "unknown schema version" },
		});
		await teardown();
	});

	it("counts a failure whose message holds a NUL byte", async () => {
		const { add, database, outbox, teardown } = await openOutbox();
		await add([candidate(eventNamed("event-1"))]);

		await outbox.markFailed("event-1", new Error("the broker said \u0000"));

		expect(await outbox.getPending(10)).toMatchObject([
			{ dispatchId: "event-1", attempts: 1 },
		]);
		const { rows } = await database.pool.query(
			"SELECT last_error FROM ddd_kit_outbox",
		);
		expect(rows[0].last_error).toBe("the broker said \uFFFD");
		await teardown();
	});

	it("rejects a limit that is not an integer", async () => {
		const { outbox, teardown } = await openOutbox();

		await expect(outbox.getPending(2.5)).rejects.toThrow(RangeError);
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

	describe("after the purge of a delivered record", () => {
		const addDeliverAndPurge = async (opened: {
			add: (
				candidates: ReadonlyArray<EventCommitCandidate<ThingHappened>>,
			) => Promise<void>;
			outbox: PgOutbox<ThingHappened>;
			database: { pool: Pool };
		}) => {
			await opened.add([candidate(eventNamed("event-5"), 5)]);
			await opened.outbox.markDispatched(["event-5"]);
			await opened.database.pool.query("DELETE FROM ddd_kit_outbox");
		};

		it("treats an exact retry at the head as a retry, so nothing is delivered again", async () => {
			const opened = await openOutbox();
			await addDeliverAndPurge(opened);

			await opened.add([candidate(eventNamed("event-5"), 5)]);

			expect(await opened.outbox.getPending()).toEqual([]);
			await opened.teardown();
		});

		it("rejects another event at the head version, because the head proves another commit", async () => {
			const opened = await openOutbox();
			await addDeliverAndPurge(opened);

			await expect(
				opened.add([candidate(eventNamed("event-other"), 5)]),
			).rejects.toMatchObject({ code: "EVENT_COLLECTION_FAILED" });

			expect(await opened.outbox.getPending()).toEqual([]);
			await opened.teardown();
		});

		it("links the next commit to the head", async () => {
			const opened = await openOutbox();
			await addDeliverAndPurge(opened);

			await opened.add([candidate(eventNamed("event-6"), 6)]);

			const [record] = await opened.outbox.getPending();
			expect(record?.position.previousEventfulAggregateVersion).toBe(5);
			await opened.teardown();
		});
	});

	it.each([
		["a lease of zero", { claim: { leaseMs: 0 } }, "leaseMs"],
		["a negative lease", { claim: { leaseMs: -1 } }, "leaseMs"],
		["a lease that is not an integer", { claim: { leaseMs: 1.5 } }, "leaseMs"],
		["no delivery attempts", { maxDeliveryAttempts: 0 }, "maxDeliveryAttempts"],
		[
			"NaN attempts",
			{ maxDeliveryAttempts: Number.NaN },
			"maxDeliveryAttempts",
		],
	])("rejects %s at construction", (_name, options, field) => {
		expect(
			() =>
				new PgOutbox<ThingHappened>({
					pool: {} as Pool,
					...options,
				}),
		).toThrow(new RegExp(`${field} must be a positive integer`));
	});

	describe("the records of a removed aggregate", () => {
		const removed = { aggregateType: "Thing", aggregateId: "a-1" };
		const recordsOf = async (database: IsolatedSchema, aggregateId: string) => {
			const { rows } = await database.pool.query(
				"SELECT event_id FROM ddd_kit_outbox WHERE aggregate_id = $1 ORDER BY position",
				[aggregateId],
			);
			return rows.map((row) => row.event_id);
		};

		it("deletes the delivered records of a source when the source ends", async () => {
			const { add, database, outbox, scope, teardown } = await openOutbox();
			await add([candidate(eventNamed("event-1"), 1)]);
			await add([candidate(eventNamed("other-1"), 1, "a-2")]);
			await outbox.markDispatched(["event-1", "other-1"]);

			await scope.transactional((tx) => outbox.endEventSources([removed], tx));

			expect(await recordsOf(database, "a-1")).toEqual([]);
			expect(await recordsOf(database, "a-2")).toEqual(["other-1"]);
			await teardown();
		});

		it("delivers a pending record of an ended source and then deletes it", async () => {
			const { add, database, outbox, scope, teardown } = await openOutbox();
			await add([candidate(eventNamed("event-1"), 1)]);
			await scope.transactional((tx) => outbox.endEventSources([removed], tx));

			const pending = await outbox.getPending(10);
			await outbox.markDispatched(pending.map((record) => record.dispatchId));

			expect(pending.map((record) => record.dispatchId)).toEqual(["event-1"]);
			expect(await recordsOf(database, "a-1")).toEqual([]);
			await teardown();
		});

		it("deletes a dead letter of an ended source when an operator marks it delivered", async () => {
			const { add, database, outbox, scope, teardown } = await openOutbox();
			await add([candidate(eventNamed("event-1"), 1)]);
			for (let attempt = 0; attempt < ATTEMPT_CEILING; attempt++) {
				await outbox.markFailed("event-1", new Error("poison"));
			}
			await scope.transactional((tx) => outbox.endEventSources([removed], tx));

			await outbox.markDispatched(["event-1"]);

			expect(await recordsOf(database, "a-1")).toEqual([]);
			await teardown();
		});

		it("makes an acknowledgement wait for an open removal, so no delivered record of the source stays", async () => {
			const { add, database, outbox, teardown } = await openOutbox();
			await add([candidate(eventNamed("event-1"), 1)]);
			const remover = await database.pool.connect();
			await remover.query("BEGIN");
			await outbox.endEventSources([removed], fromPg(remover));
			let settled = false;
			const acknowledgement = outbox
				.markDispatched(["event-1"], {
					signal: new AbortController().signal,
					deadlineAt: Date.now() + 5_000,
				})
				.finally(() => {
					settled = true;
				});
			for (;;) {
				const { rows } = await database.pool.query(
					"SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()",
				);
				if (settled || rows[0].waiting > 0) break;
			}

			await remover.query("COMMIT");
			remover.release();
			await acknowledgement;

			expect(await recordsOf(database, "a-1")).toEqual([]);
			await teardown();
		});
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

		it("starts the lease after the wait for the claim lock", async () => {
			const { add, database, outbox, teardown } = await openOutbox({
				claim: { leaseMs: 60_000 },
			});
			await add([candidate(eventNamed("event-1"))]);
			const holder = await database.pool.connect();
			await holder.query("BEGIN");
			const { rows: keys } = await holder.query(
				"SELECT hashtextextended('ddd_kit_outbox'::regclass::oid::text, 0) AS key",
			);
			await holder.query("SELECT pg_advisory_xact_lock($1::bigint)", [
				keys[0].key,
			]);
			const start = Date.now();
			const claiming = outbox.getPending(10);
			await new Promise((resolve) => setTimeout(resolve, 200));
			await holder.query("COMMIT");
			holder.release();
			await claiming;

			const { rows } = await database.pool.query(
				"SELECT extract(epoch FROM claimed_until) * 1000 AS until FROM ddd_kit_outbox",
			);
			expect(Number(rows[0].until)).toBeGreaterThanOrEqual(
				start + 200 + 60_000 - 50,
			);
			await teardown();
		});

		it("rolls back a claim that the caller aborted, so no record is stranded", async () => {
			const { add, outbox, teardown } = await openOutbox({
				claim: { leaseMs: 60_000 },
			});
			await add([candidate(eventNamed("event-1"))]);
			const controller = new AbortController();

			const poll = outbox.getPending(10, {
				signal: controller.signal,
				deadlineAt: Date.now() + 5_000,
			});
			controller.abort(new Error("the deadline passed"));
			await expect(poll).rejects.toThrow("the deadline passed");

			await expect
				.poll(async () =>
					(await outbox.getPending(10)).map((r) => r.dispatchId),
				)
				.toEqual(["event-1"]);
			await teardown();
		});

		it("cancels a statement in the database when the deadline passes", async () => {
			const { add, database, outbox, teardown } = await openOutbox();
			await add([candidate(eventNamed("event-1"))]);
			const blocker = await database.pool.connect();
			await blocker.query("BEGIN");
			await blocker.query("LOCK TABLE ddd_kit_outbox IN ACCESS EXCLUSIVE MODE");

			await expect(
				outbox.getPending(10, {
					signal: new AbortController().signal,
					deadlineAt: Date.now() + 100,
				}),
			).rejects.toMatchObject({ code: "57014" });

			await blocker.query("ROLLBACK");
			blocker.release();
			await teardown();
		});

		it.each(["repeatable read", "serializable"])(
			"claims with a context on a database whose default isolation is %s",
			async (defaultTransactionIsolation) => {
				const { add, outbox, teardown } = await openOutbox({
					claim: { leaseMs: 60_000 },
					defaultTransactionIsolation,
				});
				await add([candidate(eventNamed("event-1"))]);

				const claimed = await outbox.getPending(10, {
					signal: new AbortController().signal,
					deadlineAt: Date.now() + 5_000,
				});

				expect(claimed.map((r) => r.dispatchId)).toEqual(["event-1"]);
				await teardown();
			},
		);

		it("retries a failed record when its lease ends, and counts the attempt", async () => {
			const { add, outbox, teardown } = await openOutbox({
				claim: { leaseMs: 500 },
			});
			await add([candidate(eventNamed("event-1"))]);
			await outbox.getPending(10);

			await outbox.markFailed("event-1", new Error("the broker is down"));

			expect(await outbox.getPending(10)).toEqual([]);
			await expect
				.poll(() => outbox.getPending(10), { timeout: 3_000 })
				.toMatchObject([{ dispatchId: "event-1", attempts: 1 }]);
			await teardown();
		});

		it("holds back a later event while another statement locks the earlier one after its lease", async () => {
			const { add, database, outbox, teardown } = await openOutbox({
				claim: { leaseMs: 1 },
			});
			await add([candidate(eventNamed("event-1"), 1)]);
			await add([candidate(eventNamed("event-2"), 2)]);
			await outbox.getPending(1);
			await new Promise((resolve) => setTimeout(resolve, 20));
			const lateAcknowledgement = await database.pool.connect();
			await lateAcknowledgement.query("BEGIN");
			await lateAcknowledgement.query(
				"SELECT 1 FROM ddd_kit_outbox WHERE event_id = 'event-1' FOR UPDATE",
			);

			const claimed = await outbox.getPending(10);

			expect(claimed).toEqual([]);
			await lateAcknowledgement.query("ROLLBACK");
			lateAcknowledgement.release();
			await teardown();
		});

		it("keeps the claim of another dispatcher when a failure report comes after the lease", async () => {
			const { add, database, outbox, teardown } = await openOutbox({
				claim: { leaseMs: 1 },
			});
			const otherDispatcher = new PgOutbox<ThingHappened>({
				pool: database.pool,
				maxDeliveryAttempts: ATTEMPT_CEILING,
				claim: { leaseMs: 60_000 },
			});
			await add([candidate(eventNamed("event-1"))]);
			await outbox.getPending(10);
			await new Promise((resolve) => setTimeout(resolve, 20));
			await otherDispatcher.getPending(10);

			await outbox.markFailed("event-1", new Error("the late failure"));

			expect(await otherDispatcher.getPending(10)).toEqual([]);
			await teardown();
		});
	});
});
