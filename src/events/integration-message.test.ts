import { describe, expect, it } from "vite-plus/test";
import { createDomainEvent } from "../aggregate/domain-event";
import { InvalidIntegrationMessageError } from "../core/errors";
import {
	createIntegrationMessage,
	decodeIntegrationMessage,
	encodeIntegrationMessage,
	integrationMessageToCommittedEvent,
} from "./integration-message";
import type { CommittedDomainEvent } from "./ports";

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
				metadata: {
					correlationId: "internal-correlation",
					conversationId: "internal-conversation",
					causationId: "internal-cause",
				},
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
			correlationId: "corr-1",
			conversationId: "conversation-1",
			causationId: "command-1",
			metadata: { tenantId: "tenant-1" },
		}));
		const decoded = decodeIntegrationMessage(encodeIntegrationMessage(message));
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
			correlationId: "corr-1",
			conversationId: "conversation-1",
			causationId: "command-1",
			metadata: { tenantId: "tenant-1" },
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
		expect(projected.event.metadata).toEqual({
			correlationId: "corr-1",
			conversationId: "conversation-1",
			causationId: "command-1",
			tenantId: "tenant-1",
		});
		expect(projected.source).toEqual(decoded.source);
		expect(projected.position).toEqual(decoded.position);
	});

	it("does not expose domain relationship metadata unless the boundary mapper maps it", () => {
		const event = createDomainEvent(
			"OrderPlaced",
			{ totalMinor: "1250" },
			{
				eventId: "evt-order-relationships",
				aggregateId: "o-1",
				aggregateType: "Order",
				occurredAt: new Date("2026-07-13T09:00:00.000Z"),
				metadata: {
					correlationId: "corr-internal",
					conversationId: "conversation-internal",
					causationId: "cause-internal",
				},
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
			payload: domainEvent.payload,
		}));

		expect(Object.hasOwn(message, "correlationId")).toBe(false);
		expect(Object.hasOwn(message, "conversationId")).toBe(false);
		expect(Object.hasOwn(message, "causationId")).toBe(false);
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
		[
			"UTC without fractional seconds",
			"2026-07-13T09:00:00Z",
			"2026-07-13T09:00:00.000Z",
		],
		[
			"one fractional digit",
			"2026-07-13T09:00:00.1Z",
			"2026-07-13T09:00:00.100Z",
		],
		[
			"a numeric UTC offset",
			"2026-07-13T09:00:00+00:00",
			"2026-07-13T09:00:00.000Z",
		],
		[
			"a positive offset",
			"2026-07-13T11:30:00+02:30",
			"2026-07-13T09:00:00.000Z",
		],
		[
			"a negative offset",
			"2026-07-13T04:00:00-05:00",
			"2026-07-13T09:00:00.000Z",
		],
	] as const)(
		"accepts %s from the wire and normalizes it to canonical UTC",
		(_label, occurredAt, canonical) => {
			const decoded = decodeIntegrationMessage(
				JSON.stringify({ ...validWireMessage(), occurredAt }),
			);

			expect(decoded.occurredAt).toBe(canonical);
			expect(Object.isFrozen(decoded)).toBe(true);
		},
	);

	it("keeps encoder output restricted to canonical UTC timestamps", () => {
		expect(() =>
			encodeIntegrationMessage({
				...validWireMessage(),
				occurredAt: "2026-07-13T09:00:00Z",
			}),
		).toThrow(InvalidIntegrationMessageError);
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
		["correlationId", ""],
		["conversationId", 42],
		["causationId", null],
	] as const)("rejects an invalid %s envelope header", (field, value) => {
		let caught: unknown;
		try {
			decodeIntegrationMessage(
				JSON.stringify({ ...validWireMessage(), [field]: value }),
			);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(InvalidIntegrationMessageError);
		expect(caught).toMatchObject({ path: `$.${field}` });
	});

	it.each(["correlationId", "conversationId", "causationId"] as const)(
		"rejects a duplicate %s hidden in custom metadata",
		(field) => {
			let caught: unknown;
			try {
				decodeIntegrationMessage(
					JSON.stringify({
						...validWireMessage(),
						metadata: { [field]: "ambiguous" },
					}),
				);
			} catch (error) {
				caught = error;
			}

			expect(caught).toBeInstanceOf(InvalidIntegrationMessageError);
			expect(caught).toMatchObject({ path: `$.metadata.${field}` });
		},
	);

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
			"a locale timestamp",
			() => ({ ...validWireMessage(), occurredAt: "13.07.2026" }),
		],
		[
			"a local timestamp without an offset",
			() => ({
				...validWireMessage(),
				occurredAt: "2026-07-13T09:00:00",
			}),
		],
		[
			"an impossible calendar date",
			() => ({
				...validWireMessage(),
				occurredAt: "2026-02-29T09:00:00Z",
			}),
		],
		[
			"precision finer than milliseconds",
			() => ({
				...validWireMessage(),
				occurredAt: "2026-07-13T09:00:00.0001Z",
			}),
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
		expect(() => decodeIntegrationMessage(JSON.stringify(message()))).toThrow(
			InvalidIntegrationMessageError,
		);
	});
});
