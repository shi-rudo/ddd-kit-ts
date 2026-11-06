import type { AggregateIdentity, DomainEvent } from "@shirudo/ddd-kit";
import { createDomainEvent } from "@shirudo/ddd-kit";
import { createEventStoreContractTests } from "@shirudo/ddd-kit/testing";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it } from "vite-plus/test";
import { openIsolatedSchema } from "../test/isolated-schema";
import { PgUnsupportedIsolationLevelError } from "./pg-errors";
import type { PgEventCodec } from "./pg-event-codec";
import { PgEventStore } from "./pg-event-store";
import { fromPg, type PgQueryExecutor } from "./pg-query-executor";

type NoteWritten = DomainEvent<"NoteWritten", unknown>;

const stream: AggregateIdentity = {
	aggregateType: "Note",
	aggregateId: "note-1",
};

function noteWritten(
	payload: unknown,
	options: { eventId?: string; metadata?: Record<string, string> } = {},
): NoteWritten {
	return createDomainEvent("NoteWritten", payload, {
		eventId: options.eventId ?? crypto.randomUUID(),
		metadata: options.metadata,
		...stream,
	});
}

/** Opens a store on its own connection, outside a transaction. */
async function openStore(codec?: PgEventCodec<NoteWritten>) {
	const database = await openIsolatedSchema();
	await database.applySql("event-stream.sql");
	const client: PoolClient = await database.pool.connect();
	return {
		client,
		pool: database.pool,
		store: new PgEventStore<NoteWritten>(fromPg(client), { codec }),
		teardown: async () => {
			client.release();
			await database.teardown();
		},
	};
}

/** Starts `work`, and resolves when `client` waits for a lock of another writer. */
const startAndWaitUntilBlocked = async (
	pool: Pool,
	client: PoolClient,
	work: () => Promise<void>,
): Promise<{ readonly settled: Promise<unknown> }> => {
	const { rows } = await client.query("SELECT pg_backend_pid() AS pid");
	const settled = work().then(
		() => undefined,
		(error: unknown) => error,
	);
	for (;;) {
		const activity = await pool.query(
			"SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
			[rows[0].pid],
		);
		if (activity.rows[0]?.wait_event_type === "Lock") return { settled };
	}
};

describe("PgEventStore contract suite", () => {
	const tests = createEventStoreContractTests<NoteWritten>({
		createEnvironment: async () => {
			const { store, teardown } = await openStore();
			return { store, teardown };
		},
		createCollidingStreamKeys: () => [
			{ aggregateType: "Alpha", aggregateId: "shared-1" },
			{ aggregateType: "Beta", aggregateId: "shared-1" },
		],
		createEvent: (identity, sequence) =>
			createDomainEvent(
				"NoteWritten",
				{ sequence },
				{
					eventId: `${identity.aggregateType}-${identity.aggregateId}-${sequence}`,
					...identity,
				},
			),
	});

	for (const test of tests) {
		(test.skipped ? it.skip : it)(test.name, test.run);
	}

	it("runs with zero skips", () => {
		expect(tests.filter((test) => test.skipped)).toEqual([]);
	});
});

describe("PgEventStore", () => {
	it.each([
		["text with quotes, a backslash, and a comma", { text: 'a "b" \\c, d' }],
		["unicode", { text: "寿司 🍣" }],
		["null", null],
		["undefined", undefined],
		["an empty record", {}],
		["a nested array", { items: [1, [2, { three: 3 }]] }],
	])("keeps a payload of %s", async (_name, payload) => {
		const { store, teardown } = await openStore();
		const event = noteWritten(payload);

		await store.append(stream, [event], { expectedVersion: 0 });

		const read = await store.readStream(stream, { limit: 1 });
		expect(read.events[0]).toHaveProperty("payload");
		expect(read.events[0]?.payload).toStrictEqual(payload);
		await teardown();
	});

	it("keeps every field of the envelope", async () => {
		const { store, teardown } = await openStore();
		const event = noteWritten(
			{ text: "first" },
			{ metadata: { correlationId: "correlation-1" } },
		);

		await store.append(stream, [event], { expectedVersion: 0 });

		const read = await store.readStream(stream, { limit: 1 });
		expect(read.events[0]).toEqual({
			eventId: event.eventId,
			type: "NoteWritten",
			...stream,
			payload: { text: "first" },
			occurredAt: event.occurredAt,
			schemaVersion: event.schemaVersion,
			metadata: { correlationId: "correlation-1" },
		});
		await teardown();
	});

	it("rejects a payload that JSON does not keep, names the path, and writes nothing", async () => {
		const { store, teardown } = await openStore();

		await expect(
			store.append(stream, [noteWritten({ at: new Date(0) })], {
				expectedVersion: 0,
			}),
		).rejects.toThrow(/events\[0\] payload: \$\.at is not JSON-safe/);

		const read = await store.readStream(stream, { limit: 1 });
		expect(read.exists).toBe(false);
		await teardown();
	});

	it("rejects an event of another aggregate before any write", async () => {
		const { store, teardown } = await openStore();
		const foreign = createDomainEvent(
			"NoteWritten",
			{},
			{ aggregateType: "Note", aggregateId: "note-2" },
		);

		await expect(
			store.append(stream, [foreign], { expectedVersion: 0 }),
		).rejects.toMatchObject({ code: "MISATTRIBUTED_EVENT" });

		const read = await store.readStream(stream, { limit: 1 });
		expect(read.exists).toBe(false);
		await teardown();
	});

	describe("with a codec", () => {
		const dateCodec: PgEventCodec<NoteWritten> = {
			encode: (event) => ({
				...event,
				payload: {
					at: (event.payload as { at: Date }).at.toISOString(),
				},
			}),
			decode: (stored) => ({
				...stored,
				type: "NoteWritten",
				payload: { at: new Date((stored.payload as { at: string }).at) },
			}),
		};

		it("stores JSON and returns the domain value on the read", async () => {
			const { client, store, teardown } = await openStore(dateCodec);
			const at = new Date("2026-01-05T10:20:30.456Z");

			await store.append(stream, [noteWritten({ at })], {
				expectedVersion: 0,
			});

			const read = await store.readStream(stream, { limit: 1 });
			expect(read.events[0]?.payload).toEqual({ at });
			const { rows } = await client.query(
				"SELECT payload FROM ddd_kit_event_stream",
			);
			expect(rows[0].payload).toEqual({ at: at.toISOString() });
			await teardown();
		});

		it("upcasts a stored event of an older schema version on the read", async () => {
			const { client, store, teardown } = await openStore({
				encode: (event) => event,
				decode: (stored) =>
					stored.schemaVersion === 1
						? {
								...stored,
								type: "NoteWritten",
								schemaVersion: 2,
								payload: { title: (stored.payload as { text: string }).text },
							}
						: (stored as NoteWritten),
			});
			await client.query(
				`INSERT INTO ddd_kit_event_stream
				(aggregate_type, aggregate_id, position, event_id, event_type, schema_version, occurred_at, payload)
				VALUES ('Note', 'note-1', 1, 'event-1', 'NoteWritten', 1, now(), '{"text":"old"}')`,
			);

			const read = await store.readStream(stream, { limit: 1 });

			expect(read.events[0]).toMatchObject({
				schemaVersion: 2,
				payload: { title: "old" },
			});
			await teardown();
		});
	});

	describe("a corrupt stream", () => {
		it.each([
			["a gap in the middle", 2],
			["a missing first position", 1],
		])(
			"rejects %s instead of folding a truncated stream",
			async (_name, removed) => {
				const { client, store, teardown } = await openStore();
				await store.append(
					stream,
					[noteWritten({}), noteWritten({}), noteWritten({})],
					{ expectedVersion: 0 },
				);
				await client.query(
					"DELETE FROM ddd_kit_event_stream WHERE position = $1",
					[removed],
				);

				await expect(
					store.readStream(stream, { limit: 10 }),
				).rejects.toMatchObject({ code: "PG_EVENT_STREAM_CORRUPT" });
				await teardown();
			},
		);
	});

	describe("two writers", () => {
		const appendInTransaction = async (
			client: PoolClient,
			work: (executor: PgQueryExecutor) => Promise<void>,
		) => {
			await client.query("BEGIN");
			await work(fromPg(client));
		};

		it("the second writer of a new stream gets DuplicateAggregateError", async () => {
			const { pool, teardown } = await openStore();
			const first = await pool.connect();
			const second = await pool.connect();
			await appendInTransaction(first, (executor) =>
				new PgEventStore<NoteWritten>(executor).append(
					stream,
					[noteWritten({})],
					{ expectedVersion: 0 },
				),
			);

			await second.query("BEGIN");
			const racing = await startAndWaitUntilBlocked(pool, second, () =>
				new PgEventStore<NoteWritten>(fromPg(second)).append(
					stream,
					[noteWritten({})],
					{ expectedVersion: 0 },
				),
			);
			await first.query("COMMIT");

			expect(await racing.settled).toMatchObject({
				code: "DUPLICATE_AGGREGATE",
			});
			await second.query("ROLLBACK");
			first.release();
			second.release();
			await teardown();
		});

		it("maps a unique violation at REPEATABLE READ, where the stale snapshot hides the head", async () => {
			const { pool, store, teardown } = await openStore();
			const second = await pool.connect();
			await second.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
			await second.query("SELECT 1 FROM ddd_kit_event_stream");
			await store.append(stream, [noteWritten({})], { expectedVersion: 0 });

			await expect(
				new PgEventStore<NoteWritten>(fromPg(second)).append(
					stream,
					[noteWritten({})],
					{ expectedVersion: 0 },
				),
			).rejects.toMatchObject({
				code: "DUPLICATE_AGGREGATE",
				cause: { code: "23505" },
			});

			await second.query("ROLLBACK");
			second.release();
			await teardown();
		});

		it("the second writer of a stream gets a retryable ConcurrencyConflictError", async () => {
			const { pool, store, teardown } = await openStore();
			await store.append(stream, [noteWritten({})], { expectedVersion: 0 });
			const first = await pool.connect();
			const second = await pool.connect();
			await appendInTransaction(first, (executor) =>
				new PgEventStore<NoteWritten>(executor).append(
					stream,
					[noteWritten({})],
					{ expectedVersion: 1 },
				),
			);

			await second.query("BEGIN");
			const racing = await startAndWaitUntilBlocked(pool, second, () =>
				new PgEventStore<NoteWritten>(fromPg(second)).append(
					stream,
					[noteWritten({})],
					{ expectedVersion: 1 },
				),
			);
			await first.query("COMMIT");

			expect(await racing.settled).toMatchObject({
				code: "CONCURRENCY_CONFLICT",
				retryable: true,
				actualVersion: 2,
			});
			await second.query("ROLLBACK");
			first.release();
			second.release();
			await teardown();
		});
	});

	describe("removeStream", () => {
		it("deletes the whole stream, so a read reports it as absent", async () => {
			const { store, teardown } = await openStore();
			await store.append(stream, [noteWritten({}), noteWritten({})], {
				expectedVersion: 0,
			});

			await store.removeStream(stream, { expectedVersion: 2 });

			expect(await store.readStream(stream, { limit: 1 })).toEqual({
				exists: false,
				lastVersion: 0,
				events: [],
			});
			await teardown();
		});

		it("leaves another stream with the same id untouched", async () => {
			const { store, teardown } = await openStore();
			const other = { aggregateType: "Other", aggregateId: stream.aggregateId };
			await store.append(stream, [noteWritten({})], { expectedVersion: 0 });
			await store.append(
				other,
				[
					createDomainEvent(
						"NoteWritten",
						{},
						{
							eventId: "other-1",
							...other,
						},
					),
				],
				{ expectedVersion: 0 },
			);

			await store.removeStream(stream, { expectedVersion: 1 });

			expect((await store.readStream(other, { limit: 1 })).exists).toBe(true);
			await teardown();
		});

		it("rejects a stale version and keeps the stream", async () => {
			const { store, teardown } = await openStore();
			await store.append(stream, [noteWritten({}), noteWritten({})], {
				expectedVersion: 0,
			});

			await expect(
				store.removeStream(stream, { expectedVersion: 1 }),
			).rejects.toMatchObject({
				code: "CONCURRENCY_CONFLICT",
				reason: "stale_version",
				actualVersion: 2,
			});

			const read = await store.readStream(stream, { limit: 1 });
			expect(read.lastVersion).toBe(2);
			await teardown();
		});

		it("waits for an open append and then rejects it as stale, so no event survives the removal", async () => {
			const { pool, store, teardown } = await openStore();
			await store.append(stream, [noteWritten({})], { expectedVersion: 0 });
			const appender = await pool.connect();
			const remover = await pool.connect();
			await appender.query("BEGIN");
			await new PgEventStore<NoteWritten>(fromPg(appender)).append(
				stream,
				[noteWritten({})],
				{ expectedVersion: 1 },
			);

			const removal = await startAndWaitUntilBlocked(pool, remover, () =>
				new PgEventStore<NoteWritten>(fromPg(remover)).removeStream(stream, {
					expectedVersion: 1,
				}),
			);
			await appender.query("COMMIT");

			expect(await removal.settled).toMatchObject({
				code: "CONCURRENCY_CONFLICT",
				actualVersion: 2,
			});
			expect((await store.readStream(stream, { limit: 10 })).lastVersion).toBe(
				2,
			);
			appender.release();
			remover.release();
			await teardown();
		});

		it("makes an append that waited for it fail, so no event lands in a removed stream", async () => {
			const { pool, store, teardown } = await openStore();
			await store.append(stream, [noteWritten({})], { expectedVersion: 0 });
			const appender = await pool.connect();
			const remover = await pool.connect();
			await remover.query("BEGIN");
			await new PgEventStore<NoteWritten>(fromPg(remover)).removeStream(
				stream,
				{
					expectedVersion: 1,
				},
			);

			const append = await startAndWaitUntilBlocked(pool, appender, () =>
				new PgEventStore<NoteWritten>(fromPg(appender)).append(
					stream,
					[noteWritten({})],
					{ expectedVersion: 1 },
				),
			);
			await remover.query("COMMIT");

			expect(await append.settled).toMatchObject({
				code: "CONCURRENCY_CONFLICT",
				actualVersion: 0,
			});
			expect((await store.readStream(stream, { limit: 1 })).exists).toBe(false);
			appender.release();
			remover.release();
			await teardown();
		});

		it("rolls back with the transaction", async () => {
			const { client, store, teardown } = await openStore();
			await store.append(stream, [noteWritten({})], { expectedVersion: 0 });

			await client.query("BEGIN");
			await store.removeStream(stream, { expectedVersion: 1 });
			await client.query("ROLLBACK");

			const read = await store.readStream(stream, { limit: 1 });
			expect(read.exists).toBe(true);
			await teardown();
		});

		it.each(["REPEATABLE READ", "SERIALIZABLE"])(
			"rejects a removal at %s and keeps the stream",
			async (level) => {
				const { client, store, teardown } = await openStore();
				await store.append(stream, [noteWritten({})], { expectedVersion: 0 });

				await client.query(`BEGIN ISOLATION LEVEL ${level}`);
				const failure = await store
					.removeStream(stream, { expectedVersion: 1 })
					.catch((error: unknown) => error);
				await client.query("ROLLBACK");

				expect(failure).toBeInstanceOf(PgUnsupportedIsolationLevelError);
				expect(failure).toMatchObject({
					code: "PG_UNSUPPORTED_ISOLATION_LEVEL",
					isolationLevel: level.toLowerCase(),
					identity: stream,
				});
				expect((await store.readStream(stream, { limit: 1 })).exists).toBe(
					true,
				);
				await teardown();
			},
		);
	});

	describe("the abort signal of a read", () => {
		const hangingExecutor: PgQueryExecutor = {
			query: () => new Promise(() => {}),
		};

		it("rejects with the reason of a signal that already aborted", async () => {
			const reason = new Error("the caller gave up");

			await expect(
				new PgEventStore<NoteWritten>(hangingExecutor).readStream(stream, {
					limit: 1,
					signal: AbortSignal.abort(reason),
				}),
			).rejects.toBe(reason);
		});

		it("stops waiting for a hanging read when the signal aborts", async () => {
			const controller = new AbortController();
			const reason = new Error("the caller gave up");

			const read = new PgEventStore<NoteWritten>(hangingExecutor).readStream(
				stream,
				{ limit: 1, signal: controller.signal },
			);
			controller.abort(reason);

			await expect(read).rejects.toBe(reason);
		});
	});

	it("appends a large batch atomically", async () => {
		const { store, teardown } = await openStore();
		const events = Array.from({ length: 10_000 }, (_, index) =>
			noteWritten({ index }),
		);

		await store.append(stream, events, { expectedVersion: 0 });

		const read = await store.readStream(stream, {
			limit: 1,
			fromVersion: 9_999,
		});
		expect(read.lastVersion).toBe(10_000);
		expect(read.events[0]?.payload).toEqual({ index: 9_999 });
		await teardown();
	});
});
