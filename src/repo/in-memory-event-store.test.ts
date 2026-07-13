import { describe, expect, it } from "vitest";
import { createDomainEvent, type DomainEvent } from "../aggregate/domain-event";
import { ConcurrencyConflictError } from "../core/errors";
import type { Id } from "../core/id";
import type { StreamKey } from "./event-store";
import { InMemoryEventStore } from "./in-memory-event-store";

type StreamId = Id<"EsOrderId">;
type OrderEvent = DomainEvent<"OrderRenamed", { name: string }>;

const streamA: StreamKey<StreamId> = {
	aggregateType: "EsOrder",
	aggregateId: "order-a" as StreamId,
};
const streamB: StreamKey<StreamId> = {
	aggregateType: "EsOrder",
	aggregateId: "order-b" as StreamId,
};

function renamed(name: string, stream: StreamKey = streamA): OrderEvent {
	return createDomainEvent("OrderRenamed", { name }, stream);
}

describe("InMemoryEventStore", () => {
	it("isolates equal aggregate ids by aggregate type", async () => {
		const store = new InMemoryEventStore<OrderEvent>();
		const aggregateId = "shared-1" as StreamId;
		const salesOrder: StreamKey = {
			aggregateType: "SalesOrder",
			aggregateId,
		};
		const fulfillmentOrder: StreamKey = {
			aggregateType: "FulfillmentOrder",
			aggregateId,
		};
		const salesEvent = createDomainEvent(
			"OrderRenamed",
			{ name: "sales" },
			salesOrder,
		);
		const fulfillmentEvent = createDomainEvent(
			"OrderRenamed",
			{ name: "fulfillment" },
			fulfillmentOrder,
		);

		await store.append(salesOrder, [salesEvent], { expectedVersion: 0 });
		await store.append(fulfillmentOrder, [fulfillmentEvent], {
			expectedVersion: 0,
		});

		await expect(store.readStream({ ...salesOrder })).resolves.toEqual([
			salesEvent,
		]);
		await expect(store.readStream({ ...fulfillmentOrder })).resolves.toEqual([
			fulfillmentEvent,
		]);
	});

	it("appends to a new stream at expectedVersion 0 and reads back in order", async () => {
		const store = new InMemoryEventStore<OrderEvent>();
		const first = renamed("a");
		const second = renamed("b");

		await store.append(streamA, [first, second], { expectedVersion: 0 });

		const events = await store.readStream(streamA);
		expect(events.map((e) => e.eventId)).toEqual([
			first.eventId,
			second.eventId,
		]);
	});

	it("appends subsequent events when expectedVersion matches the stream length", async () => {
		const store = new InMemoryEventStore<OrderEvent>();
		const first = renamed("a");
		const second = renamed("b");
		await store.append(streamA, [first], { expectedVersion: 0 });

		await store.append(streamA, [second], { expectedVersion: 1 });

		const events = await store.readStream(streamA);
		expect(events.map((e) => e.eventId)).toEqual([
			first.eventId,
			second.eventId,
		]);
	});

	it("rejects a stale append with ConcurrencyConflictError and leaves the stream untouched", async () => {
		const store = new InMemoryEventStore<OrderEvent>();
		const seeded = renamed("a");
		await store.append(streamA, [seeded], { expectedVersion: 0 });

		const rejection = await store
			.append(streamA, [renamed("b"), renamed("c")], { expectedVersion: 0 })
			.then(
				() => undefined,
				(error: unknown) => error,
			);

		expect(rejection).toBeInstanceOf(ConcurrencyConflictError);
		const conflict = rejection as ConcurrencyConflictError;
		expect(conflict.expectedVersion).toBe(0);
		expect(conflict.actualVersion).toBe(1);
		// Rejected appends are atomic: neither of the two events landed.
		const events = await store.readStream(streamA);
		expect(events.map((e) => e.eventId)).toEqual([seeded.eventId]);
	});

	it("rejects an expectedVersion ahead of the stream (lost history is never fabricated)", async () => {
		const store = new InMemoryEventStore<OrderEvent>();

		await expect(
			store.append(streamA, [renamed("a")], { expectedVersion: 3 }),
		).rejects.toBeInstanceOf(ConcurrencyConflictError);
		expect(await store.readStream(streamA)).toHaveLength(0);
	});

	it("keeps streams independent", async () => {
		const store = new InMemoryEventStore<OrderEvent>();
		await store.append(streamA, [renamed("a")], { expectedVersion: 0 });

		// streamB is untouched by streamA's history: a fresh create works.
		await store.append(streamB, [renamed("b", streamB)], {
			expectedVersion: 0,
		});

		expect(await store.readStream(streamA)).toHaveLength(1);
		expect(await store.readStream(streamB)).toHaveLength(1);
	});

	it("returns an empty array for an unknown stream", async () => {
		const store = new InMemoryEventStore<OrderEvent>();
		expect(await store.readStream(streamA)).toEqual([]);
	});

	it("readStream honors fromVersion (events after the given stream position)", async () => {
		const store = new InMemoryEventStore<OrderEvent>();
		const first = renamed("a");
		const second = renamed("b");
		const third = renamed("c");
		await store.append(streamA, [first, second, third], {
			expectedVersion: 0,
		});

		const afterTwo = await store.readStream(streamA, { fromVersion: 2 });
		expect(afterTwo.map((e) => e.eventId)).toEqual([third.eventId]);

		const afterAll = await store.readStream(streamA, { fromVersion: 3 });
		expect(afterAll).toEqual([]);

		const fromZero = await store.readStream(streamA, { fromVersion: 0 });
		expect(fromZero).toHaveLength(3);
	});

	it("treats an empty append as a no-op", async () => {
		const store = new InMemoryEventStore<OrderEvent>();

		await store.append(streamA, [], { expectedVersion: 0 });

		expect(await store.readStream(streamA)).toEqual([]);
	});

	it("never hands out its internal array", async () => {
		const store = new InMemoryEventStore<OrderEvent>();
		await store.append(streamA, [renamed("a")], { expectedVersion: 0 });

		const events = (await store.readStream(streamA)) as OrderEvent[];
		events.push(renamed("smuggled"));

		expect(await store.readStream(streamA)).toHaveLength(1);
	});
});

describe("store hygiene", () => {
	it("readStream is side-effect free: an unknown id does not grow the store", async () => {
		const store = new InMemoryEventStore();

		await store.readStream({ aggregateType: "Ghost", aggregateId: "ghost-1" });
		await store.readStream({ aggregateType: "Ghost", aggregateId: "ghost-2" });

		expect(
			(store as unknown as { streams: Map<string, unknown> }).streams.size,
		).toBe(0);
	});

	it("a rejected append on a nonexistent stream leaves no empty entry behind", async () => {
		const store = new InMemoryEventStore();

		await expect(
			store.append(
				{ aggregateType: "A", aggregateId: "ghost" },
				[{ eventId: "e1", type: "T", aggregateType: "A" } as never],
				{ expectedVersion: 5 },
			),
		).rejects.toThrow();

		expect(
			(store as unknown as { streams: Map<string, unknown> }).streams.size,
		).toBe(0);
	});
});
