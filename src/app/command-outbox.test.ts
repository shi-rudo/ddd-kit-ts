import { describe, expect, it } from "vite-plus/test";
import { createDomainEvent } from "../aggregate/domain-event";
import type { EventCommitCandidate } from "../events/ports";
import type { Command } from "./command";
import {
	type CommandOutboxCommitCandidate,
	type CommandOutboxWriter,
	routeEventsToCommandOutbox,
} from "./command-outbox";

type CheckoutAdvancedToShipping = ReturnType<
	typeof createDomainEvent<
		"CheckoutAdvancedToShipping",
		{ readonly shipmentId: string }
	>
>;

type RequestShipping = Command & {
	readonly type: "RequestShipping";
	readonly orderId: string;
	readonly shipmentId: string;
};

function processEventCandidate(): EventCommitCandidate<CheckoutAdvancedToShipping> {
	return {
		event: createDomainEvent(
			"CheckoutAdvancedToShipping",
			{ shipmentId: "shipment-1" },
			{
				eventId: "process-event-1",
				aggregateId: "order-1",
				aggregateType: "CheckoutProcess",
				occurredAt: new Date("2027-04-05T06:07:08.000Z"),
				metadata: {
					correlationId: "payment-correlation-1",
					conversationId: "checkout-order-1",
				},
			},
		),
		source: {
			aggregateId: "order-1",
			aggregateType: "CheckoutProcess",
		},
		position: {
			aggregateVersion: 2,
			commitSequence: 0,
			commitSize: 1,
		},
	};
}

describe("routeEventsToCommandOutbox", () => {
	it("persists an addressed command without exposing the private process event", async () => {
		const writes: Array<
			ReadonlyArray<CommandOutboxCommitCandidate<RequestShipping>>
		> = [];
		const commandOutbox: CommandOutboxWriter<RequestShipping> = {
			add: async (commits) => {
				writes.push(commits);
			},
		};
		const writer = routeEventsToCommandOutbox(
			commandOutbox,
			(event: CheckoutAdvancedToShipping) => {
				if (!event.aggregateId) throw new Error("missing aggregate id");
				return [
					{
						destination: "shipping.commands",
						command: {
							type: "RequestShipping",
							orderId: event.aggregateId,
							shipmentId: event.payload.shipmentId,
						},
						correlationId: event.metadata?.correlationId,
						conversationId: event.metadata?.conversationId,
					},
				];
			},
		);

		await writer.add([processEventCandidate()]);

		expect(writes).toEqual([
			[
				{
					origin: {
						eventId: "process-event-1",
						source: {
							aggregateId: "order-1",
							aggregateType: "CheckoutProcess",
						},
						position: {
							aggregateVersion: 2,
							commitSequence: 0,
							commitSize: 1,
						},
					},
					messages: [
						{
							messageId: "process-event-1:command:0",
							recordedAt: "2027-04-05T06:07:08.000Z",
							destination: "shipping.commands",
							command: {
								type: "RequestShipping",
								orderId: "order-1",
								shipmentId: "shipment-1",
							},
							correlationId: "payment-correlation-1",
							conversationId: "checkout-order-1",
							causationId: "process-event-1",
						},
					],
				},
			],
		]);
		expect(writes[0]?.[0]?.origin).not.toHaveProperty("event");
	});

	it("retains an empty commit receipt when a private fact requests no command", async () => {
		let received:
			| ReadonlyArray<CommandOutboxCommitCandidate<Command>>
			| undefined;
		const commandOutbox: CommandOutboxWriter<Command> = {
			add: async (commits) => {
				received = commits;
			},
		};
		const writer = routeEventsToCommandOutbox(commandOutbox, () => []);

		await writer.add([processEventCandidate()]);

		expect(received).toEqual([
			{
				origin: {
					eventId: "process-event-1",
					source: {
						aggregateId: "order-1",
						aggregateType: "CheckoutProcess",
					},
					position: {
						aggregateVersion: 2,
						commitSequence: 0,
						commitSize: 1,
					},
				},
				messages: [],
			},
		]);
	});

	it("keeps compensation commands in mapper order with distinct stable ids", async () => {
		const writes: Array<ReadonlyArray<CommandOutboxCommitCandidate<Command>>> =
			[];
		const commandOutbox: CommandOutboxWriter<Command> = {
			add: async (commits) => {
				writes.push(commits);
			},
		};
		const writer = routeEventsToCommandOutbox(commandOutbox, () => [
			{
				destination: "payments.commands",
				command: { type: "RefundPayment" },
				conversationId: "checkout-order-1",
			},
			{
				destination: "orders.commands",
				command: { type: "CancelOrder" },
				conversationId: "checkout-order-1",
			},
		]);

		await writer.add([processEventCandidate()]);

		expect(
			writes[0]?.[0]?.messages.map((message) => message.command.type),
		).toEqual(["RefundPayment", "CancelOrder"]);
		expect(
			writes[0]?.[0]?.messages.map((message) => message.messageId),
		).toEqual(["process-event-1:command:0", "process-event-1:command:1"]);
	});

	it("owns and freezes mapper output before passing it to an adapter", async () => {
		const mutableCommand: RequestShipping = {
			type: "RequestShipping",
			orderId: "order-1",
			shipmentId: "shipment-1",
		};
		let recorded: CommandOutboxCommitCandidate<RequestShipping> | undefined;
		const writer = routeEventsToCommandOutbox<RequestShipping>(
			{
				add: async (commits) => {
					recorded = commits[0];
				},
			},
			() => [
				{
					destination: "shipping.commands",
					command: mutableCommand,
				},
			],
		);

		await writer.add([processEventCandidate()]);
		(mutableCommand as { shipmentId: string }).shipmentId = "changed";

		expect(recorded?.messages[0]?.command).toMatchObject({
			shipmentId: "shipment-1",
		});
		expect(Object.isFrozen(recorded?.messages[0])).toBe(true);
		expect(Object.isFrozen(recorded?.messages[0]?.command)).toBe(true);
	});

	it("rejects the whole mapped batch before calling the adapter", async () => {
		let addCalls = 0;
		const writer = routeEventsToCommandOutbox(
			{
				add: async () => {
					addCalls += 1;
				},
			},
			() => [
				{
					destination: " ",
					command: { type: "RequestShipping" },
				},
			],
		);

		await expect(writer.add([processEventCandidate()])).rejects.toThrow(
			/destination/,
		);
		expect(addCalls).toBe(0);
	});

	it("rejects sparse mapper output instead of persisting a missing sequence", async () => {
		let addCalls = 0;
		const sparse = new Array(1) as Array<{
			destination: string;
			command: Command;
		}>;
		const writer = routeEventsToCommandOutbox(
			{
				add: async () => {
					addCalls += 1;
				},
			},
			() => sparse,
		);

		await expect(writer.add([processEventCandidate()])).rejects.toThrow(
			/entry must be an object/,
		);
		expect(addCalls).toBe(0);
	});
});
