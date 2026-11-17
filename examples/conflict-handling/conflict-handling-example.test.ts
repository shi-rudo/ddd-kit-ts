import { describe, expect, it } from "vite-plus/test";
import type { RepositoryTracking } from "../../src/application/unit-of-work/persistence-contract";
import {
	defineRepository,
	UnitOfWork,
} from "../../src/application/unit-of-work/unit-of-work";
import { versionedFlush } from "../../src/application/unit-of-work/versioned-flush";
import { toVersion } from "../../src/domain/aggregate/aggregate";
import { InfrastructureError } from "../../src/errors/kit-errors";
import { RetryingTransactionScope } from "../../src/persistence/repository/retrying-scope";
import type { TransactionScope } from "../../src/persistence/repository/scope";
import { recordingOutbox } from "../../src/testing/recording-outbox";
import {
	CatalogItem,
	type CatalogItemId,
	type CatalogUnitOfWork,
	createRenameCatalogItemHandler,
	createReserveStockHandler,
	type ForStoringCatalogItems,
} from "./conflict-handling-example";

const itemId = "item-1" as CatalogItemId;

type CatalogItemRow = {
	readonly name: string;
	readonly onHand: number;
	readonly reserved: number;
	readonly version: number;
};

class CatalogItemStoreUnavailableError extends InfrastructureError<"CATALOG_ITEM_STORE_UNAVAILABLE"> {
	constructor(cause: unknown) {
		super({
			code: "CATALOG_ITEM_STORE_UNAVAILABLE",
			message: "The catalog item store failed",
			cause,
		});
	}
}

/**
 * A catalog in memory. `afterNextLoad` runs one time after the next load, in
 * the gap between the load and the flush of the command that loaded.
 */
function createCatalog() {
	const rows = new Map<CatalogItemId, CatalogItemRow>();
	let afterNextLoad: (() => Promise<unknown>) | undefined;
	let attempts = 0;

	const rowOf = (item: CatalogItem): CatalogItemRow => ({
		name: item.name,
		onHand: item.onHand,
		reserved: item.reserved,
		version: item.version,
	});

	const items = defineRepository<ForStoringCatalogItems>()({
		aggregate: CatalogItem,
		persistence: {
			capture: rowOf,
			changes: (_baseline: CatalogItemRow, item: CatalogItem) => rowOf(item),
			isEmpty: () => false,
		},
		create: (_tx: undefined, tracking: RepositoryTracking<CatalogItem>) => ({
			findById: async (id: CatalogItemId) => {
				const row = rows.get(id);
				if (!row) return undefined;
				const { version, ...state } = row;
				const item = tracking.trackLoaded(
					CatalogItem.reconstitute(id, state, toVersion(version)),
				);
				const competingWrite = afterNextLoad;
				afterNextLoad = undefined;
				await competingWrite?.();
				return item;
			},
		}),
		flush: versionedFlush({
			insert: (_tx: undefined, write) => {
				rows.set(write.aggregateIdentity.aggregateId, write.changes.value);
			},
			isDuplicate: () => false,
			update: (_tx, write) => {
				const id = write.aggregateIdentity.aggregateId;
				if (rows.get(id)?.version !== write.expectedVersion) return 0;
				rows.set(id, write.changes.value);
				return 1;
			},
			currentVersion: (_tx, id) => rows.get(id)?.version,
		}),
		mapError: (error) =>
			error instanceof InfrastructureError
				? error
				: new CatalogItemStoreUnavailableError(error),
	});

	const countingScope: TransactionScope<undefined> = {
		transactional: (fn) => {
			attempts += 1;
			return fn(undefined);
		},
	};
	const newUnitOfWork = (): CatalogUnitOfWork =>
		new UnitOfWork({
			scope: new RetryingTransactionScope(countingScope, {
				maxAttempts: 3,
				sleep: async () => {},
			}),
			outbox: recordingOutbox(),
			repositories: { items },
		});

	return {
		newUnitOfWork,
		rows,
		attempts: () => attempts,
		afterNextLoad: (competingWrite: () => Promise<unknown>) => {
			afterNextLoad = competingWrite;
		},
		list: (name: string, onHand: number) =>
			newUnitOfWork().run(async ({ repositories }) => {
				const item = CatalogItem.list(itemId, name, onHand);
				repositories.items.add(item);
				return item.version;
			}),
	};
}

describe("conflict-handling example", () => {
	it("renames a catalog item that is at the version that the editor saw", async () => {
		const catalog = createCatalog();
		const seenVersion = await catalog.list("Tuna", 10);
		const rename = createRenameCatalogItemHandler(catalog.newUnitOfWork);

		const result = await rename({
			type: "RenameCatalogItem",
			itemId,
			name: "Bluefin tuna",
			seenVersion,
		});

		expect(result.isOk()).toBe(true);
		expect(catalog.rows.get(itemId)?.name).toBe("Bluefin tuna");
	});

	it("rejects a rename that the editor based on an older version", async () => {
		const catalog = createCatalog();
		const seenVersion = await catalog.list("Tuna", 10);
		const rename = createRenameCatalogItemHandler(catalog.newUnitOfWork);
		await rename({
			type: "RenameCatalogItem",
			itemId,
			name: "Bluefin tuna",
			seenVersion,
		});

		const result = await rename({
			type: "RenameCatalogItem",
			itemId,
			name: "Yellowfin tuna",
			seenVersion,
		});

		expect(result.isErr() && result.error).toBe("ITEM_CHANGED_SINCE_READ");
		expect(catalog.rows.get(itemId)?.name).toBe("Bluefin tuna");
	});

	it("rejects a rename when another editor commits between its load and its flush", async () => {
		const catalog = createCatalog();
		const seenVersion = await catalog.list("Tuna", 10);
		const rename = createRenameCatalogItemHandler(catalog.newUnitOfWork);
		catalog.afterNextLoad(() =>
			rename({
				type: "RenameCatalogItem",
				itemId,
				name: "Bluefin tuna",
				seenVersion,
			}),
		);
		const attemptsBefore = catalog.attempts();

		const result = await rename({
			type: "RenameCatalogItem",
			itemId,
			name: "Yellowfin tuna",
			seenVersion,
		});

		expect(result.isErr() && result.error).toBe("ITEM_CHANGED_SINCE_READ");
		expect(catalog.rows.get(itemId)?.name).toBe("Bluefin tuna");
		// The competing rename, the attempt that lost, and the attempt that
		// loaded another version than the editor saw.
		expect(catalog.attempts() - attemptsBefore).toBe(3);
	});

	it("retries a reservation that lost the race and keeps both reservations", async () => {
		const catalog = createCatalog();
		await catalog.list("Tuna", 10);
		const reserve = createReserveStockHandler(catalog.newUnitOfWork);
		catalog.afterNextLoad(() =>
			reserve({ type: "ReserveStock", itemId, quantity: 4 }),
		);

		const result = await reserve({
			type: "ReserveStock",
			itemId,
			quantity: 3,
		});

		expect(result.isOk() && result.value).toBe(3);
		expect(catalog.rows.get(itemId)?.reserved).toBe(7);
	});

	it("rejects a reservation that the retry finds without enough stock", async () => {
		const catalog = createCatalog();
		await catalog.list("Tuna", 10);
		const reserve = createReserveStockHandler(catalog.newUnitOfWork);
		catalog.afterNextLoad(() =>
			reserve({ type: "ReserveStock", itemId, quantity: 8 }),
		);

		const result = await reserve({
			type: "ReserveStock",
			itemId,
			quantity: 3,
		});

		expect(result.isErr() && result.error).toBe("INSUFFICIENT_STOCK");
		expect(catalog.rows.get(itemId)?.reserved).toBe(8);
	});
});
