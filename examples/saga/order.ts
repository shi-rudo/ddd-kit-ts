import { AggregateRoot } from "../../src/aggregate/aggregate-root";
import {
	createDomainEvent,
	type DomainEvent,
} from "../../src/aggregate/domain-event";
import { DomainError } from "../../src/core/errors";
import type { Id } from "../../src/core/id";

export type OrderId = Id<"OrderId">;

export type OrderState = {
	id: OrderId;
	customerId: string;
	totalCents: number;
	status: "placed" | "confirmed" | "cancelled";
	cancelReason?: string;
};

export type OrderPlaced = DomainEvent<
	"OrderPlaced",
	{ customerId: string; totalCents: number }
>;
export type OrderConfirmed = DomainEvent<"OrderConfirmed", { confirmedAt: string }>;
export type OrderCancelled = DomainEvent<"OrderCancelled", { reason: string }>;

export type OrderEvent = OrderPlaced | OrderConfirmed | OrderCancelled;

export class OrderInWrongStateError extends DomainError<"OrderInWrongStateError"> {
	constructor(orderId: OrderId, current: string, attempted: string) {
		super(`Order ${orderId} is ${current}; cannot ${attempted}`);
	}
}

export class Order extends AggregateRoot<OrderState, OrderId, OrderEvent> {
	static place(
		id: OrderId,
		customerId: string,
		totalCents: number,
	): Order {
		const order = new Order(id, {
			id,
			customerId,
			totalCents,
			status: "placed",
		});
		// Bump version to 1 and record the placement event.
		order.commit(
			{ id, customerId, totalCents, status: "placed" },
			createDomainEvent(
				"OrderPlaced",
				{ customerId, totalCents },
				{ aggregateId: id, aggregateType: "Order" },
			),
		);
		return order;
	}

	confirm(): void {
		if (this.state.status !== "placed") {
			throw new OrderInWrongStateError(this.id, this.state.status, "confirm");
		}
		this.commit(
			{ ...this.state, status: "confirmed" },
			createDomainEvent(
				"OrderConfirmed",
				{ confirmedAt: new Date().toISOString() },
				{ aggregateId: this.id, aggregateType: "Order" },
			),
		);
	}

	cancel(reason: string): void {
		if (this.state.status === "cancelled") return; // idempotent
		if (this.state.status === "confirmed") {
			throw new OrderInWrongStateError(this.id, this.state.status, "cancel");
		}
		this.commit(
			{ ...this.state, status: "cancelled", cancelReason: reason },
			createDomainEvent(
				"OrderCancelled",
				{ reason },
				{ aggregateId: this.id, aggregateType: "Order" },
			),
		);
	}
}
