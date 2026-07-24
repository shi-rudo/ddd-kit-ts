import { describe, expect, it } from "vite-plus/test";
import {
	createDomainEvent,
	createDomainEventFactory,
	type DomainEventFactory,
} from "../../src/aggregate/domain-event";
import {
	type CommandOutboxCommitCandidate,
	type CommandOutboxWriter,
	routeEventsToCommandOutbox,
} from "../../src/app/command-outbox";
import { withCommit } from "../../src/app/handler";
import { InMemoryIdempotencyStore } from "../../src/app/in-memory-idempotency-store";
import { withIdempotentCommit } from "../../src/app/idempotency";
import { recordPendingEvents } from "../../src/app/record-pending-events";
import { outboxWriterAcceptingEventLoss } from "../../src/events/outbox";
import { moneyOfMinor } from "../../src/money";
import type { TransactionScope } from "../../src/repo/scope";
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

		expect(saga.step).toBe("cancelling-after-payment-failure");
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
		const replayed = restored.loadFromHistory(history);

		expect(replayed.isOk()).toBe(true);
		expect(restored.step).toBe("compensating-after-shipping-failure");
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
					orderId,
					paymentId,
					amount: total,
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

		const retainedEventId = saga.pendingEvents[0]?.eventId;
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
		expect(restored.loadFromHistory(database.snapshot().history).isOk()).toBe(
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
						message.command.type,
						orderId,
						paymentId,
						total.amountMinor.toString(),
						total.currency,
						total.scale,
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

	it("propagates conversation and direct causation through the participant result", async () => {
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
		});
		expect(paymentReceived.metadata).toMatchObject({
			causationId: "checkout-started-1:command:0",
			conversationId: "checkout-order-1",
		});
	});

	it("persists shipping compensation in reverse completion order", async () => {
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

		const compensation = database.snapshot().commandCommits.at(-1)?.messages;
		expect(compensation?.map((message) => message.command.type)).toEqual([
			"RefundPayment",
			"CancelOrder",
		]);
		expect(compensation?.map((message) => message.destination)).toEqual([
			"payments.commands",
			"orders.commands",
		]);
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
