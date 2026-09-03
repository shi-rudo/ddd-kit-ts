import {
	type MoneySnapshot,
	moneyFromSnapshot,
	moneyToSnapshot,
} from "../../src/domain/value-object/money";
import { SnapshotCorruptedError } from "../../src/errors/kit-errors";
import { defineSnapshotModel } from "../../src/persistence/snapshot-store/snapshot-model";
import {
	type CustomerId,
	Order,
	type OrderId,
	type OrderState,
	type ProductId,
} from "./order";

/**
 * Stored DTO of the order snapshot. Money values are stored as
 * `MoneySnapshot` (number amount plus an explicit currency object), never as
 * raw `Money`: the raw value carries a bigint `amountMinor`, and a
 * JSON-backed snapshot store cannot serialize bigints.
 */
export interface OrderSnapshotState {
	readonly id: OrderId;
	readonly customerId: CustomerId;
	readonly items: ReadonlyArray<{
		readonly productId: ProductId;
		readonly quantity: number;
		readonly lineTotal: MoneySnapshot;
	}>;
	readonly total: MoneySnapshot;
	readonly status: OrderState["status"];
}

/** Snapshot persistence belongs to the adapter, next to its stored DTO. */
export const orderSnapshotModel = defineSnapshotModel({
	aggregateType: "Order",
	schemaVersion: 1,
	capture: (order: Order): OrderSnapshotState => ({
		id: order.id,
		customerId: order.customerId,
		items: order.items.map((item) => ({
			productId: item.productId,
			quantity: item.quantity,
			lineTotal: moneyToSnapshot(item.lineTotal),
		})),
		total: moneyToSnapshot(order.total),
		status: order.status,
	}),
	reconstitute: (id: OrderId, state: OrderSnapshotState, version) => {
		if (state.id !== id) {
			throw new SnapshotCorruptedError(
				`Order snapshot ${String(state.id)} was loaded for ${String(id)}`,
			);
		}
		const restored: OrderState = {
			id: state.id,
			customerId: state.customerId,
			items: state.items.map((item) => ({
				productId: item.productId,
				quantity: item.quantity,
				lineTotal: moneyFromSnapshot(item.lineTotal),
			})),
			total: moneyFromSnapshot(state.total),
			status: state.status,
		};
		return Order.reconstitute(id, restored, version);
	},
});
