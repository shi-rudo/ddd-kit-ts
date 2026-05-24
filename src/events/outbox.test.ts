import { describe, expect, it } from "vitest";
import { createDomainEvent, type DomainEvent } from "../aggregate/aggregate";
import { InMemoryOutbox } from "./outbox";

type OrderCreated = DomainEvent<"OrderCreated", { orderId: string }>;

describe("InMemoryOutbox", () => {
	it("getPending returns everything added until something is marked", async () => {
		const outbox = new InMemoryOutbox<OrderCreated>();
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
		const outbox = new InMemoryOutbox<OrderCreated>();
		const e1 = createDomainEvent("OrderCreated", { orderId: "o-1" });
		const e2 = createDomainEvent("OrderCreated", { orderId: "o-2" });
		await outbox.add([e1, e2]);

		await outbox.markDispatched([e1.eventId]);

		const pending = await outbox.getPending();
		expect(pending).toHaveLength(1);
		expect(pending[0]?.event.payload.orderId).toBe("o-2");
	});

	it("markDispatched is idempotent on already-marked ids", async () => {
		const outbox = new InMemoryOutbox<OrderCreated>();
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
		const outbox = new InMemoryOutbox<OrderCreated>();
		await outbox.add([
			createDomainEvent("OrderCreated", { orderId: "o-1" }),
			createDomainEvent("OrderCreated", { orderId: "o-2" }),
			createDomainEvent("OrderCreated", { orderId: "o-3" }),
		]);

		const firstTwo = await outbox.getPending(2);
		expect(firstTwo).toHaveLength(2);
	});

	it("re-adding the same eventId is naturally idempotent", async () => {
		// Re-adds (via at-least-once consumers, transactional outbox-
		// dispatcher retries, etc.) overwrite the existing entry keyed on
		// eventId, so getPending still returns each event exactly once.
		const outbox = new InMemoryOutbox<OrderCreated>();
		const e = createDomainEvent("OrderCreated", { orderId: "o-1" });

		await outbox.add([e]);
		await outbox.add([e]); // duplicate add

		const pending = await outbox.getPending();
		expect(pending).toHaveLength(1);
		expect(pending[0]?.dispatchId).toBe(e.eventId);
	});
});
