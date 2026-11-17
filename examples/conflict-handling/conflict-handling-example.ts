import { err, ok } from "@shirudo/result";
import type {
	Command,
	CommandHandler,
} from "../../src/application/cqrs/command/command";
import { domainErrorToResult } from "../../src/application/domain-error-result";
import type { Version } from "../../src/domain/aggregate/aggregate";
import { StateStoredAggregate } from "../../src/domain/aggregate/state-stored-aggregate";
import type { Id } from "../../src/domain/identity/id";
import {
	ConcurrencyConflictError,
	DomainError,
	ExpectedVersionMismatchError,
} from "../../src/errors/kit-errors";
import {
	type Repository,
	versionAtLoad,
} from "../../src/persistence/repository/repository";

export type CatalogItemId = Id<"CatalogItemId">;

type CatalogItemState = {
	readonly name: string;
	readonly onHand: number;
	readonly reserved: number;
};

export class InsufficientStockError extends DomainError<"INSUFFICIENT_STOCK"> {
	constructor(itemId: CatalogItemId, requested: number, available: number) {
		super({
			code: "INSUFFICIENT_STOCK",
			message:
				`Cannot reserve ${requested} of catalog item ${itemId}: ` +
				`${available} available`,
		});
	}
}

export class CatalogItem extends StateStoredAggregate<
	CatalogItemState,
	CatalogItemId
> {
	protected readonly aggregateType = "CatalogItem";

	static list(id: CatalogItemId, name: string, onHand: number): CatalogItem {
		return new CatalogItem(id, { name, onHand, reserved: 0 });
	}

	static reconstitute(
		id: CatalogItemId,
		state: CatalogItemState,
		version: Version,
	): CatalogItem {
		const item = new CatalogItem(id, state);
		item.markReconstituted(version);
		return item;
	}

	get name(): string {
		return this.state.name;
	}

	get onHand(): number {
		return this.state.onHand;
	}

	get reserved(): number {
		return this.state.reserved;
	}

	get available(): number {
		return this.onHand - this.reserved;
	}

	rename(name: string): void {
		this.setState({ ...this.state, name });
	}

	reserve(quantity: number): void {
		if (quantity > this.available) {
			throw new InsufficientStockError(this.id, quantity, this.available);
		}
		this.setState({
			...this.state,
			reserved: this.reserved + quantity,
		});
	}
}

export interface ForStoringCatalogItems
	extends Pick<
		Repository<CatalogItem, CatalogItemId>,
		"findById" | "add" | "update"
	> {}

export interface CatalogUnitOfWork {
	run<T>(
		work: (context: {
			readonly repositories: { readonly items: ForStoringCatalogItems };
		}) => Promise<T>,
	): Promise<T>;
}

// #region rename-catalog-item
export type RenameCatalogItemCommand = Command & {
	readonly type: "RenameCatalogItem";
	readonly itemId: CatalogItemId;
	readonly name: string;
	/** The version of the catalog item that the editor saw. */
	readonly seenVersion: Version;
};

export function createRenameCatalogItemHandler(
	newUnitOfWork: () => CatalogUnitOfWork,
): CommandHandler<
	RenameCatalogItemCommand,
	Version,
	"ITEM_NOT_FOUND" | "ITEM_CHANGED_SINCE_READ"
> {
	return async (command) => {
		try {
			return await newUnitOfWork().run(async ({ repositories }) => {
				const item = await repositories.items.findById(command.itemId);
				if (!item) return err("ITEM_NOT_FOUND");

				item.rename(command.name);
				repositories.items.update(item, {
					expectedVersion: command.seenVersion,
				});
				return ok(item.version);
			});
		} catch (error) {
			if (error instanceof ExpectedVersionMismatchError) {
				return err("ITEM_CHANGED_SINCE_READ");
			}
			// A conflict that is not retryable names a defect of the adapter.
			if (error instanceof ConcurrencyConflictError && error.retryable) {
				return err("ITEM_CHANGED_SINCE_READ");
			}
			throw error;
		}
	};
}
// #endregion rename-catalog-item

// #region reserve-stock
export type ReserveStockCommand = Command & {
	readonly type: "ReserveStock";
	readonly itemId: CatalogItemId;
	readonly quantity: number;
};

export function createReserveStockHandler(
	newUnitOfWork: () => CatalogUnitOfWork,
): CommandHandler<
	ReserveStockCommand,
	number,
	"ITEM_NOT_FOUND" | "INSUFFICIENT_STOCK"
> {
	return (command) =>
		newUnitOfWork().run(async ({ repositories }) => {
			const item = await repositories.items.findById(command.itemId);
			if (!item) return err("ITEM_NOT_FOUND");

			const reservation = await domainErrorToResult(
				() => item.reserve(command.quantity),
				[InsufficientStockError],
			);
			if (reservation.isErr()) return err(reservation.error.code);

			repositories.items.update(item, { expectedVersion: versionAtLoad });
			return ok(item.available);
		});
}
// #endregion reserve-stock
