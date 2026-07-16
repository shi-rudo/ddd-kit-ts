import { ok } from "@shirudo/result";
import { describe, expect, it } from "vite-plus/test";
import type { IAggregateRoot } from "../../src/aggregate/aggregate-root";
import type { Command, CommandHandler } from "../../src/app/command";
import { CommandBus } from "../../src/app/command-bus";
import { withCommit } from "../../src/app/handler";
import { AggregateNotFoundError } from "../../src/core/errors";
import type { Id } from "../../src/core/id";
import { InvalidDomainTransitionError } from "../../src/domain-state-machine/domain-state-machine";
import { EventBusImpl } from "../../src/events/event-bus";
import { outboxWriterAcceptingEventLoss } from "../../src/events/outbox";
import type { EventBus, OutboxWriter } from "../../src/events/ports";
import { type Money, moneyOfMinor } from "../../src/money";
import type { IRepository } from "../../src/repo/repository";
import type { TransactionScope } from "../../src/repo/scope";

import { CheckoutSaga } from "./checkout-saga";
import { Order, type OrderEvent, type OrderId } from "./order";
import { Payment, type PaymentEvent, type PaymentId } from "./payment";
import { Shipment, type ShipmentId, type ShippingEvent } from "./shipping";

// ----------------------------------------------------------------------------
// Tiny test helpers
// ----------------------------------------------------------------------------

function inMemoryRepo<TAgg extends IAggregateRoot<TId>, TId extends Id<string>>(
	name: string,
): IRepository<TAgg, TId> {
	const store = new Map<TId, TAgg>();
	return {
		async findById(id) {
			return store.get(id) ?? null;
		},
		async getById(id) {
			const a = store.get(id);
			if (!a) throw new AggregateNotFoundError({ aggregateType: name, id });
			return a;
		},
		async exists(id) {
			return store.has(id);
		},
		async save(agg) {
			store.set(agg.id, agg);
		},
		async delete(aggregate) {
			store.delete(aggregate.id);
		},
	};
}

const eur = (minor: bigint): Money => moneyOfMinor(minor, "EUR", 2);

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
	total: Money;
};
type RequestPaymentCommand = Command & {
	type: "RequestPayment";
	orderId: OrderId;
	paymentId: PaymentId;
	amount: Money;
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
	outbox: OutboxWriter<AppEvent>;
	scope: TransactionScope<undefined>;
	orderRepository: IRepository<Order, OrderId>;
	paymentRepository: IRepository<Payment, PaymentId>;
	shipmentRepository: IRepository<Shipment, ShipmentId>;
	sagaRepository: IRepository<CheckoutSaga, OrderId>;
}

function registerCommandHandlers(deps: AppDeps): void {
	const { commandBus, eventBus, outbox, scope } = deps;

	const placeOrder: CommandHandler<PlaceOrderCommand, OrderId> = async (cmd) =>
		withCommit({ outbox, bus: eventBus, scope }, async (_tx, enrollment) => {
			const order = Order.place(cmd.orderId, cmd.customerId, cmd.total);
			await deps.orderRepository.save(order);
			return {
				result: ok(order.id),
				commits: [enrollment.enrollSaved(order)],
			};
		});

	const requestPayment: CommandHandler<
		RequestPaymentCommand,
		PaymentId
	> = async (cmd) =>
		withCommit({ outbox, bus: eventBus, scope }, async (_tx, enrollment) => {
			const payment = Payment.request(cmd.paymentId, cmd.orderId, cmd.amount);
			await deps.paymentRepository.save(payment);
			return {
				result: ok(payment.id),
				commits: [enrollment.enrollSaved(payment)],
			};
		});

	const requestShipping: CommandHandler<
		RequestShippingCommand,
		ShipmentId
	> = async (cmd) =>
		withCommit({ outbox, bus: eventBus, scope }, async (_tx, enrollment) => {
			const shipment = Shipment.request(cmd.shipmentId, cmd.orderId);
			await deps.shipmentRepository.save(shipment);
			return {
				result: ok(shipment.id),
				commits: [enrollment.enrollSaved(shipment)],
			};
		});

	const confirmOrder: CommandHandler<ConfirmOrderCommand, void> = async (cmd) =>
		withCommit({ outbox, bus: eventBus, scope }, async (_tx, enrollment) => {
			const order = await deps.orderRepository.getById(cmd.orderId);
			order.confirm();
			await deps.orderRepository.save(order);
			return {
				result: ok(undefined as void),
				commits: [enrollment.enrollSaved(order)],
			};
		});

	const cancelOrder: CommandHandler<CancelOrderCommand, void> = async (cmd) =>
		withCommit({ outbox, bus: eventBus, scope }, async (_tx, enrollment) => {
			const order = await deps.orderRepository.getById(cmd.orderId);
			order.cancel(cmd.reason);
			await deps.orderRepository.save(order);
			return {
				result: ok(undefined as void),
				commits: [enrollment.enrollSaved(order)],
			};
		});

	const refundPayment: CommandHandler<RefundPaymentCommand, void> = async (
		cmd,
	) =>
		withCommit({ outbox, bus: eventBus, scope }, async (_tx, enrollment) => {
			const payment = await deps.paymentRepository.getById(cmd.paymentId);
			payment.refund();
			await deps.paymentRepository.save(payment);
			return {
				result: ok(undefined as void),
				commits: [enrollment.enrollSaved(payment)],
			};
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
 * In production the trigger is durable: withCommit writes a real
 * outbox, an OutboxDispatcher with eventBusSink delivers from it, and
 * each reaction runs under withIdempotentCommit so redelivery cannot
 * double-fire a step. The subscriber logic stays identical; the sagas
 * guide (docs/guide/sagas.md) shows that wiring end to end.
 */
function wireSaga(
	deps: AppDeps,
	paymentIdGen: () => PaymentId,
	shipmentIdGen: () => ShipmentId,
): void {
	const { eventBus, commandBus, sagaRepository } = deps;

	eventBus.subscribe("OrderPlaced", async (event) => {
		const orderId = (event.aggregateId as OrderId) ?? null;
		if (!orderId) return;
		const saga = CheckoutSaga.start(orderId, event.payload.total);
		await sagaRepository.save(saga);
		await commandBus.execute({
			type: "RequestPayment",
			orderId,
			paymentId: paymentIdGen(),
			amount: event.payload.total,
		});
	});

	eventBus.subscribe("PaymentRequested", async (event) => {
		const saga = await sagaRepository.getById(event.payload.orderId);
		saga.recordPaymentRequested(event.aggregateId as PaymentId);
		await sagaRepository.save(saga);
	});

	eventBus.subscribe("PaymentReceived", async (event) => {
		const saga = await sagaRepository.getById(event.payload.orderId);
		saga.advanceToShipping();
		await sagaRepository.save(saga);
		await commandBus.execute({
			type: "RequestShipping",
			orderId: event.payload.orderId,
			shipmentId: shipmentIdGen(),
		});
	});

	eventBus.subscribe("PaymentFailed", async (event) => {
		const saga = await sagaRepository.getById(event.payload.orderId);
		saga.cancelOnPaymentFailure();
		await sagaRepository.save(saga);
		await commandBus.execute({
			type: "CancelOrder",
			orderId: event.payload.orderId,
			reason: `payment-failed: ${event.payload.reason}`,
		});
	});

	eventBus.subscribe("ShippingRequested", async (event) => {
		const saga = await sagaRepository.getById(event.payload.orderId);
		saga.recordShippingRequested(event.aggregateId as ShipmentId);
		await sagaRepository.save(saga);
	});

	eventBus.subscribe("ShippingCompleted", async (event) => {
		const saga = await sagaRepository.getById(event.payload.orderId);
		saga.complete();
		await sagaRepository.save(saga);
		await commandBus.execute({
			type: "ConfirmOrder",
			orderId: event.payload.orderId,
		});
	});

	eventBus.subscribe("ShippingFailed", async (event) => {
		const saga = await sagaRepository.getById(event.payload.orderId);
		saga.cancelOnShippingFailure();
		await sagaRepository.save(saga);
		// Compensating sequence: refund payment first, then cancel order.
		if (saga.paymentId) {
			await commandBus.execute({
				type: "RefundPayment",
				paymentId: saga.paymentId,
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
	await withCommit(
		{ outbox, bus: eventBus, scope },
		async (_tx, enrollment) => {
			const payment = await paymentRepository.getById(paymentId);
			if (outcome.kind === "received") payment.receive();
			else payment.fail(outcome.reason);
			await paymentRepository.save(payment);
			return {
				result: ok(undefined as void),
				commits: [enrollment.enrollSaved(payment)],
			};
		},
	);
}

async function simulateShippingResult(
	deps: AppDeps,
	shipmentId: ShipmentId,
	outcome:
		| { kind: "completed"; trackingId: string }
		| { kind: "failed"; reason: string },
): Promise<void> {
	const { outbox, eventBus, scope, shipmentRepository } = deps;
	await withCommit(
		{ outbox, bus: eventBus, scope },
		async (_tx, enrollment) => {
			const shipment = await shipmentRepository.getById(shipmentId);
			if (outcome.kind === "completed") shipment.complete(outcome.trackingId);
			else shipment.fail(outcome.reason);
			await shipmentRepository.save(shipment);
			return {
				result: ok(undefined as void),
				commits: [enrollment.enrollSaved(shipment)],
			};
		},
	);
}

// ----------------------------------------------------------------------------
// Bootstrap a fresh world for each test
// ----------------------------------------------------------------------------

function bootstrap() {
	let nextPaymentSeq = 1;
	let nextShipmentSeq = 1;
	const paymentIdGen = (): PaymentId => `pay-${nextPaymentSeq++}` as PaymentId;
	const shipmentIdGen = (): ShipmentId =>
		`ship-${nextShipmentSeq++}` as ShipmentId;

	const deps: AppDeps = {
		commandBus: new CommandBus<AppCommands>(),
		eventBus: new EventBusImpl<AppEvent>(),
		// Demo wiring: events reach the saga over the bus fast path only,
		// so the outbox slot gets the explicit event-loss writer instead of
		// an InMemoryOutbox nobody drains (that dummy would grow unbounded;
		// its own docs say so). The durable wiring, outbox drained by an
		// OutboxDispatcher into eventBusSink, is what the sagas guide shows.
		outbox: outboxWriterAcceptingEventLoss<AppEvent>(),
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
	it("enforces its lifecycle through the domain state machine", () => {
		const saga = CheckoutSaga.start("ord-invalid" as OrderId, eur(1000n));

		expect(() => saga.complete()).toThrow(InvalidDomainTransitionError);
	});

	it("happy path: order → payment → shipping → confirmed", async () => {
		const { deps } = bootstrap();
		const orderId = "ord-1" as OrderId;

		// 1. User places the order
		const placed = await deps.commandBus.execute({
			type: "PlaceOrder",
			orderId,
			customerId: "cust-42",
			total: eur(9999n),
		});
		expect(placed.isOk()).toBe(true);

		// At this point the saga has dispatched RequestPayment and the
		// Payment aggregate has been created with status "requested".
		const saga = await deps.sagaRepository.getById(orderId);
		expect(saga.step).toBe("awaiting-payment");
		const paymentId = saga.paymentId!;
		expect(paymentId).toBeDefined();

		const payment = await deps.paymentRepository.getById(paymentId);
		expect(payment.status).toBe("requested");

		// 2. Payment gateway calls back successfully
		await simulatePaymentResult(deps, paymentId, { kind: "received" });

		// Saga transitions to awaiting-shipping; RequestShipping dispatched.
		const sagaAfterPayment = await deps.sagaRepository.getById(orderId);
		expect(sagaAfterPayment.step).toBe("awaiting-shipping");
		const shipmentId = sagaAfterPayment.shipmentId!;
		expect(shipmentId).toBeDefined();

		const shipment = await deps.shipmentRepository.getById(shipmentId);
		expect(shipment.status).toBe("requested");

		// 3. Shipping carrier reports completion
		await simulateShippingResult(deps, shipmentId, {
			kind: "completed",
			trackingId: "TRACK-001",
		});

		// Final state: saga completed, order confirmed.
		const finalSaga = await deps.sagaRepository.getById(orderId);
		expect(finalSaga.step).toBe("completed");

		const finalOrder = await deps.orderRepository.getById(orderId);
		expect(finalOrder.status).toBe("confirmed");

		const finalShipment = await deps.shipmentRepository.getById(shipmentId);
		expect(finalShipment.status).toBe("shipped");
		expect(finalShipment.trackingId).toBe("TRACK-001");
	});

	it("payment failure compensates: order is cancelled, no shipment created", async () => {
		const { deps } = bootstrap();
		const orderId = "ord-2" as OrderId;

		await deps.commandBus.execute({
			type: "PlaceOrder",
			orderId,
			customerId: "cust-42",
			total: eur(5000n),
		});

		const saga = await deps.sagaRepository.getById(orderId);
		const paymentId = saga.paymentId!;

		// Payment gateway rejects the charge
		await simulatePaymentResult(deps, paymentId, {
			kind: "failed",
			reason: "insufficient-funds",
		});

		// Compensation: saga cancelled, order cancelled, no shipment touched.
		const finalSaga = await deps.sagaRepository.getById(orderId);
		expect(finalSaga.step).toBe("cancelled-payment-failed");
		expect(finalSaga.shipmentId).toBeUndefined();

		const finalOrder = await deps.orderRepository.getById(orderId);
		expect(finalOrder.status).toBe("cancelled");
		expect(finalOrder.cancelReason).toContain("payment-failed");
		expect(finalOrder.cancelReason).toContain("insufficient-funds");

		const finalPayment = await deps.paymentRepository.getById(paymentId);
		expect(finalPayment.status).toBe("failed");
	});

	it("shipping failure compensates: payment refunded, order cancelled", async () => {
		const { deps } = bootstrap();
		const orderId = "ord-3" as OrderId;

		await deps.commandBus.execute({
			type: "PlaceOrder",
			orderId,
			customerId: "cust-42",
			total: eur(7500n),
		});

		const sagaAfterPlace = await deps.sagaRepository.getById(orderId);
		const paymentId = sagaAfterPlace.paymentId!;

		// Payment succeeds
		await simulatePaymentResult(deps, paymentId, { kind: "received" });

		const sagaAfterPayment = await deps.sagaRepository.getById(orderId);
		const shipmentId = sagaAfterPayment.shipmentId!;

		// Shipping carrier reports failure (warehouse on fire, etc.)
		await simulateShippingResult(deps, shipmentId, {
			kind: "failed",
			reason: "warehouse-unavailable",
		});

		// Compensation sequence: payment refunded, then order cancelled.
		const finalSaga = await deps.sagaRepository.getById(orderId);
		expect(finalSaga.step).toBe("cancelled-shipping-failed");

		const finalPayment = await deps.paymentRepository.getById(paymentId);
		expect(finalPayment.status).toBe("refunded");

		const finalOrder = await deps.orderRepository.getById(orderId);
		expect(finalOrder.status).toBe("cancelled");
		expect(finalOrder.cancelReason).toContain("shipping-failed");
		expect(finalOrder.cancelReason).toContain("warehouse-unavailable");

		const finalShipment = await deps.shipmentRepository.getById(shipmentId);
		expect(finalShipment.status).toBe("failed");
	});
});
