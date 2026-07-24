import type {
	DomainEvent,
	UncommittedDomainEventOf,
} from "../../src/aggregate/domain-event";
import { EventSourcedAggregate } from "../../src/aggregate/event-sourced-aggregate";
import { DomainError } from "../../src/core/errors";
import type { Money } from "../../src/money";
import type { OrderId } from "./order";
import type { PaymentId } from "./payment";
import type { ShipmentId } from "./shipping";

export type EventSourcedCheckoutSagaStep =
	| "not-started"
	| "awaiting-payment"
	| "awaiting-shipping"
	| "awaiting-order-confirmation"
	| "completed"
	| "cancelling-after-payment-failure"
	| "compensating-after-shipping-failure";

type EventSourcedCheckoutSagaState = {
	readonly orderId: OrderId;
	readonly step: EventSourcedCheckoutSagaStep;
	readonly total?: Money;
	readonly paymentId?: PaymentId;
	readonly shipmentId?: ShipmentId;
	readonly failureReason?: string;
};

export type CheckoutStartedAwaitingPayment = DomainEvent<
	"CheckoutStartedAwaitingPayment",
	{ readonly total: Money; readonly paymentId: PaymentId }
>;

export type CheckoutAdvancedToShipping = DomainEvent<
	"CheckoutAdvancedToShipping",
	{ readonly shipmentId: ShipmentId }
>;

export type CheckoutCompleted = DomainEvent<
	"CheckoutCompleted",
	Record<string, never>
>;

export type CheckoutOrderConfirmationStarted = DomainEvent<
	"CheckoutOrderConfirmationStarted",
	Record<string, never>
>;

export type CheckoutCancellationStartedAfterPaymentFailure = DomainEvent<
	"CheckoutCancellationStartedAfterPaymentFailure",
	{ readonly reason: string }
>;

export type CheckoutCompensationStartedAfterShippingFailure = DomainEvent<
	"CheckoutCompensationStartedAfterShippingFailure",
	{ readonly paymentId: PaymentId; readonly reason: string }
>;

export type EventSourcedCheckoutSagaEvent =
	| CheckoutStartedAwaitingPayment
	| CheckoutAdvancedToShipping
	| CheckoutOrderConfirmationStarted
	| CheckoutCompleted
	| CheckoutCancellationStartedAfterPaymentFailure
	| CheckoutCompensationStartedAfterShippingFailure;

const EXPECTED_STEP_BY_EVENT = {
	CheckoutStartedAwaitingPayment: "not-started",
	CheckoutAdvancedToShipping: "awaiting-payment",
	CheckoutOrderConfirmationStarted: "awaiting-shipping",
	CheckoutCompleted: "awaiting-order-confirmation",
	CheckoutCancellationStartedAfterPaymentFailure: "awaiting-payment",
	CheckoutCompensationStartedAfterShippingFailure: "awaiting-shipping",
} as const satisfies Record<
	EventSourcedCheckoutSagaEvent["type"],
	EventSourcedCheckoutSagaStep
>;

export class CheckoutProcessInWrongStateError extends DomainError<"CHECKOUT_PROCESS_IN_WRONG_STATE"> {
	constructor(
		orderId: OrderId,
		current: EventSourcedCheckoutSagaStep,
		attempted: EventSourcedCheckoutSagaEvent["type"],
	) {
		super({
			code: "CHECKOUT_PROCESS_IN_WRONG_STATE",
			message: `Checkout process ${orderId} is ${current}; cannot record ${attempted}`,
		});
	}
}

/**
 * Compact event-sourced counterpart to {@link CheckoutSaga}.
 *
 * Its stream records process decisions. Those events rebuild process state and
 * can be mapped to participant commands after the commit/outbox boundary.
 * Event handlers only evolve state: replay never dispatches commands.
 */
export class EventSourcedCheckoutSaga extends EventSourcedAggregate<
	EventSourcedCheckoutSagaState,
	EventSourcedCheckoutSagaEvent,
	OrderId
> {
	protected readonly aggregateType = "EventSourcedCheckoutSaga";

	protected constructor(orderId: OrderId) {
		super(orderId, { orderId, step: "not-started" });
	}

	get step(): EventSourcedCheckoutSagaStep {
		return this.state.step;
	}

	get paymentId(): PaymentId | undefined {
		return this.state.paymentId;
	}

	get shipmentId(): ShipmentId | undefined {
		return this.state.shipmentId;
	}

	/** Creates a new process and records its first durable outgoing decision. */
	static start(
		orderId: OrderId,
		total: Money,
		paymentId: PaymentId,
	): EventSourcedCheckoutSaga {
		const saga = EventSourcedCheckoutSaga.reconstitute(orderId);
		saga.assertCanRecord("not-started", "CheckoutStartedAwaitingPayment");
		saga.apply(
			saga.createEvent<CheckoutStartedAwaitingPayment>(
				"CheckoutStartedAwaitingPayment",
				{
					total,
					paymentId,
				},
			),
		);
		return saga;
	}

	/** Creates an empty replay target. It emits no events of its own. */
	static reconstitute(orderId: OrderId): EventSourcedCheckoutSaga {
		return new EventSourcedCheckoutSaga(orderId);
	}

	advanceToShipping(shipmentId: ShipmentId): void {
		this.assertCanRecord("awaiting-payment", "CheckoutAdvancedToShipping");
		this.apply(
			this.createEvent<CheckoutAdvancedToShipping>(
				"CheckoutAdvancedToShipping",
				{ shipmentId },
			),
		);
	}

	complete(): void {
		this.assertCanRecord("awaiting-order-confirmation", "CheckoutCompleted");
		this.apply(this.createEvent<CheckoutCompleted>("CheckoutCompleted", {}));
	}

	beginOrderConfirmation(): void {
		this.assertCanRecord(
			"awaiting-shipping",
			"CheckoutOrderConfirmationStarted",
		);
		this.apply(
			this.createEvent<CheckoutOrderConfirmationStarted>(
				"CheckoutOrderConfirmationStarted",
				{},
			),
		);
	}

	beginCancellationAfterPaymentFailure(reason: string): void {
		this.assertCanRecord(
			"awaiting-payment",
			"CheckoutCancellationStartedAfterPaymentFailure",
		);
		this.apply(
			this.createEvent<CheckoutCancellationStartedAfterPaymentFailure>(
				"CheckoutCancellationStartedAfterPaymentFailure",
				{ reason },
			),
		);
	}

	beginCompensationAfterShippingFailure(reason: string): void {
		this.assertCanRecord(
			"awaiting-shipping",
			"CheckoutCompensationStartedAfterShippingFailure",
		);
		const { paymentId } = this.state;
		if (paymentId === undefined) {
			throw new CheckoutProcessInWrongStateError(
				this.id,
				this.state.step,
				"CheckoutCompensationStartedAfterShippingFailure",
			);
		}
		this.apply(
			this.createEvent<CheckoutCompensationStartedAfterShippingFailure>(
				"CheckoutCompensationStartedAfterShippingFailure",
				{ paymentId, reason },
			),
		);
	}

	protected validateEvent(
		event: UncommittedDomainEventOf<EventSourcedCheckoutSagaEvent>,
	): void {
		this.assertCanRecord(EXPECTED_STEP_BY_EVENT[event.type], event.type);
	}

	private assertCanRecord(
		expected: EventSourcedCheckoutSagaStep,
		attempted: EventSourcedCheckoutSagaEvent["type"],
	): void {
		if (this.state.step !== expected) {
			throw new CheckoutProcessInWrongStateError(
				this.id,
				this.state.step,
				attempted,
			);
		}
	}

	protected readonly handlers = {
		CheckoutStartedAwaitingPayment: (
			state: EventSourcedCheckoutSagaState,
			event: UncommittedDomainEventOf<CheckoutStartedAwaitingPayment>,
		): EventSourcedCheckoutSagaState => ({
			...state,
			step: "awaiting-payment",
			total: event.payload.total,
			paymentId: event.payload.paymentId,
		}),
		CheckoutAdvancedToShipping: (
			state: EventSourcedCheckoutSagaState,
			event: UncommittedDomainEventOf<CheckoutAdvancedToShipping>,
		): EventSourcedCheckoutSagaState => ({
			...state,
			step: "awaiting-shipping",
			shipmentId: event.payload.shipmentId,
		}),
		CheckoutCompleted: (
			state: EventSourcedCheckoutSagaState,
		): EventSourcedCheckoutSagaState => ({
			...state,
			step: "completed",
		}),
		CheckoutOrderConfirmationStarted: (
			state: EventSourcedCheckoutSagaState,
		): EventSourcedCheckoutSagaState => ({
			...state,
			step: "awaiting-order-confirmation",
		}),
		CheckoutCancellationStartedAfterPaymentFailure: (
			state: EventSourcedCheckoutSagaState,
			event: UncommittedDomainEventOf<CheckoutCancellationStartedAfterPaymentFailure>,
		): EventSourcedCheckoutSagaState => ({
			...state,
			step: "cancelling-after-payment-failure",
			failureReason: event.payload.reason,
		}),
		CheckoutCompensationStartedAfterShippingFailure: (
			state: EventSourcedCheckoutSagaState,
			event: UncommittedDomainEventOf<CheckoutCompensationStartedAfterShippingFailure>,
		): EventSourcedCheckoutSagaState => ({
			...state,
			step: "compensating-after-shipping-failure",
			failureReason: event.payload.reason,
		}),
	};
}
