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

	it("getPending with a zero or negative limit returns nothing", async () => {
		const outbox = new InMemoryOutbox<OrderCreated>();
		await outbox.add([
			createDomainEvent("OrderCreated", { orderId: "o-1" }),
			createDomainEvent("OrderCreated", { orderId: "o-2" }),
			createDomainEvent("OrderCreated", { orderId: "o-3" }),
		]);

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

		await outbox.add([e]);
		await outbox.add([e]); // duplicate add

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
		await outbox.add([e1, e2]);
		await outbox.add([e3]);

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
			await outbox.add([e]);

			await outbox.markFailed(e.eventId, new Error("broker down"));

			const pending = await outbox.getPending();
			expect(pending).toHaveLength(1);
			expect(pending[0]?.attempts).toBe(1);
		});

		it("keeps insertion order across failures (a failed record does not move)", async () => {
			const outbox = new InMemoryOutbox<OrderCreated>();
			const e1 = createDomainEvent("OrderCreated", { orderId: "o-1" });
			const e2 = createDomainEvent("OrderCreated", { orderId: "o-2" });
			await outbox.add([e1, e2]);

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
			await outbox.add([poison, healthy]);

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
			await outbox.add([e]);
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
				{ eventId: "evt-1", aggregateVersion: 3 },
			);
			const committedCopy = createDomainEvent(
				"OrderCreated",
				{ orderId: "o-1" },
				{ eventId: "evt-1", aggregateVersion: 4 },
			);
			await outbox.add([staleCopy]);
			await outbox.markFailed("evt-1", new Error("broker down"));

			await outbox.add([committedCopy]);

			const pending = await outbox.getPending();
			expect(pending).toHaveLength(1);
			expect(pending[0]?.event.aggregateVersion).toBe(4);
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
			await outbox.add([e]);
			await outbox.markFailed(e.eventId, new Error("poison"));
			expect(await outbox.deadLetters()).toHaveLength(1);

			await outbox.add([e]);

			expect(await outbox.deadLetters()).toHaveLength(0);
			const pending = await outbox.getPending();
			expect(pending).toHaveLength(1);
			expect(pending[0]?.attempts).toBe(0);
		});

		it("markDispatched clears a dead-lettered record (manual redelivery then ack)", async () => {
			const outbox = new InMemoryOutbox<OrderCreated>({
				maxDeliveryAttempts: 1,
			});
			const e = createDomainEvent("OrderCreated", { orderId: "o-1" });
			await outbox.add([e]);
			await outbox.markFailed(e.eventId, new Error("poison"));
			expect(await outbox.deadLetters()).toHaveLength(1);

			await outbox.markDispatched([e.eventId]);

			expect(await outbox.deadLetters()).toHaveLength(0);
			expect(await outbox.getPending()).toHaveLength(0);
		});
	});
});
