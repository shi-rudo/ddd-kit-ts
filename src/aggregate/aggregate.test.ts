import { describe, expect, it } from "vitest";
import type { Id } from "../core/id";
import {
	createDomainEvent,
	createDomainEventWithMetadata,
	copyMetadata,
	mergeMetadata,
	sameAggregate,
	type DomainEvent,
	type EventMetadata,
	type Version,
} from "./aggregate";

describe("Domain Events", () => {
	describe("createDomainEvent()", () => {
		it("should create a basic domain event with defaults", () => {
			const event = createDomainEvent("OrderCreated", { orderId: "123" });

			expect(event.type).toBe("OrderCreated");
			expect(event.payload).toEqual({ orderId: "123" });
			expect(event.occurredAt).toBeInstanceOf(Date);
			expect(event.version).toBe(1);
			expect(event.metadata).toBeUndefined();
		});

		it("should create event with custom occurredAt", () => {
			const customDate = new Date("2024-01-01");
			const event = createDomainEvent("OrderCreated", { orderId: "123" }, {
				occurredAt: customDate,
			});

			expect(event.occurredAt).toBe(customDate);
		});

		it("should create event with custom version", () => {
			const event = createDomainEvent("OrderCreated", { orderId: "123" }, {
				version: 2,
			});

			expect(event.version).toBe(2);
		});

		it("should create event with metadata", () => {
			const metadata: EventMetadata = {
				correlationId: "corr-123",
				userId: "user-456",
			};

			const event = createDomainEvent("OrderCreated", { orderId: "123" }, {
				metadata,
			});

			expect(event.metadata).toEqual(metadata);
		});

		it("should create event with all options", () => {
			const customDate = new Date("2024-01-01");
			const metadata: EventMetadata = {
				correlationId: "corr-123",
			};

			const event = createDomainEvent("OrderCreated", { orderId: "123" }, {
				occurredAt: customDate,
				version: 2,
				metadata,
			});

			expect(event.type).toBe("OrderCreated");
			expect(event.payload).toEqual({ orderId: "123" });
			expect(event.occurredAt).toBe(customDate);
			expect(event.version).toBe(2);
			expect(event.metadata).toEqual(metadata);
		});
	});

	describe("createDomainEventWithMetadata()", () => {
		it("should create event with metadata", () => {
			const metadata: EventMetadata = {
				correlationId: "corr-123",
				causationId: "cmd-456",
				userId: "user-789",
				source: "order-service",
			};

			const event = createDomainEventWithMetadata(
				"OrderCreated",
				{ orderId: "123" },
				metadata,
			);

			expect(event.type).toBe("OrderCreated");
			expect(event.payload).toEqual({ orderId: "123" });
			expect(event.metadata).toEqual(metadata);
			expect(event.version).toBe(1);
		});

		it("should create event with metadata and custom version", () => {
			const metadata: EventMetadata = {
				correlationId: "corr-123",
			};

			const event = createDomainEventWithMetadata(
				"OrderCreated",
				{ orderId: "123" },
				metadata,
				{ version: 2 },
			);

			expect(event.metadata).toEqual(metadata);
			expect(event.version).toBe(2);
		});

		it("should create event with metadata and custom occurredAt", () => {
			const customDate = new Date("2024-01-01");
			const metadata: EventMetadata = {
				correlationId: "corr-123",
			};

			const event = createDomainEventWithMetadata(
				"OrderCreated",
				{ orderId: "123" },
				metadata,
				{ occurredAt: customDate },
			);

			expect(event.metadata).toEqual(metadata);
			expect(event.occurredAt).toBe(customDate);
		});

		it("should support custom metadata fields", () => {
			const metadata: EventMetadata = {
				correlationId: "corr-123",
				customField: "custom-value",
				anotherField: 42,
			};

			const event = createDomainEventWithMetadata(
				"OrderCreated",
				{ orderId: "123" },
				metadata,
			);

			expect(event.metadata?.customField).toBe("custom-value");
			expect(event.metadata?.anotherField).toBe(42);
		});
	});

	describe("copyMetadata()", () => {
		it("should copy metadata from source event", () => {
			const sourceEvent: DomainEvent<"OrderCreated", { orderId: string }> = {
				type: "OrderCreated",
				payload: { orderId: "123" },
				occurredAt: new Date(),
				version: 1,
				metadata: {
					correlationId: "corr-123",
					userId: "user-456",
				},
			};

			const copied = copyMetadata(sourceEvent);

			expect(copied.correlationId).toBe("corr-123");
			expect(copied.userId).toBe("user-456");
		});

		it("should merge additional metadata when copying", () => {
			const sourceEvent: DomainEvent<"OrderCreated", { orderId: string }> = {
				type: "OrderCreated",
				payload: { orderId: "123" },
				occurredAt: new Date(),
				version: 1,
				metadata: {
					correlationId: "corr-123",
					userId: "user-456",
				},
			};

			const copied = copyMetadata(sourceEvent, {
				causationId: "cmd-789",
				source: "order-service",
			});

			expect(copied.correlationId).toBe("corr-123");
			expect(copied.userId).toBe("user-456");
			expect(copied.causationId).toBe("cmd-789");
			expect(copied.source).toBe("order-service");
		});

		it("should override source metadata with additional metadata", () => {
			const sourceEvent: DomainEvent<"OrderCreated", { orderId: string }> = {
				type: "OrderCreated",
				payload: { orderId: "123" },
				occurredAt: new Date(),
				version: 1,
				metadata: {
					correlationId: "corr-123",
					userId: "user-456",
				},
			};

			const copied = copyMetadata(sourceEvent, {
				userId: "user-999", // Override
			});

			expect(copied.correlationId).toBe("corr-123");
			expect(copied.userId).toBe("user-999"); // Overridden
		});

		it("should handle events without metadata", () => {
			const sourceEvent: DomainEvent<"OrderCreated", { orderId: string }> = {
				type: "OrderCreated",
				payload: { orderId: "123" },
				occurredAt: new Date(),
				version: 1,
			};

			const copied = copyMetadata(sourceEvent, {
				correlationId: "corr-123",
			});

			expect(copied.correlationId).toBe("corr-123");
		});
	});

	describe("mergeMetadata()", () => {
		it("should merge multiple metadata objects", () => {
			const metadata1: EventMetadata = {
				correlationId: "corr-123",
			};
			const metadata2: EventMetadata = {
				userId: "user-456",
			};
			const metadata3: EventMetadata = {
				source: "order-service",
			};

			const merged = mergeMetadata(metadata1, metadata2, metadata3);

			expect(merged.correlationId).toBe("corr-123");
			expect(merged.userId).toBe("user-456");
			expect(merged.source).toBe("order-service");
		});

		it("should override earlier metadata with later metadata", () => {
			const metadata1: EventMetadata = {
				correlationId: "corr-123",
				userId: "user-456",
			};
			const metadata2: EventMetadata = {
				userId: "user-999", // Override
				source: "order-service",
			};

			const merged = mergeMetadata(metadata1, metadata2);

			expect(merged.correlationId).toBe("corr-123");
			expect(merged.userId).toBe("user-999"); // Overridden
			expect(merged.source).toBe("order-service");
		});

		it("should handle undefined metadata objects", () => {
			const metadata1: EventMetadata = {
				correlationId: "corr-123",
			};
			const metadata2: EventMetadata | undefined = undefined;
			const metadata3: EventMetadata = {
				userId: "user-456",
			};

			const merged = mergeMetadata(metadata1, metadata2, metadata3);

			expect(merged.correlationId).toBe("corr-123");
			expect(merged.userId).toBe("user-456");
		});

		it("should handle empty metadata objects", () => {
			const merged = mergeMetadata();

			expect(merged).toEqual({});
		});
	});

	describe("EventMetadata interface", () => {
		it("should support all standard metadata fields", () => {
			const metadata: EventMetadata = {
				correlationId: "corr-123",
				causationId: "cmd-456",
				userId: "user-789",
				source: "order-service",
			};

			expect(metadata.correlationId).toBe("corr-123");
			expect(metadata.causationId).toBe("cmd-456");
			expect(metadata.userId).toBe("user-789");
			expect(metadata.source).toBe("order-service");
		});

		it("should support custom metadata fields", () => {
			const metadata: EventMetadata = {
				correlationId: "corr-123",
				customField: "custom-value",
				numericField: 42,
				booleanField: true,
				arrayField: [1, 2, 3],
			};

			expect(metadata.customField).toBe("custom-value");
			expect(metadata.numericField).toBe(42);
			expect(metadata.booleanField).toBe(true);
			expect(metadata.arrayField).toEqual([1, 2, 3]);
		});

		it("should allow partial metadata", () => {
			const metadata: EventMetadata = {
				correlationId: "corr-123",
				// Other fields optional
			};

			expect(metadata.correlationId).toBe("corr-123");
			expect(metadata.causationId).toBeUndefined();
			expect(metadata.userId).toBeUndefined();
		});
	});

	describe("DomainEvent interface", () => {
		it("should support events without version and metadata (backward compatible)", () => {
			const event: DomainEvent<"OrderCreated", { orderId: string }> = {
				type: "OrderCreated",
				payload: { orderId: "123" },
				occurredAt: new Date(),
			};

			expect(event.type).toBe("OrderCreated");
			expect(event.payload).toEqual({ orderId: "123" });
			expect(event.version).toBeUndefined();
			expect(event.metadata).toBeUndefined();
		});

		it("should support events with version only", () => {
			const event: DomainEvent<"OrderCreated", { orderId: string }> = {
				type: "OrderCreated",
				payload: { orderId: "123" },
				occurredAt: new Date(),
				version: 2,
			};

			expect(event.version).toBe(2);
			expect(event.metadata).toBeUndefined();
		});

		it("should support events with metadata only", () => {
			const event: DomainEvent<"OrderCreated", { orderId: string }> = {
				type: "OrderCreated",
				payload: { orderId: "123" },
				occurredAt: new Date(),
				metadata: {
					correlationId: "corr-123",
				},
			};

			expect(event.metadata?.correlationId).toBe("corr-123");
			expect(event.version).toBeUndefined();
		});

		it("should support events with both version and metadata", () => {
			const event: DomainEvent<"OrderCreated", { orderId: string }> = {
				type: "OrderCreated",
				payload: { orderId: "123" },
				occurredAt: new Date(),
				version: 2,
				metadata: {
					correlationId: "corr-123",
					userId: "user-456",
				},
			};

			expect(event.version).toBe(2);
			expect(event.metadata?.correlationId).toBe("corr-123");
			expect(event.metadata?.userId).toBe("user-456");
		});
	});

	describe("Event versioning", () => {
		it("should support different event versions for schema evolution", () => {
			// Version 1 event
			const eventV1 = createDomainEvent("OrderCreated", { orderId: "123" }, {
				version: 1,
			});

			// Version 2 event with additional fields
			const eventV2 = createDomainEvent(
				"OrderCreated",
				{ orderId: "123", customerId: "cust-456" },
				{ version: 2 },
			);

			expect(eventV1.version).toBe(1);
			expect(eventV2.version).toBe(2);
			expect(eventV1.payload).not.toHaveProperty("customerId");
			expect(eventV2.payload).toHaveProperty("customerId");
		});
	});

	describe("Event correlation chain", () => {
		it("should maintain correlation chain across events", () => {
			// Initial event
			const initialEvent = createDomainEventWithMetadata(
				"OrderCreated",
				{ orderId: "123" },
				{
					correlationId: "corr-123",
					causationId: "cmd-456",
					userId: "user-789",
				},
			);

			// Follow-up event maintaining correlation
			const followUpEvent = createDomainEventWithMetadata(
				"OrderShipped",
				{ orderId: "123", trackingNumber: "TRACK-789" },
				copyMetadata(initialEvent, {
					causationId: initialEvent.type, // New causation
				}),
			);

			expect(followUpEvent.metadata?.correlationId).toBe("corr-123");
			expect(followUpEvent.metadata?.causationId).toBe("OrderCreated");
			expect(followUpEvent.metadata?.userId).toBe("user-789");
		});
	});

	describe("sameAggregate()", () => {
		type OrderId = Id<"OrderId">;

		it("should return true for aggregates with same ID and version", () => {
			const agg1 = {
				id: "order-1" as OrderId,
				version: 5 as Version,
			};
			const agg2 = {
				id: "order-1" as OrderId,
				version: 5 as Version,
			};

			expect(sameAggregate(agg1, agg2)).toBe(true);
		});

		it("should return false for aggregates with different IDs", () => {
			const agg1 = {
				id: "order-1" as OrderId,
				version: 5 as Version,
			};
			const agg2 = {
				id: "order-2" as OrderId,
				version: 5 as Version,
			};

			expect(sameAggregate(agg1, agg2)).toBe(false);
		});

		it("should return false for aggregates with different versions", () => {
			const agg1 = {
				id: "order-1" as OrderId,
				version: 5 as Version,
			};
			const agg2 = {
				id: "order-1" as OrderId,
				version: 6 as Version,
			};

			expect(sameAggregate(agg1, agg2)).toBe(false);
		});

		it("should return false for aggregates with different ID and version", () => {
			const agg1 = {
				id: "order-1" as OrderId,
				version: 5 as Version,
			};
			const agg2 = {
				id: "order-2" as OrderId,
				version: 6 as Version,
			};

			expect(sameAggregate(agg1, agg2)).toBe(false);
		});
	});
});

