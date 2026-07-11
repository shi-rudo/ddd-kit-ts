import { AggregateRoot } from "../../src/aggregate/aggregate-root";
import type { DomainEvent } from "../../src/aggregate/domain-event";
import { DomainError } from "../../src/core/errors";
import type { Id } from "../../src/core/id";
import type { Money } from "../../src/money";

export type OrderId = Id<"OrderId">;

export type OrderState = {
	id: OrderId;
	customerId: string;
	total: Money;
	status: "placed" | "confirmed" | "cancelled";
	cancelReason?: string;
};

export type OrderPlaced = DomainEvent<
	"OrderPlaced",
	{ customerId: string; total: Money }
>;
export type OrderConfirmed = DomainEvent<
	"OrderConfirmed",
	{ confirmedAt: string }
>;
export type OrderCancelled = DomainEvent<"OrderCancelled", { reason: string }>;

export type OrderEvent = OrderPlaced | OrderConfirmed | OrderCancelled;

export class OrderInWrongStateError extends DomainError<"ORDER_IN_WRONG_STATE"> {
	constructor(orderId: OrderId, current: string, attempted: string) {
		super({
			code: "ORDER_IN_WRONG_STATE",
			message: `Order ${orderId} is ${current}; cannot ${attempted}`,
		});
	}
}

export class Order extends AggregateRoot<OrderState, OrderId, OrderEvent> {
	protected readonly aggregateType = "Order";

	get status(): OrderState["status"] {
		return this.state.status;
	}

	get cancelReason(): string | undefined {
		return this.state.cancelReason;
	}

	static place(id: OrderId, customerId: string, total: Money): Order {
		const order = new Order(id, {
			id,
			customerId,
			total,
			status: "placed",
		});
		// Bump version to 1 and record the placement event.
		order.commit(
			{ id, customerId, total, status: "placed" },
			order.recordEvent("OrderPlaced", { customerId, total }),
		);
		return order;
	}

	confirm(): void {
		if (this.state.status !== "placed") {
			throw new OrderInWrongStateError(this.id, this.state.status, "confirm");
		}
		this.commit(
			{ ...this.state, status: "confirmed" },
			this.recordEvent("OrderConfirmed", {
				confirmedAt: new Date().toISOString(),
			}),
		);
	}

	cancel(reason: string): void {
		if (this.state.status === "cancelled") return; // idempotent
		if (this.state.status === "confirmed") {
			throw new OrderInWrongStateError(this.id, this.state.status, "cancel");
		}
		this.commit(
			{ ...this.state, status: "cancelled", cancelReason: reason },
			this.recordEvent("OrderCancelled", { reason }),
		);
	}
}
