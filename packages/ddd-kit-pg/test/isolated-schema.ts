import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool, type PoolConfig } from "pg";
import { inject } from "vite-plus/test";

export interface IsolatedSchema {
	/** A pool whose connections resolve unqualified names in this schema. */
	readonly pool: Pool;
	/** Runs a shipped DDL file of `sql/` in this schema. */
	applySql(fileName: string): Promise<void>;
	teardown(): Promise<void>;
}

/**
 * Opens a schema of its own for one test, because test files run in parallel
 * against one PostgreSQL container.
 */
export async function openIsolatedSchema({
	defaultTransactionIsolation,
	...poolOptions
}: Pick<PoolConfig, "max"> & {
	/** The isolation level of a transaction that names none, as `repeatable read`. */
	readonly defaultTransactionIsolation?: string;
} = {}): Promise<IsolatedSchema> {
	const connectionString = inject("postgresUri");
	const schema = `test_${randomUUID().replaceAll("-", "")}`;
	const admin = new Pool({ connectionString, max: 1 });
	await admin.query(`CREATE SCHEMA ${schema}`);
	// The server splits options at spaces unless a backslash escapes them.
	const isolationOption =
		defaultTransactionIsolation === undefined
			? ""
			: ` -c default_transaction_isolation=${defaultTransactionIsolation.replaceAll(" ", "\\ ")}`;
	const pool = new Pool({
		...poolOptions,
		connectionString,
		options: `-c search_path=${schema}${isolationOption}`,
	});
	return {
		pool,
		applySql: async (fileName) => {
			const file = new URL(`../sql/${fileName}`, import.meta.url);
			await pool.query(await readFile(file, "utf8"));
		},
		teardown: async () => {
			await pool.end();
			await admin.query(`DROP SCHEMA ${schema} CASCADE`);
			await admin.end();
		},
	};
}

export interface TablesBehindPrivateSchemas {
	/** Two pools that resolve the tables in one shared schema. */
	readonly pools: readonly [Pool, Pool];
	teardown(): Promise<void>;
}

/**
 * Opens a shared schema with the tables of a shipped DDL file. Each pool has a
 * private schema of its own first in its `search_path`, as two roles with
 * `"$user", public` have. `current_schema()` then differs between the pools,
 * although both resolve the same tables.
 */
export async function openTablesBehindPrivateSchemas(
	fileName: string,
): Promise<TablesBehindPrivateSchemas> {
	const connectionString = inject("postgresUri");
	const suffix = randomUUID().replaceAll("-", "");
	const [shared, first, second] = ["shared", "first", "second"].map(
		(name) => `test_${name}_${suffix}`,
	);
	const admin = new Pool({ connectionString, max: 1 });
	await admin.query(
		`CREATE SCHEMA ${shared}; CREATE SCHEMA ${first}; CREATE SCHEMA ${second}`,
	);
	const file = new URL(`../sql/${fileName}`, import.meta.url);
	await admin.query(
		`SET search_path = ${shared}; ${await readFile(file, "utf8")}`,
	);
	const poolFor = (privateSchema: string | undefined) =>
		new Pool({
			connectionString,
			options: `-c search_path=${privateSchema},${shared}`,
		});
	const pools = [poolFor(first), poolFor(second)] as const;
	return {
		pools,
		teardown: async () => {
			await Promise.all(pools.map((pool) => pool.end()));
			await admin.query(
				`DROP SCHEMA ${shared} CASCADE; DROP SCHEMA ${first}; DROP SCHEMA ${second}`,
			);
			await admin.end();
		},
	};
}
