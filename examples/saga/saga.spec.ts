import { describe, expect, it } from "vitest";
import type { IAggregateRoot } from "../../src/aggregate/aggregate-root";
import { CommandBus } from "../../src/app/command-bus";
import type { Command, CommandHandler } from "../../src/app/command";
import { withCommit } from "../../src/app/handler";
import { AggregateNotFoundError } from "../../src/core/errors";
import type { Id } from "../../src/core/id";
import { EventBusImpl } from "../../src/events/event-bus";
import { InMemoryOutbox } from "../../src/events/outbox";
import type { EventBus, Outbox } from "../../src/events/ports";
import type { IRepository } from "../../src/repo/repository";
import type { TransactionScope } from "../../src/repo/scope";
import { err, ok, type Result } from "@shirudo/result";

import { Order, type OrderEvent, type OrderId } from "./order";
import {
	Payment,
	type PaymentEvent,
	type PaymentId,
} from "./payment";
import {
	Shipment,
	type ShipmentId,
	type ShippingEvent,
} from "./shipping";
import { CheckoutSaga } from "./checkout-saga";

// ----------------------------------------------------------------------------
// Tiny test helpers
// ----------------------------------------------------------------------------

function inMemoryRepo<
	TAgg extends IAggregateRoot<TId>,
	TId extends Id<string>,
>(name: string): IRepository<TAgg, TId> {
	const store = new Map<TId, TAgg>();
	return {
		async getById(id) {
			return store.get(id) ?? null;
		},
		async getByIdOrFail(id) {
			const a = store.get(id);
			if (!a) throw new AggregateNotFoundError(name, id);
			return a;
		},
		async exists(id) {
			return store.has(id);
		},
		async save(agg) {
			store.set(agg.id, agg);
		},
		async delete(id) {
			store.delete(id);
		},
	};
}

const noTxScope: TransactionScope<undefined> = {
	transactional: (fn) => fn(undefined),
};

// ----------------------------------------------------------------------------
// App-level types
// ----------------------------------------------------------------------------

type AppEvent = OrderEvent | PaymentEvent | ShippingEvent;

type PlaceOrderCommand = Command & {
	type: "PlaceOrder";
	orderId: OrderId;
	customerId: string;
	totalCents: number;
};
type RequestPaymentCommand = Command & {
	type: "RequestPayment";
	orderId: OrderId;
	paymentId: PaymentId;
	amountCents: number;
};
type RequestShippingCommand = Command & {
	type: "RequestShipping";
	orderId: OrderId;
	shipmentId: ShipmentId;
};
type ConfirmOrderCommand = Command & { type: "ConfirmOrder"; orderId: OrderId };
type CancelOrderCommand = Command & {
	type: "CancelOrder";
	orderId: OrderId;
	reason: string;
};
type RefundPaymentCommand = Command & {
	type: "RefundPayment";
	paymentId: PaymentId;
};

type AppCommands = {
	PlaceOrder: OrderId;
	RequestPayment: PaymentId;
	RequestShipping: ShipmentId;
	ConfirmOrder: void;
	CancelOrder: void;
	RefundPayment: void;
};

// ----------------------------------------------------------------------------
// Wiring: takes the buses + repos and registers handlers + saga subscribers
// ----------------------------------------------------------------------------

interface AppDeps {
	commandBus: CommandBus<AppCommands>;
	eventBus: EventBus<AppEvent>;
	outbox: Outbox<AppEvent>;
	scope: TransactionScope<undefined>;
	orderRepository: IRepository<Order, OrderId>;
	paymentRepository: IRepository<Payment, PaymentId>;
	shipmentRepository: IRepository<Shipment, ShipmentId>;
	sagaRepository: IRepository<CheckoutSaga, OrderId>;
}

function registerCommandHandlers(deps: AppDeps): void {
	const { commandBus, eventBus, outbox, scope } = deps;

	const placeOrder: CommandHandler<PlaceOrderCommand, OrderId> = async (cmd) =>
		withCommit({ outbox, bus: eventBus, scope }, async () => {
			const order = Order.place(cmd.orderId, cmd.customerId, cmd.totalCents);
			await deps.orderRepository.save(order);
			return { result: ok(order.id), aggregates: [order] };
		});

	const requestPayment: CommandHandler<RequestPaymentCommand, PaymentId> =
		async (cmd) =>
			withCommit({ outbox, bus: eventBus, scope }, async () => {
				const payment = Payment.request(
					cmd.paymentId,
					cmd.orderId,
					cmd.amountCents,
				);
				await deps.paymentRepository.save(payment);
				return { result: ok(payment.id), aggregates: [payment] };
			});

	const requestShipping: CommandHandler<RequestShippingCommand, ShipmentId> =
		async (cmd) =>
			withCommit({ outbox, bus: eventBus, scope }, async () => {
				const shipment = Shipment.request(cmd.shipmentId, cmd.orderId);
				await deps.shipmentRepository.save(shipment);
				return { result: ok(shipment.id), aggregates: [shipment] };
			});

	const confirmOrder: CommandHandler<ConfirmOrderCommand, void> = async (
		cmd,
	) =>
		withCommit({ outbox, bus: eventBus, scope }, async () => {
			const order = await deps.orderRepository.getByIdOrFail(cmd.orderId);
			order.confirm();
			await deps.orderRepository.save(order);
			return { result: ok(undefined as void), aggregates: [order] };
		});

	const cancelOrder: CommandHandler<CancelOrderCommand, void> = async (cmd) =>
		withCommit({ outbox, bus: eventBus, scope }, async () => {
			const order = await deps.orderRepository.getByIdOrFail(cmd.orderId);
			order.cancel(cmd.reason);
			await deps.orderRepository.save(order);
			return { result: ok(undefined as void), aggregates: [order] };
		});

	const refundPayment: CommandHandler<RefundPaymentCommand, void> = async (
		cmd,
	) =>
		withCommit({ outbox, bus: eventBus, scope }, async () => {
			const payment = await deps.paymentRepository.getByIdOrFail(cmd.paymentId);
			payment.refund();
			await deps.paymentRepository.save(payment);
			return { result: ok(undefined as void), aggregates: [payment] };
		});

	commandBus.register("PlaceOrder", placeOrder);
	commandBus.register("RequestPayment", requestPayment);
	commandBus.register("RequestShipping", requestShipping);
	commandBus.register("ConfirmOrder", confirmOrder);
	commandBus.register("CancelOrder", cancelOrder);
	commandBus.register("RefundPayment", refundPayment);
}

/**
 * Wires the CheckoutSaga as a set of EventBus subscribers.
 *
 * Each subscriber: load saga state, transition, save, then dispatch
 * the next command (if any). Failure-path subscribers compensate by
 * dispatching CancelOrder + RefundPayment as needed.
 *
 * In production: replace EventBus.subscribe with a durable outbox
 * dispatcher reading from the outbox table. The choreography logic
 * stays identical; only the trigger mechanism changes.
 */
function wireSaga(deps: AppDeps, paymentIdGen: () => PaymentId, shipmentIdGen: () => ShipmentId): void {
	const { eventBus, commandBus, sagaRepository } = deps;

	eventBus.subscribe("OrderPlaced", async (event) => {
		const orderId = (event.aggregateId as OrderId) ?? null;
		if (!orderId) return;
		const saga = CheckoutSaga.start(orderId, event.payload.totalCents);
		await sagaRepository.save(saga);
		await commandBus.execute({
			type: "RequestPayment",
			orderId,
			paymentId: paymentIdGen(),
			amountCents: event.payload.totalCents,
		});
	});

	eventBus.subscribe("PaymentRequested", async (event) => {
		const saga = await sagaRepository.getByIdOrFail(event.payload.orderId);
		saga.recordPaymentRequested(event.aggregateId as PaymentId);
		await sagaRepository.save(saga);
	});

	eventBus.subscribe("PaymentReceived", async (event) => {
		const saga = await sagaRepository.getByIdOrFail(event.payload.orderId);
		saga.advanceToShipping();
		await sagaRepository.save(saga);
		await commandBus.execute({
			type: "RequestShipping",
			orderId: event.payload.orderId,
			shipmentId: shipmentIdGen(),
		});
	});

	eventBus.subscribe("PaymentFailed", async (event) => {
		const saga = await sagaRepository.getByIdOrFail(event.payload.orderId);
		saga.cancelOnPaymentFailure();
		await sagaRepository.save(saga);
		await commandBus.execute({
			type: "CancelOrder",
			orderId: event.payload.orderId,
			reason: `payment-failed: ${event.payload.reason}`,
		});
	});

	eventBus.subscribe("ShippingRequested", async (event) => {
		const saga = await sagaRepository.getByIdOrFail(event.payload.orderId);
		saga.recordShippingRequested(event.aggregateId as ShipmentId);
		await sagaRepository.save(saga);
	});

	eventBus.subscribe("ShippingCompleted", async (event) => {
		const saga = await sagaRepository.getByIdOrFail(event.payload.orderId);
		saga.complete();
		await sagaRepository.save(saga);
		await commandBus.execute({
			type: "ConfirmOrder",
			orderId: event.payload.orderId,
		});
	});

	eventBus.subscribe("ShippingFailed", async (event) => {
		const saga = await sagaRepository.getByIdOrFail(event.payload.orderId);
		saga.cancelOnShippingFailure();
		await sagaRepository.save(saga);
		// Compensating sequence: refund payment first, then cancel order.
		if (saga.state.paymentId) {
			await commandBus.execute({
				type: "RefundPayment",
				paymentId: saga.state.paymentId,
			});
		}
		await commandBus.execute({
			type: "CancelOrder",
			orderId: event.payload.orderId,
			reason: `shipping-failed: ${event.payload.reason}`,
		});
	});
}

// ----------------------------------------------------------------------------
// External-system simulators (would be real gateway webhooks in production)
// ----------------------------------------------------------------------------

async function simulatePaymentResult(
	deps: AppDeps,
	paymentId: PaymentId,
	outcome: { kind: "received" } | { kind: "failed"; reason: string },
): Promise<void> {
	const { outbox, eventBus, scope, paymentRepository } = deps;
	await withCommit({ outbox, bus: eventBus, scope }, async () => {
		const payment = await paymentRepository.getByIdOrFail(paymentId);
		if (outcome.kind === "received") payment.receive();
		else payment.fail(outcome.reason);
		await paymentRepository.save(payment);
		return { result: ok(undefined as void), aggregates: [payment] };
	});
}

async function simulateShippingResult(
	deps: AppDeps,
	shipmentId: ShipmentId,
	outcome:
		| { kind: "completed"; trackingId: string }
		| { kind: "failed"; reason: string },
): Promise<void> {
	const { outbox, eventBus, scope, shipmentRepository } = deps;
	await withCommit({ outbox, bus: eventBus, scope }, async () => {
		const shipment = await shipmentRepository.getByIdOrFail(shipmentId);
		if (outcome.kind === "completed") shipment.complete(outcome.trackingId);
		else shipment.fail(outcome.reason);
		await shipmentRepository.save(shipment);
		return { result: ok(undefined as void), aggregates: [shipment] };
	});
}

// ----------------------------------------------------------------------------
// Bootstrap a fresh world for each test
// ----------------------------------------------------------------------------

function bootstrap() {
	let nextPaymentSeq = 1;
	let nextShipmentSeq = 1;
	const paymentIdGen = (): PaymentId =>
		`pay-${nextPaymentSeq++}` as PaymentId;
	const shipmentIdGen = (): ShipmentId =>
		`ship-${nextShipmentSeq++}` as ShipmentId;

	const deps: AppDeps = {
		commandBus: new CommandBus<AppCommands>(),
		eventBus: new EventBusImpl<AppEvent>(),
		outbox: new InMemoryOutbox<AppEvent>(),
		scope: noTxScope,
		orderRepository: inMemoryRepo<Order, OrderId>("Order"),
		paymentRepository: inMemoryRepo<Payment, PaymentId>("Payment"),
		shipmentRepository: inMemoryRepo<Shipment, ShipmentId>("Shipment"),
		sagaRepository: inMemoryRepo<CheckoutSaga, OrderId>("CheckoutSaga"),
	};

	registerCommandHandlers(deps);
	wireSaga(deps, paymentIdGen, shipmentIdGen);

	return { deps, paymentIdGen, shipmentIdGen };
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe("Checkout saga (Process Manager)", () => {
	it("happy path: order → payment → shipping → confirmed", async () => {
		const { deps } = bootstrap();
		const orderId = "ord-1" as OrderId;

		// 1. User places the order
		const placed = await deps.commandBus.execute({
			type: "PlaceOrder",
			orderId,
			customerId: "cust-42",
			totalCents: 9999,
		});
		expect(placed.isOk()).toBe(true);

		// At this point the saga has dispatched RequestPayment and the
		// Payment aggregate has been created with status "requested".
		const saga = await deps.sagaRepository.getByIdOrFail(orderId);
		expect(saga.state.step).toBe("awaiting-payment");
		const paymentId = saga.state.paymentId!;
		expect(paymentId).toBeDefined();

		const payment = await deps.paymentRepository.getByIdOrFail(paymentId);
		expect(payment.state.status).toBe("requested");

		// 2. Payment gateway calls back successfully
		await simulatePaymentResult(deps, paymentId, { kind: "received" });

		// Saga transitions to awaiting-shipping; RequestShipping dispatched.
		const sagaAfterPayment = await deps.sagaRepository.getByIdOrFail(orderId);
		expect(sagaAfterPayment.state.step).toBe("awaiting-shipping");
		const shipmentId = sagaAfterPayment.state.shipmentId!;
		expect(shipmentId).toBeDefined();

		const shipment = await deps.shipmentRepository.getByIdOrFail(shipmentId);
		expect(shipment.state.status).toBe("requested");

		// 3. Shipping carrier reports completion
		await simulateShippingResult(deps, shipmentId, {
			kind: "completed",
			trackingId: "TRACK-001",
		});

		// Final state: saga completed, order confirmed.
		const finalSaga = await deps.sagaRepository.getByIdOrFail(orderId);
		expect(finalSaga.state.step).toBe("completed");

		const finalOrder = await deps.orderRepository.getByIdOrFail(orderId);
		expect(finalOrder.state.status).toBe("confirmed");

		const finalShipment =
			await deps.shipmentRepository.getByIdOrFail(shipmentId);
		expect(finalShipment.state.status).toBe("shipped");
		expect(finalShipment.state.trackingId).toBe("TRACK-001");
	});

	it("payment failure compensates: order is cancelled, no shipment created", async () => {
		const { deps } = bootstrap();
		const orderId = "ord-2" as OrderId;

		await deps.commandBus.execute({
			type: "PlaceOrder",
			orderId,
			customerId: "cust-42",
			totalCents: 5000,
		});

		const saga = await deps.sagaRepository.getByIdOrFail(orderId);
		const paymentId = saga.state.paymentId!;

		// Payment gateway rejects the charge
		await simulatePaymentResult(deps, paymentId, {
			kind: "failed",
			reason: "insufficient-funds",
		});

		// Compensation: saga cancelled, order cancelled, no shipment touched.
		const finalSaga = await deps.sagaRepository.getByIdOrFail(orderId);
		expect(finalSaga.state.step).toBe("cancelled-payment-failed");
		expect(finalSaga.state.shipmentId).toBeUndefined();

		const finalOrder = await deps.orderRepository.getByIdOrFail(orderId);
		expect(finalOrder.state.status).toBe("cancelled");
		expect(finalOrder.state.cancelReason).toContain("payment-failed");
		expect(finalOrder.state.cancelReason).toContain("insufficient-funds");

		const finalPayment = await deps.paymentRepository.getByIdOrFail(paymentId);
		expect(finalPayment.state.status).toBe("failed");
	});

	it("shipping failure compensates: payment refunded, order cancelled", async () => {
		const { deps } = bootstrap();
		const orderId = "ord-3" as OrderId;

		await deps.commandBus.execute({
			type: "PlaceOrder",
			orderId,
			customerId: "cust-42",
			totalCents: 7500,
		});

		const sagaAfterPlace = await deps.sagaRepository.getByIdOrFail(orderId);
		const paymentId = sagaAfterPlace.state.paymentId!;

		// Payment succeeds
		await simulatePaymentResult(deps, paymentId, { kind: "received" });

		const sagaAfterPayment = await deps.sagaRepository.getByIdOrFail(orderId);
		const shipmentId = sagaAfterPayment.state.shipmentId!;

		// Shipping carrier reports failure (warehouse on fire, etc.)
		await simulateShippingResult(deps, shipmentId, {
			kind: "failed",
			reason: "warehouse-unavailable",
		});

		// Compensation sequence: payment refunded, then order cancelled.
		const finalSaga = await deps.sagaRepository.getByIdOrFail(orderId);
		expect(finalSaga.state.step).toBe("cancelled-shipping-failed");

		const finalPayment = await deps.paymentRepository.getByIdOrFail(paymentId);
		expect(finalPayment.state.status).toBe("refunded");

		const finalOrder = await deps.orderRepository.getByIdOrFail(orderId);
		expect(finalOrder.state.status).toBe("cancelled");
		expect(finalOrder.state.cancelReason).toContain("shipping-failed");
		expect(finalOrder.state.cancelReason).toContain("warehouse-unavailable");

		const finalShipment =
			await deps.shipmentRepository.getByIdOrFail(shipmentId);
		expect(finalShipment.state.status).toBe("failed");
	});
});
