import type { Id } from "../../src/core/id";
import { Entity } from "../../src/entity/entity";

export type ItemId = Id<"ItemId">;

/**
 * State of an OrderItem (a child entity within the Order aggregate).
 */
export type OrderItemState = {
	productId: string;
	quantity: number;
	price: number;
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
	constructor(id: ItemId, productId: string, quantity: number, price: number) {
		const initialState: OrderItemState = {
			productId,
			quantity,
			price,
		};
		super(id, initialState);
	}

	/**
	 * Updates the quantity of this item.
	 * This is local business logic within the entity.
	 */
	updateQuantity(newQuantity: number): void {
		if (newQuantity <= 0) {
			throw new Error("Quantity must be greater than 0");
		}
		this._state = { ...this._state, quantity: newQuantity };
	}

	/**
	 * Calculates the subtotal for this item.
	 * This is domain logic that belongs to the entity.
	 */
	calculateSubtotal(): number {
		return this._state.price * this._state.quantity;
	}

	/**
	 * Checks if this item is for a specific product.
	 */
	isForProduct(productId: string): boolean {
		return this._state.productId === productId;
	}

	/**
	 * Validates state when constructed or updated.
	 */
	protected validateState(state: OrderItemState): void {
		if (state.quantity <= 0) {
			throw new Error("Quantity must be greater than 0");
		}
		if (state.price < 0) {
			throw new Error("Price cannot be negative");
		}
		if (!state.productId) {
			throw new Error("Product ID is required");
		}
	}
}
