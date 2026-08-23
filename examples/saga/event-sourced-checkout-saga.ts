import { EventSourcedAggregate } from "../../src/domain/aggregate/event-sourced-aggregate";
import type {
	DomainEvent,
	UncommittedDomainEventOf,
} from "../../src/domain/event/domain-event";
import { DomainError } from "../../src/errors/kit-errors";
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
	| "awaiting-cancellation-after-payment-failure"
	| "awaiting-refund-after-shipping-failure"
	| "awaiting-cancellation-after-shipping-failure"
	| "cancelled-after-payment-failure"
	| "compensated-after-shipping-failure"
	| "manual-repair-required";

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

export type CheckoutPaymentRefundConfirmed = DomainEvent<
	"CheckoutPaymentRefundConfirmed",
	{ readonly reason: string }
>;

export type CheckoutCancellationCompletedAfterPaymentFailure = DomainEvent<
	"CheckoutCancellationCompletedAfterPaymentFailure",
	Record<string, never>
>;

export type CheckoutCompensationCompletedAfterShippingFailure = DomainEvent<
	"CheckoutCompensationCompletedAfterShippingFailure",
	Record<string, never>
>;

export type CheckoutManualRepairRequired = DomainEvent<
	"CheckoutManualRepairRequired",
	{
		readonly failedCommand: "CancelOrder" | "RefundPayment";
		readonly reason: string;
	}
>;

export type EventSourcedCheckoutSagaEvent =
	| CheckoutStartedAwaitingPayment
	| CheckoutAdvancedToShipping
	| CheckoutOrderConfirmationStarted
	| CheckoutCompleted
	| CheckoutCancellationStartedAfterPaymentFailure
	| CheckoutCompensationStartedAfterShippingFailure
	| CheckoutPaymentRefundConfirmed
	| CheckoutCancellationCompletedAfterPaymentFailure
	| CheckoutCompensationCompletedAfterShippingFailure
	| CheckoutManualRepairRequired;

const EXPECTED_STEPS_BY_EVENT = {
	CheckoutStartedAwaitingPayment: ["not-started"],
	CheckoutAdvancedToShipping: ["awaiting-payment"],
	CheckoutOrderConfirmationStarted: ["awaiting-shipping"],
	CheckoutCompleted: ["awaiting-order-confirmation"],
	CheckoutCancellationStartedAfterPaymentFailure: ["awaiting-payment"],
	CheckoutCompensationStartedAfterShippingFailure: ["awaiting-shipping"],
	CheckoutPaymentRefundConfirmed: ["awaiting-refund-after-shipping-failure"],
	CheckoutCancellationCompletedAfterPaymentFailure: [
		"awaiting-cancellation-after-payment-failure",
	],
	CheckoutCompensationCompletedAfterShippingFailure: [
		"awaiting-cancellation-after-shipping-failure",
	],
	CheckoutManualRepairRequired: [
		"awaiting-cancellation-after-payment-failure",
		"awaiting-refund-after-shipping-failure",
		"awaiting-cancellation-after-shipping-failure",
	],
} as const satisfies Record<
	EventSourcedCheckoutSagaEvent["type"],
	ReadonlyArray<EventSourcedCheckoutSagaStep>
>;

export class CheckoutProcessInWrongStateError extends DomainError<"CHECKOUT_PROCESS_IN_WRONG_STATE"> {
	constructor(
		orderId: OrderId,
		current: EventSourcedCheckoutSagaStep,
		attempted:
			| EventSourcedCheckoutSagaEvent["type"]
			| ReadonlyArray<EventSourcedCheckoutSagaEvent["type"]>,
	) {
		// A method that serves several flows cannot know which event the
		// caller intended when the state fits none of them; naming only one
		// would point half the callers at the wrong flow.
		const attemptedNames = Array.isArray(attempted)
			? attempted.join(" or ")
			: attempted;
		super({
			code: "CHECKOUT_PROCESS_IN_WRONG_STATE",
			message: `Checkout process ${orderId} is ${current}; cannot record ${attemptedNames}`,
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

	confirmPaymentRefunded(): void {
		this.assertCanRecord(
			"awaiting-refund-after-shipping-failure",
			"CheckoutPaymentRefundConfirmed",
		);
		const reason = this.requiredFailureReason("CheckoutPaymentRefundConfirmed");
		this.apply(
			this.createEvent<CheckoutPaymentRefundConfirmed>(
				"CheckoutPaymentRefundConfirmed",
				{ reason },
			),
		);
	}

	confirmOrderCancelled(): void {
		switch (this.state.step) {
			case "awaiting-cancellation-after-payment-failure":
				this.apply(
					this.createEvent<CheckoutCancellationCompletedAfterPaymentFailure>(
						"CheckoutCancellationCompletedAfterPaymentFailure",
						{},
					),
				);
				return;
			case "awaiting-cancellation-after-shipping-failure":
				this.apply(
					this.createEvent<CheckoutCompensationCompletedAfterShippingFailure>(
						"CheckoutCompensationCompletedAfterShippingFailure",
						{},
					),
				);
				return;
			default:
				throw new CheckoutProcessInWrongStateError(this.id, this.state.step, [
					"CheckoutCancellationCompletedAfterPaymentFailure",
					"CheckoutCompensationCompletedAfterShippingFailure",
				]);
		}
	}

	requireManualRepair(reason: string): void {
		let failedCommand: CheckoutManualRepairRequired["payload"]["failedCommand"];
		switch (this.state.step) {
			case "awaiting-refund-after-shipping-failure":
				failedCommand = "RefundPayment";
				break;
			case "awaiting-cancellation-after-payment-failure":
			case "awaiting-cancellation-after-shipping-failure":
				failedCommand = "CancelOrder";
				break;
			default:
				throw new CheckoutProcessInWrongStateError(
					this.id,
					this.state.step,
					"CheckoutManualRepairRequired",
				);
		}
		this.apply(
			this.createEvent<CheckoutManualRepairRequired>(
				"CheckoutManualRepairRequired",
				{ failedCommand, reason },
			),
		);
	}

	protected validateEvent(
		event: UncommittedDomainEventOf<EventSourcedCheckoutSagaEvent>,
	): void {
		const expected = EXPECTED_STEPS_BY_EVENT[event.type];
		if (!expected.some((step) => step === this.state.step)) {
			throw new CheckoutProcessInWrongStateError(
				this.id,
				this.state.step,
				event.type,
			);
		}
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

	private requiredFailureReason(
		attempted: EventSourcedCheckoutSagaEvent["type"],
	): string {
		if (this.state.failureReason === undefined) {
			throw new CheckoutProcessInWrongStateError(
				this.id,
				this.state.step,
				attempted,
			);
		}
		return this.state.failureReason;
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
			step: "awaiting-cancellation-after-payment-failure",
			failureReason: event.payload.reason,
		}),
		CheckoutCompensationStartedAfterShippingFailure: (
			state: EventSourcedCheckoutSagaState,
			event: UncommittedDomainEventOf<CheckoutCompensationStartedAfterShippingFailure>,
		): EventSourcedCheckoutSagaState => ({
			...state,
			step: "awaiting-refund-after-shipping-failure",
			failureReason: event.payload.reason,
		}),
		CheckoutPaymentRefundConfirmed: (
			state: EventSourcedCheckoutSagaState,
		): EventSourcedCheckoutSagaState => ({
			...state,
			step: "awaiting-cancellation-after-shipping-failure",
		}),
		CheckoutCancellationCompletedAfterPaymentFailure: (
			state: EventSourcedCheckoutSagaState,
		): EventSourcedCheckoutSagaState => ({
			...state,
			step: "cancelled-after-payment-failure",
		}),
		CheckoutCompensationCompletedAfterShippingFailure: (
			state: EventSourcedCheckoutSagaState,
		): EventSourcedCheckoutSagaState => ({
			...state,
			step: "compensated-after-shipping-failure",
		}),
		CheckoutManualRepairRequired: (
			state: EventSourcedCheckoutSagaState,
		): EventSourcedCheckoutSagaState => ({
			...state,
			step: "manual-repair-required",
		}),
	};
}
