import { describe, expect, it } from "vite-plus/test";
import { createDomainEvent, type DomainEvent } from "../aggregate/aggregate";
import {
	EventHarvestError,
	InMemoryCapacityExceededError,
} from "../core/errors";
import { InMemoryOutbox, outboxWriterAcceptingEventLoss } from "./outbox";
import type { EventCommitCandidate } from "./ports";

type OrderCreated = DomainEvent<"OrderCreated", { orderId: string }>;

function candidate(
	event: OrderCreated,
	aggregateVersion = 1,
): EventCommitCandidate<OrderCreated> {
	return {
		event,
		source: {
			aggregateId: event.aggregateId ?? event.payload.orderId,
			aggregateType: event.aggregateType ?? "Order",
		},
		position: {
			aggregateVersion,
			commitSequence: 0,
			commitSize: 1,
		},
	};
}

describe("InMemoryOutbox", () => {
	describe("capacity", () => {
		it("rejects an oversized batch atomically and releases record capacity after acknowledgement", async () => {
			const outbox = new InMemoryOutbox<OrderCreated>({ maxRecords: 1 });
			const first = createDomainEvent("OrderCreated", { orderId: "o-1" });
			const second = createDomainEvent("OrderCreated", { orderId: "o-2" });

			await expect(
				outbox.add([candidate(first), candidate(second)]),
			).rejects.toMatchObject({
				code: "IN_MEMORY_CAPACITY_EXCEEDED",
				store: "InMemoryOutbox",
				resource: "records",
				limit: 1,
				current: 0,
				attempted: 2,
			});
			expect(await outbox.getPending()).toEqual([]);

			await outbox.add([candidate(first)]);
			await expect(outbox.add([candidate(first)])).resolves.toBeUndefined();
			await outbox.markDispatched([first.eventId]);
			await expect(outbox.add([candidate(second)])).resolves.toBeUndefined();
		});

		it("counts a dead letter as the same record and permits requeue at capacity", async () => {
			const outbox = new InMemoryOutbox<OrderCreated>({
				maxRecords: 1,
				maxDeliveryAttempts: 1,
			});
			const event = createDomainEvent("OrderCreated", { orderId: "o-1" });
			await outbox.add([candidate(event)]);

			await outbox.markFailed(event.eventId, new Error("poison"));
			expect(await outbox.deadLetters()).toHaveLength(1);
			await expect(outbox.add([candidate(event)])).resolves.toBeUndefined();
			expect(await outbox.deadLetters()).toEqual([]);
			expect(await outbox.getPending()).toHaveLength(1);
		});

		it("rejects a new source atomically while allowing the existing source to advance", async () => {
			const outbox = new InMemoryOutbox<OrderCreated>({
				maxRecords: 2,
				maxSources: 1,
			});
			const forSource = (eventId: string, aggregateId: string) =>
				createDomainEvent(
					"OrderCreated",
					{ orderId: aggregateId },
					{ eventId, aggregateType: "Order", aggregateId },
				);
			const first = forSource("evt-o1-1", "o-1");
			const next = forSource("evt-o1-2", "o-1");
			const foreign = forSource("evt-o2-1", "o-2");
			await outbox.add([candidate(first, 1)]);
			await outbox.markDispatched([first.eventId]);

			await expect(
				outbox.add([candidate(next, 2), candidate(foreign, 1)]),
			).rejects.toBeInstanceOf(InMemoryCapacityExceededError);
			expect(await outbox.getPending()).toEqual([]);

			await expect(outbox.add([candidate(next, 2)])).resolves.toBeUndefined();
			await expect(outbox.add([candidate(foreign, 1)])).rejects.toMatchObject({
				resource: "sources",
				limit: 1,
				current: 1,
				attempted: 1,
			});
		});

		it.each([
			["maxRecords", 0],
			["maxRecords", -1],
			["maxRecords", 1.5],
			["maxRecords", Number.MAX_SAFE_INTEGER + 1],
			["maxSources", 0],
			["maxSources", -1],
			["maxSources", 1.5],
			["maxSources", Number.MAX_SAFE_INTEGER + 1],
		] as const)("rejects invalid %s capacity %s", (name, value) => {
			expect(() => new InMemoryOutbox({ [name]: value })).toThrow(RangeError);
		});
	});

	it("stores the committed envelope while exposing its bare event in the record", async () => {
		const outbox = new InMemoryOutbox<OrderCreated>();
		const event = createDomainEvent("OrderCreated", { orderId: "o-1" });
		const message = candidate(event, 4);

		await outbox.add([message]);

		const [record] = await outbox.getPending();
		expect(record).toMatchObject({
			dispatchId: event.eventId,
			event,
			source: message.source,
			position: {
				aggregateVersion: 4,
				commitSequence: 0,
				commitSize: 1,
				previousEventfulAggregateVersion: null,
			},
		});
	});

	it("defensively owns source and position after add", async () => {
		const outbox = new InMemoryOutbox<OrderCreated>();
		const event = createDomainEvent("OrderCreated", { orderId: "o-1" });
		const message = candidate(event, 4);

		await outbox.add([message]);
		(message.source as { aggregateId: string }).aggregateId = "tampered";
		(message.position as { aggregateVersion: number }).aggregateVersion = 99;

		const [record] = await outbox.getPending();
		expect(record?.source.aggregateId).toBe("o-1");
		expect(record?.position.aggregateVersion).toBe(4);
	});

	describe("eventId collisions across aggregate sources", () => {
		const eventFor = (
			eventId: string,
			aggregateType: string,
			aggregateId: string,
		) =>
			createDomainEvent(
				"OrderCreated",
				{ orderId: aggregateId },
				{ eventId, aggregateType, aggregateId },
			);

		it("rejects a pending collision without replacing the record or advancing the foreign source", async () => {
			const outbox = new InMemoryOutbox<OrderCreated>();
			const original = eventFor("evt-collision", "Order", "o-1");
			const collision = eventFor("evt-collision", "Invoice", "i-1");
			await outbox.add([candidate(original, 1)]);

			await expect(
				outbox.add([candidate(collision, 1)]),
			).rejects.toBeInstanceOf(EventHarvestError);

			const foreignNext = eventFor("evt-invoice-next", "Invoice", "i-1");
			await outbox.add([candidate(foreignNext, 2)]);
			const pending = await outbox.getPending();
			expect(pending).toHaveLength(2);
			expect(pending[0]).toMatchObject({
				event: original,
				source: { aggregateType: "Order", aggregateId: "o-1" },
			});
			expect(pending[1]).toMatchObject({
				event: foreignNext,
				source: { aggregateType: "Invoice", aggregateId: "i-1" },
				position: { previousEventfulAggregateVersion: null },
			});
		});

		it("rejects a dead-letter collision without requeueing the recorded event", async () => {
			const outbox = new InMemoryOutbox<OrderCreated>({
				maxDeliveryAttempts: 1,
			});
			const original = eventFor("evt-collision", "Order", "o-1");
			const collision = eventFor("evt-collision", "Invoice", "i-1");
			await outbox.add([candidate(original)]);
			await outbox.markFailed(original.eventId, new Error("poison"));

			await expect(outbox.add([candidate(collision)])).rejects.toBeInstanceOf(
				EventHarvestError,
			);

			expect(await outbox.getPending()).toEqual([]);
			expect(await outbox.deadLetters()).toMatchObject([
				{
					event: original,
					source: { aggregateType: "Order", aggregateId: "o-1" },
				},
			]);
		});

		it("rejects a collision covered by a retained dispatched receipt", async () => {
			const outbox = new InMemoryOutbox<OrderCreated>();
			const original = eventFor("evt-collision", "Order", "o-1");
			const collision = eventFor("evt-collision", "Invoice", "i-1");
			await outbox.add([candidate(original)]);
			await outbox.markDispatched([original.eventId]);

			await expect(outbox.add([candidate(collision)])).rejects.toBeInstanceOf(
				EventHarvestError,
			);

			expect(await outbox.getPending()).toEqual([]);
		});
	});

	describe("event identity at one qualified source position", () => {
		const eventAt = (eventId: string, aggregateVersion: number) =>
			candidate(
				createDomainEvent(
					"OrderCreated",
					{ orderId: "o-position" },
					{
						eventId,
						aggregateId: "o-position",
						aggregateType: "Order",
					},
				),
				aggregateVersion,
			);

		it("rejects a different eventId at an occupied position without changing records or the source head", async () => {
			const outbox = new InMemoryOutbox<OrderCreated>();
			const original = eventAt("evt-position-original", 1);
			const collision = eventAt("evt-position-collision", 1);

			await outbox.add([original]);
			await expect(outbox.add([collision])).rejects.toBeInstanceOf(
				EventHarvestError,
			);

			const next = eventAt("evt-position-next", 2);
			await outbox.add([next]);
			const pending = await outbox.getPending();
			expect(pending.map(({ event }) => event.eventId)).toEqual([
				original.event.eventId,
				next.event.eventId,
			]);
			expect(pending[1]?.position.previousEventfulAggregateVersion).toBe(1);
		});

		it("rejects an intra-add position collision atomically", async () => {
			const outbox = new InMemoryOutbox<OrderCreated>();
			const original = eventAt("evt-intra-add-original", 1);
			const collision = eventAt("evt-intra-add-collision", 1);

			await expect(outbox.add([original, collision])).rejects.toBeInstanceOf(
				EventHarvestError,
			);
			expect(await outbox.getPending()).toEqual([]);

			const afterRejectedBatch = eventAt("evt-after-rejected-batch", 2);
			await outbox.add([afterRejectedBatch]);
			const [record] = await outbox.getPending();
			expect(record?.position.previousEventfulAggregateVersion).toBeNull();
		});

		it("rejects moving a pending eventId to another sequence of the same commit", async () => {
			const outbox = new InMemoryOutbox<OrderCreated>();
			const original = {
				...eventAt("evt-pending-position", 1),
				position: {
					aggregateVersion: 1,
					commitSequence: 0,
					commitSize: 2,
				},
			};
			await outbox.add([original]);

			await expect(
				outbox.add([
					{
						...original,
						position: { ...original.position, commitSequence: 1 },
					},
				]),
			).rejects.toBeInstanceOf(EventHarvestError);

			const [record] = await outbox.getPending();
			expect(record?.position.commitSequence).toBe(0);
		});
	});

	it("derives the predecessor from the last eventful source commit, not the aggregate OCC baseline", async () => {
		const outbox = new InMemoryOutbox<OrderCreated>();
		const first = createDomainEvent(
			"OrderCreated",
			{ orderId: "o-1" },
			{ aggregateId: "o-1", aggregateType: "Order" },
		);
		await outbox.add([candidate(first, 1)]);
		await outbox.markDispatched([first.eventId]);

		// Aggregate v2 was persisted without an event. The next eventful
		// commit is v3, but its predecessor in the EVENT source is still v1.
		const afterStateOnlySave = createDomainEvent(
			"OrderCreated",
			{ orderId: "o-1" },
			{ aggregateId: "o-1", aggregateType: "Order" },
		);
		await outbox.add([candidate(afterStateOnlySave, 3)]);

		const [record] = await outbox.getPending();
		expect(record?.position.previousEventfulAggregateVersion).toBe(1);
	});

	it("treats the first event after state-only persistence as event-source genesis", async () => {
		const outbox = new InMemoryOutbox<OrderCreated>();
		const firstEvent = createDomainEvent(
			"OrderCreated",
			{ orderId: "o-1" },
			{ aggregateId: "o-1", aggregateType: "Order" },
		);

		// Aggregate v1 was persisted without an event; its first eventful
		// commit therefore has no event-source predecessor even though it is v2.
		await outbox.add([candidate(firstEvent, 2)]);

		const [record] = await outbox.getPending();
		expect(record?.position.previousEventfulAggregateVersion).toBeNull();
	});

	it("dedupes a recently dispatched eventId without rewinding the source head", async () => {
		const outbox = new InMemoryOutbox<OrderCreated>();
		const first = createDomainEvent(
			"OrderCreated",
			{ orderId: "o-1" },
			{ eventId: "evt-v1", aggregateId: "o-1", aggregateType: "Order" },
		);
		const second = createDomainEvent(
			"OrderCreated",
			{ orderId: "o-1" },
			{ eventId: "evt-v2", aggregateId: "o-1", aggregateType: "Order" },
		);
		const third = createDomainEvent(
			"OrderCreated",
			{ orderId: "o-1" },
			{ eventId: "evt-v3", aggregateId: "o-1", aggregateType: "Order" },
		);
		await outbox.add([candidate(first, 1)]);
		await outbox.markDispatched([first.eventId]);
		await outbox.add([candidate(second, 2)]);
		await outbox.markDispatched([second.eventId]);

		await outbox.add([candidate(first, 1)]);
		expect(await outbox.getPending()).toEqual([]);

		await outbox.add([candidate(third, 3)]);
		const [record] = await outbox.getPending();
		expect(record?.event.eventId).toBe("evt-v3");
		expect(record?.position.previousEventfulAggregateVersion).toBe(2);
	});

	it("rejects a retained dispatched eventId with a different commit position", async () => {
		const outbox = new InMemoryOutbox<OrderCreated>();
		const event = createDomainEvent(
			"OrderCreated",
			{ orderId: "o-dispatched-receipt" },
			{
				eventId: "evt-dispatched-receipt",
				aggregateId: "o-dispatched-receipt",
				aggregateType: "Order",
			},
		);
		await outbox.add([candidate(event, 1)]);
		await outbox.markDispatched([event.eventId]);

		await expect(outbox.add([candidate(event, 2)])).rejects.toBeInstanceOf(
			EventHarvestError,
		);
		expect(await outbox.getPending()).toEqual([]);
	});

	it("preflights a late contradictory retry before mutating earlier batch entries", async () => {
		const outbox = new InMemoryOutbox<OrderCreated>();
		const event = (eventId: string) =>
			createDomainEvent(
				"OrderCreated",
				{ orderId: "o-atomic-receipt" },
				{
					eventId,
					aggregateId: "o-atomic-receipt",
					aggregateType: "Order",
				},
			);
		const retained = event("evt-retained-receipt");
		await outbox.add([candidate(retained, 1)]);
		await outbox.markDispatched([retained.eventId]);

		const fresh = candidate(event("evt-fresh-prefix"), 2);
		const contradictoryRetry = candidate(retained, 2);
		await expect(
			outbox.add([
				{
					...fresh,
					position: { ...fresh.position, commitSequence: 0, commitSize: 2 },
				},
				{
					...contradictoryRetry,
					position: {
						...contradictoryRetry.position,
						commitSequence: 1,
						commitSize: 2,
					},
				},
			]),
		).rejects.toBeInstanceOf(EventHarvestError);

		expect(await outbox.getPending()).toEqual([]);
		const successor = event("evt-successor-after-rejection");
		await outbox.add([candidate(successor, 2)]);
		const [record] = await outbox.getPending();
		expect(record?.position.previousEventfulAggregateVersion).toBe(1);
	});

	it("rejects a batch-local eventId reassignment before mutating pending records or the source head", async () => {
		const outbox = new InMemoryOutbox<OrderCreated>();
		const event = (eventId: string) =>
			createDomainEvent(
				"OrderCreated",
				{ orderId: "o-batch-self-collision" },
				{
					eventId,
					aggregateId: "o-batch-self-collision",
					aggregateType: "Order",
				},
			);
		const repeated = event("evt-batch-self-collision");
		const first = {
			...candidate(repeated, 1),
			position: {
				aggregateVersion: 1,
				commitSequence: 0,
				commitSize: 2,
			},
		};
		const reassigned = {
			...first,
			position: { ...first.position, commitSequence: 1 },
		};

		await expect(outbox.add([first, reassigned])).rejects.toBeInstanceOf(
			EventHarvestError,
		);
		expect(await outbox.getPending()).toEqual([]);

		await outbox.add([candidate(event("evt-after-self-collision"), 2)]);
		const [record] = await outbox.getPending();
		expect(record?.position.previousEventfulAggregateVersion).toBeNull();
	});

	it("keeps an exact batch-local eventId repetition idempotent", async () => {
		const outbox = new InMemoryOutbox<OrderCreated>();
		const event = createDomainEvent(
			"OrderCreated",
			{ orderId: "o-exact-batch-retry" },
			{
				eventId: "evt-exact-batch-retry",
				aggregateId: "o-exact-batch-retry",
				aggregateType: "Order",
			},
		);
		const exact = candidate(event, 1);

		await outbox.add([
			exact,
			{
				...exact,
				source: { ...exact.source },
				position: { ...exact.position },
			},
		]);

		expect(await outbox.getPending()).toMatchObject([
			{
				event,
				position: {
					aggregateVersion: 1,
					commitSequence: 0,
					commitSize: 1,
					previousEventfulAggregateVersion: null,
				},
			},
		]);
	});

	it("rejects an evicted stale candidate without changing the source head", async () => {
		const outbox = new InMemoryOutbox<OrderCreated>({
			maxRetainedDispatchedEventIds: 1,
		});
		const event = (eventId: string) =>
			createDomainEvent(
				"OrderCreated",
				{ orderId: "o-1" },
				{ eventId, aggregateId: "o-1", aggregateType: "Order" },
			);
		const first = event("evt-v1");
		const second = event("evt-v2");
		const third = event("evt-v3");
		await outbox.add([candidate(first, 1)]);
		await outbox.markDispatched([first.eventId]);
		await outbox.add([candidate(second, 2)]);
		await outbox.markDispatched([second.eventId]);

		await expect(outbox.add([candidate(first, 1)])).rejects.toBeInstanceOf(
			EventHarvestError,
		);
		await outbox.add([candidate(third, 3)]);

		const [record] = await outbox.getPending();
		expect(record?.event.eventId).toBe("evt-v3");
		expect(record?.position.previousEventfulAggregateVersion).toBe(2);
	});

	it("rejects a downward pending refresh without changing the record or source head", async () => {
		const outbox = new InMemoryOutbox<OrderCreated>();
		const event = (eventId: string) =>
			createDomainEvent(
				"OrderCreated",
				{ orderId: "o-1" },
				{ eventId, aggregateId: "o-1", aggregateType: "Order" },
			);
		const pending = event("evt-pending");
		const next = event("evt-next");
		await outbox.add([candidate(pending, 3)]);

		await expect(outbox.add([candidate(pending, 1)])).rejects.toBeInstanceOf(
			EventHarvestError,
		);
		await outbox.add([candidate(next, 4)]);

		expect(
			(await outbox.getPending()).map((record) => ({
				eventId: record.event.eventId,
				aggregateVersion: record.position.aggregateVersion,
				previousEventfulAggregateVersion:
					record.position.previousEventfulAggregateVersion,
			})),
		).toEqual([
			{
				eventId: "evt-pending",
				aggregateVersion: 3,
				previousEventfulAggregateVersion: null,
			},
			{
				eventId: "evt-next",
				aggregateVersion: 4,
				previousEventfulAggregateVersion: 3,
			},
		]);
	});

	it("getPending returns everything added until something is marked", async () => {
		const outbox = new InMemoryOutbox<OrderCreated>();
		const e1 = createDomainEvent("OrderCreated", { orderId: "o-1" });
		const e2 = createDomainEvent("OrderCreated", { orderId: "o-2" });

		await outbox.add([candidate(e1), candidate(e2)]);

		const pending = await outbox.getPending();
		expect(pending).toHaveLength(2);
		expect(pending.map((r) => r.event.payload.orderId)).toEqual(
			expect.arrayContaining(["o-1", "o-2"]),
		);
	});

	it("markDispatched removes only the matching records", async () => {
		const outbox = new InMemoryOutbox<OrderCreated>();
		const e1 = createDomainEvent("OrderCreated", { orderId: "o-1" });
		const e2 = createDomainEvent("OrderCreated", { orderId: "o-2" });
		await outbox.add([candidate(e1), candidate(e2)]);

		await outbox.markDispatched([e1.eventId]);

		const pending = await outbox.getPending();
		expect(pending).toHaveLength(1);
		expect(pending[0]?.event.payload.orderId).toBe("o-2");
	});

	it("markDispatched is idempotent on already-marked ids", async () => {
		const outbox = new InMemoryOutbox<OrderCreated>();
		const e = createDomainEvent("OrderCreated", { orderId: "o-1" });
		await outbox.add([candidate(e)]);

		await outbox.markDispatched([e.eventId]);
		// Calling again on the same id must not throw
		await expect(outbox.markDispatched([e.eventId])).resolves.toBeUndefined();
		// Calling with an id that was never in the outbox must not throw
		await expect(
			outbox.markDispatched(["never-existed"]),
		).resolves.toBeUndefined();

		expect(await outbox.getPending()).toHaveLength(0);
	});

	it("getPending respects the optional limit", async () => {
		const outbox = new InMemoryOutbox<OrderCreated>();
		await outbox.add(
			["o-1", "o-2", "o-3"].map((orderId) =>
				candidate(createDomainEvent("OrderCreated", { orderId })),
			),
		);

		const firstTwo = await outbox.getPending(2);
		expect(firstTwo).toHaveLength(2);
	});

	it("getPending with a zero or negative limit returns nothing", async () => {
		const outbox = new InMemoryOutbox<OrderCreated>();
		await outbox.add(
			["o-1", "o-2", "o-3"].map((orderId) =>
				candidate(createDomainEvent("OrderCreated", { orderId })),
			),
		);

		// A dispatcher computing `batchSize - inFlight` can go negative:
		// slice's end-relative indexing must not dispatch the whole backlog.
		expect(await outbox.getPending(0)).toHaveLength(0);
		expect(await outbox.getPending(-1)).toHaveLength(0);
	});

	it("re-adding the same eventId is naturally idempotent", async () => {
		// Re-adds (via at-least-once consumers, transactional outbox-
		// dispatcher retries, etc.) overwrite the existing entry keyed on
		// eventId, so getPending still returns each event exactly once.
		const outbox = new InMemoryOutbox<OrderCreated>();
		const e = createDomainEvent("OrderCreated", { orderId: "o-1" });

		await outbox.add([candidate(e)]);
		await outbox.add([candidate(e)]); // duplicate add

		const pending = await outbox.getPending();
		expect(pending).toHaveLength(1);
		expect(pending[0]?.dispatchId).toBe(e.eventId);
	});

	it("getPending returns records in insertion (commit) order", async () => {
		// The port contract: withCommit promises subscribers per-aggregate
		// causal order; a dispatcher can only honor it when getPending
		// preserves add() order.
		const outbox = new InMemoryOutbox<OrderCreated>();
		const e1 = createDomainEvent("OrderCreated", { orderId: "o-1" });
		const e2 = createDomainEvent("OrderCreated", { orderId: "o-2" });
		const e3 = createDomainEvent("OrderCreated", { orderId: "o-3" });
		await outbox.add([candidate(e1), candidate(e2)]);
		await outbox.add([candidate(e3)]);

		const pending = await outbox.getPending();
		expect(pending.map((r) => r.event.eventId)).toEqual([
			e1.eventId,
			e2.eventId,
			e3.eventId,
		]);
	});

	describe("dispatch tracking (markFailed / deadLetters)", () => {
		it("markFailed increments the record's attempts, visible on getPending", async () => {
			const outbox = new InMemoryOutbox<OrderCreated>();
			const e = createDomainEvent("OrderCreated", { orderId: "o-1" });
			await outbox.add([candidate(e)]);

			await outbox.markFailed(e.eventId, new Error("broker down"));

			const pending = await outbox.getPending();
			expect(pending).toHaveLength(1);
			expect(pending[0]?.attempts).toBe(1);
		});

		it("keeps insertion order across failures (a failed record does not move)", async () => {
			const outbox = new InMemoryOutbox<OrderCreated>();
			const e1 = createDomainEvent("OrderCreated", { orderId: "o-1" });
			const e2 = createDomainEvent("OrderCreated", { orderId: "o-2" });
			await outbox.add([candidate(e1), candidate(e2)]);

			await outbox.markFailed(e1.eventId, new Error("transient"));

			const pending = await outbox.getPending();
			expect(pending.map((r) => r.event.eventId)).toEqual([
				e1.eventId,
				e2.eventId,
			]);
		});

		it("dead-letters a record after maxDeliveryAttempts failures", async () => {
			const outbox = new InMemoryOutbox<OrderCreated>({
				maxDeliveryAttempts: 2,
			});
			const poison = createDomainEvent("OrderCreated", { orderId: "o-1" });
			const healthy = createDomainEvent("OrderCreated", { orderId: "o-2" });
			await outbox.add([candidate(poison), candidate(healthy)]);

			await outbox.markFailed(poison.eventId, new Error("first failure"));
			expect(await outbox.getPending()).toHaveLength(2);

			await outbox.markFailed(poison.eventId, new Error("second failure"));

			// The poison record stops coming back; the healthy one still does.
			const pending = await outbox.getPending();
			expect(pending.map((r) => r.event.eventId)).toEqual([healthy.eventId]);

			const dead = await outbox.deadLetters();
			expect(dead).toHaveLength(1);
			expect(dead[0]?.event.eventId).toBe(poison.eventId);
			expect(dead[0]?.attempts).toBe(2);
			expect(dead[0]?.lastError).toContain("second failure");
		});

		it("markFailed on an unknown or already-dispatched id is a no-op", async () => {
			const outbox = new InMemoryOutbox<OrderCreated>();
			const e = createDomainEvent("OrderCreated", { orderId: "o-1" });
			await outbox.add([candidate(e)]);
			await outbox.markDispatched([e.eventId]);

			await expect(
				outbox.markFailed(e.eventId, new Error("late failure")),
			).resolves.toBeUndefined();
			await expect(
				outbox.markFailed("never-existed", new Error("noise")),
			).resolves.toBeUndefined();

			expect(await outbox.deadLetters()).toHaveLength(0);
		});

		it("re-adding a pending event refreshes the stored copy but keeps the delivery bookkeeping", async () => {
			// A failed-commit-then-retry re-adds the same eventId with a NEWLY
			// stamped aggregateVersion (withCommit stamps at harvest). The
			// outbox must serve the latest copy, or dispatched events carry a
			// version from a commit that never happened; the attempts count
			// belongs to delivery, not to the payload, and survives.
			const outbox = new InMemoryOutbox<OrderCreated>();
			const staleCopy = createDomainEvent(
				"OrderCreated",
				{ orderId: "o-1" },
				{ eventId: "evt-1" },
			);
			const committedCopy = createDomainEvent(
				"OrderCreated",
				{ orderId: "o-1" },
				{ eventId: "evt-1" },
			);
			await outbox.add([candidate(staleCopy, 3)]);
			await outbox.markFailed("evt-1", new Error("broker down"));

			await outbox.add([candidate(committedCopy, 4)]);

			const pending = await outbox.getPending();
			expect(pending).toHaveLength(1);
			expect(pending[0]?.position.aggregateVersion).toBe(4);
			// The v3 envelope leaked from a transaction that rolled back. A
			// refresh of that same eventId replaces the uncommitted position;
			// it must not turn the leaked v3 into a durable predecessor.
			expect(pending[0]?.position.previousEventfulAggregateVersion).toBeNull();
			expect(pending[0]?.attempts).toBe(1);
		});

		it("re-adding a dead-lettered event requeues it with a fresh attempts budget", async () => {
			// add() is the natural inverse of deadLetters() for requeue
			// tooling: after the handler bug is fixed, re-adding the event
			// moves it back into automatic dispatch instead of silently
			// succeeding while the event stays dead.
			const outbox = new InMemoryOutbox<OrderCreated>({
				maxDeliveryAttempts: 1,
			});
			const e = createDomainEvent("OrderCreated", { orderId: "o-1" });
			await outbox.add([candidate(e)]);
			await outbox.markFailed(e.eventId, new Error("poison"));
			expect(await outbox.deadLetters()).toHaveLength(1);

			await outbox.add([candidate(e)]);

			expect(await outbox.deadLetters()).toHaveLength(0);
			const pending = await outbox.getPending();
			expect(pending).toHaveLength(1);
			expect(pending[0]?.attempts).toBe(0);
		});

		it("rejects requeueing a dead-lettered eventId at a different commit position", async () => {
			const outbox = new InMemoryOutbox<OrderCreated>({
				maxDeliveryAttempts: 1,
			});
			const event = createDomainEvent(
				"OrderCreated",
				{ orderId: "o-dead-receipt" },
				{
					eventId: "evt-dead-receipt",
					aggregateId: "o-dead-receipt",
					aggregateType: "Order",
				},
			);
			await outbox.add([candidate(event, 1)]);
			await outbox.markFailed(event.eventId, new Error("poison"));

			await expect(outbox.add([candidate(event, 2)])).rejects.toBeInstanceOf(
				EventHarvestError,
			);
			expect(await outbox.getPending()).toEqual([]);
			expect(await outbox.deadLetters()).toHaveLength(1);
		});

		it("markDispatched clears a dead-lettered record (manual redelivery then ack)", async () => {
			const outbox = new InMemoryOutbox<OrderCreated>({
				maxDeliveryAttempts: 1,
			});
			const e = createDomainEvent("OrderCreated", { orderId: "o-1" });
			await outbox.add([candidate(e)]);
			await outbox.markFailed(e.eventId, new Error("poison"));
			expect(await outbox.deadLetters()).toHaveLength(1);

			await outbox.markDispatched([e.eventId]);

			expect(await outbox.deadLetters()).toHaveLength(0);
			expect(await outbox.getPending()).toHaveLength(0);
		});
	});
});

describe("getPending limit edge cases", () => {
	it("a NaN limit yields an empty batch, never the whole backlog", async () => {
		const outbox = new InMemoryOutbox();
		await outbox.add([
			{
				event: { eventId: "e1", type: "T" },
				source: { aggregateId: "1", aggregateType: "A" },
				position: {
					aggregateVersion: 1,
					commitSequence: 0,
					commitSize: 1,
				},
			} as never,
		]);

		const batchSize = undefined as unknown as number;
		const inFlight = 0;
		expect(await outbox.getPending(batchSize - inFlight)).toHaveLength(0);
	});
});

describe("outboxWriterAcceptingEventLoss", () => {
	it("drops every event and retains nothing", async () => {
		const writer = outboxWriterAcceptingEventLoss<OrderCreated>();
		await expect(
			writer.add([
				candidate(createDomainEvent("OrderCreated", { orderId: "o-1" })),
				candidate(createDomainEvent("OrderCreated", { orderId: "o-2" })),
			]),
		).resolves.toBeUndefined();
		// Nothing to poll, nothing retained: the writer has no read side at
		// all; the type system already prevents getPending on it.
	});
});
