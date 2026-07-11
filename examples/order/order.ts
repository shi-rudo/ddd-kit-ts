import { AggregateRoot } from "../../src/aggregate/aggregate-root";
import type { Id } from "../../src/core/id";
import { addMoney, type Money } from "../../src/money";

export type OrderId = Id<"OrderId">;

export type OrderState = {
	id: OrderId;
	customerId: string;
	items: Array<{
		productId: string;
		quantity: number;
		lineTotal: Money;
	}>;
	total: Money;
	status: "pending" | "confirmed" | "shipped" | "cancelled";
};

/**
 * Example of an Aggregate WITHOUT Event Sourcing.
 * This aggregate uses direct state mutation via setState().
 */
export class Order extends AggregateRoot<OrderState, OrderId> {
	protected readonly aggregateType = "Order";

	// The zero comes in from the caller, like every other Money: the
	// kit ships no currency table, so the aggregate never invents one.
	static create(id: OrderId, customerId: string, zero: Money): Order {
		const initialState: OrderState = {
			id,
			customerId,
			items: [],
			total: zero,
			status: "pending",
		};
		return new Order(id, initialState);
	}

	get customerId(): string {
		return this.state.customerId;
	}

	get status(): OrderState["status"] {
		return this.state.status;
	}

	get itemCount(): number {
		return this.state.items.length;
	}

	get total(): Money {
		return this.state.total;
	}

	// The line total arrives as Money, already computed: quantity times
	// unit price is a pricing policy that lives with the caller (and in
	// a calculation library once it needs rounding). addMoney also
	// rejects mixed currencies, so the invariant rides along for free.
	addItem(productId: string, quantity: number, lineTotal: Money): void {
		if (this.state.status !== "pending") {
			throw new Error("Cannot add items to a non-pending order");
		}

		const newItem = { productId, quantity, lineTotal };
		const newTotal = addMoney(this.state.total, lineTotal);

		this.setState({
			...this.state,
			items: [...this.state.items, newItem],
			total: newTotal,
		});
	}

	confirm(): void {
		if (this.state.status !== "pending") {
			throw new Error("Only pending orders can be confirmed");
		}
		if (this.state.items.length === 0) {
			throw new Error("Cannot confirm an order without items");
		}

		this.setState({ ...this.state, status: "confirmed" });
	}

	ship(): void {
		if (this.state.status !== "confirmed") {
			throw new Error("Only confirmed orders can be shipped");
		}

		this.setState({ ...this.state, status: "shipped" });
	}

	cancel(): void {
		if (this.state.status === "shipped") {
			throw new Error("Cannot cancel a shipped order");
		}

		this.setState({ ...this.state, status: "cancelled" });
	}
}
