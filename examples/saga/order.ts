import { StateStoredAggregate } from "../../src/domain/aggregate/state-stored-aggregate";
import type { DomainEvent } from "../../src/domain/event/domain-event";
import type { Id } from "../../src/domain/identity/id";
import type { Money } from "../../src/domain/value-object/money";
import { DomainError } from "../../src/errors/kit-errors";

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

export class Order extends StateStoredAggregate<
	OrderState,
	OrderId,
	OrderEvent
> {
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
		order.setState(
			{ id, customerId, total, status: "placed" },
			order.createEvent("OrderPlaced", { customerId, total }),
		);
		return order;
	}

	confirm(confirmedAt: Date): void {
		if (this.state.status !== "placed") {
			throw new OrderInWrongStateError(this.id, this.state.status, "confirm");
		}
		this.setState(
			{ ...this.state, status: "confirmed" },
			this.createEvent("OrderConfirmed", {
				confirmedAt: confirmedAt.toISOString(),
			}),
		);
	}

	cancel(reason: string): void {
		if (this.state.status === "cancelled") return; // idempotent
		if (this.state.status === "confirmed") {
			throw new OrderInWrongStateError(this.id, this.state.status, "cancel");
		}
		this.setState(
			{ ...this.state, status: "cancelled", cancelReason: reason },
			this.createEvent("OrderCancelled", { reason }),
		);
	}
}
