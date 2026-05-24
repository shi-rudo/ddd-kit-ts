import { AggregateRoot } from "../../src/aggregate/aggregate-root";
import { DomainError } from "../../src/core/errors";
import type { OrderId } from "./order";
import type { PaymentId } from "./payment";
import type { ShipmentId } from "./shipping";

/**
 * Process Manager (Vernon IDDD §12) that orchestrates the checkout
 * flow: order placed → payment requested → payment received →
 * shipping requested → shipping completed → order confirmed.
 *
 * Failure paths trigger compensating actions:
 *  - Payment fails  → order cancelled
 *  - Shipping fails → payment refunded + order cancelled
 *
 * The Process Manager is itself an aggregate: it has identity (the
 * saga id, here aligned with the orderId), state (its position in the
 * workflow), and a lifecycle. It does NOT publish domain events of
 * its own — its outputs are commands dispatched to other aggregates,
 * not events for subscribers to react to.
 */

export type CheckoutSagaState = {
	orderId: OrderId;
	totalCents: number;
	step:
		| "awaiting-payment"
		| "awaiting-shipping"
		| "completed"
		| "cancelled-payment-failed"
		| "cancelled-shipping-failed";
	paymentId?: PaymentId;
	shipmentId?: ShipmentId;
};

export class SagaInWrongStateError extends DomainError<"SagaInWrongStateError"> {
	constructor(orderId: OrderId, current: string, attempted: string) {
		super(`Checkout saga for ${orderId} is in ${current}; cannot ${attempted}`);
	}
}

// TEvent stays at the default `never` — the saga has no domain events
// of its own. Its state changes are private bookkeeping; downstream
// effects flow through dispatched commands, not published events.
export class CheckoutSaga extends AggregateRoot<
	CheckoutSagaState,
	OrderId
> {
	static start(orderId: OrderId, totalCents: number): CheckoutSaga {
		const saga = new CheckoutSaga(orderId, {
			orderId,
			totalCents,
			step: "awaiting-payment",
		});
		// commit() with no events: bumps version, records no domain events.
		saga.commit({ orderId, totalCents, step: "awaiting-payment" });
		return saga;
	}

	recordPaymentRequested(paymentId: PaymentId): void {
		if (this.state.step !== "awaiting-payment") {
			throw new SagaInWrongStateError(
				this.state.orderId,
				this.state.step,
				"recordPaymentRequested",
			);
		}
		this.commit({ ...this.state, paymentId });
	}

	advanceToShipping(): void {
		if (this.state.step !== "awaiting-payment") {
			throw new SagaInWrongStateError(
				this.state.orderId,
				this.state.step,
				"advanceToShipping",
			);
		}
		this.commit({ ...this.state, step: "awaiting-shipping" });
	}

	recordShippingRequested(shipmentId: ShipmentId): void {
		if (this.state.step !== "awaiting-shipping") {
			throw new SagaInWrongStateError(
				this.state.orderId,
				this.state.step,
				"recordShippingRequested",
			);
		}
		this.commit({ ...this.state, shipmentId });
	}

	complete(): void {
		if (this.state.step !== "awaiting-shipping") {
			throw new SagaInWrongStateError(
				this.state.orderId,
				this.state.step,
				"complete",
			);
		}
		this.commit({ ...this.state, step: "completed" });
	}

	cancelOnPaymentFailure(): void {
		if (this.state.step !== "awaiting-payment") {
			throw new SagaInWrongStateError(
				this.state.orderId,
				this.state.step,
				"cancelOnPaymentFailure",
			);
		}
		this.commit({ ...this.state, step: "cancelled-payment-failed" });
	}

	cancelOnShippingFailure(): void {
		if (this.state.step !== "awaiting-shipping") {
			throw new SagaInWrongStateError(
				this.state.orderId,
				this.state.step,
				"cancelOnShippingFailure",
			);
		}
		this.commit({ ...this.state, step: "cancelled-shipping-failed" });
	}
}
