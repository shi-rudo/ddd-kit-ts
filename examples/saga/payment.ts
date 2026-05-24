import { AggregateRoot } from "../../src/aggregate/aggregate-root";
import {
	createDomainEvent,
	type DomainEvent,
} from "../../src/aggregate/domain-event";
import { DomainError } from "../../src/core/errors";
import type { Id } from "../../src/core/id";
import type { OrderId } from "./order";

export type PaymentId = Id<"PaymentId">;

export type PaymentState = {
	id: PaymentId;
	orderId: OrderId;
	amountCents: number;
	status: "requested" | "received" | "failed" | "refunded";
	failureReason?: string;
};

export type PaymentRequested = DomainEvent<
	"PaymentRequested",
	{ orderId: OrderId; amountCents: number }
>;
export type PaymentReceived = DomainEvent<
	"PaymentReceived",
	{ orderId: OrderId; amountCents: number }
>;
export type PaymentFailed = DomainEvent<
	"PaymentFailed",
	{ orderId: OrderId; reason: string }
>;
export type PaymentRefunded = DomainEvent<
	"PaymentRefunded",
	{ orderId: OrderId; amountCents: number }
>;

export type PaymentEvent =
	| PaymentRequested
	| PaymentReceived
	| PaymentFailed
	| PaymentRefunded;

export class PaymentInWrongStateError extends DomainError<"PaymentInWrongStateError"> {
	constructor(paymentId: PaymentId, current: string, attempted: string) {
		super(`Payment ${paymentId} is ${current}; cannot ${attempted}`);
	}
}

export class Payment extends AggregateRoot<
	PaymentState,
	PaymentId,
	PaymentEvent
> {
	static request(id: PaymentId, orderId: OrderId, amountCents: number): Payment {
		const payment = new Payment(id, {
			id,
			orderId,
			amountCents,
			status: "requested",
		});
		payment.commit(
			{ id, orderId, amountCents, status: "requested" },
			createDomainEvent(
				"PaymentRequested",
				{ orderId, amountCents },
				{ aggregateId: id, aggregateType: "Payment" },
			),
		);
		return payment;
	}

	receive(): void {
		if (this.state.status !== "requested") {
			throw new PaymentInWrongStateError(this.id, this.state.status, "receive");
		}
		this.commit(
			{ ...this.state, status: "received" },
			createDomainEvent(
				"PaymentReceived",
				{ orderId: this.state.orderId, amountCents: this.state.amountCents },
				{ aggregateId: this.id, aggregateType: "Payment" },
			),
		);
	}

	fail(reason: string): void {
		if (this.state.status !== "requested") {
			throw new PaymentInWrongStateError(this.id, this.state.status, "fail");
		}
		this.commit(
			{ ...this.state, status: "failed", failureReason: reason },
			createDomainEvent(
				"PaymentFailed",
				{ orderId: this.state.orderId, reason },
				{ aggregateId: this.id, aggregateType: "Payment" },
			),
		);
	}

	refund(): void {
		if (this.state.status !== "received") {
			throw new PaymentInWrongStateError(this.id, this.state.status, "refund");
		}
		this.commit(
			{ ...this.state, status: "refunded" },
			createDomainEvent(
				"PaymentRefunded",
				{ orderId: this.state.orderId, amountCents: this.state.amountCents },
				{ aggregateId: this.id, aggregateType: "Payment" },
			),
		);
	}
}
