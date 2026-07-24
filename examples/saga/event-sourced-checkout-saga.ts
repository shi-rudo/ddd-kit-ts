import type {
	DomainEvent,
	DomainEventFacts,
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
	| "completed"
	| "cancelled-payment-failed"
	| "cancelled-shipping-failed";

type EventSourcedCheckoutSagaState = {
	readonly orderId: OrderId;
	readonly step: EventSourcedCheckoutSagaStep;
	readonly total?: Money;
	readonly paymentId?: PaymentId;
	readonly shipmentId?: ShipmentId;
	readonly failureReason?: string;
};

export type CheckoutPaymentRequested = DomainEvent<
	"CheckoutPaymentRequested",
	{ readonly total: Money; readonly paymentId: PaymentId }
>;

export type CheckoutShippingRequested = DomainEvent<
	"CheckoutShippingRequested",
	{ readonly shipmentId: ShipmentId }
>;

export type CheckoutCompleted = DomainEvent<
	"CheckoutCompleted",
	Record<string, never>
>;

export type CheckoutCancellationRequestedAfterPaymentFailure = DomainEvent<
	"CheckoutCancellationRequestedAfterPaymentFailure",
	{ readonly reason: string }
>;

export type CheckoutCompensationRequestedAfterShippingFailure = DomainEvent<
	"CheckoutCompensationRequestedAfterShippingFailure",
	{ readonly paymentId: PaymentId; readonly reason: string }
>;

export type EventSourcedCheckoutSagaEvent =
	| CheckoutPaymentRequested
	| CheckoutShippingRequested
	| CheckoutCompleted
	| CheckoutCancellationRequestedAfterPaymentFailure
	| CheckoutCompensationRequestedAfterShippingFailure;

const EXPECTED_STEP_BY_EVENT = {
	CheckoutPaymentRequested: "not-started",
	CheckoutShippingRequested: "awaiting-payment",
	CheckoutCompleted: "awaiting-shipping",
	CheckoutCancellationRequestedAfterPaymentFailure: "awaiting-payment",
	CheckoutCompensationRequestedAfterShippingFailure: "awaiting-shipping",
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
		facts: DomainEventFacts,
	): EventSourcedCheckoutSaga {
		const saga = EventSourcedCheckoutSaga.reconstitute(orderId);
		saga.assertCanRecord("not-started", "CheckoutPaymentRequested");
		saga.apply(
			saga.recordEvent<CheckoutPaymentRequested>(
				"CheckoutPaymentRequested",
				{
					total,
					paymentId,
				},
				facts,
			),
		);
		return saga;
	}

	/** Creates an empty replay target. It emits no events of its own. */
	static reconstitute(orderId: OrderId): EventSourcedCheckoutSaga {
		return new EventSourcedCheckoutSaga(orderId);
	}

	requestShipping(shipmentId: ShipmentId, facts: DomainEventFacts): void {
		this.assertCanRecord("awaiting-payment", "CheckoutShippingRequested");
		this.apply(
			this.recordEvent<CheckoutShippingRequested>(
				"CheckoutShippingRequested",
				{ shipmentId },
				facts,
			),
		);
	}

	complete(facts: DomainEventFacts): void {
		this.assertCanRecord("awaiting-shipping", "CheckoutCompleted");
		this.apply(
			this.recordEvent<CheckoutCompleted>("CheckoutCompleted", {}, facts),
		);
	}

	cancelAfterPaymentFailure(reason: string, facts: DomainEventFacts): void {
		this.assertCanRecord(
			"awaiting-payment",
			"CheckoutCancellationRequestedAfterPaymentFailure",
		);
		this.apply(
			this.recordEvent<CheckoutCancellationRequestedAfterPaymentFailure>(
				"CheckoutCancellationRequestedAfterPaymentFailure",
				{ reason },
				facts,
			),
		);
	}

	compensateAfterShippingFailure(
		reason: string,
		facts: DomainEventFacts,
	): void {
		this.assertCanRecord(
			"awaiting-shipping",
			"CheckoutCompensationRequestedAfterShippingFailure",
		);
		const { paymentId } = this.state;
		if (paymentId === undefined) {
			throw new CheckoutProcessInWrongStateError(
				this.id,
				this.state.step,
				"CheckoutCompensationRequestedAfterShippingFailure",
			);
		}
		this.apply(
			this.recordEvent<CheckoutCompensationRequestedAfterShippingFailure>(
				"CheckoutCompensationRequestedAfterShippingFailure",
				{ paymentId, reason },
				facts,
			),
		);
	}

	protected validateEvent(event: EventSourcedCheckoutSagaEvent): void {
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
		CheckoutPaymentRequested: (
			state: EventSourcedCheckoutSagaState,
			event: CheckoutPaymentRequested,
		): EventSourcedCheckoutSagaState => ({
			...state,
			step: "awaiting-payment",
			total: event.payload.total,
			paymentId: event.payload.paymentId,
		}),
		CheckoutShippingRequested: (
			state: EventSourcedCheckoutSagaState,
			event: CheckoutShippingRequested,
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
		CheckoutCancellationRequestedAfterPaymentFailure: (
			state: EventSourcedCheckoutSagaState,
			event: CheckoutCancellationRequestedAfterPaymentFailure,
		): EventSourcedCheckoutSagaState => ({
			...state,
			step: "cancelled-payment-failed",
			failureReason: event.payload.reason,
		}),
		CheckoutCompensationRequestedAfterShippingFailure: (
			state: EventSourcedCheckoutSagaState,
			event: CheckoutCompensationRequestedAfterShippingFailure,
		): EventSourcedCheckoutSagaState => ({
			...state,
			step: "cancelled-shipping-failed",
			failureReason: event.payload.reason,
		}),
	};
}
