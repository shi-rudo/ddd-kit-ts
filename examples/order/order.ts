import type { Id } from "../../src/core/id";
import { AggregateBase } from "../../src/aggregate/aggregate-base";

export type OrderId = Id<"OrderId">;

export type OrderState = {
	id: OrderId;
	customerId: string;
	items: Array<{
		productId: string;
		quantity: number;
		price: number;
	}>;
	total: number;
	status: "pending" | "confirmed" | "shipped" | "cancelled";
};

/**
 * Example of an Aggregate WITHOUT Event Sourcing.
 * This aggregate uses direct state mutation instead of events.
 */
export class Order extends AggregateBase<OrderState, OrderId> {
	static create(id: OrderId, customerId: string): Order {
		const initialState: OrderState = {
			id,
			customerId,
			items: [],
			total: 0,
			status: "pending",
		};
		return new Order(id, initialState);
	}

	addItem(productId: string, quantity: number, price: number): void {
		if (this._state.status !== "pending") {
			throw new Error("Cannot add items to a non-pending order");
		}

		const newItem = { productId, quantity, price };
		const newTotal = this._state.total + quantity * price;

		this._state = {
			...this._state,
			items: [...this._state.items, newItem],
			total: newTotal,
		};
		this.bumpVersion();
	}

	confirm(): void {
		if (this._state.status !== "pending") {
			throw new Error("Only pending orders can be confirmed");
		}
		if (this._state.items.length === 0) {
			throw new Error("Cannot confirm an order without items");
		}

		this._state = { ...this._state, status: "confirmed" };
		this.bumpVersion();
	}

	ship(): void {
		if (this._state.status !== "confirmed") {
			throw new Error("Only confirmed orders can be shipped");
		}

		this._state = { ...this._state, status: "shipped" };
		this.bumpVersion();
	}

	cancel(): void {
		if (this._state.status === "shipped") {
			throw new Error("Cannot cancel a shipped order");
		}

		this._state = { ...this._state, status: "cancelled" };
		this.bumpVersion();
	}
}

