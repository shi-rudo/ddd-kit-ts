import {
	createDomainEvent,
	type DomainEvent,
	OutboxDispatcher,
	Projector,
} from "@shirudo/ddd-kit";
import { createProjectionCheckpointStoreContractTests } from "@shirudo/ddd-kit/testing";
import { describe, expect, it } from "vite-plus/test";
import {
	openIsolatedSchema,
	openTablesBehindPrivateSchemas,
} from "../test/isolated-schema";
import { PgOutbox } from "./pg-outbox";
import { fromPgPool } from "./pg-pool-executor";
import { PgProjectionCheckpointStore } from "./pg-projection-checkpoint-store";
import { fromPg, type PgQueryExecutor } from "./pg-query-executor";
import { PgTransactionScope } from "./pg-transaction-scope";

const ROLLBACK = new Error("the contract suite asked for a rollback");

describe("PgProjectionCheckpointStore contract suite", () => {
	const tests = createProjectionCheckpointStoreContractTests<PgQueryExecutor>({
		createEnvironment: async () => {
			const database = await openIsolatedSchema();
			await database.applySql("projection-checkpoint.sql");
			const scope = new PgTransactionScope(database.pool);
			return {
				store: new PgProjectionCheckpointStore(fromPgPool(database.pool)),
				run: (work) => scope.transactional(work),
				runConcurrently: (works) =>
					Promise.all(works.map((work) => scope.transactional(work))),
				runRolledBack: async (work) => {
					await scope
						.transactional(async (tx) => {
							await work(tx);
							throw ROLLBACK;
						})
						.catch((error: unknown) => {
							if (error !== ROLLBACK) throw error;
						});
					return undefined as never;
				},
				teardown: database.teardown,
			};
		},
		providesRolledBackRuns: true,
		providesConcurrentRuns: true,
	});

	for (const test of tests) {
		(test.skipped ? it.skip : it)(test.name, test.run);
	}

	it("runs with zero skips", () => {
		expect(tests.filter((test) => test.skipped)).toEqual([]);
	});
});

describe("PgProjectionCheckpointStore", () => {
	it("serializes the checkpoint locks of two roles, although their search paths start with other schemas", async () => {
		const {
			pools: [first, second],
			teardown,
		} = await openTablesBehindPrivateSchemas("projection-checkpoint.sql");
		const identity = { aggregateType: "Note", aggregateId: "note-1" };
		const holder = await first.connect();
		const contender = await second.connect();
		await holder.query("BEGIN");
		await new PgProjectionCheckpointStore(
			fromPgPool(first),
		).withCheckpointLocks(fromPg(holder), "notes", [identity], async () => {});
		await contender.query("BEGIN");
		await contender.query("SET LOCAL lock_timeout = '500ms'");

		const failure = await new PgProjectionCheckpointStore(fromPgPool(second))
			.withCheckpointLocks(
				fromPg(contender),
				"notes",
				[identity],
				async () => {},
			)
			.catch((error: unknown) => error);

		expect(failure).toMatchObject({ code: "55P03" });
		await contender.query("ROLLBACK");
		await holder.query("ROLLBACK");
		holder.release();
		contender.release();
		await teardown();
	});

	it("locks every aggregate of a batch in one round trip", async () => {
		const database = await openIsolatedSchema();
		await database.applySql("projection-checkpoint.sql");
		const client = await database.pool.connect();
		await client.query("BEGIN");
		const tx = fromPg(client);
		const statements: string[] = [];
		const countingTx: PgQueryExecutor = {
			query: (text, values, context) => {
				statements.push(text);
				return tx.query(text, values, context);
			},
		};
		const identities = ["note-1", "note-2", "note-3", "note-1"].map(
			(aggregateId) => ({ aggregateType: "Note", aggregateId }),
		);

		await new PgProjectionCheckpointStore(
			fromPgPool(database.pool),
		).withCheckpointLocks(countingTx, "notes", identities, async () => {});
		const { rows } = await client.query<{ locks: number }>(
			`SELECT count(*)::int AS locks FROM pg_locks
			WHERE locktype = 'advisory' AND pid = pg_backend_pid()`,
		);

		expect(statements).toHaveLength(1);
		expect(rows[0]?.locks).toBe(3);
		await client.query("ROLLBACK");
		client.release();
		await database.teardown();
	});
});

type NoteWritten = DomainEvent<"NoteWritten", { text: string }>;

describe("a Projector on PostgreSQL behind the PgOutbox", () => {
	const openProjection = async () => {
		const database = await openIsolatedSchema();
		await database.applySql("outbox.sql");
		await database.applySql("projection-checkpoint.sql");
		await database.pool.query(
			"CREATE TABLE note_view (id text PRIMARY KEY, text text NOT NULL)",
		);
		const scope = new PgTransactionScope(database.pool);
		const outbox = new PgOutbox<NoteWritten>({ pool: database.pool });
		const projector = new Projector<NoteWritten, PgQueryExecutor>({
			scope,
			checkpoints: new PgProjectionCheckpointStore(fromPgPool(database.pool)),
			projection: {
				name: "note-view",
				apply: async (tx, event) => {
					await tx.query(
						`INSERT INTO note_view (id, text) VALUES ($1, $2)
						ON CONFLICT (id) DO UPDATE SET text = EXCLUDED.text`,
						[event.aggregateId, event.payload.text],
					);
				},
				truncate: async (tx) => {
					await tx.query("TRUNCATE note_view");
				},
			},
		});
		const write = (aggregateVersion: number, text: string) =>
			scope.transactional((tx) =>
				outbox.add(
					[
						{
							event: createDomainEvent(
								"NoteWritten",
								{ text },
								{
									eventId: `note-${aggregateVersion}`,
									aggregateType: "Note",
									aggregateId: "note-1",
								},
							),
							source: { aggregateType: "Note", aggregateId: "note-1" },
							position: { aggregateVersion, commitSequence: 0, commitSize: 1 },
						},
					],
					tx,
				),
			);
		const view = async () => {
			const { rows } = await database.pool.query("SELECT text FROM note_view");
			return rows.map((row) => row.text);
		};
		return { database, outbox, projector, write, view };
	};

	it("applies each event once, also when the outbox delivers it again", async () => {
		const { database, outbox, projector, write, view } = await openProjection();
		await write(1, "first");
		await write(2, "second");
		const records = await outbox.getPending();

		const first = await projector.project(records);
		const redelivery = await projector.project(records);

		expect(first).toEqual({ applied: 2, skipped: 0 });
		expect(redelivery).toEqual({ applied: 0, skipped: 2 });
		expect(await view()).toEqual(["second"]);
		await database.teardown();
	});

	it("rolls back the read-model update and the checkpoint together", async () => {
		const { database, outbox, projector, write, view } = await openProjection();
		await write(1, "first");
		await database.pool.query(
			"ALTER TABLE note_view ADD CONSTRAINT short_text CHECK (length(text) < 3)",
		);
		const records = await outbox.getPending();

		await expect(projector.project(records)).rejects.toMatchObject({
			code: "23514",
		});
		await database.pool.query(
			"ALTER TABLE note_view DROP CONSTRAINT short_text",
		);

		expect(await view()).toEqual([]);
		expect(await projector.project(records)).toEqual({
			applied: 1,
			skipped: 0,
		});
		await database.teardown();
	});

	it("rebuilds the read model from zero after a reset", async () => {
		const { database, outbox, projector, write, view } = await openProjection();
		await write(1, "first");
		const records = await outbox.getPending();
		await projector.project(records);

		await projector.reset();

		expect(await view()).toEqual([]);
		expect(await projector.project(records)).toEqual({
			applied: 1,
			skipped: 0,
		});
		expect(await view()).toEqual(["first"]);
		await database.teardown();
	});

	it("feeds the projector through OutboxDispatcher", async () => {
		const { database, outbox, projector, write, view } = await openProjection();
		await write(1, "first");
		const dispatcher = new OutboxDispatcher<NoteWritten>({
			outbox,
			sink: projector.toOutboxSink(),
			observers: {
				onPollError: () => {},
				onDispatchError: () => {},
				onDeadLetter: () => {},
			},
		});

		await dispatcher.drainOnce();

		expect(await view()).toEqual(["first"]);
		expect(await outbox.getPending()).toEqual([]);
		await database.teardown();
	});
});
