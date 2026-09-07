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
			aggregateType: "Order",
			aggregateId: orderId,
			expectedVersion: 3,
			actualVersion: 5,
		});
		expect(calls).toEqual([
			"update transaction update",
			`currentVersion transaction ${orderId}`,
		]);
	});

	it("reports actualVersion -1 when the stale update finds no row, and never inserts", async () => {
		const { statements, calls } = recordingStatements({
			update: () => 0,
			currentVersion: () => undefined,
		});

		const rejection = await versionedFlush(statements)(
			transaction,
			writeFor("update", 3 as Version),
		).catch((error: unknown) => error);

		expect(rejection).toBeInstanceOf(ConcurrencyConflictError);
		expect(rejection).toMatchObject({ expectedVersion: 3, actualVersion: -1 });
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
		"fails a %s write when the statements carry no %s",
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
				message:
					`The Unit of Work registered the ${intent} of Order(${orderId}), ` +
					`but the statements carry no ${intent}. ${requirement}`,
			});
		},
	);

	it.each([undefined, -1, 1.5, "1"])(
		"fails an update whose statement returns %s instead of the row count",
		async (returned) => {
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
				message:
					`The update statement of the update of Order(${orderId}) ` +
					`returned ${String(returned)}. It must return the count of rows ` +
					"it affected, so the flush can tell a conflict from a write.",
			});
			expect(calls).toEqual(["update transaction update"]);
		},
	);

	it("fails a write whose statement affected no row although the stored version matches", async () => {
		const { statements } = recordingStatements({
			update: () => 0,
			currentVersion: () => 3,
		});

		const rejection = await versionedFlush(statements)(
			transaction,
			writeFor("update", 3 as Version),
		).catch((error: unknown) => error);

		expect(rejection).toBeInstanceOf(InvalidFlushStatementError);
		expect(rejection).toMatchObject({
			reason: "predicate_beyond_version",
			message:
				`The update statement of the update of Order(${orderId}) affected ` +
				"no row, although the stored version is 3. Its predicate holds a " +
				"condition beyond the version, or it counts changed rows instead " +
				"of matched rows.",
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
			expectedVersion: 3,
			actualVersion: -1,
			cause: readOutage,
		});
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
