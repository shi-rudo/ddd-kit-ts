import type { Id } from "../../src/core/id";
import { Entity } from "../../src/entity/entity";
import { isNegativeMoney, type Money } from "../../src/money";

export type ItemId = Id<"ItemId">;

/**
 * State of an OrderItem (a child entity within the Order aggregate).
 */
export type OrderItemState = {
	productId: string;
	quantity: number;
	lineTotal: Money;
};

/**
 * OrderItem is a Child Entity within the Order aggregate.
 *
 * Unlike Value Objects, Entities have:
 * - Identity (id): Two items with same productId but different IDs are different entities
 * - Business Logic: Methods that encapsulate domain behavior
 * - Mutable state (within the aggregate boundary)
 *
 * This Entity extends Entity to get id + state management.
 * It does NOT have its own version - versioning is handled by the Aggregate Root (Order).
 */
export class OrderItem extends Entity<OrderItemState, ItemId> {
	constructor(
		id: ItemId,
		productId: string,
		quantity: number,
		lineTotal: Money,
	) {
		const initialState: OrderItemState = {
			productId,
			quantity,
			lineTotal,
		};
		super(id, initialState);
	}

	/**
	 * Updates the quantity of this item. Changing the quantity reprices
	 * the line, and pricing is the caller's policy (quantity times unit
	 * price, discounts, whatever applies), so the new line total comes
	 * in as Money alongside the new quantity.
	 */
	updateQuantity(newQuantity: number, repricedLineTotal: Money): void {
		if (newQuantity <= 0) {
			throw new Error("Quantity must be greater than 0");
		}
		this.setState({
			...this.state,
			quantity: newQuantity,
			lineTotal: repricedLineTotal,
		});
	}

	/**
	 * Checks if this item is for a specific product.
	 */
	isForProduct(productId: string): boolean {
		return this.state.productId === productId;
	}

	/**
	 * Validates state when constructed or updated.
	 */
	protected validateState(state: OrderItemState): void {
		if (state.quantity <= 0) {
			throw new Error("Quantity must be greater than 0");
		}
		if (isNegativeMoney(state.lineTotal)) {
			throw new Error("Line total cannot be negative");
		}
		if (!state.productId) {
			throw new Error("Product ID is required");
		}
	}
}
