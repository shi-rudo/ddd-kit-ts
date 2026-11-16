import { Client, Pool, type PoolClient } from "pg";
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	inject,
	it,
} from "vite-plus/test";
import { ClientRejectingConcurrentStatements } from "../test/client-rejecting-concurrent-statements";
import { fromPg, type PgQueryExecutor } from "./pg-query-executor";

describe("fromPg", () => {
	const pool = new Pool({
		Client: ClientRejectingConcurrentStatements,
		connectionString: inject("postgresUri"),
	});
	let client: PoolClient;
	let executor: PgQueryExecutor;

	beforeEach(async () => {
		client = await pool.connect();
		executor = fromPg(client);
		await client.query("CREATE TEMP TABLE note (text text NOT NULL)");
	});

	// Destroying the connection also drops its temporary table.
	afterEach(() => client.release(true));

	afterAll(() => pool.end());

	it("returns the rows of a statement with values", async () => {
		const result = await executor.query<{ text: string }>(
			"INSERT INTO note (text) VALUES ($1) RETURNING text",
			["first"],
		);

		expect(result.rows).toEqual([{ text: "first" }]);
	});

	it("returns the rows of a statement without values", async () => {
		const result = await executor.query<{ one: number }>("SELECT 1 AS one");

		expect(result.rows).toEqual([{ one: 1 }]);
	});

	it("joins the open transaction of the client", async () => {
		await client.query("BEGIN");
		await executor.query("INSERT INTO note (text) VALUES ($1)", [
			"rolled back",
		]);
		await client.query("ROLLBACK");

		const result = await executor.query("SELECT text FROM note");

		expect(result.rows).toEqual([]);
	});

	it("rejects with the original driver error, so an adapter can read the SQLSTATE", async () => {
		await expect(
			executor.query("SELECT text FROM missing_table"),
		).rejects.toMatchObject({ code: "42P01" });
	});

	it("does not compile with a pool, because a pool cannot hold a transaction", () => {
		// @ts-expect-error A Pool is not a ClientBase.
		const bridgeOverPool = () => fromPg(pool);

		expect(bridgeOverPool).toBeTypeOf("function");
	});
});

describe("fromPg over a client in pipeline mode", () => {
	let client: Client;

	beforeEach(async () => {
		client = new Client({
			connectionString: inject("postgresUri"),
			pipeline: true,
		});
		await client.connect();
		await client.query("CREATE TEMP TABLE note (text text NOT NULL)");
	});

	afterEach(() => client.end());

	it("keeps a ROLLBACK on the client after the statements that started before it", async () => {
		const executor = fromPg(client);
		await client.query("BEGIN");

		await Promise.all([
			executor.query("SELECT text FROM missing_table"),
			executor.query("SELECT pg_sleep(0.05)"),
			executor.query("INSERT INTO note (text) VALUES ($1)", ["rolled back"]),
		]).catch(() => client.query("ROLLBACK"));
		const { rows } = await client.query("SELECT text FROM note");

		expect(rows).toEqual([]);
	});
});
