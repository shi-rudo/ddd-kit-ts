import { describe, expect, it } from "vitest";
import { moneyOfMinor } from "../../src/money";
import {
	CheckoutProcessInWrongStateError,
	EventSourcedCheckoutSaga,
} from "./event-sourced-checkout-saga";
import type { OrderId } from "./order";
import type { PaymentId } from "./payment";
import type { ShipmentId } from "./shipping";

const orderId = "ord-es-1" as OrderId;
const paymentId = "pay-es-1" as PaymentId;
const shipmentId = "ship-es-1" as ShipmentId;
const total = moneyOfMinor(4_200n, "EUR", 2);

describe("Event-sourced checkout saga", () => {
	it("records each process decision as a domain event", () => {
		const saga = EventSourcedCheckoutSaga.start(orderId, total, paymentId);

		expect(saga.step).toBe("awaiting-payment");
		expect(saga.paymentId).toBe(paymentId);
		expect(saga.pendingEvents.map((event) => event.type)).toEqual([
			"CheckoutPaymentRequested",
		]);
		expect(saga.pendingEvents[0]).toMatchObject({
			aggregateId: orderId,
			aggregateType: "EventSourcedCheckoutSaga",
			payload: { paymentId, total },
		});

		saga.requestShipping(shipmentId);
		saga.complete();

		expect(saga.step).toBe("completed");
		expect(saga.shipmentId).toBe(shipmentId);
		expect(saga.pendingEvents.map((event) => event.type)).toEqual([
			"CheckoutPaymentRequested",
			"CheckoutShippingRequested",
			"CheckoutCompleted",
		]);
	});

	it("records a payment rejection as a terminal compensation decision", () => {
		const saga = EventSourcedCheckoutSaga.start(orderId, total, paymentId);

		saga.cancelAfterPaymentFailure("insufficient-funds");

		expect(saga.step).toBe("cancelled-payment-failed");
		expect(saga.pendingEvents.at(-1)).toMatchObject({
			type: "CheckoutCancellationRequestedAfterPaymentFailure",
			payload: { reason: "insufficient-funds" },
		});
	});

	it("replays process history without emitting new work", () => {
		const source = EventSourcedCheckoutSaga.start(orderId, total, paymentId);
		source.requestShipping(shipmentId);
		source.compensateAfterShippingFailure("warehouse-unavailable");
		const history = source.pendingEvents;

		const restored = EventSourcedCheckoutSaga.reconstitute(orderId);
		const replayed = restored.loadFromHistory(history);

		expect(replayed.isOk()).toBe(true);
		expect(restored.step).toBe("cancelled-shipping-failed");
		expect(restored.paymentId).toBe(paymentId);
		expect(restored.shipmentId).toBe(shipmentId);
		expect(history.at(-1)).toMatchObject({
			type: "CheckoutCompensationRequestedAfterShippingFailure",
			payload: {
				paymentId,
				reason: "warehouse-unavailable",
			},
		});
		expect(restored.pendingEvents).toEqual([]);
		expect(restored.version).toBe(history.length);
	});

	it("rejects a process decision that is illegal in the current state", () => {
		const saga = EventSourcedCheckoutSaga.reconstitute(orderId);

		expect(() => saga.complete()).toThrow(CheckoutProcessInWrongStateError);
		expect(saga.pendingEvents).toEqual([]);
		expect(saga.version).toBe(0);
	});
});
