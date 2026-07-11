import { describe, expect, it } from "vitest";
import { createDomainEvent, type DomainEvent } from "../aggregate/domain-event";
import { UnprojectableEventError } from "../core/errors";
import { InMemoryOutbox } from "../events/outbox";
import { OutboxDispatcher } from "../events/outbox-dispatcher";
import type { TransactionScope } from "../repo/scope";
import { InMemoryProjectionCheckpointStore } from "./in-memory-checkpoint-store";
import type {
	Projection,
	ProjectionCheckpointStore,
	ProjectionPosition,
} from "./ports";
import { Projector } from "./projector";

type OrderPlaced = DomainEvent<"OrderPlaced", { total: number }>;
type OrderShipped = DomainEvent<"OrderShipped", { at: string }>;
type OrderEvent = OrderPlaced | OrderShipped;

function placed(
	aggregateId: string,
	version: number,
	seq: number,
	total = 1,
): OrderPlaced {
	return createDomainEvent(
		"OrderPlaced",
		{ total },
		{
			aggregateId,
			aggregateType: "Order",
			eventId: `evt-${aggregateId}-${version}-${seq}`,
			aggregateVersion: version,
			commitSequence: seq,
		},
	);
}

/** Passthrough scope for the in-memory store (no real transaction). */
const passthroughScope: TransactionScope<undefined> = {
	transactional: (fn) => fn(undefined),
};

/** A projection writing into a plain array "read model". */
function arrayProjection(
	rows: string[],
	name = "order-list",
): Projection<OrderEvent, undefined> {
	return {
		name,
		apply: async (_ctx, event) => {
			rows.push(event.eventId);
		},
		truncate: async () => {
			rows.length = 0;
		},
	};
}

describe("Projector", () => {
	it("applies a batch in order, checkpoints, and skips redelivered duplicates", async () => {
		const rows: string[] = [];
		const checkpoints = new InMemoryProjectionCheckpointStore();
		const projector = new Projector({
			scope: passthroughScope,
			checkpoints,
			projection: arrayProjection(rows),
		});
		const batch = [
			placed("o-1", 1, 0),
			placed("o-1", 2, 0),
			placed("o-2", 1, 0),
		];

		const first = await projector.project(batch);
		// At-least-once redelivery of the same batch: all duplicates.
		const second = await projector.project(batch);

		expect(first).toEqual({ applied: 3, skipped: 0 });
		expect(second).toEqual({ applied: 0, skipped: 3 });
		expect(rows).toEqual(["evt-o-1-1-0", "evt-o-1-2-0", "evt-o-2-1-0"]);
	});

	it("skips positions at or behind the watermark (duplicate absorption under the ordering precondition)", async () => {
		// The watermark cannot distinguish a redelivered duplicate from a
		// straggler that never applied; per-aggregate in-order delivery is
		// a documented PRECONDITION of the projector, and this pin shows
		// the consequence side: whatever arrives behind the watermark is
		// dropped, which is correct for redelivery and permanently wrong
		// for a reordering feed (which must resequence or rebuild).
		const rows: string[] = [];
		const projector = new Projector({
			scope: passthroughScope,
			checkpoints: new InMemoryProjectionCheckpointStore(),
			projection: arrayProjection(rows),
		});

		await projector.project([placed("o-1", 3, 0)]);
		const result = await projector.project([placed("o-1", 2, 0)]);

		expect(result).toEqual({ applied: 0, skipped: 1 });
		expect(rows).toEqual(["evt-o-1-3-0"]);
	});

	it("orders within one commit by commitSequence and dedupes at that grain", async () => {
		const rows: string[] = [];
		const projector = new Projector({
			scope: passthroughScope,
			checkpoints: new InMemoryProjectionCheckpointStore(),
			projection: arrayProjection(rows),
		});

		await projector.project([placed("o-1", 5, 0), placed("o-1", 5, 1)]);
		// Redelivery of only the commit's first event: behind (5, 1).
		const result = await projector.project([placed("o-1", 5, 0)]);

		expect(result).toEqual({ applied: 0, skipped: 1 });
		expect(rows).toEqual(["evt-o-1-5-0", "evt-o-1-5-1"]);
	});

	it("a duplicate inside one batch is skipped by the intra-batch watermark", async () => {
		const rows: string[] = [];
		const projector = new Projector({
			scope: passthroughScope,
			checkpoints: new InMemoryProjectionCheckpointStore(),
			projection: arrayProjection(rows),
		});

		const result = await projector.project([
			placed("o-1", 1, 0),
			placed("o-1", 1, 0),
		]);

		expect(result).toEqual({ applied: 1, skipped: 1 });
		expect(rows).toEqual(["evt-o-1-1-0"]);
	});

	it("rejects an uncursored event loudly, before applying anything", async () => {
		const rows: string[] = [];
		const projector = new Projector({
			scope: passthroughScope,
			checkpoints: new InMemoryProjectionCheckpointStore(),
			projection: arrayProjection(rows),
		});
		const unstamped = createDomainEvent(
			"OrderPlaced",
			{ total: 1 },
			{ aggregateId: "o-1", aggregateType: "Order" },
		) as OrderPlaced;

		await expect(
			projector.project([placed("o-1", 1, 0), unstamped]),
		).rejects.toThrow(/carries no \(aggregateVersion, commitSequence\)/);
		// Pre-transaction validation: the stamped first event must not
		// have been applied either.
		expect(rows).toEqual([]);
	});

	it("rejects an event without aggregateId", async () => {
		const projector = new Projector({
			scope: passthroughScope,
			checkpoints: new InMemoryProjectionCheckpointStore(),
			projection: arrayProjection([]),
		});
		const homeless = createDomainEvent(
			"OrderPlaced",
			{ total: 1 },
			{ aggregateVersion: 1, commitSequence: 0 },
		) as OrderPlaced;

		await expect(projector.project([homeless])).rejects.toThrow(
			/carries no aggregateId/,
		);
	});

	it("uses a custom position extractor for sources with their own ordering", async () => {
		const rows: string[] = [];
		const projector = new Projector<OrderEvent, undefined>({
			scope: passthroughScope,
			checkpoints: new InMemoryProjectionCheckpointStore(),
			projection: arrayProjection(rows),
			// Event-sourced replay: the store position rides in metadata.
			position: (event) => {
				const raw = event.metadata?.streamPosition;
				return typeof raw === "number"
					? { aggregateVersion: raw, commitSequence: 0 }
					: undefined;
			},
		});
		const fromStore = (id: string, pos: number): OrderPlaced =>
			createDomainEvent(
				"OrderPlaced",
				{ total: 1 },
				{
					aggregateId: id,
					aggregateType: "Order",
					eventId: `es-${id}-${pos}`,
					metadata: { streamPosition: pos },
				},
			);

		await projector.project([fromStore("o-1", 1), fromStore("o-1", 2)]);
		const replay = await projector.project([fromStore("o-1", 1)]);

		expect(replay).toEqual({ applied: 0, skipped: 1 });
		expect(rows).toEqual(["es-o-1-1", "es-o-1-2"]);
	});

	it("hasProcessed answers the wait-for-version question at the pair grain", async () => {
		const projector = new Projector({
			scope: passthroughScope,
			checkpoints: new InMemoryProjectionCheckpointStore(),
			projection: arrayProjection([]),
		});

		await projector.project([placed("o-1", 5, 0)]);

		await expect(
			projector.hasProcessed(
				{ aggregateType: "Order", aggregateId: "o-1" },
				{ aggregateVersion: 5, commitSequence: 0 },
			),
		).resolves.toBe(true);
		// The commit emitted a second event that has not been applied yet:
		// version-level "reached" would lie here, the pair does not.
		await expect(
			projector.hasProcessed(
				{ aggregateType: "Order", aggregateId: "o-1" },
				{ aggregateVersion: 5, commitSequence: 1 },
			),
		).resolves.toBe(false);
		await expect(
			projector.hasProcessed(
				{ aggregateType: "Order", aggregateId: "o-2" },
				{ aggregateVersion: 1, commitSequence: 0 },
			),
		).resolves.toBe(false);
	});

	it("keys watermarks per aggregate TYPE: colliding raw ids do not shadow each other", async () => {
		// Identities are type-scoped; Order "1" at version 10 must not make
		// Payment "1" version 1 look stale (the exact silent-skip the old
		// (projection, aggregateId) key permitted).
		const rows: string[] = [];
		const projector = new Projector({
			scope: passthroughScope,
			checkpoints: new InMemoryProjectionCheckpointStore(),
			projection: arrayProjection(rows),
		});

		const orderAt10 = createDomainEvent(
			"OrderPlaced",
			{ total: 1 },
			{
				aggregateId: "1",
				aggregateType: "Order",
				eventId: "evt-order-1",
				aggregateVersion: 10,
				commitSequence: 0,
			},
		);
		const paymentAt1 = createDomainEvent(
			"OrderPlaced",
			{ total: 1 },
			{
				aggregateId: "1",
				aggregateType: "Payment",
				eventId: "evt-payment-1",
				aggregateVersion: 1,
				commitSequence: 0,
			},
		);

		const result = await projector.project([orderAt10, paymentAt1]);

		expect(result).toEqual({ applied: 2, skipped: 0 });
		expect(rows).toEqual(["evt-order-1", "evt-payment-1"]);
	});

	it("rejects an event without an aggregateType before applying anything", async () => {
		const rows: string[] = [];
		const projector = new Projector({
			scope: passthroughScope,
			checkpoints: new InMemoryProjectionCheckpointStore(),
			projection: arrayProjection(rows),
		});
		const untyped = createDomainEvent(
			"OrderPlaced",
			{ total: 1 },
			{
				aggregateId: "o-1",
				eventId: "evt-untyped",
				aggregateVersion: 1,
				commitSequence: 0,
			},
		);

		await expect(projector.project([untyped])).rejects.toThrow(
			UnprojectableEventError,
		);
		expect(rows).toEqual([]);
	});

	it("reset truncates the read model and clears checkpoints in one transaction, enabling a rebuild", async () => {
		const rows: string[] = [];
		const projector = new Projector({
			scope: passthroughScope,
			checkpoints: new InMemoryProjectionCheckpointStore(),
			projection: arrayProjection(rows),
		});
		const history = [placed("o-1", 1, 0), placed("o-1", 2, 0)];
		await projector.project(history);

		await projector.reset();
		expect(rows).toEqual([]);
		const rebuilt = await projector.project(history);

		expect(rebuilt).toEqual({ applied: 2, skipped: 0 });
		expect(rows).toEqual(["evt-o-1-1-0", "evt-o-1-2-0"]);
	});

	it("rolls back read-model update AND checkpoint together when a handler fails mid-batch", async () => {
		// A minimal transactional world: writes stage on the ctx and land
		// only when the scope commits, exactly what a SQL adapter provides.
		type Ctx = { staged: Array<() => void> };
		const scope: TransactionScope<Ctx> = {
			transactional: async (fn) => {
				const ctx: Ctx = { staged: [] };
				const result = await fn(ctx); // a throw skips the flush: rollback
				for (const write of ctx.staged) write();
				return result;
			},
		};
		const committed = new Map<string, ProjectionPosition>();
		const checkpoints: ProjectionCheckpointStore<Ctx> = {
			load: async (_ctx, _p, address) => committed.get(address.aggregateId),
			save: async (ctx, _p, address, position) => {
				ctx.staged.push(() => committed.set(address.aggregateId, position));
			},
			hasReached: async (_p, address, position) => {
				const stored = committed.get(address.aggregateId);
				if (!stored) return false;
				return (
					stored.aggregateVersion > position.aggregateVersion ||
					(stored.aggregateVersion === position.aggregateVersion &&
						stored.commitSequence >= position.commitSequence)
				);
			},
			reset: async (ctx) => {
				ctx.staged.push(() => committed.clear());
			},
		};
		const rows: string[] = [];
		const projector = new Projector<OrderEvent, Ctx>({
			scope,
			checkpoints,
			projection: {
				name: "order-list",
				apply: async (ctx, event) => {
					if (event.aggregateVersion === 2) throw new Error("handler bug");
					ctx.staged.push(() => rows.push(event.eventId));
				},
			},
		});

		await expect(
			projector.project([placed("o-1", 1, 0), placed("o-1", 2, 0)]),
		).rejects.toThrow("handler bug");

		// Nothing from the failed batch is visible: neither the first
		// event's row nor any checkpoint. Redelivery replays cleanly.
		expect(rows).toEqual([]);
		expect(committed.size).toBe(0);
		const retry = await projector.project([placed("o-1", 1, 0)]);
		expect(retry).toEqual({ applied: 1, skipped: 0 });
		expect(rows).toEqual(["evt-o-1-1-0"]);
	});

	it("reports correct counts under a retrying scope: a rolled-back attempt leaks nothing", async () => {
		type Ctx = { staged: Array<() => void> };
		// Retry-on-failure scope with staged commits, the shape
		// RetryingTransactionScope provides over a real database.
		const retryingScope: TransactionScope<Ctx> = {
			transactional: async (fn) => {
				for (let attempt = 1; ; attempt++) {
					const ctx: Ctx = { staged: [] };
					try {
						const result = await fn(ctx);
						for (const write of ctx.staged) write();
						return result;
					} catch (error) {
						if (attempt === 2) throw error;
					}
				}
			},
		};
		const committed = new Map<string, ProjectionPosition>();
		const checkpoints: ProjectionCheckpointStore<Ctx> = {
			load: async (_ctx, _p, address) => committed.get(address.aggregateId),
			save: async (ctx, _p, address, position) => {
				ctx.staged.push(() => committed.set(address.aggregateId, position));
			},
			hasReached: async () => false,
			reset: async () => {},
		};
		const rows: string[] = [];
		let failOnce = true;
		const projector = new Projector<OrderEvent, Ctx>({
			scope: retryingScope,
			checkpoints,
			projection: {
				name: "order-list",
				apply: async (ctx, event) => {
					if (failOnce && event.aggregateVersion === 2) {
						failOnce = false;
						throw new Error("transient");
					}
					ctx.staged.push(() => rows.push(event.eventId));
				},
			},
		});

		const result = await projector.project([
			placed("o-1", 1, 0),
			placed("o-1", 2, 0),
		]);

		// The first attempt applied one event and rolled back; only the
		// second attempt counts. Accumulated counters would report 3/0.
		expect(result).toEqual({ applied: 2, skipped: 0 });
		expect(rows).toEqual(["evt-o-1-1-0", "evt-o-1-2-0"]);
	});

	it("dedupes within one batch even when the store stages writes until commit", async () => {
		type Ctx = { staged: Array<() => void> };
		const scope: TransactionScope<Ctx> = {
			transactional: async (fn) => {
				const ctx: Ctx = { staged: [] };
				const result = await fn(ctx);
				for (const write of ctx.staged) write();
				return result;
			},
		};
		const committed = new Map<string, ProjectionPosition>();
		// load sees ONLY committed state: no read-your-writes inside the
		// open transaction. The projector's in-memory batch watermark must
		// still catch the duplicate.
		const checkpoints: ProjectionCheckpointStore<Ctx> = {
			load: async (_ctx, _p, address) => committed.get(address.aggregateId),
			save: async (ctx, _p, address, position) => {
				ctx.staged.push(() => committed.set(address.aggregateId, position));
			},
			hasReached: async () => false,
			reset: async () => {},
		};
		const rows: string[] = [];
		const projector = new Projector<OrderEvent, Ctx>({
			scope,
			checkpoints,
			projection: {
				name: "order-list",
				apply: async (ctx, event) => {
					ctx.staged.push(() => rows.push(event.eventId));
				},
			},
		});

		const result = await projector.project([
			placed("o-1", 1, 0),
			placed("o-1", 1, 0),
		]);

		expect(result).toEqual({ applied: 1, skipped: 1 });
		expect(rows).toEqual(["evt-o-1-1-0"]);
	});

	it("plugs into the OutboxDispatcher as a sink and absorbs redelivery via the cursor", async () => {
		const outbox = new InMemoryOutbox<OrderEvent>();
		await outbox.add([placed("o-1", 1, 0), placed("o-1", 2, 0)]);
		const rows: string[] = [];
		const projector = new Projector({
			scope: passthroughScope,
			checkpoints: new InMemoryProjectionCheckpointStore(),
			projection: arrayProjection(rows),
		});
		const dispatcher = new OutboxDispatcher({
			outbox,
			sink: projector.toOutboxSink(),
			pollIntervalMs: 1,
			baseDelayMs: 1,
			maxDelayMs: 2,
			random: () => 0.5,
		});

		expect(await dispatcher.drainOnce()).toBe("drained");
		// A stale straggler (an already-processed position under a fresh
		// eventId, so the outbox's own dedupe cannot catch it) is absorbed
		// by the watermark, not double-applied.
		const straggler = createDomainEvent(
			"OrderPlaced",
			{ total: 99 },
			{
				aggregateId: "o-1",
				aggregateType: "Order",
				eventId: "evt-straggler",
				aggregateVersion: 1,
				commitSequence: 0,
			},
		) as OrderPlaced;
		await outbox.add([straggler]);
		expect(await dispatcher.drainOnce()).toBe("drained");

		expect(rows).toEqual(["evt-o-1-1-0", "evt-o-1-2-0"]);
	});
});
