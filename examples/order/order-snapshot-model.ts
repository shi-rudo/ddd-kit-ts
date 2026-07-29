import { SnapshotCorruptedError } from "../../src/core/errors";
import { defineSnapshotModel } from "../../src/repo/snapshot-model";
import { Order, type OrderId, type OrderState } from "./order";

/** Snapshot persistence belongs to the adapter, next to its stored DTO. */
export const orderSnapshotModel = defineSnapshotModel({
	aggregateType: "Order",
	schemaVersion: 1,
	capture: (order: Order): OrderState => ({
		id: order.id,
		customerId: order.customerId,
		items: order.items,
		total: order.total,
		status: order.status,
	}),
	reconstitute: (id: OrderId, state: OrderState, version) => {
		if (state.id !== id) {
			throw new SnapshotCorruptedError(
				`Order snapshot ${String(state.id)} was loaded for ${String(id)}`,
			);
		}
		return Order.reconstitute(id, state, version);
	},
});
