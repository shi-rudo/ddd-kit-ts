import type { Version } from "../../src/domain/aggregate/aggregate";
import { StateStoredAggregate } from "../../src/domain/aggregate/state-stored-aggregate";
import type { Id } from "../../src/domain/identity/id";
import { addMoney, type Money } from "../../src/domain/value-object/money";
import { DomainError } from "../../src/errors/kit-errors";

export type OrderId = Id<"OrderId">;
export type CustomerId = Id<"CustomerId">;
export type ProductId = Id<"ProductId">;

export type OrderStatus = "pending" | "confirmed" | "shipped" | "cancelled";

export type OrderState = {
	id: OrderId;
	customerId: CustomerId;
	items: Array<{
		productId: ProductId;
		quantity: number;
		lineTotal: Money;
	}>;
	total: Money;
	status: OrderStatus;
};

export class OrderInWrongStateError extends DomainError<"ORDER_IN_WRONG_STATE"> {
	constructor(orderId: OrderId, current: OrderStatus, attempted: string) {
		super({
			code: "ORDER_IN_WRONG_STATE",
			message: `Order ${orderId} is ${current}; cannot ${attempted}`,
		});
	}
}

export class EmptyOrderError extends DomainError<"EMPTY_ORDER"> {
	constructor(orderId: OrderId) {
		super({
			code: "EMPTY_ORDER",
			message: `Order ${orderId} has no items; cannot confirm`,
		});
	}
}

/**
 * Example of an Aggregate WITHOUT Event Sourcing.
 * This aggregate uses direct state mutation via setState().
 */
export class Order extends StateStoredAggregate<OrderState, OrderId> {
	protected readonly aggregateType = "Order";

	// The zero comes in from the caller, like every other Money: the
	// kit ships no currency table, so the aggregate never invents one.
	static create(id: OrderId, customerId: CustomerId, zero: Money): Order {
		const initialState: OrderState = {
			id,
			customerId,
			items: [],
			total: zero,
			status: "pending",
		};
		return new Order(id, initialState);
	}

	/** Reconstitutes persisted facts without recording a new decision. */
	static reconstitute(id: OrderId, state: OrderState, version: Version): Order {
		const order = new Order(id, state);
		order.markReconstituted(version);
		return order;
	}

	get customerId(): CustomerId {
		return this.state.customerId;
	}

	get status(): OrderStatus {
		return this.state.status;
	}

	get itemCount(): number {
		return this.state.items.length;
	}

	get items(): OrderState["items"] {
		return this.state.items.map((item) => ({ ...item }));
	}

	get total(): Money {
		return this.state.total;
	}

	// The line total arrives as Money, already computed: quantity times
	// unit price is a pricing policy that lives with the caller (and in
	// a calculation library once it needs rounding). addMoney also
	// rejects mixed currencies, so the invariant rides along for free.
	addItem(productId: ProductId, quantity: number, lineTotal: Money): void {
		this.assertStatus("pending", "add an item");

		const newItem = { productId, quantity, lineTotal };
		const newTotal = addMoney(this.state.total, lineTotal);

		this.setState({
			...this.state,
			items: [...this.state.items, newItem],
			total: newTotal,
		});
	}

	confirm(): void {
		this.assertStatus("pending", "confirm");
		if (this.state.items.length === 0) {
			throw new EmptyOrderError(this.id);
		}

		this.setState({ ...this.state, status: "confirmed" });
	}

	ship(): void {
		this.assertStatus("confirmed", "ship");

		this.setState({ ...this.state, status: "shipped" });
	}

	cancel(): void {
		if (this.state.status === "shipped") {
			throw new OrderInWrongStateError(this.id, this.state.status, "cancel");
		}

		this.setState({ ...this.state, status: "cancelled" });
	}

	private assertStatus(expected: OrderStatus, attempted: string): void {
		if (this.state.status !== expected) {
			throw new OrderInWrongStateError(this.id, this.state.status, attempted);
		}
	}
}
