import { AggregateRoot } from "../../src/aggregate/aggregate-root";
import type { Id } from "../../src/core/id";
import { findEntityById } from "../../src/entity/entity";
import { addMoney, type Money } from "../../src/money";
import { type ItemId, OrderItem } from "./order-item";

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
	protected readonly aggregateType = "Order";

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
	 * Creates a new OrderItem entity and adds it to the aggregate. The
	 * line total arrives as Money, already computed: quantity times unit
	 * price is a pricing policy that lives with the caller.
	 */
	addItem(productId: string, quantity: number, lineTotal: Money): ItemId {
		if (this.state.status !== "pending") {
			throw new Error("Cannot add items to a non-pending order");
		}

		const itemId = `item-${++this.itemCounter}` as ItemId;
		const item = new OrderItem(itemId, productId, quantity, lineTotal);

		this.setState({
			...this.state,
			items: [...this.state.items, item],
		});
		return itemId;
	}

	/**
	 * Updates the quantity of an item.
	 * Delegates to the OrderItem entity's business logic.
	 */
	updateItemQuantity(
		itemId: ItemId,
		newQuantity: number,
		repricedLineTotal: Money,
	): void {
		if (this.state.status !== "pending") {
			throw new Error("Cannot modify items in a non-pending order");
		}

		const item = findEntityById(this.state.items, itemId);
		if (!item) {
			throw new Error("Item not found");
		}

		// Delegate to the entity's logic
		item.updateQuantity(newQuantity, repricedLineTotal);

		// Update state with modified item (immutable update)
		this.setState({
			...this.state,
			items: this.state.items.map((i) => (i.id === itemId ? item : i)),
		});
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
		});
	}

	/**
	 * Calculates the total order amount from the items' line totals.
	 * addMoney keeps the sum exact and rejects mixed currencies. An
	 * empty order has no total: Money carries its currency, and the
	 * aggregate has none to offer without at least one line.
	 */
	calculateTotal(): Money | undefined {
		const [first, ...rest] = this.state.items;
		if (!first) return undefined;
		return rest.reduce(
			(total, item) => addMoney(total, item.state.lineTotal),
			first.state.lineTotal,
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
