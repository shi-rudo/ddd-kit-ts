import { describe, expect, it } from "vite-plus/test";
import { InvalidCommandMessageError } from "../core/errors";
import { createDomainEvent } from "../domain/event/domain-event";
import type { EventCommitCandidate } from "../events/ports";
import type { PublishedCommand } from "./command";
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

type RequestShipping = PublishedCommand<
	"RequestShipping",
	{
		readonly orderId: string;
		readonly shipmentId: string;
	}
>;

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
					traceparent:
						"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
					tracestate: "vendor=opaque",
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
							version: 1,
							payload: {
								orderId: event.aggregateId,
								shipmentId: event.payload.shipmentId,
							},
						},
						correlationId: event.metadata?.correlationId,
						conversationId: event.metadata?.conversationId,
						traceparent: event.metadata?.traceparent as string,
						tracestate: event.metadata?.tracestate as string,
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
								version: 1,
								payload: {
									orderId: "order-1",
									shipmentId: "shipment-1",
								},
							},
							correlationId: "payment-correlation-1",
							conversationId: "checkout-order-1",
							traceparent:
								"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
							tracestate: "vendor=opaque",
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
			| ReadonlyArray<CommandOutboxCommitCandidate<PublishedCommand>>
			| undefined;
		const commandOutbox: CommandOutboxWriter<PublishedCommand> = {
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
		const writes: Array<
			ReadonlyArray<CommandOutboxCommitCandidate<PublishedCommand>>
		> = [];
		const commandOutbox: CommandOutboxWriter<PublishedCommand> = {
			add: async (commits) => {
				writes.push(commits);
			},
		};
		const writer = routeEventsToCommandOutbox(commandOutbox, () => [
			{
				destination: "payments.commands",
				command: { type: "RefundPayment", version: 1, payload: {} },
				conversationId: "checkout-order-1",
			},
			{
				destination: "orders.commands",
				command: { type: "CancelOrder", version: 1, payload: {} },
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
			version: 1,
			payload: {
				orderId: "order-1",
				shipmentId: "shipment-1",
			},
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
		(mutableCommand.payload as { shipmentId: string }).shipmentId = "changed";

		expect(recorded?.messages[0]?.command.payload).toMatchObject({
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
					command: {
						type: "RequestShipping",
						version: 1,
						payload: {},
					},
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
			command: PublishedCommand;
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

	it("rejects negative zero instead of silently storing it as 0", async () => {
		let addCalls = 0;
		const writer = routeEventsToCommandOutbox(
			{
				add: async () => {
					addCalls += 1;
				},
			},
			() => [
				{
					destination: "shipping.commands",
					command: {
						type: "AdjustBalance",
						version: 1,
						// JSON.stringify(-0) produces "0"; the exactness contract
						// must reject the payload instead of mutating it.
						payload: { delta: -0 },
					},
				},
			],
		);

		await expect(writer.add([processEventCandidate()])).rejects.toThrow(
			/negative zero/,
		);
		expect(addCalls).toBe(0);
	});

	it("rejects a command without an explicit positive schema version", async () => {
		let addCalls = 0;
		const writer = routeEventsToCommandOutbox(
			{
				add: async () => {
					addCalls += 1;
				},
			},
			() => [
				{
					destination: "shipping.commands",
					command: {
						type: "RequestShipping",
						payload: { shipmentId: "shipment-1" },
					} as unknown as PublishedCommand,
				},
			],
		);

		await expect(writer.add([processEventCandidate()])).rejects.toThrow(
			InvalidCommandMessageError,
		);
		expect(addCalls).toBe(0);
	});

	it("rejects non-JSON-safe command payloads before calling the adapter", async () => {
		let addCalls = 0;
		const writer = routeEventsToCommandOutbox(
			{
				add: async () => {
					addCalls += 1;
				},
			},
			() => [
				{
					destination: "payments.commands",
					command: {
						type: "RequestPayment",
						version: 1,
						payload: { amountMinor: 4_200n },
					} as unknown as PublishedCommand,
				},
			],
		);

		await expect(writer.add([processEventCandidate()])).rejects.toThrow(
			InvalidCommandMessageError,
		);
		expect(addCalls).toBe(0);
	});

	it("rejects malformed W3C trace context before calling the adapter", async () => {
		let addCalls = 0;
		const writer = routeEventsToCommandOutbox(
			{
				add: async () => {
					addCalls += 1;
				},
			},
			() => [
				{
					destination: "shipping.commands",
					command: {
						type: "RequestShipping",
						version: 1,
						payload: {},
					},
					traceparent: "not-a-traceparent",
				},
			],
		);

		await expect(writer.add([processEventCandidate()])).rejects.toThrow(
			InvalidCommandMessageError,
		);
		expect(addCalls).toBe(0);
	});

	it("preserves a structurally valid future traceparent version", async () => {
		let received:
			| ReadonlyArray<CommandOutboxCommitCandidate<PublishedCommand>>
			| undefined;
		const traceparent =
			"01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-future";
		const writer = routeEventsToCommandOutbox(
			{
				add: async (commits) => {
					received = commits;
				},
			},
			() => [
				{
					destination: "shipping.commands",
					command: {
						type: "RequestShipping",
						version: 1,
						payload: {},
					},
					traceparent,
				},
			],
		);

		await writer.add([processEventCandidate()]);

		expect(received?.[0]?.messages[0]?.traceparent).toBe(traceparent);
	});

	it("tolerates spec-legal empty tracestate list-members", async () => {
		let received: unknown;
		const writer = routeEventsToCommandOutbox(
			{
				add: async (commits: unknown) => {
					received = commits;
				},
			},
			() => [
				{
					destination: "shipping.commands",
					command: {
						type: "RequestShipping",
						version: 1,
						payload: {},
					},
					traceparent:
						"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
					// W3C Trace Context: receivers must tolerate empty
					// list-members forwarded by upstream tracers.
					tracestate: "vendor1=abc,,vendor2=def",
				},
			],
		);

		await expect(writer.add([processEventCandidate()])).resolves.not.toThrow();
		expect(received).toBeDefined();
	});

	it("rejects duplicate tracestate keys before calling the adapter", async () => {
		let addCalls = 0;
		const writer = routeEventsToCommandOutbox(
			{
				add: async () => {
					addCalls += 1;
				},
			},
			() => [
				{
					destination: "shipping.commands",
					command: {
						type: "RequestShipping",
						version: 1,
						payload: {},
					},
					traceparent:
						"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
					tracestate: "vendor=first,vendor=second",
				},
			],
		);

		await expect(writer.add([processEventCandidate()])).rejects.toThrow(
			InvalidCommandMessageError,
		);
		expect(addCalls).toBe(0);
	});
});
