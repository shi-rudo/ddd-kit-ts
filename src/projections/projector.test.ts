import { describe, expect, it } from "vitest";
import { createDomainEvent, type DomainEvent } from "../aggregate/domain-event";
import { ForeignEventError, UnprojectableEventError } from "../core/errors";
import { InMemoryOutbox } from "../events/outbox";
import { OutboxDispatcher } from "../events/outbox-dispatcher";
import type {
	CommittedDomainEvent,
	EventCommitCandidate,
} from "../events/ports";
import type { TransactionScope } from "../repo/scope";
import { InMemoryProjectionCheckpointStore } from "./in-memory-checkpoint-store";
import type {
	Projection,
	ProjectionCheckpoint,
	ProjectionCheckpointStore,
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
	ordering?: {
		commitSize?: number;
		previousEventfulAggregateVersion?: number | null;
	},
): CommittedDomainEvent<OrderPlaced> {
	const previousEventfulAggregateVersion =
		ordering?.previousEventfulAggregateVersion !== undefined
			? ordering.previousEventfulAggregateVersion
			: version === 1
				? null
				: version - 1;
	const event = createDomainEvent(
		"OrderPlaced",
		{ total },
		{
			aggregateId,
			aggregateType: "Order",
			eventId: `evt-${aggregateId}-${version}-${seq}`,
		},
	);
	return {
		event,
		source: { aggregateId, aggregateType: "Order" },
		position: {
			aggregateVersion: version,
			commitSequence: seq,
			commitSize: ordering?.commitSize ?? 1,
			previousEventfulAggregateVersion,
		},
	};
}

function shipped(
	aggregateId: string,
	version: number,
	seq: number,
	ordering: {
		commitSize: number;
		previousEventfulAggregateVersion: number | null;
	},
): CommittedDomainEvent<OrderShipped> {
	return {
		event: createDomainEvent(
			"OrderShipped",
			{ at: "2026-07-13T09:00:00.000Z" },
			{
				aggregateId,
				aggregateType: "Order",
				eventId: `evt-${aggregateId}-${version}-${seq}`,
			},
		),
		source: { aggregateId, aggregateType: "Order" },
		position: {
			aggregateVersion: version,
			commitSequence: seq,
			commitSize: ordering.commitSize,
			previousEventfulAggregateVersion:
				ordering.previousEventfulAggregateVersion,
		},
	};
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
	it("reads source and position from a committed envelope while applying the bare event", async () => {
		const rows: string[] = [];
		const projector = new Projector<OrderEvent, undefined>({
			scope: passthroughScope,
			checkpoints: new InMemoryProjectionCheckpointStore(),
			projection: arrayProjection(rows),
		});
		const event = createDomainEvent(
			"OrderPlaced",
			{ total: 1 },
			{
				eventId: "evt-envelope",
				aggregateId: "o-1",
				aggregateType: "Order",
			},
		);
		const committed = {
			event,
			source: { aggregateId: "o-1", aggregateType: "Order" },
			position: {
				aggregateVersion: 1,
				commitSequence: 0,
				commitSize: 1,
				previousEventfulAggregateVersion: null,
			},
		};

		await projector.project([committed]);

		expect(rows).toEqual(["evt-envelope"]);
	});

	it("projects a genesis envelope after a JSON broker round-trip", async () => {
		const rows: string[] = [];
		const projector = new Projector<OrderEvent, undefined>({
			scope: passthroughScope,
			checkpoints: new InMemoryProjectionCheckpointStore(),
			projection: arrayProjection(rows),
		});
		const wireEnvelope = JSON.parse(
			JSON.stringify(placed("o-json", 1, 0)),
		) as CommittedDomainEvent<OrderPlaced>;

		await expect(projector.project([wireEnvelope])).resolves.toEqual({
			applied: 1,
			skipped: 0,
		});
		expect(rows).toEqual(["evt-o-json-1-0"]);
	});

	it("preserves a non-genesis predecessor across a JSON broker round-trip", async () => {
		const rows: string[] = [];
		const projector = new Projector<OrderEvent, undefined>({
			scope: passthroughScope,
			checkpoints: new InMemoryProjectionCheckpointStore(),
			projection: arrayProjection(rows),
		});
		const wireBatch = JSON.parse(
			JSON.stringify([
				placed("o-json-linked", 1, 0),
				placed("o-json-linked", 3, 0, 1, {
					previousEventfulAggregateVersion: 1,
				}),
			]),
		) as CommittedDomainEvent<OrderPlaced>[];

		await expect(projector.project(wireBatch)).resolves.toEqual({
			applied: 2,
			skipped: 0,
		});
		expect(wireBatch[1]?.position.previousEventfulAggregateVersion).toBe(1);
		expect(rows).toEqual(["evt-o-json-linked-1-0", "evt-o-json-linked-3-0"]);
	});

	it("requires a committed envelope at the type level", () => {
		const projector = new Projector<OrderEvent, undefined>({
			scope: passthroughScope,
			checkpoints: new InMemoryProjectionCheckpointStore(),
			projection: arrayProjection([]),
		});
		const bare = createDomainEvent("OrderPlaced", { total: 1 });
		const invalidProjection = () => {
			// @ts-expect-error projection input must carry source and position
			void projector.project([bare]);
		};

		expect(invalidProjection).toBeTypeOf("function");
	});

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

	it("serializes competing projectors at genesis and keeps later redelivery idempotent", async () => {
		const rows: string[] = [];
		const checkpoints = new InMemoryProjectionCheckpointStore();
		const projection = arrayProjection(rows);
		const first = new Projector({
			scope: passthroughScope,
			checkpoints,
			projection,
		});
		const second = new Projector({
			scope: passthroughScope,
			checkpoints,
			projection,
		});
		const genesis = placed("o-genesis-race", 1, 0);

		const results = await Promise.all([
			first.project([genesis]),
			second.project([genesis]),
		]);

		expect(results.reduce((total, result) => total + result.applied, 0)).toBe(
			1,
		);
		expect(results.reduce((total, result) => total + result.skipped, 0)).toBe(
			1,
		);
		expect(rows).toEqual([genesis.event.eventId]);
		await expect(first.project([genesis])).resolves.toEqual({
			applied: 0,
			skipped: 1,
		});
		expect(rows).toEqual([genesis.event.eventId]);
	});

	it("checkpoints projection-irrelevant events when apply explicitly ignores them", async () => {
		const rows: string[] = [];
		const projector = new Projector<OrderEvent, undefined>({
			scope: passthroughScope,
			checkpoints: new InMemoryProjectionCheckpointStore(),
			projection: {
				name: "placed-orders",
				apply: async (_ctx, event) => {
					switch (event.type) {
						case "OrderPlaced":
							rows.push(event.eventId);
							return;
						case "OrderShipped":
							// Explicit no-op: this read model does not use shipment facts.
							return;
					}
				},
			},
		});
		const fullCommit = [
			placed("o-complete", 1, 0, 1, {
				commitSize: 2,
				previousEventfulAggregateVersion: null,
			}),
			shipped("o-complete", 1, 1, {
				commitSize: 2,
				previousEventfulAggregateVersion: null,
			}),
		];
		const nextCommit = placed("o-complete", 3, 0, 1, {
			previousEventfulAggregateVersion: 1,
		});

		await expect(
			projector.project([...fullCommit, nextCommit]),
		).resolves.toEqual({ applied: 3, skipped: 0 });
		expect(rows).toEqual(["evt-o-complete-1-0", "evt-o-complete-3-0"]);
	});

	it("rejects a different eventId redelivered at the stored watermark", async () => {
		const rows: string[] = [];
		const projector = new Projector<OrderEvent, undefined>({
			scope: passthroughScope,
			checkpoints: new InMemoryProjectionCheckpointStore(),
			projection: arrayProjection(rows),
		});
		const original = placed("o-1", 1, 0);
		const identityConflict: CommittedDomainEvent<OrderPlaced> = {
			...original,
			event: createDomainEvent(
				"OrderPlaced",
				{ total: 1 },
				{
					aggregateId: "o-1",
					aggregateType: "Order",
					eventId: "evt-forged-at-watermark",
				},
			),
		};

		await projector.project([original]);

		await expect(projector.project([identityConflict])).rejects.toMatchObject({
			code: "PROJECTION_IDENTITY_VIOLATION",
			category: "INFRASTRUCTURE",
		});
		expect(rows).toEqual([original.event.eventId]);
	});

	it.each([
		{
			name: "commitSize",
			contradict: (
				position: CommittedDomainEvent<OrderPlaced>["position"],
			) => ({
				...position,
				commitSize: position.commitSize + 1,
			}),
		},
		{
			name: "previousEventfulAggregateVersion",
			contradict: (
				position: CommittedDomainEvent<OrderPlaced>["position"],
			) => ({
				...position,
				previousEventfulAggregateVersion: 0,
			}),
		},
	])(
		"rejects contradictory $name metadata at the stored watermark",
		async ({ contradict }) => {
			const rows: string[] = [];
			const projector = new Projector<OrderEvent, undefined>({
				scope: passthroughScope,
				checkpoints: new InMemoryProjectionCheckpointStore(),
				projection: arrayProjection(rows),
			});
			const first = placed("o-receipt-watermark", 1, 0);
			const original = placed("o-receipt-watermark", 2, 0);
			const contradiction = {
				...original,
				position: contradict(original.position),
			};

			await projector.project([first, original]);

			await expect(projector.project([contradiction])).rejects.toMatchObject({
				code: "PROJECTION_RECEIPT_VIOLATION",
				category: "INFRASTRUCTURE",
			});
			expect(rows).toEqual([first.event.eventId, original.event.eventId]);
		},
	);

	it.each([
		{
			name: "commitSize",
			batch: () => {
				const original = placed("o-receipt-batch-size", 1, 0);
				return [
					original,
					{
						...original,
						position: { ...original.position, commitSize: 2 },
					},
				];
			},
		},
		{
			name: "previousEventfulAggregateVersion",
			batch: () => {
				const first = placed("o-receipt-batch-previous", 1, 0);
				const original = placed("o-receipt-batch-previous", 2, 0);
				return [
					first,
					original,
					{
						...original,
						position: {
							...original.position,
							previousEventfulAggregateVersion: 0,
						},
					},
				];
			},
		},
	])(
		"rejects contradictory $name metadata inside one batch before apply",
		async ({ batch }) => {
			const rows: string[] = [];
			const projector = new Projector<OrderEvent, undefined>({
				scope: passthroughScope,
				checkpoints: new InMemoryProjectionCheckpointStore(),
				projection: arrayProjection(rows),
			});

			await expect(projector.project(batch())).rejects.toMatchObject({
				code: "PROJECTION_RECEIPT_VIOLATION",
				category: "INFRASTRUCTURE",
			});
			expect(rows).toEqual([]);
		},
	);

	it("rejects a missing aggregate commit before advancing the watermark", async () => {
		const rows: string[] = [];
		const projector = new Projector<OrderEvent, undefined>({
			scope: passthroughScope,
			checkpoints: new InMemoryProjectionCheckpointStore(),
			projection: arrayProjection(rows),
		});

		const linked = (
			version: number,
			previousEventfulAggregateVersion: number | null,
		): CommittedDomainEvent<OrderPlaced> => {
			const message = placed("o-1", version, 0);
			return {
				...message,
				position: { ...message.position, previousEventfulAggregateVersion },
			};
		};
		const first = linked(1, null);
		const afterGap = linked(3, 2);

		await projector.project([first]);

		await expect(projector.project([afterGap])).rejects.toMatchObject({
			code: "PROJECTION_GAP",
			category: "INFRASTRUCTURE",
		});
		expect(rows).toEqual([first.event.eventId]);

		const missing = linked(2, 1);
		await projector.project([missing]);
		await projector.project([afterGap]);
		expect(rows).toEqual([
			first.event.eventId,
			missing.event.eventId,
			afterGap.event.eventId,
		]);
	});

	it("accepts an eventful commit after an intervening state-only aggregate save", async () => {
		const rows: string[] = [];
		const outbox = new InMemoryOutbox<OrderEvent>();
		const projector = new Projector<OrderEvent, undefined>({
			scope: passthroughScope,
			checkpoints: new InMemoryProjectionCheckpointStore(),
			projection: arrayProjection(rows),
		});
		const candidate = (
			message: CommittedDomainEvent<OrderPlaced>,
		): EventCommitCandidate<OrderPlaced> => {
			const { previousEventfulAggregateVersion: _, ...position } =
				message.position;
			return { event: message.event, source: message.source, position };
		};

		const first = placed("o-1", 1, 0);
		await outbox.add([candidate(first)]);
		const [firstRecord] = await outbox.getPending();
		if (!firstRecord) throw new Error("expected first outbox record");
		await projector.project([firstRecord]);
		await outbox.markDispatched([first.event.eventId]);

		// Aggregate v2 was persisted without an event. The v3 eventful commit
		// therefore follows eventful v1 directly in the source-owned chain.
		const afterStateOnly = placed("o-1", 3, 0);
		await outbox.add([candidate(afterStateOnly)]);
		const [nextRecord] = await outbox.getPending();
		if (!nextRecord) throw new Error("expected next outbox record");
		expect(nextRecord.position.previousEventfulAggregateVersion).toBe(1);
		await expect(projector.project([nextRecord])).resolves.toEqual({
			applied: 1,
			skipped: 0,
		});
		expect(rows).toEqual([first.event.eventId, afterStateOnly.event.eventId]);
	});

	it("rejects descending unprocessed positions as a transport-order violation", async () => {
		const rows: string[] = [];
		const projector = new Projector<OrderEvent, undefined>({
			scope: passthroughScope,
			checkpoints: new InMemoryProjectionCheckpointStore(),
			projection: arrayProjection(rows),
		});
		const first = placed("o-1", 1, 0);
		const second = placed("o-1", 2, 0);
		const third = placed("o-1", 3, 0);

		await projector.project([first]);

		await expect(projector.project([third, second])).rejects.toMatchObject({
			code: "PROJECTION_ORDER_VIOLATION",
			category: "INFRASTRUCTURE",
		});
		expect(rows).toEqual([first.event.eventId]);
	});

	it("allows an exact in-batch redelivery after a later unseen position", async () => {
		const rows: string[] = [];
		const projector = new Projector<OrderEvent, undefined>({
			scope: passthroughScope,
			checkpoints: new InMemoryProjectionCheckpointStore(),
			projection: arrayProjection(rows),
		});
		const first = placed("o-in-batch-redelivery", 1, 0);
		const second = placed("o-in-batch-redelivery", 2, 0);
		const redeliveredFirst = placed("o-in-batch-redelivery", 1, 0);

		await expect(
			projector.project([first, second, redeliveredFirst]),
		).resolves.toEqual({ applied: 2, skipped: 1 });
		expect(rows).toEqual([first.event.eventId, second.event.eventId]);
	});

	it("allows descending redeliveries already covered by the batch-start checkpoint", async () => {
		const rows: string[] = [];
		const projector = new Projector<OrderEvent, undefined>({
			scope: passthroughScope,
			checkpoints: new InMemoryProjectionCheckpointStore(),
			projection: arrayProjection(rows),
		});
		const first = placed("o-1", 1, 0);
		const second = placed("o-1", 2, 0);
		const third = placed("o-1", 3, 0);

		await projector.project([first, second, third]);
		const replay = await projector.project([third, second]);

		expect(replay).toEqual({ applied: 0, skipped: 2 });
		expect(rows).toEqual([
			first.event.eventId,
			second.event.eventId,
			third.event.eventId,
		]);
	});

	it("rejects a malformed commit boundary before applying a batch prefix", async () => {
		const rows: string[] = [];
		const projector = new Projector({
			scope: passthroughScope,
			checkpoints: new InMemoryProjectionCheckpointStore(),
			projection: arrayProjection(rows),
		});
		const malformedEvent = createDomainEvent(
			"OrderPlaced",
			{ total: 2 },
			{
				aggregateId: "o-2",
				aggregateType: "Order",
			},
		);
		const malformed: CommittedDomainEvent<typeof malformedEvent> = {
			event: malformedEvent,
			source: { aggregateId: "o-2", aggregateType: "Order" },
			position: {
				aggregateVersion: 1,
				commitSequence: 0,
				commitSize: 0,
				previousEventfulAggregateVersion: null,
			},
		};

		await expect(
			projector.project([placed("o-1", 1, 0), malformed]),
		).rejects.toThrow(/invalid projection cursor/i);
		expect(rows).toEqual([]);
	});

	it("rejects a legacy checkpoint that cannot prove its commit boundary", async () => {
		const rows: string[] = [];
		const legacy: ProjectionCheckpointStore<undefined> = {
			withCheckpointLocks: async (_ctx, _projection, _addresses, work) =>
				work(),
			load: async () =>
				({
					aggregateVersion: 5,
					commitSequence: 0,
				}) as unknown as ProjectionCheckpoint,
			save: async () => {},
			hasReached: async () => false,
			reset: async () => {},
		};
		const projector = new Projector({
			scope: passthroughScope,
			checkpoints: legacy,
			projection: arrayProjection(rows),
		});

		await expect(projector.project([placed("o-1", 1, 0)])).rejects.toThrow(
			/stored checkpoint.*invalid/i,
		);
		expect(rows).toEqual([]);
	});

	it("rejects a missing event inside one commit", async () => {
		const rows: string[] = [];
		const projector = new Projector({
			scope: passthroughScope,
			checkpoints: new InMemoryProjectionCheckpointStore(),
			projection: arrayProjection(rows),
		});
		const first = placed("o-1", 4, 0, 1, {
			commitSize: 3,
			previousEventfulAggregateVersion: null,
		});
		const third = placed("o-1", 4, 2, 1, {
			commitSize: 3,
			previousEventfulAggregateVersion: null,
		});

		await projector.project([first]);
		await expect(projector.project([third])).rejects.toThrow(/gap/i);
		expect(rows).toEqual([first.event.eventId]);
	});

	it("rejects the next commit while the previous commit is incomplete", async () => {
		const rows: string[] = [];
		const projector = new Projector({
			scope: passthroughScope,
			checkpoints: new InMemoryProjectionCheckpointStore(),
			projection: arrayProjection(rows),
		});
		const partial = placed("o-1", 4, 0, 1, {
			commitSize: 2,
			previousEventfulAggregateVersion: null,
		});
		const nextCommit = placed("o-1", 6, 0, 1, {
			previousEventfulAggregateVersion: 4,
		});

		await projector.project([partial]);
		await expect(projector.project([nextCommit])).rejects.toThrow(/gap/i);
		expect(rows).toEqual([partial.event.eventId]);
	});

	it("orders within one commit by commitSequence and dedupes at that grain", async () => {
		const rows: string[] = [];
		const projector = new Projector({
			scope: passthroughScope,
			checkpoints: new InMemoryProjectionCheckpointStore(),
			projection: arrayProjection(rows),
		});

		await projector.project([
			placed("o-1", 5, 0, 1, {
				commitSize: 2,
				previousEventfulAggregateVersion: null,
			}),
			placed("o-1", 5, 1, 1, {
				commitSize: 2,
				previousEventfulAggregateVersion: null,
			}),
		]);
		// Redelivery of only the commit's first event: behind (5, 1).
		const result = await projector.project([
			placed("o-1", 5, 0, 1, {
				commitSize: 2,
				previousEventfulAggregateVersion: null,
			}),
		]);

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

	it("rejects different eventIds mapped to the same position inside one batch", async () => {
		const rows: string[] = [];
		const projector = new Projector({
			scope: passthroughScope,
			checkpoints: new InMemoryProjectionCheckpointStore(),
			projection: arrayProjection(rows),
		});
		const original = placed("o-1", 1, 0);
		const identityConflict: CommittedDomainEvent<OrderPlaced> = {
			...original,
			event: createDomainEvent(
				"OrderPlaced",
				{ total: 1 },
				{
					aggregateId: "o-1",
					aggregateType: "Order",
					eventId: "evt-forged-in-batch",
				},
			),
		};

		await expect(
			projector.project([original, identityConflict]),
		).rejects.toMatchObject({
			code: "PROJECTION_IDENTITY_VIOLATION",
			category: "INFRASTRUCTURE",
		});
		expect(rows).toEqual([]);
	});

	it("rejects an envelope without a position loudly, before applying anything", async () => {
		const rows: string[] = [];
		const projector = new Projector({
			scope: passthroughScope,
			checkpoints: new InMemoryProjectionCheckpointStore(),
			projection: arrayProjection(rows),
		});
		const event = createDomainEvent(
			"OrderPlaced",
			{ total: 1 },
			{ aggregateId: "o-1", aggregateType: "Order" },
		);
		const unstamped = {
			event,
			source: { aggregateId: "o-1", aggregateType: "Order" },
		};

		await expect(
			projector.project([placed("o-1", 1, 0), unstamped as never]),
		).rejects.toThrow(/carries no complete projection cursor/);
		// Pre-transaction validation: the stamped first event must not
		// have been applied either.
		expect(rows).toEqual([]);
	});

	it("rejects an envelope without a stable eventId before applying anything", async () => {
		const rows: string[] = [];
		const projector = new Projector({
			scope: passthroughScope,
			checkpoints: new InMemoryProjectionCheckpointStore(),
			projection: arrayProjection(rows),
		});
		const invalid = {
			...placed("o-1", 1, 0),
			event: {
				...placed("o-1", 1, 0).event,
				eventId: "",
			},
		};

		await expect(projector.project([invalid])).rejects.toThrow(
			/non-empty eventId/i,
		);
		expect(rows).toEqual([]);
	});

	it("rejects an envelope source without aggregateId", async () => {
		const projector = new Projector({
			scope: passthroughScope,
			checkpoints: new InMemoryProjectionCheckpointStore(),
			projection: arrayProjection([]),
		});
		const event = createDomainEvent("OrderPlaced", { total: 1 });
		const homeless = {
			event,
			source: undefined,
			position: placed("o-1", 1, 0).position,
		};

		await expect(projector.project([homeless as never])).rejects.toThrow(
			/carries no aggregateId/,
		);
	});

	it("accepts envelopes built from an event store's own ordering", async () => {
		const rows: string[] = [];
		const projector = new Projector<OrderEvent, undefined>({
			scope: passthroughScope,
			checkpoints: new InMemoryProjectionCheckpointStore(),
			projection: arrayProjection(rows),
		});
		const fromStore = (
			id: string,
			pos: number,
		): CommittedDomainEvent<OrderPlaced> => {
			const event = createDomainEvent(
				"OrderPlaced",
				{ total: 1 },
				{
					aggregateId: id,
					aggregateType: "Order",
					eventId: `es-${id}-${pos}`,
					metadata: { streamPosition: pos },
				},
			);
			return {
				event,
				source: { aggregateId: id, aggregateType: "Order" },
				position: {
					aggregateVersion: pos,
					commitSequence: 0,
					commitSize: 1,
					previousEventfulAggregateVersion: pos === 1 ? null : pos - 1,
				},
			};
		};

		await projector.project([fromStore("o-1", 1), fromStore("o-1", 2)]);
		const replay = await projector.project([fromStore("o-1", 1)]);

		expect(replay).toEqual({ applied: 0, skipped: 1 });
		expect(rows).toEqual(["es-o-1-1", "es-o-1-2"]);
	});

	it("hasProcessed answers the wait-for-version question at full cursor grain", async () => {
		const projector = new Projector({
			scope: passthroughScope,
			checkpoints: new InMemoryProjectionCheckpointStore(),
			projection: arrayProjection([]),
		});

		await projector.project([
			placed("o-1", 5, 0, 1, {
				commitSize: 2,
				previousEventfulAggregateVersion: null,
			}),
		]);

		await expect(
			projector.hasProcessed(
				{ aggregateType: "Order", aggregateId: "o-1" },
				{
					aggregateVersion: 5,
					commitSequence: 0,
					commitSize: 2,
					previousEventfulAggregateVersion: null,
				},
			),
		).resolves.toBe(true);
		// The commit emitted a second event that has not been applied yet:
		// version-level "reached" would lie here, the pair does not.
		await expect(
			projector.hasProcessed(
				{ aggregateType: "Order", aggregateId: "o-1" },
				{
					aggregateVersion: 5,
					commitSequence: 1,
					commitSize: 2,
					previousEventfulAggregateVersion: null,
				},
			),
		).resolves.toBe(false);
		await expect(
			projector.hasProcessed(
				{ aggregateType: "Order", aggregateId: "o-2" },
				{
					aggregateVersion: 1,
					commitSequence: 0,
					commitSize: 1,
					previousEventfulAggregateVersion: null,
				},
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

		const orderEvent = createDomainEvent(
			"OrderPlaced",
			{ total: 1 },
			{
				aggregateId: "1",
				aggregateType: "Order",
				eventId: "evt-order-1",
			},
		);
		const paymentEvent = createDomainEvent(
			"OrderPlaced",
			{ total: 1 },
			{
				aggregateId: "1",
				aggregateType: "Payment",
				eventId: "evt-payment-1",
			},
		);
		const orderAt10: CommittedDomainEvent<typeof orderEvent> = {
			event: orderEvent,
			source: { aggregateId: "1", aggregateType: "Order" },
			position: {
				aggregateVersion: 10,
				commitSequence: 0,
				commitSize: 1,
				previousEventfulAggregateVersion: null,
			},
		};
		const paymentAt1: CommittedDomainEvent<typeof paymentEvent> = {
			event: paymentEvent,
			source: { aggregateId: "1", aggregateType: "Payment" },
			position: {
				aggregateVersion: 1,
				commitSequence: 0,
				commitSize: 1,
				previousEventfulAggregateVersion: null,
			},
		};

		const result = await projector.project([orderAt10, paymentAt1]);

		expect(result).toEqual({ applied: 2, skipped: 0 });
		expect(rows).toEqual(["evt-order-1", "evt-payment-1"]);
	});

	it("rejects an event aggregateId that contradicts its envelope source before the batch starts", async () => {
		const rows: string[] = [];
		const checkpoints = new InMemoryProjectionCheckpointStore();
		const projector = new Projector({
			scope: passthroughScope,
			checkpoints,
			projection: arrayProjection(rows),
		});
		const validPrefix = placed("o-valid", 1, 0);
		const mismatched = {
			...placed("o-event", 1, 0),
			source: { aggregateType: "Order", aggregateId: "o-envelope" },
		};

		await expect(
			projector.project([validPrefix, mismatched]),
		).rejects.toMatchObject({
			code: "FOREIGN_EVENT",
			expectedAggregateId: "o-envelope",
			actualAggregateId: "o-event",
		});
		expect(rows).toEqual([]);
		await expect(
			checkpoints.load(undefined, "order-list", validPrefix.source),
		).resolves.toBeUndefined();
	});

	it("rejects an event aggregateType that contradicts its envelope source", async () => {
		const rows: string[] = [];
		const projector = new Projector({
			scope: passthroughScope,
			checkpoints: new InMemoryProjectionCheckpointStore(),
			projection: arrayProjection(rows),
		});
		const mismatched = {
			...placed("shared-id", 1, 0),
			source: { aggregateType: "Payment", aggregateId: "shared-id" },
		};

		await expect(projector.project([mismatched])).rejects.toBeInstanceOf(
			ForeignEventError,
		);
		expect(rows).toEqual([]);
	});

	it("uses the envelope source when the bare event has no optional address", async () => {
		const rows: string[] = [];
		const checkpoints = new InMemoryProjectionCheckpointStore();
		const projector = new Projector({
			scope: passthroughScope,
			checkpoints,
			projection: arrayProjection(rows),
		});
		const event = createDomainEvent(
			"OrderPlaced",
			{ total: 1 },
			{
				eventId: "evt-unaddressed",
			},
		);
		const committed: CommittedDomainEvent<typeof event> = {
			event,
			source: { aggregateType: "Order", aggregateId: "o-envelope" },
			position: {
				aggregateVersion: 1,
				commitSequence: 0,
				commitSize: 1,
				previousEventfulAggregateVersion: null,
			},
		};

		await expect(projector.project([committed])).resolves.toEqual({
			applied: 1,
			skipped: 0,
		});
		expect(rows).toEqual(["evt-unaddressed"]);
		await expect(
			checkpoints.load(undefined, "order-list", committed.source),
		).resolves.toMatchObject({ lastAppliedEventId: "evt-unaddressed" });
	});

	it("rejects an envelope source without an aggregateType before applying anything", async () => {
		const rows: string[] = [];
		const projector = new Projector({
			scope: passthroughScope,
			checkpoints: new InMemoryProjectionCheckpointStore(),
			projection: arrayProjection(rows),
		});
		const event = createDomainEvent(
			"OrderPlaced",
			{ total: 1 },
			{
				eventId: "evt-untyped",
			},
		);
		const untyped = {
			event,
			source: { aggregateId: "o-1", aggregateType: "" },
			position: placed("o-1", 1, 0).position,
		};

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
		const committed = new Map<string, ProjectionCheckpoint>();
		const checkpoints: ProjectionCheckpointStore<Ctx> = {
			withCheckpointLocks: async (_ctx, _projection, _addresses, work) =>
				work(),
			load: async (_ctx, _p, address) => committed.get(address.aggregateId),
			save: async (ctx, _p, address, checkpoint) => {
				ctx.staged.push(() => committed.set(address.aggregateId, checkpoint));
			},
			hasReached: async (_p, address, position) => {
				const stored = committed.get(address.aggregateId);
				if (!stored) return false;
				return (
					stored.position.aggregateVersion > position.aggregateVersion ||
					(stored.position.aggregateVersion === position.aggregateVersion &&
						stored.position.commitSequence >= position.commitSequence)
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
					if (event.eventId.includes("-2-")) throw new Error("handler bug");
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
		const committed = new Map<string, ProjectionCheckpoint>();
		const checkpoints: ProjectionCheckpointStore<Ctx> = {
			withCheckpointLocks: async (_ctx, _projection, _addresses, work) =>
				work(),
			load: async (_ctx, _p, address) => committed.get(address.aggregateId),
			save: async (ctx, _p, address, checkpoint) => {
				ctx.staged.push(() => committed.set(address.aggregateId, checkpoint));
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
					if (failOnce && event.eventId.includes("-2-")) {
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
		const committed = new Map<string, ProjectionCheckpoint>();
		// load sees ONLY committed state: no read-your-writes inside the
		// open transaction. The projector's in-memory batch watermark must
		// still catch the duplicate.
		const checkpoints: ProjectionCheckpointStore<Ctx> = {
			withCheckpointLocks: async (_ctx, _projection, _addresses, work) =>
				work(),
			load: async (_ctx, _p, address) => committed.get(address.aggregateId),
			save: async (ctx, _p, address, checkpoint) => {
				ctx.staged.push(() => committed.set(address.aggregateId, checkpoint));
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
		const [redelivery] = await outbox.getPending(1);
		if (!redelivery) throw new Error("expected pending outbox record");

		expect(await dispatcher.drainOnce()).toBe("drained");
		// Broker redelivery repeats the already-finalized record; it does not
		// enqueue the old aggregate commit through OutboxWriter again.
		await expect(
			projector.toOutboxSink().publish(redelivery),
		).resolves.toBeUndefined();

		expect(rows).toEqual(["evt-o-1-1-0", "evt-o-1-2-0"]);
	});
});
