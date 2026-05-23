import { describe, expect, it } from "vitest";
import {
	type DomainEvent,
	copyMetadata,
	createDomainEvent,
	createDomainEventWithMetadata,
} from "./domain-event";

describe("DomainEvent", () => {
	describe("eventId", () => {
		it("auto-generates a non-empty string eventId", () => {
			const event = createDomainEvent("Demo", { x: 1 });
			expect(typeof event.eventId).toBe("string");
			expect(event.eventId.length).toBeGreaterThan(0);
		});

		it("produces a different eventId for each invocation", () => {
			const a = createDomainEvent("Demo", { x: 1 });
			const b = createDomainEvent("Demo", { x: 1 });
			expect(a.eventId).not.toBe(b.eventId);
		});

		it("uses an explicit eventId when provided via options", () => {
			const event = createDomainEvent("Demo", { x: 1 }, {
				eventId: "evt-explicit-123",
			});
			expect(event.eventId).toBe("evt-explicit-123");
		});

		it("also auto-generates eventId for payload-less events", () => {
			const event = createDomainEvent("PayloadFreeEvent");
			expect(typeof event.eventId).toBe("string");
			expect(event.eventId.length).toBeGreaterThan(0);
		});

		it("preserves the consumer-supplied eventId through createDomainEventWithMetadata", () => {
			const event = createDomainEventWithMetadata(
				"Demo",
				{ x: 1 },
				{ correlationId: "corr-1" },
				{ eventId: "evt-X" },
			);
			expect(event.eventId).toBe("evt-X");
		});
	});

	describe("aggregateId / aggregateType", () => {
		it("captures aggregateId and aggregateType when provided", () => {
			const event = createDomainEvent("OrderCreated", { customerId: "c-1" }, {
				aggregateId: "order-42",
				aggregateType: "Order",
			});
			expect(event.aggregateId).toBe("order-42");
			expect(event.aggregateType).toBe("Order");
		});

		it("leaves both fields undefined when not provided", () => {
			const event = createDomainEvent("Demo", { x: 1 });
			expect(event.aggregateId).toBeUndefined();
			expect(event.aggregateType).toBeUndefined();
		});

		it("allows aggregateId without aggregateType (and vice versa)", () => {
			const a = createDomainEvent("Demo", { x: 1 }, { aggregateId: "id-1" });
			const b = createDomainEvent("Demo", { x: 1 }, { aggregateType: "X" });
			expect(a.aggregateId).toBe("id-1");
			expect(a.aggregateType).toBeUndefined();
			expect(b.aggregateId).toBeUndefined();
			expect(b.aggregateType).toBe("X");
		});

		it("propagates aggregateId/aggregateType through createDomainEventWithMetadata", () => {
			const event = createDomainEventWithMetadata(
				"OrderShipped",
				{ trackingNumber: "T-1" },
				{ correlationId: "corr-1" },
				{ aggregateId: "order-42", aggregateType: "Order" },
			);
			expect(event.aggregateId).toBe("order-42");
			expect(event.aggregateType).toBe("Order");
		});
	});

	describe("payload semantics", () => {
		it("sets payload to undefined for payload-less events", () => {
			const event = createDomainEvent("PayloadFreeEvent");
			expect("payload" in event).toBe(true);
			expect(event.payload).toBeUndefined();
		});

		it("preserves the payload as given", () => {
			const payload = { orderId: "o-1", items: 3 };
			const event = createDomainEvent("OrderCreated", payload);
			expect(event.payload).toBe(payload);
		});
	});

	describe("existing fields still set correctly", () => {
		it("defaults occurredAt to the current time", () => {
			const before = Date.now();
			const event = createDomainEvent("Demo", { x: 1 });
			const after = Date.now();
			expect(event.occurredAt.getTime()).toBeGreaterThanOrEqual(before);
			expect(event.occurredAt.getTime()).toBeLessThanOrEqual(after);
		});

		it("defaults version to 1", () => {
			const event = createDomainEvent("Demo", { x: 1 });
			expect(event.version).toBe(1);
		});

		it("honors explicit occurredAt / version overrides", () => {
			const when = new Date("2026-01-01T00:00:00Z");
			const event = createDomainEvent("Demo", { x: 1 }, {
				occurredAt: when,
				version: 7,
			});
			expect(event.occurredAt).toBe(when);
			expect(event.version).toBe(7);
		});
	});

	describe("copyMetadata interaction", () => {
		it("does not copy eventId or aggregateId fields (those are per-event identity, not metadata)", () => {
			const previous: DomainEvent<"Prev", { v: number }> = createDomainEvent(
				"Prev",
				{ v: 1 },
				{
					aggregateId: "order-42",
					aggregateType: "Order",
					metadata: { correlationId: "corr-1" },
				},
			);
			const copied = copyMetadata(previous);
			expect((copied as Record<string, unknown>).eventId).toBeUndefined();
			expect((copied as Record<string, unknown>).aggregateId).toBeUndefined();
			expect(copied.correlationId).toBe("corr-1");
		});
	});
});
