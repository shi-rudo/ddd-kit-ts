import { describe, expect, it } from "vite-plus/test";
import { createDomainEvent } from "../../../domain/event/domain-event";
import { InvalidCommandMessageError } from "../../../errors/kit-errors";
import type { EventCommitCandidate } from "../../../messaging/committed-event";
import { recordingCommandOutbox } from "../../../testing/recording-command-outbox";
import type { PublishedCommand } from "./command";
import { routeEventsToCommandOutbox } from "./command-outbox";

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
		const commandOutbox = recordingCommandOutbox<RequestShipping>();
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

		expect(commandOutbox.added).toEqual([
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
		expect(commandOutbox.added[0]?.[0]?.origin).not.toHaveProperty("event");
	});

	it("retains an empty commit receipt when a private fact requests no command", async () => {
		const commandOutbox = recordingCommandOutbox<PublishedCommand>();
		const writer = routeEventsToCommandOutbox(commandOutbox, () => []);

		await writer.add([processEventCandidate()]);

		expect(commandOutbox.added[0]).toEqual([
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
		const commandOutbox = recordingCommandOutbox<PublishedCommand>();
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

		const [commit] = commandOutbox.added[0] ?? [];
		expect(commit?.messages.map((message) => message.command.type)).toEqual([
			"RefundPayment",
			"CancelOrder",
		]);
		expect(commit?.messages.map((message) => message.messageId)).toEqual([
			"process-event-1:command:0",
			"process-event-1:command:1",
		]);
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
		const commandOutbox = recordingCommandOutbox<RequestShipping>();
		const writer = routeEventsToCommandOutbox<RequestShipping>(
			commandOutbox,
			() => [
				{
					destination: "shipping.commands",
					command: mutableCommand,
				},
			],
		);

		await writer.add([processEventCandidate()]);
		(mutableCommand.payload as { shipmentId: string }).shipmentId = "changed";

		const recorded = commandOutbox.added[0]?.[0];
		expect(recorded?.messages[0]?.command.payload).toMatchObject({
			shipmentId: "shipment-1",
		});
		expect(Object.isFrozen(recorded?.messages[0])).toBe(true);
		expect(Object.isFrozen(recorded?.messages[0]?.command)).toBe(true);
	});

	it("rejects the whole mapped batch before calling the adapter", async () => {
		const commandOutbox = recordingCommandOutbox<PublishedCommand>();
		const writer = routeEventsToCommandOutbox(commandOutbox, () => [
			{
				destination: " ",
				command: {
					type: "RequestShipping",
					version: 1,
					payload: {},
				},
			},
		]);

		await expect(writer.add([processEventCandidate()])).rejects.toThrow(
			/destination/,
		);
		expect(commandOutbox.added).toEqual([]);
	});

	it("rejects sparse mapper output instead of persisting a missing sequence", async () => {
		const commandOutbox = recordingCommandOutbox<PublishedCommand>();
		const sparse = new Array(1) as Array<{
			destination: string;
			command: PublishedCommand;
		}>;
		const writer = routeEventsToCommandOutbox(commandOutbox, () => sparse);

		await expect(writer.add([processEventCandidate()])).rejects.toThrow(
			/entry must be an object/,
		);
		expect(commandOutbox.added).toEqual([]);
	});

	it("stores a negative zero from ordinary arithmetic as 0", async () => {
		const commandOutbox = recordingCommandOutbox<PublishedCommand>();
		const writer = routeEventsToCommandOutbox(commandOutbox, () => [
			{
				destination: "shipping.commands",
				command: {
					type: "AdjustBalance",
					version: 1,
					payload: { delta: Math.round(-0.4) },
				},
			},
		]);

		await writer.add([processEventCandidate()]);

		const payload = commandOutbox.added[0]?.[0]?.messages[0]?.command.payload;
		expect(Object.is((payload as { delta: number }).delta, 0)).toBe(true);
	});

	it("rejects a command without an explicit positive schema version", async () => {
		const commandOutbox = recordingCommandOutbox<PublishedCommand>();
		const writer = routeEventsToCommandOutbox(commandOutbox, () => [
			{
				destination: "shipping.commands",
				command: {
					type: "RequestShipping",
					payload: { shipmentId: "shipment-1" },
				} as unknown as PublishedCommand,
			},
		]);

		await expect(writer.add([processEventCandidate()])).rejects.toThrow(
			InvalidCommandMessageError,
		);
		expect(commandOutbox.added).toEqual([]);
	});

	it("rejects non-JSON-safe command payloads before calling the adapter", async () => {
		const commandOutbox = recordingCommandOutbox<PublishedCommand>();
		const writer = routeEventsToCommandOutbox(commandOutbox, () => [
			{
				destination: "payments.commands",
				command: {
					type: "RequestPayment",
					version: 1,
					payload: { amountMinor: 4_200n },
				} as unknown as PublishedCommand,
			},
		]);

		await expect(writer.add([processEventCandidate()])).rejects.toThrow(
			InvalidCommandMessageError,
		);
		expect(commandOutbox.added).toEqual([]);
	});

	it("drops a malformed traceparent with its tracestate and keeps the command", async () => {
		const commandOutbox = recordingCommandOutbox<PublishedCommand>();
		const writer = routeEventsToCommandOutbox(commandOutbox, () => [
			{
				destination: "shipping.commands",
				command: {
					type: "RequestShipping",
					version: 1,
					payload: {},
				},
				traceparent: "not-a-traceparent",
				tracestate: "vendor=opaque",
			},
		]);

		await writer.add([processEventCandidate()]);

		const message = commandOutbox.added[0]?.[0]?.messages[0];
		expect(message?.command.type).toBe("RequestShipping");
		expect(message).not.toHaveProperty("traceparent");
		expect(message).not.toHaveProperty("tracestate");
	});

	it("drops a tracestate without a traceparent", async () => {
		const commandOutbox = recordingCommandOutbox<PublishedCommand>();
		const writer = routeEventsToCommandOutbox(commandOutbox, () => [
			{
				destination: "shipping.commands",
				command: {
					type: "RequestShipping",
					version: 1,
					payload: {},
				},
				tracestate: "vendor=opaque",
			},
		]);

		await writer.add([processEventCandidate()]);

		expect(commandOutbox.added[0]?.[0]?.messages[0]).not.toHaveProperty(
			"tracestate",
		);
	});

	it("preserves a structurally valid future traceparent version", async () => {
		const commandOutbox = recordingCommandOutbox<PublishedCommand>();
		const traceparent =
			"01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-future";
		const writer = routeEventsToCommandOutbox(commandOutbox, () => [
			{
				destination: "shipping.commands",
				command: {
					type: "RequestShipping",
					version: 1,
					payload: {},
				},
				traceparent,
			},
		]);

		await writer.add([processEventCandidate()]);

		expect(commandOutbox.added[0]?.[0]?.messages[0]?.traceparent).toBe(
			traceparent,
		);
	});

	it("tolerates spec-legal empty tracestate list-members", async () => {
		const commandOutbox = recordingCommandOutbox<PublishedCommand>();
		const writer = routeEventsToCommandOutbox(commandOutbox, () => [
			{
				destination: "shipping.commands",
				command: {
					type: "RequestShipping",
					version: 1,
					payload: {},
				},
				traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
				// W3C Trace Context: receivers must tolerate empty
				// list-members forwarded by upstream tracers.
				tracestate: "vendor1=abc,,vendor2=def",
			},
		]);

		await writer.add([processEventCandidate()]);

		expect(commandOutbox.added[0]?.[0]?.messages[0]?.tracestate).toBe(
			"vendor1=abc,vendor2=def",
		);
	});

	it("drops a tracestate with duplicate keys and keeps the traceparent", async () => {
		const commandOutbox = recordingCommandOutbox<PublishedCommand>();
		const writer = routeEventsToCommandOutbox(commandOutbox, () => [
			{
				destination: "shipping.commands",
				command: {
					type: "RequestShipping",
					version: 1,
					payload: {},
				},
				traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
				tracestate: "vendor=first,vendor=second",
			},
		]);

		await writer.add([processEventCandidate()]);

		const message = commandOutbox.added[0]?.[0]?.messages[0];
		expect(message?.traceparent).toBe(
			"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
		);
		expect(message).not.toHaveProperty("tracestate");
	});
});
