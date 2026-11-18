import { someChainRetryable } from "@shirudo/base-error";
import {
	outboxWriterAcceptingEventLoss,
	RetryingTransactionScope,
	type TransactionScope,
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
import { countRoundTrips } from "../test/round-trips";
import {
	PgCommitRolledBackError,
	PgRetryableTransactionFailureError,
	PgRollbackFailedError,
} from "./pg-errors";
import type { PgQueryExecutor } from "./pg-query-executor";
import { type PgClientPool, PgTransactionScope } from "./pg-transaction-scope";

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

/** Counts the round trips of the one connection that `pool` gives. */
function countingRoundTrips(pool: PgClientPool) {
	let roundTrips = () => 0;
	return {
		pool: {
			connect: async () => {
				const client = await pool.connect();
				roundTrips = countRoundTrips(client);
				return client;
			},
		},
		roundTrips: () => roundTrips(),
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

	it("runs the statements that the callback starts together in call order", async () => {
		const [, read] = await scope.transactional((executor) =>
			Promise.all([
				increment(executor, 1),
				executor.query<{ value: number }>(
					"SELECT value FROM counter WHERE id = 1",
				),
			]),
		);

		expect(read.rows).toEqual([{ value: 1 }]);
		expect(await counterValue(1)).toBe(1);
	});

	it("rolls back after the statements that the callback started together, when one of them fails", async () => {
		await expect(
			scope.transactional((executor) =>
				Promise.all([
					executor.query("SELECT value FROM missing_table"),
					increment(executor, 1),
				]),
			),
		).rejects.toMatchObject({ code: "42P01" });

		expect(await counterValue(1)).toBe(0);
	});

	it("returns the connection to the pool after a commit and after a rollback", async () => {
		const single = await openIsolatedSchema({ max: 1 });
		const singleScope = new PgTransactionScope(single.pool);

		await singleScope.transactional((executor) => executor.query("SELECT 1"));
		await expect(
			singleScope.transactional(async (executor) => {
				await executor.query("SELECT 1");
				throw new Error("the work failed");
			}),
		).rejects.toThrow("the work failed");
		const { rows } = await singleScope.transactional((executor) =>
			executor.query("SELECT 'still open' AS state"),
		);

		expect(rows).toEqual([{ state: "still open" }]);
		await single.teardown();
	});

	describe("the BEGIN of the transaction", () => {
		it("goes to PostgreSQL in one round trip with a first statement that has values", async () => {
			const counted = countingRoundTrips(database.pool);

			await new PgTransactionScope(counted.pool).transactional((executor) =>
				increment(executor, 1),
			);

			expect(counted.roundTrips()).toBe(2);
			expect(await counterValue(1)).toBe(1);
		});

		it("goes to PostgreSQL once when the callback starts statements together", async () => {
			const counted = countingRoundTrips(database.pool);

			await new PgTransactionScope(counted.pool).transactional((executor) =>
				Promise.all([increment(executor, 1), increment(executor, 2)]),
			);

			expect(counted.roundTrips()).toBe(3);
			expect(await counterValue(1)).toBe(1);
			expect(await counterValue(2)).toBe(1);
		});

		it("opens the transaction for a first statement that the callback does not await", async () => {
			await scope.transactional(async (executor) => {
				void increment(executor, 1);
			});

			expect(await counterValue(1)).toBe(1);
		});

		it("opens the transaction for a first statement with values that fails", async () => {
			const single = await openIsolatedSchema({ max: 1 });
			const singleScope = new PgTransactionScope(single.pool);

			await expect(
				singleScope.transactional((executor) =>
					executor.query("SELECT 1 / $1::int", [0]),
				),
			).rejects.toMatchObject({ code: "22012" });
			const { rows } = await singleScope.transactional((executor) =>
				executor.query("SELECT 'rolled back' AS state"),
			);

			expect(rows).toEqual([{ state: "rolled back" }]);
			await single.teardown();
		});

		it("goes to PostgreSQL alone before a first statement without values", async () => {
			const counted = countingRoundTrips(database.pool);

			await new PgTransactionScope(counted.pool).transactional((executor) =>
				executor.query("UPDATE counter SET value = value + 1 WHERE id = 1"),
			);

			expect(counted.roundTrips()).toBe(3);
			expect(await counterValue(1)).toBe(1);
		});

		it("goes to PostgreSQL alone on a client that is not the JavaScript client of pg", async () => {
			const { client, pool } = poolRejecting(
				"a statement that this test does not send",
				new Error(),
			);

			await new PgTransactionScope(pool).transactional((executor) =>
				increment(executor, 1),
			);

			expect(client.query.mock.calls.map(([text]) => text)).toEqual([
				"BEGIN",
				"UPDATE counter SET value = value + 1 WHERE id = $1",
				"COMMIT",
			]);
		});

		it("does not go to PostgreSQL when the callback resolves without a statement", async () => {
			const counted = countingRoundTrips(database.pool);

			const result = await new PgTransactionScope(counted.pool).transactional(
				async () => "done",
			);

			expect(result).toBe("done");
			expect(counted.roundTrips()).toBe(0);
		});

		it("does not go to PostgreSQL when the callback rejects without a statement", async () => {
			const counted = countingRoundTrips(database.pool);
			const failure = new Error("the work failed");

			await expect(
				new PgTransactionScope(counted.pool).transactional(async () => {
					throw failure;
				}),
			).rejects.toBe(failure);

			expect(counted.roundTrips()).toBe(0);
		});
	});

	describe("a BEGIN that PostgreSQL did not confirm", () => {
		const beginFailure = new Error("the BEGIN failed");
		const statementsOf = (client: {
			query: { mock: { calls: unknown[][] } };
		}) => client.query.mock.calls.map(([text]) => text);

		it("rejects with the failure of the BEGIN and destroys the connection", async () => {
			const { client, pool } = poolRejecting("BEGIN", beginFailure);

			await expect(
				new PgTransactionScope(pool).transactional((executor) =>
					increment(executor, 1),
				),
			).rejects.toBe(beginFailure);

			expect(statementsOf(client)).toEqual(["BEGIN"]);
			expect(client.release).toHaveBeenCalledWith(true);
		});

		it("rejects with the failure of the BEGIN when the callback caught it", async () => {
			const { client, pool } = poolRejecting("BEGIN", beginFailure);

			await expect(
				new PgTransactionScope(pool).transactional(async (executor) => {
					await increment(executor, 1).catch(() => {});
					return "done";
				}),
			).rejects.toBe(beginFailure);

			expect(statementsOf(client)).toEqual(["BEGIN"]);
			expect(client.release).toHaveBeenCalledWith(true);
		});

		it("rejects with the failure of the BEGIN when the callback rejects with another error", async () => {
			const { client, pool } = poolRejecting("BEGIN", beginFailure);

			await expect(
				new PgTransactionScope(pool).transactional(async (executor) => {
					await increment(executor, 1).catch(() => {});
					throw new Error("the work failed");
				}),
			).rejects.toBe(beginFailure);

			expect(statementsOf(client)).toEqual(["BEGIN"]);
			expect(client.release).toHaveBeenCalledWith(true);
		});

		it("rejects each statement of the callback and sends none of them", async () => {
			const { client, pool } = poolRejecting("BEGIN", beginFailure);
			let statements: PromiseSettledResult<unknown>[] = [];

			await new PgTransactionScope(pool)
				.transactional(async (executor) => {
					statements = await Promise.allSettled([
						increment(executor, 1),
						increment(executor, 2),
					]);
					statements.push(
						...(await Promise.allSettled([increment(executor, 1)])),
					);
				})
				.catch(() => {});

			expect(statements).toEqual([
				{ status: "rejected", reason: beginFailure },
				{ status: "rejected", reason: beginFailure },
				{ status: "rejected", reason: beginFailure },
			]);
			expect(statementsOf(client)).toEqual(["BEGIN"]);
		});

		it("destroys the connection when the first statement fails before the answer to the BEGIN", async () => {
			const single = await openIsolatedSchema({ max: 1, query_timeout: 50 });

			const failure = await new PgTransactionScope(single.pool)
				.transactional((executor) =>
					executor.query("SELECT pg_sleep($1)", [0.3]),
				)
				.catch((error: unknown) => error);

			expect(failure).toMatchObject({ message: "Query read timeout" });
			expect(single.pool.totalCount).toBe(0);
			await single.teardown();
		});
	});

	describe("the isolation level", () => {
		const isolationOf = (executor: PgQueryExecutor) =>
			executor
				.query<{ level: string }>(
					"SELECT current_setting('transaction_isolation') AS level",
				)
				.then(({ rows }) => rows[0]?.level);

		it("begins the transaction at the level of its options", async () => {
			const serializable = await openIsolatedSchema({
				defaultTransactionIsolation: "serializable",
			});

			const level = await new PgTransactionScope(serializable.pool, {
				isolationLevel: "read committed",
			}).transactional(isolationOf);

			expect(level).toBe("read committed");
			await serializable.teardown();
		});

		it("keeps the default level of the database without an option", async () => {
			const serializable = await openIsolatedSchema({
				defaultTransactionIsolation: "serializable",
			});

			const level = await new PgTransactionScope(
				serializable.pool,
			).transactional(isolationOf);

			expect(level).toBe("serializable");
			await serializable.teardown();
		});

		it("rejects an unknown level when it is constructed", () => {
			expect(
				() =>
					new PgTransactionScope(database.pool, {
						isolationLevel: "snapshot" as "serializable",
					}),
			).toThrow(RangeError);
		});
	});

	describe("a COMMIT that PostgreSQL answered with a failure", () => {
		const backendPid = (executor: PgQueryExecutor) =>
			executor
				.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
				.then(({ rows }) => rows[0]?.pid);

		it("returns the connection to the pool after a constraint fails at the COMMIT", async () => {
			const single = await openIsolatedSchema({ max: 1 });
			await single.pool.query(
				"CREATE TABLE ticket (id int UNIQUE DEFERRABLE INITIALLY DEFERRED)",
			);
			const singleScope = new PgTransactionScope(single.pool);
			let pidOfFailedCommit: number | undefined;

			const failure = await singleScope
				.transactional(async (executor) => {
					pidOfFailedCommit = await backendPid(executor);
					await executor.query("INSERT INTO ticket VALUES (1), (1)");
				})
				.catch((error: unknown) => error);
			const pidAfter = await singleScope.transactional(backendPid);

			expect(failure).toMatchObject({ code: "23505" });
			expect(pidAfter).toBe(pidOfFailedCommit);
			await single.teardown();
		});

		it("returns the connection to the pool after a COMMIT that rolled back", async () => {
			const single = await openIsolatedSchema({ max: 1 });
			const singleScope = new PgTransactionScope(single.pool);
			let pidOfFailedCommit: number | undefined;

			const failure = await singleScope
				.transactional(async (executor) => {
					pidOfFailedCommit = await backendPid(executor);
					await executor.query("SELECT 1 / 0").catch(() => {});
				})
				.catch((error: unknown) => error);
			const pidAfter = await singleScope.transactional(backendPid);

			expect(failure).toBeInstanceOf(PgCommitRolledBackError);
			expect(pidAfter).toBe(pidOfFailedCommit);
			await single.teardown();
		});
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
				new PgTransactionScope(pool).transactional((executor) =>
					executor.query("SELECT 1"),
				),
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
					await increment(executor, 1);
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

	it.each([
		["a later statement", "SELECT pg_terminate_backend(pg_backend_pid())", []],
		[
			"the statement that carries the BEGIN",
			"SELECT pg_terminate_backend(pg_backend_pid()), $1::int",
			[1],
		],
	])(
		"survives a connection that %s loses, and rejects without ending the process",
		async (_statement, terminate, values) => {
			const single = await openIsolatedSchema({ max: 1 });
			const singleScope = new PgTransactionScope(single.pool);

			await expect(
				singleScope.transactional((executor) =>
					executor.query(terminate, values),
				),
			).rejects.toBeDefined();
			const { rows } = await singleScope.transactional((executor) =>
				executor.query("SELECT 'reconnected' AS state"),
			);

			expect(rows).toEqual([{ state: "reconnected" }]);
			await single.teardown();
		},
	);

	describe("a failed ROLLBACK", () => {
		const rollbackFailure = new Error("the ROLLBACK failed");
		const workFailure = new Error("the work failed");

		it("rejects with both failures and destroys the connection", async () => {
			const { client, pool } = poolRejecting("ROLLBACK", rollbackFailure);

			const failure = await new PgTransactionScope(pool)
				.transactional(async (executor) => {
					await executor.query("SELECT 1");
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
			const scope = new PgTransactionScope(pool);
			const scopeWithOpenTransaction: TransactionScope<PgQueryExecutor> = {
				transactional: (work) =>
					scope.transactional(async (executor) => {
						await executor.query("SELECT 1");
						return work(executor);
					}),
			};
			const unitOfWork = new UnitOfWork({
				scope: scopeWithOpenTransaction,
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
