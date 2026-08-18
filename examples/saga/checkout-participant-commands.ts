import type { PublishedCommand } from "../../src/app/command";
import type {
	CommandMessageContent,
	CommandMessageRelationships,
} from "../../src/app/command-outbox";
import { type MoneyDto, moneyToDto } from "../../src/money";
import type {
	CheckoutAdvancedToShipping,
	CheckoutCancellationStartedAfterPaymentFailure,
	CheckoutCompensationStartedAfterShippingFailure,
	CheckoutOrderConfirmationStarted,
	CheckoutPaymentRefundConfirmed,
	CheckoutStartedAwaitingPayment,
	EventSourcedCheckoutSagaEvent,
} from "./event-sourced-checkout-saga";
import type { OrderId } from "./order";
import type { PaymentId } from "./payment";
import type { ShipmentId } from "./shipping";

export type RequestPayment = PublishedCommand<
	"RequestPayment",
	{
		readonly orderId: OrderId;
		readonly paymentId: PaymentId;
		readonly amount: MoneyDto;
	}
>;

export type RequestShipping = PublishedCommand<
	"RequestShipping",
	{
		readonly orderId: OrderId;
		readonly shipmentId: ShipmentId;
	}
>;

export type ConfirmOrder = PublishedCommand<
	"ConfirmOrder",
	{ readonly orderId: OrderId }
>;

export type CancelOrder = PublishedCommand<
	"CancelOrder",
	{
		readonly orderId: OrderId;
		readonly reason: string;
	}
>;

export type RefundPayment = PublishedCommand<
	"RefundPayment",
	{ readonly paymentId: PaymentId }
>;

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
			return compensateAfterShippingFailure(event, relationships);
		case "CheckoutPaymentRefundConfirmed":
			return cancelAfterRefund(event, orderId, relationships);
		case "CheckoutCancellationCompletedAfterPaymentFailure":
		case "CheckoutCompensationCompletedAfterShippingFailure":
		case "CheckoutManualRepairRequired":
			return [];
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
				version: 1,
				payload: {
					orderId,
					paymentId: event.payload.paymentId,
					amount: moneyToDto(event.payload.total),
				},
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
				version: 1,
				payload: {
					orderId,
					shipmentId: event.payload.shipmentId,
				},
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
			command: {
				type: "ConfirmOrder",
				version: 1,
				payload: { orderId },
			},
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
				version: 1,
				payload: {
					orderId,
					reason: `payment-failed: ${event.payload.reason}`,
				},
			},
			...relationships,
		},
	];
}

function compensateAfterShippingFailure(
	event: CheckoutCompensationStartedAfterShippingFailure,
	relationships: CommandMessageRelationships,
): ReadonlyArray<CommandMessageContent<RefundPayment>> {
	return [
		{
			destination: "payments.commands",
			command: {
				type: "RefundPayment",
				version: 1,
				payload: { paymentId: event.payload.paymentId },
			},
			...relationships,
		},
	];
}

function cancelAfterRefund(
	event: CheckoutPaymentRefundConfirmed,
	orderId: OrderId,
	relationships: CommandMessageRelationships,
): ReadonlyArray<CommandMessageContent<CancelOrder>> {
	return [
		{
			destination: "orders.commands",
			command: {
				type: "CancelOrder",
				version: 1,
				payload: {
					orderId,
					reason: `shipping-failed: ${event.payload.reason}`,
				},
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
	const conversationId = event.metadata?.conversationId;
	if (
		typeof conversationId !== "string" ||
		conversationId.trim().length === 0
	) {
		throw new TypeError(
			`Checkout process fact ${event.type} requires metadata.conversationId`,
		);
	}
	const traceparent = optionalStringMetadata(event, "traceparent");
	const tracestate = optionalStringMetadata(event, "tracestate");
	return {
		...(event.metadata?.correlationId === undefined
			? {}
			: { correlationId: event.metadata.correlationId }),
		conversationId,
		...(traceparent === undefined ? {} : { traceparent }),
		...(tracestate === undefined ? {} : { tracestate }),
	};
}

function optionalStringMetadata(
	event: EventSourcedCheckoutSagaEvent,
	field: "traceparent" | "tracestate",
): string | undefined {
	const value = event.metadata?.[field];
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		throw new TypeError(
			`Checkout process fact ${event.type} metadata.${field} must be a string`,
		);
	}
	return value;
}

function assertNever(value: never): never {
	throw new TypeError(`Unsupported checkout process fact: ${String(value)}`);
}
