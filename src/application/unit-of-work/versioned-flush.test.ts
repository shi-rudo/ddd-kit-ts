import { describe, expect, it } from "vite-plus/test";
import type { Version } from "../../domain/aggregate/aggregate";
import { StateStoredAggregate } from "../../domain/aggregate/state-stored-aggregate";
import type { Id } from "../../domain/identity/id";
import {
	ConcurrencyConflictError,
	DuplicateAggregateError,
} from "../../errors/kit-errors";
import { InvalidFlushStatementError } from "./errors";
import type {
	AggregatePersistenceWrite,
	AggregateWriteIntent,
} from "./persistence-contract";
import {
	type VersionedFlushStatements,
	versionedFlush,
} from "./versioned-flush";

type OrderId = Id<"OrderId">;

class Order extends StateStoredAggregate<{ readonly name: string }, OrderId> {
	protected readonly aggregateType = "Order";
}

type OrderRow = { readonly name: string; readonly version: number };

interface Transaction {
	readonly name: "transaction";
}

const transaction: Transaction = { name: "transaction" };
const orderId = "order-1" as OrderId;

class UniqueViolation extends Error {}

function writeFor(
	intent: AggregateWriteIntent,
	expectedVersion: Version | undefined,
): AggregatePersistenceWrite<Order, OrderRow | undefined> {
	return Object.freeze({
		intent,
		aggregateId: orderId,
		expectedVersion,
		version: ((expectedVersion ?? -1) + 1) as Version,
		changes: { value: { name: "renamed", version: 1 }, empty: false },
		events: [],
	});
}

/** Records every statement call and answers with the configured results. */
function recordingStatements(
	answers: {
		readonly insert?: () => void;
		readonly update?: () => unknown;
		readonly remove?: () => unknown;
		readonly currentVersion?: () => number | undefined;
	} = {},
): {
	statements: VersionedFlushStatements<
		Transaction,
		Order,
		OrderRow | undefined
	>;
	calls: string[];
} {
	const calls: string[] = [];
	const statements: VersionedFlushStatements<
		Transaction,
		Order,
		OrderRow | undefined
	> = {
		aggregateType: "Order",
		insert: (tx, write) => {
			calls.push(`insert ${tx.name} ${write.intent}`);
			answers.insert?.();
		},
		isDuplicate: (error) => error instanceof UniqueViolation,
		update: (tx, write) => {
			calls.push(`update ${tx.name} ${write.intent}`);
			return (answers.update ? answers.update() : 1) as number;
		},
		remove: (tx, write) => {
			calls.push(`remove ${tx.name} ${write.intent}`);
			return (answers.remove ? answers.remove() : 1) as number;
		},
		currentVersion: (tx, id) => {
			calls.push(`currentVersion ${tx.name} ${id}`);
			return answers.currentVersion?.();
		},
	};
	return { statements, calls };
}

describe("versionedFlush", () => {
	it("runs insert for an add and reports nothing else", async () => {
		const { statements, calls } = recordingStatements();

		await versionedFlush(statements)(transaction, writeFor("add", undefined));

		expect(calls).toEqual(["insert transaction add"]);
	});

	it("turns the store's unique violation on insert into DuplicateAggregateError with the cause", async () => {
		const violation = new UniqueViolation("duplicate key");
		const { statements } = recordingStatements({
			insert: () => {
				throw violation;
			},
		});

		const rejection = await versionedFlush(statements)(
			transaction,
			writeFor("add", undefined),
		).catch((error: unknown) => error);

		expect(rejection).toBeInstanceOf(DuplicateAggregateError);
		expect(rejection).toMatchObject({
			aggregateType: "Order",
			aggregateId: orderId,
			cause: violation,
		});
	});

	it("passes an insert error that is not a duplicate through untouched", async () => {
		const outage = new Error("connection reset");
		const { statements } = recordingStatements({
			insert: () => {
				throw outage;
			},
		});

		await expect(
			versionedFlush(statements)(transaction, writeFor("add", undefined)),
		).rejects.toBe(outage);
	});

	it("runs update for an update and does not read the stored version when a row was affected", async () => {
		const { statements, calls } = recordingStatements({ update: () => 1 });

		await versionedFlush(statements)(
			transaction,
			writeFor("update", 3 as Version),
		);

		expect(calls).toEqual(["update transaction update"]);
	});

	it("turns a stale update into ConcurrencyConflictError with the stored version as actualVersion", async () => {
		const { statements, calls } = recordingStatements({
			update: () => 0,
			currentVersion: () => 5,
		});

		const rejection = await versionedFlush(statements)(
			transaction,
			writeFor("update", 3 as Version),
		).catch((error: unknown) => error);

		expect(rejection).toBeInstanceOf(ConcurrencyConflictError);
		expect(rejection).toMatchObject({
			reason: "stale_version",
			aggregateType: "Order",
			aggregateId: orderId,
			expectedVersion: 3,
			actualVersion: 5,
			retryable: true,
		});
		expect(calls).toEqual([
			"update transaction update",
			`currentVersion transaction ${orderId}`,
		]);
	});

	it("reports an absent aggregate when the stale update finds no row, and never inserts", async () => {
		const { statements, calls } = recordingStatements({
			update: () => 0,
			currentVersion: () => undefined,
		});

		const rejection = await versionedFlush(statements)(
			transaction,
			writeFor("update", 3 as Version),
		).catch((error: unknown) => error);

		expect(rejection).toBeInstanceOf(ConcurrencyConflictError);
		expect(rejection).toMatchObject({
			reason: "aggregate_absent",
			expectedVersion: 3,
			actualVersion: null,
			retryable: true,
		});
		expect(calls).not.toContain("insert transaction update");
	});

	it("runs remove for a remove", async () => {
		const { statements, calls } = recordingStatements({ remove: () => 1 });

		await versionedFlush(statements)(
			transaction,
			writeFor("remove", 3 as Version),
		);

		expect(calls).toEqual(["remove transaction remove"]);
	});

	it("turns a stale remove into ConcurrencyConflictError", async () => {
		const { statements } = recordingStatements({
			remove: () => 0,
			currentVersion: () => 4,
		});

		const rejection = await versionedFlush(statements)(
			transaction,
			writeFor("remove", 3 as Version),
		).catch((error: unknown) => error);

		expect(rejection).toBeInstanceOf(ConcurrencyConflictError);
		expect(rejection).toMatchObject({ expectedVersion: 3, actualVersion: 4 });
	});

	it("passes an update error through untouched", async () => {
		const outage = new Error("connection reset");
		const { statements } = recordingStatements({
			update: () => {
				throw outage;
			},
		});

		await expect(
			versionedFlush(statements)(transaction, writeFor("update", 3 as Version)),
		).rejects.toBe(outage);
	});

	it("accepts a statement that returns the row count as a promise", async () => {
		const { statements } = recordingStatements({
			update: () => Promise.resolve(0),
			currentVersion: () => 9,
		});

		await expect(
			versionedFlush(statements)(transaction, writeFor("update", 3 as Version)),
		).rejects.toMatchObject({ actualVersion: 9 });
	});

	it.each([
		[
			"update",
			"A definition without appendOnly: true needs an update statement.",
		],
		[
			"remove",
			"A definition with physicalRemoval: true needs a remove statement.",
		],
	] as const)(
		"fails a %s write when the statements carry no such statement",
		async (intent, requirement) => {
			const { statements } = recordingStatements();
			const { [intent]: _absent, ...withoutStatement } = statements;

			const rejection = await versionedFlush(withoutStatement)(
				transaction,
				writeFor(intent, 3 as Version),
			).catch((error: unknown) => error);

			expect(rejection).toBeInstanceOf(InvalidFlushStatementError);
			expect(rejection).toMatchObject({
				code: "INVALID_FLUSH_STATEMENT",
				reason: "statement_absent",
				aggregateType: "Order",
				aggregateId: orderId,
				intent,
			});
			expect((rejection as Error).message).toContain(requirement);
		},
	);

	it.each([
		[undefined, "no value"],
		[-1, "-1"],
		[1.5, "1.5"],
		["1", "1 (string)"],
		[1n, "1 (bigint)"],
	])(
		"fails an update whose statement returns %s instead of the row count",
		async (returned, received) => {
			const { statements, calls } = recordingStatements({
				update: () => returned,
			});

			const rejection = await versionedFlush(statements)(
				transaction,
				writeFor("update", 3 as Version),
			).catch((error: unknown) => error);

			expect(rejection).toBeInstanceOf(InvalidFlushStatementError);
			expect(rejection).toMatchObject({
				reason: "no_row_count",
				received: returned === undefined ? undefined : received,
			});
			expect(calls).toEqual(["update transaction update"]);
		},
	);

	it("reports an unchanged version, and no retry, when the statement matched no row", async () => {
		const { statements } = recordingStatements({
			update: () => 0,
			currentVersion: () => 3,
		});

		const rejection = await versionedFlush(statements)(
			transaction,
			writeFor("update", 3 as Version),
		).catch((error: unknown) => error);

		expect(rejection).toBeInstanceOf(ConcurrencyConflictError);
		expect(rejection).toMatchObject({
			reason: "version_unchanged",
			expectedVersion: 3,
			actualVersion: 3,
			retryable: false,
		});
	});

	it("keeps the conflict when the version read fails, and carries the read failure as cause", async () => {
		const readOutage = new Error("connection reset");
		const { statements } = recordingStatements({
			update: () => 0,
			currentVersion: () => {
				throw readOutage;
			},
		});

		const rejection = await versionedFlush(statements)(
			transaction,
			writeFor("update", 3 as Version),
		).catch((error: unknown) => error);

		expect(rejection).toBeInstanceOf(ConcurrencyConflictError);
		expect(rejection).toMatchObject({
			reason: "version_unknown",
			expectedVersion: 3,
			actualVersion: null,
			cause: readOutage,
			retryable: true,
		});
	});

	it("reports a failed version read even when the statement rejects with undefined", async () => {
		const { statements } = recordingStatements({ update: () => 0 });
		const rejectingReader = {
			...statements,
			// A driver can reject with no value at all.
			currentVersion: () => Promise.reject(),
		};

		const rejection = await versionedFlush(rejectingReader)(
			transaction,
			writeFor("update", 3 as Version),
		).catch((error: unknown) => error);

		expect(rejection).toBeInstanceOf(ConcurrencyConflictError);
		expect(rejection).toMatchObject({
			reason: "version_unknown",
			actualVersion: null,
		});
	});

	it("fails an add whose isDuplicate throws, and keeps the insert failure as cause", async () => {
		const outage = new Error("connection reset");
		const classifierFailure = new TypeError("cannot read code of undefined");
		const { statements } = recordingStatements({
			insert: () => {
				throw outage;
			},
		});
		const brokenClassifier = {
			...statements,
			isDuplicate: () => {
				throw classifierFailure;
			},
		};

		const rejection = await versionedFlush(brokenClassifier)(
			transaction,
			writeFor("add", undefined),
		).catch((error: unknown) => error);

		expect(rejection).toBeInstanceOf(InvalidFlushStatementError);
		expect(rejection).toMatchObject({
			reason: "duplicate_check_failed",
			intent: "add",
			cause: outage,
			classifierCause: classifierFailure,
		});
	});

	it("awaits an insert that rejects, and still classifies the duplicate", async () => {
		const violation = new UniqueViolation("duplicate key");
		const { statements } = recordingStatements();
		const asyncInsert = {
			...statements,
			insert: async () => {
				await Promise.resolve();
				throw violation;
			},
		};

		await expect(
			versionedFlush(asyncInsert)(transaction, writeFor("add", undefined)),
		).rejects.toBeInstanceOf(DuplicateAggregateError);
	});

	it("awaits a version read that resolves later", async () => {
		const { statements } = recordingStatements({ update: () => 0 });
		const asyncReader = {
			...statements,
			currentVersion: async () => {
				await Promise.resolve();
				return 7;
			},
		};

		await expect(
			versionedFlush(asyncReader)(
				transaction,
				writeFor("update", 3 as Version),
			),
		).rejects.toMatchObject({ expectedVersion: 3, actualVersion: 7 });
	});

	it("accepts statements with insert only, as an append-only definition supplies them", async () => {
		const calls: string[] = [];
		const flush = versionedFlush<Transaction, Order, OrderRow | undefined>({
			aggregateType: "Order",
			insert: () => {
				calls.push("insert");
			},
			isDuplicate: () => false,
		});

		await flush(transaction, writeFor("add", undefined));

		expect(calls).toEqual(["insert"]);
	});

	it("rejects statements that carry update or remove without currentVersion when the flush is built", () => {
		const { statements } = recordingStatements();
		const { currentVersion: _absent, ...withoutReader } = statements;

		expect(() => versionedFlush(withoutReader as typeof statements)).toThrow(
			new TypeError(
				"versionedFlush: the statements carry update or remove but no " +
					"currentVersion. A failed version check reports the stored " +
					"version through currentVersion.",
			),
		);
	});

	it("fails an update that carries no expectedVersion before it runs a statement", async () => {
		const { statements, calls } = recordingStatements();

		const rejection = await versionedFlush(statements)(
			transaction,
			writeFor("update", undefined),
		).catch((error: unknown) => error);

		expect(rejection).toBeInstanceOf(InvalidFlushStatementError);
		expect(rejection).toMatchObject({ reason: "no_expected_version" });
		expect(calls).toEqual([]);
	});
});
