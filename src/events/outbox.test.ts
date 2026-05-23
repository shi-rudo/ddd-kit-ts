import { describe, expect, it } from "vitest";
import { createDomainEvent, type DomainEvent } from "../aggregate/aggregate";
import type { Outbox, OutboxRecord } from "./ports";

type OrderCreated = DomainEvent<"OrderCreated", { orderId: string }>;

/**
 * Minimal reference outbox — the kind of in-memory impl a Worker would use
 * in tests or for very small monoliths. Reuses the event's own `eventId`
 * as the dispatch id (a common, clean choice).
 */
function createInMemoryOutbox(): Outbox<OrderCreated> {
	const pending = new Map<string, OutboxRecord<OrderCreated>>();
	return {
		async add(events) {
			for (const event of events) {
				const id = event.eventId;
				pending.set(id, { dispatchId: id, event });
			}
		},
		async getPending(limit) {
			const all = [...pending.values()];
			return typeof limit === "number" ? all.slice(0, limit) : all;
		},
		async markDispatched(dispatchIds) {
			for (const id of dispatchIds) pending.delete(id);
		},
	};
}

describe("Outbox port", () => {
	it("getPending returns everything added until something is marked", async () => {
		const outbox = createInMemoryOutbox();
		const e1 = createDomainEvent("OrderCreated", { orderId: "o-1" });
		const e2 = createDomainEvent("OrderCreated", { orderId: "o-2" });

		await outbox.add([e1, e2]);

		const pending = await outbox.getPending();
		expect(pending).toHaveLength(2);
		expect(pending.map((r) => r.event.payload.orderId)).toEqual(
			expect.arrayContaining(["o-1", "o-2"]),
		);
	});

	it("markDispatched removes only the matching records", async () => {
		const outbox = createInMemoryOutbox();
		const e1 = createDomainEvent("OrderCreated", { orderId: "o-1" });
		const e2 = createDomainEvent("OrderCreated", { orderId: "o-2" });
		await outbox.add([e1, e2]);

		await outbox.markDispatched([e1.eventId]);

		const pending = await outbox.getPending();
		expect(pending).toHaveLength(1);
		expect(pending[0]?.event.payload.orderId).toBe("o-2");
	});

	it("markDispatched is idempotent on already-marked ids", async () => {
		const outbox = createInMemoryOutbox();
		const e = createDomainEvent("OrderCreated", { orderId: "o-1" });
		await outbox.add([e]);

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
		const outbox = createInMemoryOutbox();
		await outbox.add([
			createDomainEvent("OrderCreated", { orderId: "o-1" }),
			createDomainEvent("OrderCreated", { orderId: "o-2" }),
			createDomainEvent("OrderCreated", { orderId: "o-3" }),
		]);

		const firstTwo = await outbox.getPending(2);
		expect(firstTwo).toHaveLength(2);
	});
});
