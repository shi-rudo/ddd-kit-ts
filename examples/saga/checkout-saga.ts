import { AggregateRoot } from "../../src/aggregate/aggregate-root";
import {
	createInitialDomainMachineSnapshot,
	type DomainMachineDefinition,
	type DomainMachineSnapshot,
	transitionDomainState,
} from "../../src/domain-state-machine/domain-state-machine";
import type { OrderId } from "./order";
import type { PaymentId } from "./payment";
import type { ShipmentId } from "./shipping";

/**
 * Process Manager (Vernon IDDD §12) that orchestrates checkout while keeping
 * its public API in domain language. The table-driven state machine remains an
 * internal implementation detail of methods such as `advanceToShipping()`.
 */

export type CheckoutSagaStep =
	| "awaiting-payment"
	| "awaiting-shipping"
	| "completed"
	| "cancelled-payment-failed"
	| "cancelled-shipping-failed";

export type CheckoutSagaState = {
	orderId: OrderId;
	totalCents: number;
	step: CheckoutSagaStep;
	paymentId?: PaymentId;
	shipmentId?: ShipmentId;
};

type CheckoutSagaContext = Omit<CheckoutSagaState, "step">;

type CheckoutSagaInput =
	| { readonly type: "PaymentRequested"; readonly paymentId: PaymentId }
	| { readonly type: "PaymentReceived" }
	| { readonly type: "ShippingRequested"; readonly shipmentId: ShipmentId }
	| { readonly type: "ShippingCompleted" }
	| { readonly type: "PaymentFailed" }
	| { readonly type: "ShippingFailed" };

function checkoutLifecycle(
	initialContext: CheckoutSagaContext,
): DomainMachineDefinition<
	CheckoutSagaStep,
	CheckoutSagaContext,
	CheckoutSagaInput
> {
	return {
		initial: "awaiting-payment",
		initialContext: () => initialContext,
		validateSnapshot: ({ state, context }) => {
			if (state === "awaiting-payment") return true;
			if (context.paymentId === undefined) return false;
			if (state === "completed" || state === "cancelled-shipping-failed") {
				return context.shipmentId !== undefined;
			}
			return true;
		},
		states: {
			"awaiting-payment": {
				on: {
					PaymentRequested: {
						target: "awaiting-payment",
						reduce: ({ context, input }) => ({
							context: { ...context, paymentId: input.paymentId },
						}),
					},
					PaymentReceived: {
						target: "awaiting-shipping",
						guard: ({ context }) => context.paymentId !== undefined,
					},
					PaymentFailed: {
						target: "cancelled-payment-failed",
						guard: ({ context }) => context.paymentId !== undefined,
					},
				},
			},
			"awaiting-shipping": {
				on: {
					ShippingRequested: {
						target: "awaiting-shipping",
						reduce: ({ context, input }) => ({
							context: { ...context, shipmentId: input.shipmentId },
						}),
					},
					ShippingCompleted: {
						target: "completed",
						guard: ({ context }) => context.shipmentId !== undefined,
					},
					ShippingFailed: {
						target: "cancelled-shipping-failed",
						guard: ({ context }) => context.shipmentId !== undefined,
					},
				},
			},
			completed: { terminal: true },
			"cancelled-payment-failed": { terminal: true },
			"cancelled-shipping-failed": { terminal: true },
		},
	};
}

function toMachineSnapshot(
	state: CheckoutSagaState,
): DomainMachineSnapshot<CheckoutSagaStep, CheckoutSagaContext> {
	const { step, ...context } = state;
	return { state: step, context };
}

function toSagaState(
	snapshot: DomainMachineSnapshot<CheckoutSagaStep, CheckoutSagaContext>,
): CheckoutSagaState {
	return { ...snapshot.context, step: snapshot.state };
}

// TEvent stays at the default `never`: machine transitions are internal state
// decisions, while aggregate domain events still go through recordEvent/commit.
export class CheckoutSaga extends AggregateRoot<CheckoutSagaState, OrderId> {
	protected readonly aggregateType = "CheckoutSaga";

	static start(orderId: OrderId, totalCents: number): CheckoutSaga {
		const initialContext = { orderId, totalCents };
		const snapshot = createInitialDomainMachineSnapshot(
			checkoutLifecycle(initialContext),
		);
		const state = toSagaState(snapshot);
		const saga = new CheckoutSaga(orderId, state);
		saga.commit(state);
		return saga;
	}

	recordPaymentRequested(paymentId: PaymentId): void {
		this.transition({ type: "PaymentRequested", paymentId });
	}

	advanceToShipping(): void {
		this.transition({ type: "PaymentReceived" });
	}

	recordShippingRequested(shipmentId: ShipmentId): void {
		this.transition({ type: "ShippingRequested", shipmentId });
	}

	complete(): void {
		this.transition({ type: "ShippingCompleted" });
	}

	cancelOnPaymentFailure(): void {
		this.transition({ type: "PaymentFailed" });
	}

	cancelOnShippingFailure(): void {
		this.transition({ type: "ShippingFailed" });
	}

	private transition(input: CheckoutSagaInput): void {
		const snapshot = toMachineSnapshot(this.state);
		const result = transitionDomainState(
			checkoutLifecycle(snapshot.context),
			snapshot,
			input,
		);
		this.commit(toSagaState(result.snapshot));
	}
}
