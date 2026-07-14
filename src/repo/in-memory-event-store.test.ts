import { describe, expect, it } from "vitest";
import type { AggregateAddress } from "../aggregate/aggregate-address";
import { createDomainEvent, type DomainEvent } from "../aggregate/domain-event";
import { ConcurrencyConflictError } from "../core/errors";
import type { Id } from "../core/id";
import { InMemoryEventStore } from "./in-memory-event-store";

type StreamId = Id<"EsOrderId">;
type OrderEvent = DomainEvent<"OrderRenamed", { name: string }>;

const streamA: AggregateAddress<StreamId> = {
	aggregateType: "EsOrder",
	aggregateId: "order-a" as StreamId,
};
const streamB: AggregateAddress<StreamId> = {
	aggregateType: "EsOrder",
	aggregateId: "order-b" as StreamId,
};
const allEvents = { limit: 100 } as const;

function renamed(name: string, stream: AggregateAddress = streamA): OrderEvent {
	return createDomainEvent("OrderRenamed", { name }, stream);
}

describe("InMemoryEventStore", () => {
	it("isolates equal aggregate ids by aggregate type", async () => {
		const store = new InMemoryEventStore<OrderEvent>();
		const aggregateId = "shared-1" as StreamId;
		const salesOrder: AggregateAddress = {
			aggregateType: "SalesOrder",
			aggregateId,
		};
		const fulfillmentOrder: AggregateAddress = {
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

		await expect(
			store.readStream({ ...salesOrder }, allEvents),
		).resolves.toEqual({
			exists: true,
			lastVersion: 1,
			events: [salesEvent],
		});
		await expect(
			store.readStream({ ...fulfillmentOrder }, allEvents),
		).resolves.toEqual({
			exists: true,
			lastVersion: 1,
			events: [fulfillmentEvent],
		});
	});

	it("appends to a new stream at expectedVersion 0 and reads back in order", async () => {
		const store = new InMemoryEventStore<OrderEvent>();
		const first = renamed("a");
		const second = renamed("b");

		await store.append(streamA, [first, second], { expectedVersion: 0 });

		const result = await store.readStream(streamA, allEvents);
		expect(result.lastVersion).toBe(2);
		expect(result.events.map((e) => e.eventId)).toEqual([
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

		const result = await store.readStream(streamA, allEvents);
		expect(result.lastVersion).toBe(2);
		expect(result.events.map((e) => e.eventId)).toEqual([
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
		const result = await store.readStream(streamA, allEvents);
		expect(result.events.map((e) => e.eventId)).toEqual([seeded.eventId]);
	});

	it("rejects an expectedVersion ahead of the stream (lost history is never fabricated)", async () => {
		const store = new InMemoryEventStore<OrderEvent>();

		await expect(
			store.append(streamA, [renamed("a")], { expectedVersion: 3 }),
		).rejects.toBeInstanceOf(ConcurrencyConflictError);
		await expect(store.readStream(streamA, allEvents)).resolves.toEqual({
			exists: false,
			lastVersion: 0,
			events: [],
		});
	});

	it("keeps streams independent", async () => {
		const store = new InMemoryEventStore<OrderEvent>();
		await store.append(streamA, [renamed("a")], { expectedVersion: 0 });

		// streamB is untouched by streamA's history: a fresh create works.
		await store.append(streamB, [renamed("b", streamB)], {
			expectedVersion: 0,
		});

		expect((await store.readStream(streamA, allEvents)).events).toHaveLength(1);
		expect((await store.readStream(streamB, allEvents)).events).toHaveLength(1);
	});

	it("returns an explicit missing-stream result for an unknown stream", async () => {
		const store = new InMemoryEventStore<OrderEvent>();
		await expect(store.readStream(streamA, allEvents)).resolves.toEqual({
			exists: false,
			lastVersion: 0,
			events: [],
		});
	});

	it("reports an existing stream and its head when the read window is empty", async () => {
		const store = new InMemoryEventStore<OrderEvent>();
		await store.append(streamA, [renamed("a"), renamed("b"), renamed("c")], {
			expectedVersion: 0,
		});

		await expect(
			store.readStream(streamA, { ...allEvents, fromVersion: 3 }),
		).resolves.toEqual({
			exists: true,
			lastVersion: 3,
			events: [],
		});
	});

	it("readStream honors fromVersion (events after the given stream position)", async () => {
		const store = new InMemoryEventStore<OrderEvent>();
		const first = renamed("a");
		const second = renamed("b");
		const third = renamed("c");
		await store.append(streamA, [first, second, third], {
			expectedVersion: 0,
		});

		const afterTwo = await store.readStream(streamA, {
			...allEvents,
			fromVersion: 2,
		});
		expect(afterTwo).toMatchObject({ exists: true, lastVersion: 3 });
		expect(afterTwo.events.map((e) => e.eventId)).toEqual([third.eventId]);

		const afterAll = await store.readStream(streamA, {
			...allEvents,
			fromVersion: 3,
		});
		expect(afterAll).toEqual({
			exists: true,
			lastVersion: 3,
			events: [],
		});

		const fromZero = await store.readStream(streamA, {
			...allEvents,
			fromVersion: 0,
		});
		expect(fromZero.events).toHaveLength(3);
	});

	it("bounds each read to the requested page size", async () => {
		const store = new InMemoryEventStore<OrderEvent>();
		const events = ["a", "b", "c", "d"].map((name) => renamed(name));
		await store.append(streamA, events, { expectedVersion: 0 });

		const firstPage = await store.readStream(streamA, { limit: 2 });

		expect(firstPage).toMatchObject({ exists: true, lastVersion: 4 });
		expect(firstPage.events.map((event) => event.eventId)).toEqual(
			events.slice(0, 2).map((event) => event.eventId),
		);
	});

	it.each([
		["missing", undefined],
		["zero", 0],
		["negative", -1],
		["fractional", 1.5],
		["unsafe", Number.MAX_SAFE_INTEGER + 1],
	])("rejects a %s page limit", async (_case, limit) => {
		const store = new InMemoryEventStore<OrderEvent>();
		await store.append(streamA, [renamed("a")], { expectedVersion: 0 });

		await expect(
			store.readStream(
				streamA,
				(limit === undefined ? {} : { limit }) as never,
			),
		).rejects.toBeInstanceOf(RangeError);
	});

	it.each([
		["negative fromVersion", { fromVersion: -1 }],
		["fractional fromVersion", { fromVersion: 1.5 }],
		["unsafe fromVersion", { fromVersion: Number.MAX_SAFE_INTEGER + 1 }],
		["negative toVersion", { toVersion: -1 }],
		["fractional toVersion", { toVersion: 1.5 }],
		["unsafe toVersion", { toVersion: Number.MAX_SAFE_INTEGER + 1 }],
	])("rejects a %s", async (_case, invalidBound) => {
		const store = new InMemoryEventStore<OrderEvent>();
		await store.append(streamA, [renamed("a"), renamed("b")], {
			expectedVersion: 0,
		});

		await expect(
			store.readStream(streamA, { limit: 1, ...invalidBound }),
		).rejects.toBeInstanceOf(RangeError);
	});

	it("readStream honors an inclusive toVersion while reporting the actual head", async () => {
		const store = new InMemoryEventStore<OrderEvent>();
		const first = renamed("a");
		const second = renamed("b");
		const third = renamed("c");
		await store.append(streamA, [first, second, third], {
			expectedVersion: 0,
		});

		const asOfTwo = await store.readStream(streamA, {
			...allEvents,
			toVersion: 2,
		});

		expect(asOfTwo).toMatchObject({ exists: true, lastVersion: 3 });
		expect(asOfTwo.events.map((event) => event.eventId)).toEqual([
			first.eventId,
			second.eventId,
		]);
	});

	it("treats an empty append as a no-op", async () => {
		const store = new InMemoryEventStore<OrderEvent>();

		await store.append(streamA, [], { expectedVersion: 0 });

		await expect(store.readStream(streamA, allEvents)).resolves.toEqual({
			exists: false,
			lastVersion: 0,
			events: [],
		});
	});

	it("never hands out its internal array", async () => {
		const store = new InMemoryEventStore<OrderEvent>();
		await store.append(streamA, [renamed("a")], { expectedVersion: 0 });

		const events = (await store.readStream(streamA, allEvents))
			.events as OrderEvent[];
		events.push(renamed("smuggled"));

		expect((await store.readStream(streamA, allEvents)).events).toHaveLength(1);
	});
});

describe("store hygiene", () => {
	it("readStream is side-effect free: an unknown id does not grow the store", async () => {
		const store = new InMemoryEventStore();

		await store.readStream(
			{ aggregateType: "Ghost", aggregateId: "ghost-1" },
			allEvents,
		);
		await store.readStream(
			{ aggregateType: "Ghost", aggregateId: "ghost-2" },
			allEvents,
		);

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
