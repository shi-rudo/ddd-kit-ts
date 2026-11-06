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
