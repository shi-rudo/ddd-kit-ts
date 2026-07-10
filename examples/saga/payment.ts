import { AggregateRoot } from "../../src/aggregate/aggregate-root";
import type { DomainEvent } from "../../src/aggregate/domain-event";
import { DomainError } from "../../src/core/errors";
import type { Id } from "../../src/core/id";
import type { Money } from "../../src/money";
import type { OrderId } from "./order";

export type PaymentId = Id<"PaymentId">;

export type PaymentState = {
	id: PaymentId;
	orderId: OrderId;
	amount: Money;
	status: "requested" | "received" | "failed" | "refunded";
	failureReason?: string;
};

export type PaymentRequested = DomainEvent<
	"PaymentRequested",
	{ orderId: OrderId; amount: Money }
>;
export type PaymentReceived = DomainEvent<
	"PaymentReceived",
	{ orderId: OrderId; amount: Money }
>;
export type PaymentFailed = DomainEvent<
	"PaymentFailed",
	{ orderId: OrderId; reason: string }
>;
export type PaymentRefunded = DomainEvent<
	"PaymentRefunded",
	{ orderId: OrderId; amount: Money }
>;

export type PaymentEvent =
	| PaymentRequested
	| PaymentReceived
	| PaymentFailed
	| PaymentRefunded;

export class PaymentInWrongStateError extends DomainError<"PAYMENT_IN_WRONG_STATE"> {
	constructor(paymentId: PaymentId, current: string, attempted: string) {
		super({
			code: "PAYMENT_IN_WRONG_STATE",
			message: `Payment ${paymentId} is ${current}; cannot ${attempted}`,
		});
	}
}

export class Payment extends AggregateRoot<
	PaymentState,
	PaymentId,
	PaymentEvent
> {
	protected readonly aggregateType = "Payment";

	static request(id: PaymentId, orderId: OrderId, amount: Money): Payment {
		const payment = new Payment(id, {
			id,
			orderId,
			amount,
			status: "requested",
		});
		payment.commit(
			{ id, orderId, amount, status: "requested" },
			payment.recordEvent("PaymentRequested", { orderId, amount }),
		);
		return payment;
	}

	receive(): void {
		if (this.state.status !== "requested") {
			throw new PaymentInWrongStateError(this.id, this.state.status, "receive");
		}
		this.commit(
			{ ...this.state, status: "received" },
			this.recordEvent("PaymentReceived", {
				orderId: this.state.orderId,
				amount: this.state.amount,
			}),
		);
	}

	fail(reason: string): void {
		if (this.state.status !== "requested") {
			throw new PaymentInWrongStateError(this.id, this.state.status, "fail");
		}
		this.commit(
			{ ...this.state, status: "failed", failureReason: reason },
			this.recordEvent("PaymentFailed", {
				orderId: this.state.orderId,
				reason,
			}),
		);
	}

	refund(): void {
		if (this.state.status !== "received") {
			throw new PaymentInWrongStateError(this.id, this.state.status, "refund");
		}
		this.commit(
			{ ...this.state, status: "refunded" },
			this.recordEvent("PaymentRefunded", {
				orderId: this.state.orderId,
				amount: this.state.amount,
			}),
		);
	}
}
