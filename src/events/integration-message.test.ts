import { describe, expect, it } from "vitest";
import { createDomainEvent } from "../aggregate/domain-event";
import { InvalidIntegrationMessageError } from "../core/errors";
import type { CommittedDomainEvent } from "./ports";
import {
	createIntegrationMessage,
	decodeIntegrationMessage,
	encodeIntegrationMessage,
	integrationMessageToCommittedEvent,
} from "./integration-message";

describe("integration message codec", () => {
	const validWireMessage = () => ({
		messageId: "evt-order-1",
		type: "sales.order-placed.v1",
		version: 1,
		occurredAt: "2026-07-13T09:00:00.000Z",
		payload: { totalMinor: "1250" },
		source: { aggregateType: "Order", aggregateId: "o-1" },
		position: {
			aggregateVersion: 1,
			commitSequence: 0,
			commitSize: 1,
			previousEventfulAggregateVersion: null,
		},
	});

	it("round-trips an explicitly JSON-mapped event without losing its cursor", () => {
		const occurredAt = new Date("2026-07-13T09:00:00.000Z");
		const event = createDomainEvent(
			"OrderPlaced",
			{
				placedAt: occurredAt,
				amounts: new Map([["gross", 1250]]),
				tags: new Set(["pilot", "priority"]),
			},
			{
				eventId: "evt-order-1",
				aggregateId: "o-1",
				aggregateType: "Order",
				occurredAt,
			},
		);
		const committed: CommittedDomainEvent<typeof event> = {
			event,
			source: { aggregateType: "Order", aggregateId: "o-1" },
			position: {
				aggregateVersion: 1,
				commitSequence: 0,
				commitSize: 1,
				previousEventfulAggregateVersion: null,
			},
		};

		const message = createIntegrationMessage(committed, (domainEvent) => ({
			type: "sales.order-placed.v1",
			version: 1,
			payload: {
				placedAt: domainEvent.payload.placedAt.toISOString(),
				amounts: [...domainEvent.payload.amounts],
				tags: [...domainEvent.payload.tags],
			},
			metadata: { correlationId: "corr-1" },
		}));
		const decoded = decodeIntegrationMessage(
			encodeIntegrationMessage(message),
		);
		const projected = integrationMessageToCommittedEvent(decoded);

		expect(decoded).toEqual({
			messageId: "evt-order-1",
			type: "sales.order-placed.v1",
			version: 1,
			occurredAt: "2026-07-13T09:00:00.000Z",
			payload: {
				placedAt: "2026-07-13T09:00:00.000Z",
				amounts: [["gross", 1250]],
				tags: ["pilot", "priority"],
			},
			metadata: { correlationId: "corr-1" },
			source: { aggregateType: "Order", aggregateId: "o-1" },
			position: {
				aggregateVersion: 1,
				commitSequence: 0,
				commitSize: 1,
				previousEventfulAggregateVersion: null,
			},
		});
		expect(Object.isFrozen(decoded)).toBe(true);
		expect(Object.isFrozen(decoded.payload)).toBe(true);
		expect(projected.event.occurredAt).toEqual(occurredAt);
		expect(projected.event.payload).toEqual(decoded.payload);
		expect(projected.source).toEqual(decoded.source);
		expect(projected.position).toEqual(decoded.position);
	});

	it("defensively owns a valid mutable message before composing a committed event", () => {
		const message = validWireMessage();

		const committed = integrationMessageToCommittedEvent(message);
		message.source.aggregateId = "tampered";
		message.position.aggregateVersion = 99;

		expect(committed.source.aggregateId).toBe("o-1");
		expect(committed.position.aggregateVersion).toBe(1);
		expect(Object.isFrozen(committed.source)).toBe(true);
		expect(Object.isFrozen(committed.position)).toBe(true);
	});

	it.each([
		["Date", new Date("2026-07-13T09:00:00.000Z")],
		["Map", new Map([["gross", 1250]])],
		["Set", new Set(["pilot"])],
	])("rejects an unmapped %s before JSON can change it", (_label, value) => {
		const event = createDomainEvent(
			"OrderPlaced",
			{ total: 1250 },
			{
				eventId: "evt-order-unsafe",
				aggregateId: "o-1",
				aggregateType: "Order",
				occurredAt: new Date("2026-07-13T09:00:00.000Z"),
			},
		);
		const committed: CommittedDomainEvent<typeof event> = {
			event,
			source: { aggregateType: "Order", aggregateId: "o-1" },
			position: {
				aggregateVersion: 1,
				commitSequence: 0,
				commitSize: 1,
				previousEventfulAggregateVersion: null,
			},
		};

		expect(() =>
			createIntegrationMessage(committed, () => ({
				type: "sales.order-placed.v1",
				version: 1,
				payload: { unsafe: value } as never,
			})),
		).toThrow(InvalidIntegrationMessageError);
	});

	it("rejects array properties that JSON would silently discard", () => {
		const event = createDomainEvent(
			"OrderPlaced",
			{ total: 1250 },
			{
				eventId: "evt-order-array-expando",
				aggregateId: "o-1",
				aggregateType: "Order",
				occurredAt: new Date("2026-07-13T09:00:00.000Z"),
			},
		);
		const committed: CommittedDomainEvent<typeof event> = {
			event,
			source: { aggregateType: "Order", aggregateId: "o-1" },
			position: {
				aggregateVersion: 1,
				commitSequence: 0,
				commitSize: 1,
				previousEventfulAggregateVersion: null,
			},
		};
		const values = ["priority"] as Array<string> & { label?: string };
		values.label = "tags";

		expect(() =>
			createIntegrationMessage(committed, () => ({
				type: "sales.order-placed.v1",
				version: 1,
				payload: values,
			})),
		).toThrow(InvalidIntegrationMessageError);
	});

	it.each([
		[
			"a missing genesis predecessor",
			() => {
				const message = validWireMessage();
				const { previousEventfulAggregateVersion: _, ...position } =
					message.position;
				return { ...message, position };
			},
		],
		[
			"a non-canonical timestamp",
			() => ({ ...validWireMessage(), occurredAt: "13.07.2026" }),
		],
		["an empty message id", () => ({ ...validWireMessage(), messageId: "" })],
		[
			"a missing payload",
			() => {
				const { payload: _, ...message } = validWireMessage();
				return message;
			},
		],
		[
			"an invalid commit boundary",
			() => ({
				...validWireMessage(),
				position: { ...validWireMessage().position, commitSize: 0 },
			}),
		],
		[
			"a hostile payload key",
			() => ({
				...validWireMessage(),
				payload: JSON.parse('{"__proto__":{"polluted":true}}'),
			}),
		],
	] as const)("rejects %s from an untrusted wire body", (_label, message) => {
		expect(() =>
			decodeIntegrationMessage(JSON.stringify(message())),
		).toThrow(InvalidIntegrationMessageError);
	});
});
