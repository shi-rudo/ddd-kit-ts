import type { Id } from "../../src/core/id";
import { AggregateRoot } from "../../src/aggregate/aggregate-root";
import { findEntityById } from "../../src/entity/entity";
import { OrderItem, type ItemId } from "./order-item";

export type OrderId = Id<"OrderId">;

/**
 * State of the Order aggregate.
 * Contains child entities (OrderItem) and aggregate-level properties.
 */
export type OrderState = {
	id: OrderId;
	customerId: string;
	items: OrderItem[]; // Child entities with logic
	status: "pending" | "confirmed" | "shipped" | "cancelled";
};

/**
 * Order is an Aggregate Root (an Entity with version).
 *
 * This example demonstrates:
 * - Child Entities (OrderItem) that extend Entity and have business logic
 * - The Aggregate Root enforcing aggregate-wide invariants
 * - How child entity logic is accessed through the Aggregate Root
 */
export class Order extends AggregateRoot<OrderState, OrderId> {
	private itemCounter = 0;

	static create(id: OrderId, customerId: string): Order {
		const initialState: OrderState = {
			id,
			customerId,
			items: [],
			status: "pending",
		};
		return new Order(id, initialState);
	}

	/**
	 * Adds an item to the order.
	 * Creates a new OrderItem entity and adds it to the aggregate.
	 */
	addItem(productId: string, quantity: number, price: number): ItemId {
		if (this.state.status !== "pending") {
			throw new Error("Cannot add items to a non-pending order");
		}

		const itemId = `item-${++this.itemCounter}` as ItemId;
		const item = new OrderItem(itemId, productId, quantity, price);

		this.setState({
			...this.state,
			items: [...this.state.items, item],
		}, true);
		return itemId;
	}

	/**
	 * Updates the quantity of an item.
	 * Delegates to the OrderItem entity's business logic.
	 */
	updateItemQuantity(itemId: ItemId, newQuantity: number): void {
		if (this.state.status !== "pending") {
			throw new Error("Cannot modify items in a non-pending order");
		}

		const item = findEntityById(this.state.items, itemId);
		if (!item) {
			throw new Error("Item not found");
		}

		// Delegate to the entity's logic
		item.updateQuantity(newQuantity);

		// Update state with modified item (immutable update)
		this.setState({
			...this.state,
			items: this.state.items.map((i) => (i.id === itemId ? item : i)),
		}, true);
	}

	/**
	 * Removes an item from the order.
	 */
	removeItem(itemId: ItemId): void {
		if (this.state.status !== "pending") {
			throw new Error("Cannot remove items from a non-pending order");
		}

		this.setState({
			...this.state,
			items: this.state.items.filter((item) => item.id !== itemId),
		}, true);
	}

	/**
	 * Calculates the total order amount.
	 * Uses the OrderItem entities' calculateSubtotal() method.
	 */
	calculateTotal(): number {
		return this.state.items.reduce(
			(total, item) => total + item.calculateSubtotal(),
			0,
		);
	}

	/**
	 * Confirms the order.
	 * Enforces aggregate-wide invariant: must have at least one item.
	 */
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

	/**
	 * Gets a specific item by ID.
	 */
	getItem(itemId: ItemId): OrderItem | undefined {
		return findEntityById(this.state.items, itemId);
	}

	/**
	 * Validates the aggregate state.
	 * This enforces aggregate-wide invariants.
	 */
	protected validateState(state: OrderState): void {
		if (!state.customerId) {
			throw new Error("Customer ID is required");
		}
	}
}
