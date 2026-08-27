import { describe, expect, it } from "vite-plus/test";
import {
	type CommandOutboxCommitCandidate,
	type CommandOutboxWriter,
	routeEventsToCommandOutbox,
} from "../../src/application/cqrs/command/command-outbox";
import { withCommit } from "../../src/application/cqrs/handler";
import { InMemoryIdempotencyStore } from "../../src/application/idempotency/adapters/in-memory-idempotency-store";
import { withIdempotentCommit } from "../../src/application/idempotency/idempotency";
import { recordPendingEvents } from "../../src/application/unit-of-work/record-pending-events";
import {
	createDomainEvent,
	createDomainEventFactory,
	type DomainEventFactory,
} from "../../src/domain/event/domain-event";
import { moneyOfMinor } from "../../src/domain/value-object/money";
import { outboxWriterAcceptingEventLoss } from "../../src/messaging/outbox/outbox";
import type { TransactionScope } from "../../src/persistence/repository/scope";
import {
	type CheckoutParticipantCommand,
	checkoutCommandsFromProcessFact,
} from "./checkout-participant-commands";
import {
	CheckoutProcessInWrongStateError,
	EventSourcedCheckoutSaga,
	type EventSourcedCheckoutSagaEvent,
} from "./event-sourced-checkout-saga";
import type { OrderId } from "./order";
import type { PaymentId } from "./payment";
import type { ShipmentId } from "./shipping";

const orderId = "ord-es-1" as OrderId;
const paymentId = "pay-es-1" as PaymentId;
const shipmentId = "ship-es-1" as ShipmentId;
const total = moneyOfMinor(4_200n, "EUR", 2);
let eventSequence = 0;
const eventRecorder = createDomainEventFactory({
	eventIdFactory: () => `event-${++eventSequence}`,
	clock: () => new Date("2027-04-05T06:07:08.000Z"),
});

interface ProcessDatabase {
	readonly history: Array<EventSourcedCheckoutSagaEvent>;
	readonly commandCommits: Array<
		CommandOutboxCommitCandidate<CheckoutParticipantCommand>
	>;
}

function processDatabase() {
	let committed: ProcessDatabase = { history: [], commandCommits: [] };
	let active: ProcessDatabase | undefined;
	let rejectCommandWrite = false;
	const current = (): ProcessDatabase => {
		if (!active) throw new Error("write attempted outside transaction");
		return active;
	};
	const scope: TransactionScope<undefined> = {
		transactional: async (work) => {
			active = {
				history: [...committed.history],
				commandCommits: [...committed.commandCommits],
			};
			try {
				const result = await work(undefined);
				committed = active;
				return result;
			} finally {
				active = undefined;
			}
		},
	};
	const commandOutbox: CommandOutboxWriter<CheckoutParticipantCommand> = {
		add: async (commits) => {
			if (rejectCommandWrite) throw new Error("command outbox unavailable");
			current().commandCommits.push(...commits);
		},
	};

	return {
		scope,
		commandOutbox,
		append: async (events: ReadonlyArray<EventSourcedCheckoutSagaEvent>) => {
			current().history.push(...events);
		},
		snapshot: (): ProcessDatabase => committed,
		rejectCommandWrites: (reject: boolean) => {
			rejectCommandWrite = reject;
		},
	};
}

async function commitProcessDecision(
	database: ReturnType<typeof processDatabase>,
	saga: EventSourcedCheckoutSaga,
	domainEvents: Pick<DomainEventFactory, "createStamp">,
	trigger: {
		readonly messageId: string;
		readonly correlationId: string;
		readonly conversationId: string;
		readonly traceparent?: string;
		readonly tracestate?: string;
	},
): Promise<void> {
	await withCommit(
		{
			scope: database.scope,
			outbox: routeEventsToCommandOutbox(
				database.commandOutbox,
				checkoutCommandsFromProcessFact,
			),
		},
		async (_ctx, enrollment) => {
			const recorded = recordPendingEvents(saga, () =>
				domainEvents.createStamp({
					metadata: {
						correlationId: trigger.correlationId,
						conversationId: trigger.conversationId,
						causationId: trigger.messageId,
						...(trigger.traceparent === undefined
							? {}
							: { traceparent: trigger.traceparent }),
						...(trigger.tracestate === undefined
							? {}
							: { tracestate: trigger.tracestate }),
					},
				}),
			);
			await database.append(recorded);
			return {
				result: undefined,
				commits: [enrollment.enrollSaved(saga)],
			};
		},
	);
}

const messagesIn = (
	database: ProcessDatabase,
): ReadonlyArray<
	CommandOutboxCommitCandidate<CheckoutParticipantCommand>["messages"][number]
> => database.commandCommits.flatMap((commit) => commit.messages);

function firstMessageIn(
	database: ProcessDatabase,
): CommandOutboxCommitCandidate<CheckoutParticipantCommand>["messages"][number] {
	const message = messagesIn(database)[0];
	if (!message) throw new Error("expected one pending participant command");
	return message;
}

describe("Event-sourced checkout saga", () => {
	it("records each process decision as a domain event", () => {
		const saga = EventSourcedCheckoutSaga.start(orderId, total, paymentId);

		expect(saga.step).toBe("awaiting-payment");
		expect(saga.paymentId).toBe(paymentId);
		expect(saga.pendingEvents.map((event) => event.type)).toEqual([
			"CheckoutStartedAwaitingPayment",
		]);
		expect(saga.pendingEvents[0]).toMatchObject({
			aggregateId: orderId,
			aggregateType: "EventSourcedCheckoutSaga",
			payload: { paymentId, total },
		});

		saga.advanceToShipping(shipmentId);
		saga.beginOrderConfirmation();
		saga.complete();

		expect(saga.step).toBe("completed");
		expect(saga.shipmentId).toBe(shipmentId);
		expect(saga.pendingEvents.map((event) => event.type)).toEqual([
			"CheckoutStartedAwaitingPayment",
			"CheckoutAdvancedToShipping",
			"CheckoutOrderConfirmationStarted",
			"CheckoutCompleted",
		]);
	});

	it("records a payment rejection as the start of cancellation", () => {
		const saga = EventSourcedCheckoutSaga.start(orderId, total, paymentId);

		saga.beginCancellationAfterPaymentFailure("insufficient-funds");

		expect(saga.step).toBe("awaiting-cancellation-after-payment-failure");
		expect(saga.pendingEvents.at(-1)).toMatchObject({
			type: "CheckoutCancellationStartedAfterPaymentFailure",
			payload: { reason: "insufficient-funds" },
		});
	});

	it("replays process history without emitting new work", () => {
		const source = EventSourcedCheckoutSaga.start(orderId, total, paymentId);
		source.advanceToShipping(shipmentId);
		source.beginCompensationAfterShippingFailure("warehouse-unavailable");
		const history = recordPendingEvents(source, eventRecorder);

		const restored = EventSourcedCheckoutSaga.reconstitute(orderId);
		const replayed = restored.replayHistory(history);

		expect(replayed.isOk()).toBe(true);
		expect(restored.step).toBe("awaiting-refund-after-shipping-failure");
		expect(restored.paymentId).toBe(paymentId);
		expect(restored.shipmentId).toBe(shipmentId);
		expect(history.at(-1)).toMatchObject({
			type: "CheckoutCompensationStartedAfterShippingFailure",
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

	it("commits private process facts and addressed participant commands atomically", async () => {
		const database = processDatabase();
		const recorder = createDomainEventFactory({
			eventIdFactory: () => "checkout-started-1",
			clock: () => new Date("2027-04-05T06:07:08.000Z"),
		});
		const saga = EventSourcedCheckoutSaga.start(orderId, total, paymentId);

		await commitProcessDecision(database, saga, recorder, {
			messageId: "order-placed-1",
			correlationId: "place-order-1",
			conversationId: "checkout-order-1",
		});

		expect(database.snapshot().history.map((event) => event.type)).toEqual([
			"CheckoutStartedAwaitingPayment",
		]);
		expect(messagesIn(database.snapshot())).toMatchObject([
			{
				messageId: "checkout-started-1:command:0",
				destination: "payments.commands",
				command: {
					type: "RequestPayment",
					version: 1,
					payload: {
						orderId,
						paymentId,
						amount: {
							amountMinor: "4200",
							currency: "EUR",
							scale: 2,
						},
					},
				},
				correlationId: "place-order-1",
				conversationId: "checkout-order-1",
				causationId: "checkout-started-1",
			},
		]);
		expect(saga.pendingEvents).toEqual([]);
	});

	it("rolls back the process stream when the command outbox cannot commit", async () => {
		const database = processDatabase();
		let sequence = 0;
		const recorder = createDomainEventFactory({
			eventIdFactory: () => `process-event-${++sequence}`,
			clock: () => new Date("2027-04-05T06:07:08.000Z"),
		});
		const saga = EventSourcedCheckoutSaga.start(orderId, total, paymentId);
		database.rejectCommandWrites(true);

		await expect(
			commitProcessDecision(database, saga, recorder, {
				messageId: "order-placed-1",
				correlationId: "place-order-1",
				conversationId: "checkout-order-1",
			}),
		).rejects.toThrow("command outbox unavailable");

		// The pending list is typed as the uncommitted union; the failed
		// commit already recorded the decision, so narrow structurally.
		const [retainedEvent] = saga.pendingEvents;
		const retainedEventId =
			retainedEvent !== undefined && "eventId" in retainedEvent
				? retainedEvent.eventId
				: undefined;
		expect(database.snapshot()).toEqual({ history: [], commandCommits: [] });
		expect(retainedEventId).toBe("process-event-1");

		database.rejectCommandWrites(false);
		await commitProcessDecision(database, saga, recorder, {
			messageId: "order-placed-1",
			correlationId: "place-order-1",
			conversationId: "checkout-order-1",
		});

		expect(database.snapshot().history[0]?.eventId).toBe(retainedEventId);
		expect(sequence).toBe(1);
	});

	it("leaves a durable command pending when the process stops after commit", async () => {
		const database = processDatabase();
		const recorder = createDomainEventFactory({
			eventIdFactory: () => "checkout-started-1",
			clock: () => new Date("2027-04-05T06:07:08.000Z"),
		});

		await commitProcessDecision(
			database,
			EventSourcedCheckoutSaga.start(orderId, total, paymentId),
			recorder,
			{
				messageId: "order-placed-1",
				correlationId: "place-order-1",
				conversationId: "checkout-order-1",
			},
		);

		// No dispatcher ran. A new process instance can still observe the
		// committed command, which closes the commit-before-send crash window.
		expect(messagesIn(database.snapshot())).toHaveLength(1);
		expect(messagesIn(database.snapshot())[0]?.command.type).toBe(
			"RequestPayment",
		);
	});

	it("replays process state without recreating committed commands", async () => {
		const database = processDatabase();
		const recorder = createDomainEventFactory({
			eventIdFactory: () => "checkout-started-1",
			clock: () => new Date("2027-04-05T06:07:08.000Z"),
		});
		const source = EventSourcedCheckoutSaga.start(orderId, total, paymentId);
		await commitProcessDecision(database, source, recorder, {
			messageId: "order-placed-1",
			correlationId: "place-order-1",
			conversationId: "checkout-order-1",
		});
		const commandsBeforeReplay = messagesIn(database.snapshot());

		const restored = EventSourcedCheckoutSaga.reconstitute(orderId);
		expect(restored.replayHistory(database.snapshot().history).isOk()).toBe(
			true,
		);

		expect(restored.step).toBe("awaiting-payment");
		expect(restored.pendingEvents).toEqual([]);
		expect(messagesIn(database.snapshot())).toEqual(commandsBeforeReplay);
	});

	it("replays the stored command result when delivery repeats after execution", async () => {
		const database = processDatabase();
		const recorder = createDomainEventFactory({
			eventIdFactory: () => "checkout-started-1",
			clock: () => new Date("2027-04-05T06:07:08.000Z"),
		});
		await commitProcessDecision(
			database,
			EventSourcedCheckoutSaga.start(orderId, total, paymentId),
			recorder,
			{
				messageId: "order-placed-1",
				correlationId: "place-order-1",
				conversationId: "checkout-order-1",
			},
		);
		const message = firstMessageIn(database.snapshot());
		// A payment consumer handles exactly one command type; narrowing the
		// union here types every payload field below.
		const command = message.command;
		if (command.type !== "RequestPayment") {
			throw new Error("expected the RequestPayment participant command");
		}
		const idempotency = new InMemoryIdempotencyStore<undefined>();
		const scope: TransactionScope<undefined> = {
			transactional: (work) => work(undefined),
		};
		let executions = 0;
		const consume = () =>
			withIdempotentCommit(
				{
					scope,
					idempotency,
					outbox: outboxWriterAcceptingEventLoss<never>(),
				},
				{
					key: `payments:${message.messageId}`,
					fingerprint: [
						command.type,
						command.version,
						command.payload.orderId,
						command.payload.paymentId,
						command.payload.amount.amountMinor,
						command.payload.amount.currency,
						command.payload.amount.scale,
					].join(":"),
				},
				async () => {
					executions += 1;
					return {
						result: { paymentId, accepted: true },
						commits: [],
					};
				},
			);

		const first = await consume();
		// The handler committed, but the worker crashed before acknowledging the
		// outbox row, so the same message is delivered once more.
		const redelivered = await consume();

		expect(first).toEqual({
			replayed: false,
			result: { paymentId, accepted: true },
		});
		expect(redelivered).toEqual({
			replayed: true,
			result: first.result,
		});
		expect(executions).toBe(1);
	});

	it("propagates conversation, direct causation, and technical trace context", async () => {
		const database = processDatabase();
		const recorder = createDomainEventFactory({
			eventIdFactory: () => "checkout-started-1",
			clock: () => new Date("2027-04-05T06:07:08.000Z"),
		});
		await commitProcessDecision(
			database,
			EventSourcedCheckoutSaga.start(orderId, total, paymentId),
			recorder,
			{
				messageId: "order-placed-1",
				correlationId: "place-order-1",
				conversationId: "checkout-order-1",
				traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
				tracestate: "vendor=opaque",
			},
		);
		const command = firstMessageIn(database.snapshot());
		const paymentReceived = createDomainEvent(
			"PaymentReceived",
			{ orderId, paymentId },
			{
				eventId: "payment-received-1",
				occurredAt: new Date("2027-04-05T06:08:00.000Z"),
				metadata: {
					conversationId: command.conversationId,
					causationId: command.messageId,
				},
			},
		);

		expect(database.snapshot().history[0]?.metadata).toMatchObject({
			causationId: "order-placed-1",
			conversationId: "checkout-order-1",
		});
		expect(command).toMatchObject({
			causationId: "checkout-started-1",
			conversationId: "checkout-order-1",
			traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
			tracestate: "vendor=opaque",
		});
		expect(paymentReceived.metadata).toMatchObject({
			causationId: "checkout-started-1:command:0",
			conversationId: "checkout-order-1",
		});
	});

	it("rejects a saga command when the process fact has no conversation id", () => {
		const saga = EventSourcedCheckoutSaga.start(orderId, total, paymentId);
		const [event] = recordPendingEvents(saga, () =>
			eventRecorder.createStamp({
				metadata: {
					correlationId: "place-order-1",
					causationId: "order-placed-1",
				},
			}),
		);
		if (!event) throw new Error("expected one recorded process fact");

		expect(() => checkoutCommandsFromProcessFact(event)).toThrow(
			/conversationId/,
		);
	});

	it("waits for the refund result before it requests order cancellation", async () => {
		const database = processDatabase();
		let sequence = 0;
		const recorder = createDomainEventFactory({
			eventIdFactory: () => `process-event-${++sequence}`,
			clock: () => new Date("2027-04-05T06:07:08.000Z"),
		});
		const saga = EventSourcedCheckoutSaga.start(orderId, total, paymentId);
		await commitProcessDecision(database, saga, recorder, {
			messageId: "order-placed-1",
			correlationId: "place-order-1",
			conversationId: "checkout-order-1",
		});
		saga.advanceToShipping(shipmentId);
		await commitProcessDecision(database, saga, recorder, {
			messageId: "payment-received-1",
			correlationId: "receive-payment-1",
			conversationId: "checkout-order-1",
		});
		saga.beginCompensationAfterShippingFailure("warehouse-unavailable");
		await commitProcessDecision(database, saga, recorder, {
			messageId: "shipping-failed-1",
			correlationId: "ship-order-1",
			conversationId: "checkout-order-1",
		});

		expect(saga.step).toBe("awaiting-refund-after-shipping-failure");
		expect(
			database
				.snapshot()
				.commandCommits.at(-1)
				?.messages.map((message) => message.command.type),
		).toEqual(["RefundPayment"]);
		expect(() => saga.confirmOrderCancelled()).toThrow(
			CheckoutProcessInWrongStateError,
		);

		saga.confirmPaymentRefunded();
		await commitProcessDecision(database, saga, recorder, {
			messageId: "payment-refunded-1",
			correlationId: "refund-payment-1",
			conversationId: "checkout-order-1",
		});

		expect(saga.step).toBe("awaiting-cancellation-after-shipping-failure");
		expect(database.snapshot().history.at(-1)).toMatchObject({
			type: "CheckoutPaymentRefundConfirmed",
			payload: { reason: "warehouse-unavailable" },
		});
		expect(
			database
				.snapshot()
				.commandCommits.at(-1)
				?.messages.map((message) => message.command.type),
		).toEqual(["CancelOrder"]);

		saga.confirmOrderCancelled();
		await commitProcessDecision(database, saga, recorder, {
			messageId: "order-cancelled-1",
			correlationId: "cancel-order-1",
			conversationId: "checkout-order-1",
		});

		expect(saga.step).toBe("compensated-after-shipping-failure");
		expect(database.snapshot().history.at(-1)?.type).toBe(
			"CheckoutCompensationCompletedAfterShippingFailure",
		);
		expect(database.snapshot().commandCommits.at(-1)?.messages).toEqual([]);
	});

	it("records a terminal cancellation after a payment failure", async () => {
		const database = processDatabase();
		let sequence = 0;
		const recorder = createDomainEventFactory({
			eventIdFactory: () => `process-event-${++sequence}`,
			clock: () => new Date("2027-04-05T06:07:08.000Z"),
		});
		const saga = EventSourcedCheckoutSaga.start(orderId, total, paymentId);
		await commitProcessDecision(database, saga, recorder, {
			messageId: "order-placed-1",
			correlationId: "place-order-1",
			conversationId: "checkout-order-1",
		});

		saga.beginCancellationAfterPaymentFailure("insufficient-funds");
		await commitProcessDecision(database, saga, recorder, {
			messageId: "payment-failed-1",
			correlationId: "request-payment-1",
			conversationId: "checkout-order-1",
		});
		expect(saga.step).toBe("awaiting-cancellation-after-payment-failure");
		expect(
			database
				.snapshot()
				.commandCommits.at(-1)
				?.messages.map((message) => message.command.type),
		).toEqual(["CancelOrder"]);

		saga.confirmOrderCancelled();
		await commitProcessDecision(database, saga, recorder, {
			messageId: "order-cancelled-1",
			correlationId: "cancel-order-1",
			conversationId: "checkout-order-1",
		});

		expect(saga.step).toBe("cancelled-after-payment-failure");
		expect(database.snapshot().history.at(-1)?.type).toBe(
			"CheckoutCancellationCompletedAfterPaymentFailure",
		);
		expect(database.snapshot().commandCommits.at(-1)?.messages).toEqual([]);
	});

	it("moves a failed compensation to explicit manual repair", () => {
		const saga = EventSourcedCheckoutSaga.start(orderId, total, paymentId);
		saga.advanceToShipping(shipmentId);
		saga.beginCompensationAfterShippingFailure("warehouse-unavailable");

		saga.requireManualRepair("refund-rejected-permanently");

		expect(saga.step).toBe("manual-repair-required");
		expect(saga.pendingEvents.at(-1)).toMatchObject({
			type: "CheckoutManualRepairRequired",
			payload: {
				failedCommand: "RefundPayment",
				reason: "refund-rejected-permanently",
			},
		});
	});

	it("moves a permanently failed cancellation to explicit manual repair", () => {
		const saga = EventSourcedCheckoutSaga.start(orderId, total, paymentId);
		saga.advanceToShipping(shipmentId);
		saga.beginCompensationAfterShippingFailure("warehouse-unavailable");
		saga.confirmPaymentRefunded();

		saga.requireManualRepair("order-cancellation-rejected");

		expect(saga.step).toBe("manual-repair-required");
		expect(saga.pendingEvents.at(-1)).toMatchObject({
			type: "CheckoutManualRepairRequired",
			payload: {
				failedCommand: "CancelOrder",
				reason: "order-cancellation-rejected",
			},
		});
	});

	it("requests order confirmation before it records checkout completion", async () => {
		const database = processDatabase();
		let sequence = 0;
		const recorder = createDomainEventFactory({
			eventIdFactory: () => `process-event-${++sequence}`,
			clock: () => new Date("2027-04-05T06:07:08.000Z"),
		});
		const saga = EventSourcedCheckoutSaga.start(orderId, total, paymentId);
		await commitProcessDecision(database, saga, recorder, {
			messageId: "order-placed-1",
			correlationId: "place-order-1",
			conversationId: "checkout-order-1",
		});
		saga.advanceToShipping(shipmentId);
		await commitProcessDecision(database, saga, recorder, {
			messageId: "payment-received-1",
			correlationId: "receive-payment-1",
			conversationId: "checkout-order-1",
		});

		saga.beginOrderConfirmation();
		await commitProcessDecision(database, saga, recorder, {
			messageId: "shipping-completed-1",
			correlationId: "ship-order-1",
			conversationId: "checkout-order-1",
		});

		expect(saga.step).toBe("awaiting-order-confirmation");
		expect(
			database
				.snapshot()
				.commandCommits.at(-1)
				?.messages.map((message) => message.command.type),
		).toEqual(["ConfirmOrder"]);

		saga.complete();
		await commitProcessDecision(database, saga, recorder, {
			messageId: "order-confirmed-1",
			correlationId: "confirm-order-1",
			conversationId: "checkout-order-1",
		});

		expect(saga.step).toBe("completed");
		expect(database.snapshot().history.at(-1)?.type).toBe("CheckoutCompleted");
		expect(database.snapshot().commandCommits.at(-1)?.messages).toEqual([]);
	});
});
