import type { Command } from "../../src/app/command";
import type {
	CommandMessageContent,
	CommandMessageRelationships,
} from "../../src/app/command-outbox";
import type { Money } from "../../src/money";
import type {
	CheckoutAdvancedToShipping,
	CheckoutCancellationStartedAfterPaymentFailure,
	CheckoutCompensationStartedAfterShippingFailure,
	CheckoutOrderConfirmationStarted,
	CheckoutStartedAwaitingPayment,
	EventSourcedCheckoutSagaEvent,
} from "./event-sourced-checkout-saga";
import type { OrderId } from "./order";
import type { PaymentId } from "./payment";
import type { ShipmentId } from "./shipping";

export type RequestPayment = Command & {
	readonly type: "RequestPayment";
	readonly orderId: OrderId;
	readonly paymentId: PaymentId;
	readonly amount: Money;
};

export type RequestShipping = Command & {
	readonly type: "RequestShipping";
	readonly orderId: OrderId;
	readonly shipmentId: ShipmentId;
};

export type ConfirmOrder = Command & {
	readonly type: "ConfirmOrder";
	readonly orderId: OrderId;
};

export type CancelOrder = Command & {
	readonly type: "CancelOrder";
	readonly orderId: OrderId;
	readonly reason: string;
};

export type RefundPayment = Command & {
	readonly type: "RefundPayment";
	readonly paymentId: PaymentId;
};

export type CheckoutParticipantCommand =
	| RequestPayment
	| RequestShipping
	| ConfirmOrder
	| CancelOrder
	| RefundPayment;

/**
 * Application-boundary mapper from private process facts to exact participant
 * commands. The fact is never published. `routeEventsToCommandOutbox` invokes
 * this mapper inside the process commit and stores only the addressed commands
 * plus a source receipt.
 */
export function checkoutCommandsFromProcessFact(
	event: EventSourcedCheckoutSagaEvent,
): ReadonlyArray<CommandMessageContent<CheckoutParticipantCommand>> {
	const orderId = requiredOrderId(event);
	const relationships = messageRelationships(event);
	switch (event.type) {
		case "CheckoutStartedAwaitingPayment":
			return requestPayment(event, orderId, relationships);
		case "CheckoutAdvancedToShipping":
			return requestShipping(event, orderId, relationships);
		case "CheckoutOrderConfirmationStarted":
			return confirmOrder(event, orderId, relationships);
		case "CheckoutCompleted":
			return [];
		case "CheckoutCancellationStartedAfterPaymentFailure":
			return cancelAfterPaymentFailure(event, orderId, relationships);
		case "CheckoutCompensationStartedAfterShippingFailure":
			return compensateAfterShippingFailure(event, orderId, relationships);
		default:
			return assertNever(event);
	}
}

function requestPayment(
	event: CheckoutStartedAwaitingPayment,
	orderId: OrderId,
	relationships: CommandMessageRelationships,
): ReadonlyArray<CommandMessageContent<RequestPayment>> {
	return [
		{
			destination: "payments.commands",
			command: {
				type: "RequestPayment",
				orderId,
				paymentId: event.payload.paymentId,
				amount: event.payload.total,
			},
			...relationships,
		},
	];
}

function requestShipping(
	event: CheckoutAdvancedToShipping,
	orderId: OrderId,
	relationships: CommandMessageRelationships,
): ReadonlyArray<CommandMessageContent<RequestShipping>> {
	return [
		{
			destination: "shipping.commands",
			command: {
				type: "RequestShipping",
				orderId,
				shipmentId: event.payload.shipmentId,
			},
			...relationships,
		},
	];
}

function confirmOrder(
	_event: CheckoutOrderConfirmationStarted,
	orderId: OrderId,
	relationships: CommandMessageRelationships,
): ReadonlyArray<CommandMessageContent<ConfirmOrder>> {
	return [
		{
			destination: "orders.commands",
			command: { type: "ConfirmOrder", orderId },
			...relationships,
		},
	];
}

function cancelAfterPaymentFailure(
	event: CheckoutCancellationStartedAfterPaymentFailure,
	orderId: OrderId,
	relationships: CommandMessageRelationships,
): ReadonlyArray<CommandMessageContent<CancelOrder>> {
	return [
		{
			destination: "orders.commands",
			command: {
				type: "CancelOrder",
				orderId,
				reason: `payment-failed: ${event.payload.reason}`,
			},
			...relationships,
		},
	];
}

function compensateAfterShippingFailure(
	event: CheckoutCompensationStartedAfterShippingFailure,
	orderId: OrderId,
	relationships: CommandMessageRelationships,
): ReadonlyArray<CommandMessageContent<RefundPayment | CancelOrder>> {
	return [
		{
			destination: "payments.commands",
			command: {
				type: "RefundPayment",
				paymentId: event.payload.paymentId,
			},
			...relationships,
		},
		{
			destination: "orders.commands",
			command: {
				type: "CancelOrder",
				orderId,
				reason: `shipping-failed: ${event.payload.reason}`,
			},
			...relationships,
		},
	];
}

function requiredOrderId(event: EventSourcedCheckoutSagaEvent): OrderId {
	if (!event.aggregateId) {
		throw new TypeError(
			`Checkout process fact ${event.type} is missing its order id`,
		);
	}
	return event.aggregateId as OrderId;
}

function messageRelationships(
	event: EventSourcedCheckoutSagaEvent,
): CommandMessageRelationships {
	return {
		...(event.metadata?.correlationId === undefined
			? {}
			: { correlationId: event.metadata.correlationId }),
		...(event.metadata?.conversationId === undefined
			? {}
			: { conversationId: event.metadata.conversationId }),
	};
}

function assertNever(value: never): never {
	throw new TypeError(`Unsupported checkout process fact: ${String(value)}`);
}
