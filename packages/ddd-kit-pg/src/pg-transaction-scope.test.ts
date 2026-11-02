import { someChainRetryable } from "@shirudo/base-error";
import {
	outboxWriterAcceptingEventLoss,
	RetryingTransactionScope,
	UnitOfWork,
} from "@shirudo/ddd-kit";
import type { PoolClient } from "pg";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import {
	type IsolatedSchema,
	openIsolatedSchema,
} from "../test/isolated-schema";
import {
	PgCommitRolledBackError,
	PgRetryableTransactionFailureError,
	PgRollbackFailedError,
} from "./pg-errors";
import type { PgQueryExecutor } from "./pg-query-executor";
import { PgTransactionScope } from "./pg-transaction-scope";

/** A pool with a client that rejects one statement, for failures a test cannot provoke. */
function poolRejecting(statement: string, failure: Error) {
	const client = {
		query: vi.fn(async (text: string) => {
			if (text === statement) throw failure;
			return { command: text, rows: [] };
		}),
		on: vi.fn(),
		off: vi.fn(),
		release: vi.fn(),
	};
	return {
		client,
		pool: { connect: async () => client as unknown as PoolClient },
	};
}

describe("PgTransactionScope", () => {
	let database: IsolatedSchema;
	let scope: PgTransactionScope;

	beforeEach(async () => {
		database = await openIsolatedSchema();
		scope = new PgTransactionScope(database.pool);
		await database.pool.query(
			"CREATE TABLE counter (id int PRIMARY KEY, value int NOT NULL)",
		);
		await database.pool.query("INSERT INTO counter VALUES (1, 0), (2, 0)");
	});

	afterEach(() => database.teardown());

	const counterValue = async (id: number) => {
		const { rows } = await database.pool.query(
			"SELECT value FROM counter WHERE id = $1",
			[id],
		);
		return rows[0].value;
	};
	const increment = (executor: PgQueryExecutor, id: number) =>
		executor.query("UPDATE counter SET value = value + 1 WHERE id = $1", [id]);

	it("commits the work of a resolved callback and returns its result", async () => {
		const result = await scope.transactional(async (executor) => {
			await increment(executor, 1);
			return "done";
		});

		expect(result).toBe("done");
		expect(await counterValue(1)).toBe(1);
	});

	it("rolls back the work of a rejected callback and rejects with the same error", async () => {
		const failure = new Error("the work failed");

		await expect(
			scope.transactional(async (executor) => {
				await increment(executor, 1);
				throw failure;
			}),
		).rejects.toBe(failure);

		expect(await counterValue(1)).toBe(0);
	});

	it("returns the connection to the pool after a commit and after a rollback", async () => {
		const single = await openIsolatedSchema({ max: 1 });
		const singleScope = new PgTransactionScope(single.pool);

		await singleScope.transactional(async () => {});
		await expect(
			singleScope.transactional(async () => {
				throw new Error("the work failed");
			}),
		).rejects.toThrow("the work failed");
		const result = await singleScope.transactional(async () => "still open");

		expect(result).toBe("still open");
		await single.teardown();
	});

	describe("a failure that a new attempt can resolve", () => {
		/** Loses the race of a REPEATABLE READ update once, which gives SQLSTATE 40001. */
		const loseSerializationRace = async (executor: PgQueryExecutor) => {
			await executor.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
			await executor.query("SELECT value FROM counter WHERE id = 1");
			await database.pool.query(
				"UPDATE counter SET value = value + 1 WHERE id = 1",
			);
			await increment(executor, 1);
		};

		it("marks a serialization failure as retryable and keeps the driver error", async () => {
			const failure = await scope
				.transactional(loseSerializationRace)
				.catch((error: unknown) => error);

			expect(failure).toBeInstanceOf(PgRetryableTransactionFailureError);
			expect(failure).toMatchObject({
				code: "PG_RETRYABLE_TRANSACTION_FAILURE",
				sqlState: "40001",
				retryable: true,
				cause: { code: "40001" },
			});
			expect(someChainRetryable(failure)).toBe(true);
		});

		it("marks a deadlock as retryable", async () => {
			let lockedByFirst!: () => void;
			const firstHasLock = new Promise<void>((resolve) => {
				lockedByFirst = resolve;
			});
			let lockedBySecond!: () => void;
			const secondHasLock = new Promise<void>((resolve) => {
				lockedBySecond = resolve;
			});

			const results = await Promise.allSettled([
				scope.transactional(async (executor) => {
					await executor.query("SET LOCAL deadlock_timeout = '10ms'");
					await increment(executor, 1);
					lockedByFirst();
					await secondHasLock;
					await increment(executor, 2);
				}),
				scope.transactional(async (executor) => {
					await executor.query("SET LOCAL deadlock_timeout = '10ms'");
					await increment(executor, 2);
					lockedBySecond();
					await firstHasLock;
					await increment(executor, 1);
				}),
			]);

			const rejected = results.filter((result) => result.status === "rejected");
			expect(rejected).toHaveLength(1);
			expect(rejected[0]).toMatchObject({
				reason: { sqlState: "40P01", retryable: true },
			});
		});

		it("lets RetryingTransactionScope retry until the work commits", async () => {
			const retrying = new RetryingTransactionScope(scope, {
				baseDelayMs: 1,
			});
			let attempts = 0;

			await retrying.transactional(async (executor) => {
				attempts += 1;
				if (attempts === 1) {
					await loseSerializationRace(executor);
					return;
				}
				await increment(executor, 1);
			});

			expect(attempts).toBe(2);
			expect(await counterValue(1)).toBe(2);
		});

		it("marks a serialization failure that the COMMIT reports as retryable", async () => {
			const failure = Object.assign(new Error("could not serialize"), {
				code: "40001",
			});
			const { pool } = poolRejecting("COMMIT", failure);

			await expect(
				new PgTransactionScope(pool).transactional(async () => {}),
			).rejects.toMatchObject({ sqlState: "40001", cause: failure });
		});
	});

	it("rejects when the COMMIT rolled back, because the callback swallowed a failed statement", async () => {
		const failure = await scope
			.transactional(async (executor) => {
				await increment(executor, 1);
				await executor.query("SELECT 1 / 0").catch(() => {});
			})
			.catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(PgCommitRolledBackError);
		expect(failure).toMatchObject({
			code: "PG_COMMIT_ROLLED_BACK",
			retryable: false,
		});
		expect(await counterValue(1)).toBe(0);
	});

	it("rejects a statement on an executor that outlives its transaction", async () => {
		const leaked = await scope.transactional(async (executor) => executor);

		await expect(leaked.query("SELECT 1")).rejects.toMatchObject({
			code: "TRANSACTION_CLOSED",
		});
	});

	it.each([
		["the rollback", "rolled back", true],
		["the commit", "committed", false],
	])(
		"rejects a statement that arrives during %s, so it cannot run outside the transaction",
		async (_phase, _result, workFails) => {
			let late: Promise<unknown> = Promise.resolve();

			await scope
				.transactional(async (executor) => {
					late = new Promise((resolve) => setImmediate(resolve))
						.then(() => increment(executor, 2))
						.catch((error: unknown) => error);
					if (workFails) throw new Error("the work failed");
				})
				.catch(() => {});

			expect(await late).toMatchObject({ code: "TRANSACTION_CLOSED" });
			expect(await counterValue(2)).toBe(0);
		},
	);

	it("survives a lost connection and rejects without ending the process", async () => {
		const single = await openIsolatedSchema({ max: 1 });
		const singleScope = new PgTransactionScope(single.pool);

		await expect(
			singleScope.transactional(async (executor) => {
				await executor.query("SELECT pg_terminate_backend(pg_backend_pid())");
			}),
		).rejects.toBeDefined();
		const result = await singleScope.transactional(async () => "reconnected");

		expect(result).toBe("reconnected");
		await single.teardown();
	});

	describe("a failed ROLLBACK", () => {
		const rollbackFailure = new Error("the ROLLBACK failed");
		const workFailure = new Error("the work failed");

		it("rejects with both failures and destroys the connection", async () => {
			const { client, pool } = poolRejecting("ROLLBACK", rollbackFailure);

			const failure = await new PgTransactionScope(pool)
				.transactional(async () => {
					throw workFailure;
				})
				.catch((error: unknown) => error);

			expect(failure).toBeInstanceOf(PgRollbackFailedError);
			expect(failure).toMatchObject({
				code: "PG_ROLLBACK_FAILED",
				cause: rollbackFailure,
				workFailure,
			});
			expect(client.release).toHaveBeenCalledWith(true);
		});

		it("still reaches UnitOfWork as a RollbackError that names the work failure", async () => {
			const { pool } = poolRejecting("ROLLBACK", rollbackFailure);
			const unitOfWork = new UnitOfWork({
				scope: new PgTransactionScope(pool),
				outbox: outboxWriterAcceptingEventLoss(),
				repositories: {},
			});

			await expect(
				unitOfWork.run(async () => {
					throw workFailure;
				}),
			).rejects.toMatchObject({
				code: "ROLLBACK_FAILED",
				cause: workFailure,
				rollbackCause: { code: "PG_ROLLBACK_FAILED" },
			});
		});
	});
});
