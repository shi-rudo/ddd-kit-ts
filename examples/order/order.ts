import type { Id } from "../../src/core/id";
import { AggregateRoot } from "../../src/aggregate/aggregate-root";

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
 * This aggregate uses direct state mutation via setState().
 */
export class Order extends AggregateRoot<OrderState, OrderId> {
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
		if (this.state.status !== "pending") {
			throw new Error("Cannot add items to a non-pending order");
		}

		const newItem = { productId, quantity, price };
		const newTotal = this.state.total + quantity * price;

		this.setState({
			...this.state,
			items: [...this.state.items, newItem],
			total: newTotal,
		}, true);
	}

	confirm(): void {
		if (this.state.status !== "pending") {
			throw new Error("Only pending orders can be confirmed");
		}
		if (this.state.items.length === 0) {
			throw new Error("Cannot confirm an order without items");
		}

		this.setState({ ...this.state, status: "confirmed" }, true);
	}

	ship(): void {
		if (this.state.status !== "confirmed") {
			throw new Error("Only confirmed orders can be shipped");
		}

		this.setState({ ...this.state, status: "shipped" }, true);
	}

	cancel(): void {
		if (this.state.status === "shipped") {
			throw new Error("Cannot cancel a shipped order");
		}

		this.setState({ ...this.state, status: "cancelled" }, true);
	}
}
