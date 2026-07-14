import { describe, expect, it } from "vitest";
import type { Version } from "../aggregate/aggregate";
import type { IAggregateRoot } from "../aggregate/aggregate-root";
import { createDomainEvent, type DomainEvent } from "../aggregate/domain-event";
import { EventHarvestError, InfrastructureError } from "../core/errors";
import type { Id } from "../core/id";
import type { EventBus, EventCommitCandidate, Outbox } from "../events/ports";
import type { TransactionScope } from "../repo/scope";
import {
	type AggregateCommitToken,
	type CommitEnrollment,
	type WithCommitWorkResult,
	withCommit,
} from "./handler";

type TestEvent = DomainEvent<"OrderCreated", { orderId: string }>;
type TestId = Id<"TestId">;

type MockAggregate = IAggregateRoot<TestId, TestEvent> & {
	markPersistedCalls: number;
};

function createMockAggregate(
	events: TestEvent[],
	version = 1,
	persistedVersion?: number,
): MockAggregate {
	let pending: TestEvent[] = [...events];
	let calls = 0;
	return {
		id: "agg-1" as TestId,
		version: version as Version,
		persistedVersion: persistedVersion as Version | undefined,
		get pendingEvents(): ReadonlyArray<TestEvent> {
			return pending;
		},
		clearPendingEvents(): void {
			pending = [];
		},
		markPersisted(_v: Version): void {
			pending = [];
			calls += 1;
		},
		get markPersistedCalls(): number {
			return calls;
		},
	};
}

function createMockScope(): TransactionScope<undefined> {
	return {
		transactional: <T>(fn: (_ctx: undefined) => Promise<T>) => fn(undefined),
	};
}

function createMockOutbox(): Outbox<TestEvent> & {
	added: EventCommitCandidate<TestEvent>[][];
} {
	const added: EventCommitCandidate<TestEvent>[][] = [];
	return {
		added,
		add: async (events) => {
			added.push([...events]);
		},
		getPending: async () => [],
		markDispatched: async () => {},
	};
}

function createMockBus(): EventBus<TestEvent> & { published: TestEvent[][] } {
	const published: TestEvent[][] = [];
	return {
		published,
		publish: async (events) => {
			published.push([...events]);
		},
		subscribe: () => () => {},
		subscribeAll: () => () => {},
		once: () => new Promise(() => {}),
	};
}

/** Expected persistence envelope for one harvested event. */
function stamped(
	event: TestEvent,
	aggregateVersion = 1,
	commitSequence = 0,
	commitSize = 1,
): EventCommitCandidate<TestEvent> {
	return {
		event,
		source: {
			aggregateId: event.aggregateId ?? "agg-1",
			aggregateType: event.aggregateType ?? "MockOrder",
		},
		position: {
			aggregateVersion,
			commitSequence,
			commitSize,
		},
	};
}

function enrolledResult<R>(
	enrollment: CommitEnrollment<TestEvent>,
	result: R,
	aggregates: ReadonlyArray<IAggregateRoot<Id<string>, TestEvent>>,
	deleted: ReadonlyArray<IAggregateRoot<Id<string>, TestEvent>> = [],
): WithCommitWorkResult<TestEvent, R> {
	const deletedSet = new Set(deleted);
	return {
		result,
		commits: aggregates.map((aggregate) =>
			deletedSet.has(aggregate)
				? enrollment.enrollDeleted(aggregate)
				: enrollment.enrollSaved(aggregate),
		),
	};
}

describe("withCommit", () => {
	it("keeps commit evidence opaque at the type boundary", () => {
		const legacy: WithCommitWorkResult<TestEvent, string> = {
			result: "legacy",
			// @ts-expect-error a naked aggregate array is no longer a work result
			aggregates: [],
		};
		// @ts-expect-error consumers cannot structurally construct the private brand
		const forged: AggregateCommitToken<TestEvent> = {};

		expect(legacy.result).toBe("legacy");
		expect(forged).toEqual({});
	});

	it("returns the result from the function", async () => {
		const result = await withCommit(
			{ outbox: createMockOutbox(), scope: createMockScope() },
			async () => ({ result: "order-123", commits: [] }),
		);

		expect(result).toBe("order-123");
	});

	it("harvests pendingEvents only from enrolled commit tokens", async () => {
		const outbox = createMockOutbox();
		const event = createDomainEvent(
			"OrderCreated",
			{ orderId: "order-1" },
			{ aggregateId: "order-1", aggregateType: "MockOrder" },
		);
		const agg = createMockAggregate([event]);

		await withCommit(
			{ outbox, scope: createMockScope() },
			async (_ctx, enrollment) => enrolledResult(enrollment, "ok", [agg]),
		);

		expect(outbox.added).toHaveLength(1);
		expect(outbox.added[0]).toEqual([stamped(event)]);
	});

	it("rejects a fresh aggregate that was never enrolled by persistence", async () => {
		const outbox = createMockOutbox();
		const event = createDomainEvent(
			"OrderCreated",
			{ orderId: "order-1" },
			{ aggregateId: "order-1", aggregateType: "MockOrder" },
		);
		const aggregate = createMockAggregate([event]);

		await expect(
			withCommit(
				{ outbox, scope: createMockScope() },
				async () =>
					({
						result: "must not commit",
						aggregates: [aggregate],
					}) as unknown as WithCommitWorkResult<TestEvent, string>,
			),
		).rejects.toBeInstanceOf(EventHarvestError);
		expect(outbox.added).toEqual([]);
		expect(aggregate.pendingEvents).toEqual([event]);
		expect(aggregate.markPersistedCalls).toBe(0);
	});

	it("rejects a forged commit token before harvesting", async () => {
		const outbox = createMockOutbox();
		const event = createDomainEvent(
			"OrderCreated",
			{ orderId: "order-1" },
			{ aggregateId: "order-1", aggregateType: "MockOrder" },
		);
		const aggregate = createMockAggregate([event]);
		const forged = Object.freeze({}) as AggregateCommitToken<TestEvent>;

		await expect(
			withCommit({ outbox, scope: createMockScope() }, async () => ({
				result: "must not commit",
				commits: [forged],
			})),
		).rejects.toBeInstanceOf(EventHarvestError);
		expect(outbox.added).toEqual([]);
		expect(aggregate.pendingEvents).toEqual([event]);
		expect(aggregate.markPersistedCalls).toBe(0);
	});

	it("rejects a token minted by an earlier withCommit invocation", async () => {
		let staleToken: AggregateCommitToken<TestEvent> | undefined;
		const firstAggregate = createMockAggregate([]);
		await withCommit(
			{ outbox: createMockOutbox(), scope: createMockScope() },
			async (_ctx, enrollment) => {
				staleToken = enrollment.enrollSaved(firstAggregate);
				return { result: undefined, commits: [staleToken] };
			},
		);

		const outbox = createMockOutbox();
		await expect(
			withCommit({ outbox, scope: createMockScope() }, async () => ({
				result: "must not commit",
				commits: [staleToken as AggregateCommitToken<TestEvent>],
			})),
		).rejects.toBeInstanceOf(EventHarvestError);
		expect(outbox.added).toEqual([]);
	});

	it("does not harvest an enrolled aggregate whose token was not returned", async () => {
		const outbox = createMockOutbox();
		const event = createDomainEvent(
			"OrderCreated",
			{ orderId: "order-omitted" },
			{ aggregateId: "order-omitted", aggregateType: "MockOrder" },
		);
		const aggregate = createMockAggregate([event]);

		await withCommit(
			{ outbox, scope: createMockScope() },
			async (_ctx, enrollment) => {
				enrollment.enrollSaved(aggregate);
				return { result: undefined, commits: [] };
			},
		);

		expect(outbox.added).toEqual([]);
		expect(aggregate.pendingEvents).toEqual([event]);
		expect(aggregate.markPersistedCalls).toBe(0);
	});

	it("seals enrollment before the outbox write begins", async () => {
		let signalOutboxStarted: () => void = () => {};
		const outboxStarted = new Promise<void>((resolve) => {
			signalOutboxStarted = resolve;
		});
		let releaseOutbox: () => void = () => {};
		const outboxBlocked = new Promise<void>((resolve) => {
			releaseOutbox = resolve;
		});
		const outbox = createMockOutbox();
		outbox.add = async (events) => {
			outbox.added.push([...events]);
			signalOutboxStarted();
			await outboxBlocked;
		};
		const aggregate = createMockAggregate([
			createDomainEvent(
				"OrderCreated",
				{ orderId: "order-late" },
				{ aggregateId: "order-late", aggregateType: "MockOrder" },
			),
		]);
		let leaked: CommitEnrollment<TestEvent> | undefined;

		const execution = withCommit(
			{ outbox, scope: createMockScope() },
			async (_ctx, enrollment) => {
				leaked = enrollment;
				return enrolledResult(enrollment, "ok", [aggregate]);
			},
		);
		await outboxStarted;

		expect(() => leaked?.enrollSaved(createMockAggregate([]))).toThrow(
			EventHarvestError,
		);
		releaseOutbox();
		await expect(execution).resolves.toBe("ok");
	});

	it("writes a committed envelope to the outbox but publishes the bare domain event", async () => {
		const outbox = createMockOutbox();
		const bus = createMockBus();
		const event = createDomainEvent(
			"OrderCreated",
			{ orderId: "order-1" },
			{ aggregateId: "order-1", aggregateType: "MockOrder" },
		);
		const agg = createMockAggregate([event], 7, 5);

		await withCommit(
			{ outbox, bus, scope: createMockScope() },
			async (_ctx, enrollment) => enrolledResult(enrollment, "ok", [agg]),
		);

		expect(outbox.added[0]?.[0]).toEqual({
			event,
			source: { aggregateId: "order-1", aggregateType: "MockOrder" },
			position: {
				aggregateVersion: 7,
				commitSequence: 0,
				commitSize: 1,
			},
		});
		expect(bus.published).toEqual([[event]]);
	});

	it("leaves the previous eventful commit to the outbox source", async () => {
		const outbox = createMockOutbox();
		const event = createDomainEvent(
			"OrderCreated",
			{ orderId: "order-1" },
			{ aggregateId: "order-1", aggregateType: "MockOrder" },
		);
		const agg = createMockAggregate([event], 7, 5);

		await withCommit(
			{ outbox, scope: createMockScope() },
			async (_ctx, enrollment) => enrolledResult(enrollment, "ok", [agg]),
		);

		const candidate = outbox.added[0]?.[0];
		expect(
			Object.hasOwn(
				candidate?.position ?? {},
				"previousEventfulAggregateVersion",
			),
		).toBe(false);
	});

	it("publishes harvested events to the bus when provided", async () => {
		const outbox = createMockOutbox();
		const bus = createMockBus();
		const event = createDomainEvent(
			"OrderCreated",
			{ orderId: "order-1" },
			{ aggregateId: "order-1", aggregateType: "MockOrder" },
		);
		const agg = createMockAggregate([event]);

		await withCommit(
			{ outbox, bus, scope: createMockScope() },
			async (_ctx, enrollment) => enrolledResult(enrollment, "ok", [agg]),
		);

		expect(bus.published).toHaveLength(1);
		expect(bus.published[0]).toEqual([event]);
	});

	it("works without a bus", async () => {
		const outbox = createMockOutbox();
		const event = createDomainEvent(
			"OrderCreated",
			{ orderId: "order-1" },
			{ aggregateId: "order-1", aggregateType: "MockOrder" },
		);
		const agg = createMockAggregate([event]);

		const result = await withCommit(
			{ outbox, scope: createMockScope() },
			async (_ctx, enrollment) => enrolledResult(enrollment, "ok", [agg]),
		);

		expect(result).toBe("ok");
		expect(outbox.added).toHaveLength(1);
	});

	it("runs fn inside the transaction scope", async () => {
		const callOrder: string[] = [];
		const scope: TransactionScope<undefined> = {
			transactional: async <T>(fn: (_ctx: undefined) => Promise<T>) => {
				callOrder.push("tx-start");
				const result = await fn(undefined);
				callOrder.push("tx-end");
				return result;
			},
		};

		await withCommit({ outbox: createMockOutbox(), scope }, async () => {
			callOrder.push("fn");
			return { result: "ok", commits: [] };
		});

		expect(callOrder).toEqual(["tx-start", "fn", "tx-end"]);
	});

	it("propagates errors from the function", async () => {
		await expect(
			withCommit(
				{ outbox: createMockOutbox(), scope: createMockScope() },
				async () => {
					throw new Error("Something went wrong");
				},
			),
		).rejects.toThrow("Something went wrong");
	});

	it("propagates errors from the outbox", async () => {
		const outbox: Outbox<TestEvent> = {
			add: async () => {
				throw new Error("Outbox failed");
			},
			getPending: async () => [],
			markDispatched: async () => {},
		};
		const agg = createMockAggregate([
			createDomainEvent(
				"OrderCreated",
				{ orderId: "order-1" },
				{ aggregateId: "order-1", aggregateType: "MockOrder" },
			),
		]);

		await expect(
			withCommit(
				{ outbox, scope: createMockScope() },
				async (_ctx, enrollment) => enrolledResult(enrollment, "ok", [agg]),
			),
		).rejects.toThrow("Outbox failed");
	});

	it("orders outbox.add inside tx, markPersisted + bus.publish after commit", async () => {
		const callOrder: string[] = [];
		const scope: TransactionScope<undefined> = {
			transactional: async <T>(fn: (_ctx: undefined) => Promise<T>) => {
				callOrder.push("tx-start");
				const result = await fn(undefined);
				callOrder.push("tx-commit");
				return result;
			},
		};
		const outbox: Outbox<TestEvent> = {
			add: async () => {
				callOrder.push("outbox.add");
			},
			getPending: async () => [],
			markDispatched: async () => {},
		};
		const bus: EventBus<TestEvent> = {
			publish: async () => {
				callOrder.push("bus.publish");
			},
			subscribe: () => () => {},
			subscribeAll: () => () => {},
			once: () => new Promise(() => {}),
		};
		// A specifically-instrumented mock that records when markPersisted is called.
		let pending: TestEvent[] = [
			createDomainEvent(
				"OrderCreated",
				{ orderId: "o-1" },
				{ aggregateId: "o-1", aggregateType: "MockOrder" },
			),
		];
		const agg: IAggregateRoot<TestId, TestEvent> = {
			id: "agg-1" as TestId,
			version: 1 as Version,
			persistedVersion: undefined,
			get pendingEvents() {
				return pending;
			},
			clearPendingEvents() {
				pending = [];
			},
			markPersisted() {
				callOrder.push("markPersisted");
				pending = [];
			},
		};

		await withCommit({ outbox, bus, scope }, async (_ctx, enrollment) => {
			callOrder.push("fn");
			return enrolledResult(enrollment, "ok", [agg]);
		});

		expect(callOrder).toEqual([
			"tx-start",
			"fn",
			"outbox.add",
			"tx-commit",
			"markPersisted",
			"bus.publish",
		]);
	});

	it("threads the TransactionScope context through to fn", async () => {
		type DrizzleLikeTx = { id: string; isTx: true };
		const tx: DrizzleLikeTx = { id: "tx-42", isTx: true };

		const scope: TransactionScope<DrizzleLikeTx> = {
			transactional: async <T>(
				fn: (ctx: DrizzleLikeTx) => Promise<T>,
			): Promise<T> => fn(tx),
		};

		let received: DrizzleLikeTx | undefined;
		await withCommit({ outbox: createMockOutbox(), scope }, async (ctx) => {
			received = ctx;
			return { result: ctx.id, commits: [] };
		});

		expect(received).toBe(tx);
	});

	it("calls markPersisted only AFTER the tx commits (not on a rolled-back tx)", async () => {
		const scope = createMockScope();
		const agg = createMockAggregate([
			createDomainEvent(
				"OrderCreated",
				{ orderId: "o-1" },
				{ aggregateId: "o-1", aggregateType: "MockOrder" },
			),
		]);

		await expect(
			withCommit({ outbox: createMockOutbox(), scope }, async () => {
				throw new Error("write failed");
			}),
		).rejects.toThrow("write failed");

		// fn threw before withCommit even saw the aggregate; markPersisted
		// must NOT have been called and pending events must survive.
		expect(agg.markPersistedCalls).toBe(0);
		expect(agg.pendingEvents).toHaveLength(1);
	});

	it("does not publish to the bus when the transaction throws", async () => {
		const scope = createMockScope();
		const outbox = createMockOutbox();
		const bus = createMockBus();

		await expect(
			withCommit({ outbox, bus, scope }, async () => {
				throw new Error("write failed");
			}),
		).rejects.toThrow("write failed");

		expect(bus.published).toHaveLength(0);
	});

	it("calls markPersisted on EACH returned aggregate", async () => {
		const a = createMockAggregate([
			createDomainEvent(
				"OrderCreated",
				{ orderId: "a" },
				{ aggregateId: "a", aggregateType: "MockOrder" },
			),
		]);
		const b = createMockAggregate([
			createDomainEvent(
				"OrderCreated",
				{ orderId: "b" },
				{ aggregateId: "b", aggregateType: "MockOrder" },
			),
		]);

		await withCommit(
			{ outbox: createMockOutbox(), scope: createMockScope() },
			async (_ctx, enrollment) => enrolledResult(enrollment, "ok", [a, b]),
		);

		expect(a.markPersistedCalls).toBe(1);
		expect(b.markPersistedCalls).toBe(1);
		expect(a.pendingEvents).toHaveLength(0);
		expect(b.pendingEvents).toHaveLength(0);
	});

	describe("committed event envelopes", () => {
		it("puts the aggregate commit version on the outbox envelope only", async () => {
			const outbox = createMockOutbox();
			const bus = createMockBus();
			const event = createDomainEvent(
				"OrderCreated",
				{ orderId: "o-1" },
				{ aggregateId: "o-1", aggregateType: "MockOrder" },
			);
			const agg = createMockAggregate([event], 7);

			await withCommit(
				{ outbox, bus, scope: createMockScope() },
				async (_ctx, enrollment) => enrolledResult(enrollment, "ok", [agg]),
			);

			expect(outbox.added[0]?.[0]?.position.aggregateVersion).toBe(7);
			expect(outbox.added[0]?.[0]?.event).toBe(event);
			expect(bus.published).toEqual([[event]]);
		});

		it("stamps per aggregate: two aggregates carry their own versions", async () => {
			const outbox = createMockOutbox();
			const eventA = createDomainEvent(
				"OrderCreated",
				{ orderId: "a" },
				{ aggregateId: "a", aggregateType: "MockOrder" },
			);
			const eventB = createDomainEvent(
				"OrderCreated",
				{ orderId: "b" },
				{ aggregateId: "b", aggregateType: "MockOrder" },
			);
			const aggA = createMockAggregate([eventA], 3);
			const aggB = createMockAggregate([eventB], 11);

			await withCommit(
				{ outbox, scope: createMockScope() },
				async (_ctx, enrollment) =>
					enrolledResult(enrollment, "ok", [aggA, aggB]),
			);

			expect(
				outbox.added[0]?.map((message) => [
					message.source.aggregateId,
					message.position.aggregateVersion,
				]),
			).toEqual([
				["a", 3],
				["b", 11],
			]);
		});

		it("freezes the envelope while retaining the original domain event", async () => {
			const outbox = createMockOutbox();
			const event = createDomainEvent(
				"OrderCreated",
				{ orderId: "o-1" },
				{ aggregateId: "o-1", aggregateType: "MockOrder" },
			);
			const agg = createMockAggregate([event], 7);

			await withCommit(
				{ outbox, scope: createMockScope() },
				async (_ctx, enrollment) => enrolledResult(enrollment, "ok", [agg]),
			);

			const message = outbox.added[0]?.[0];
			expect(message?.event).toBe(event);
			expect(Object.isFrozen(message)).toBe(true);
			expect(Object.isFrozen(message?.source)).toBe(true);
			expect(Object.isFrozen(message?.position)).toBe(true);
			expect(Object.hasOwn(event, "aggregateVersion")).toBe(false);
		});
	});

	it("deleted-marked aggregates: events harvested, pendingEvents cleared, but markPersisted (and onPersisted) never fires", async () => {
		// Deletion events must reach the outbox atomically with the row
		// removal, but the post-save lifecycle is a semantic lie for a
		// deleted row: a user onPersisted hook doing cache-fill would
		// resurrect the deleted aggregate in the cache.
		const deletionEvent = createDomainEvent(
			"OrderCreated",
			{ orderId: "del-1" },
			{ aggregateId: "del-1", aggregateType: "MockOrder" },
		);
		const savedEvent = createDomainEvent(
			"OrderCreated",
			{ orderId: "sav-1" },
			{ aggregateId: "sav-1", aggregateType: "MockOrder" },
		);
		const deletedAgg = createMockAggregate([deletionEvent]);
		const savedAgg = createMockAggregate([savedEvent]);
		const outbox = createMockOutbox();

		await withCommit(
			{ outbox, scope: createMockScope() },
			async (_ctx, enrollment) =>
				enrolledResult(enrollment, "ok", [savedAgg, deletedAgg], [deletedAgg]),
		);

		// Both aggregates' events were harvested, in array order.
		expect(outbox.added).toEqual([
			[stamped(savedEvent), stamped(deletionEvent)],
		]);
		// Saved aggregate: full post-commit lifecycle.
		expect(savedAgg.markPersistedCalls).toBe(1);
		// Deleted aggregate: events cleared (no re-emission on a later
		// commit), but NO markPersisted → no onPersisted hook.
		expect(deletedAgg.markPersistedCalls).toBe(0);
		expect(deletedAgg.pendingEvents).toHaveLength(0);
	});

	it("preserves harvest order: aggregates-array order, then each aggregate's emission order", async () => {
		// Subscribers will come to rely on this. Concatenation is:
		//   aggregates[0].pendingEvents... aggregates[1].pendingEvents... etc.
		const e1 = createDomainEvent(
			"OrderCreated",
			{ orderId: "a-evt-1" },
			{ aggregateId: "a-evt-1", aggregateType: "MockOrder" },
		);
		const e2 = createDomainEvent(
			"OrderCreated",
			{ orderId: "a-evt-2" },
			{ aggregateId: "a-evt-2", aggregateType: "MockOrder" },
		);
		const e3 = createDomainEvent(
			"OrderCreated",
			{ orderId: "b-evt-1" },
			{ aggregateId: "b-evt-1", aggregateType: "MockOrder" },
		);
		const e4 = createDomainEvent(
			"OrderCreated",
			{ orderId: "c-evt-1" },
			{ aggregateId: "c-evt-1", aggregateType: "MockOrder" },
		);

		const aggA = createMockAggregate([e1, e2]);
		const aggB = createMockAggregate([e3]);
		const aggC = createMockAggregate([e4]);

		const outbox = createMockOutbox();
		const bus = createMockBus();

		await withCommit(
			{ outbox, bus, scope: createMockScope() },
			async (_ctx, enrollment) =>
				enrolledResult(enrollment, "ok", [aggA, aggB, aggC]),
		);

		// Sequences restart per aggregate: [e1, e2] on A, [e3] on B, [e4] on C.
		const expected = [
			stamped(e1, 1, 0, 2),
			stamped(e2, 1, 1, 2),
			stamped(e3, 1, 0),
			stamped(e4, 1, 0),
		];
		expect(outbox.added).toEqual([expected]);
		expect(bus.published).toEqual([[e1, e2, e3, e4]]);
	});

	it("dedupes aggregates by reference: same instance twice harvests events once and markPersists once", async () => {
		// A use case that touches the same aggregate via two repository
		// references (same identity-map entry) would otherwise double-
		// harvest its events through the outbox and call markPersisted
		// twice. Dedupe is by JavaScript object identity; distinct
		// instances with the same logical id are NOT detected here.
		const event = createDomainEvent(
			"OrderCreated",
			{ orderId: "o-1" },
			{ aggregateId: "o-1", aggregateType: "MockOrder" },
		);
		const agg = createMockAggregate([event]);

		const outbox = createMockOutbox();
		const bus = createMockBus();

		await withCommit(
			{ outbox, bus, scope: createMockScope() },
			async (_ctx, enrollment) =>
				enrolledResult(enrollment, "ok", [agg, agg, agg]),
		);

		// Event harvested exactly once.
		expect(outbox.added).toEqual([[stamped(event)]]);
		expect(bus.published).toEqual([[event]]);
		// markPersisted called exactly once on the deduped aggregate.
		expect(agg.markPersistedCalls).toBe(1);
	});

	it("throws if a harvested event is missing aggregateId (recordEvent guard)", async () => {
		// A direct createDomainEvent without aggregateId would silently
		// break downstream routing. The guard catches it at the harvest
		// boundary with a diagnostic message naming the event type and
		// the missing field.
		const badEvent = createDomainEvent(
			"OrderCreated",
			{ orderId: "x" },
			{
				// aggregateType set, aggregateId NOT set → guard rejects
				aggregateType: "MockOrder",
			},
		);
		const agg = createMockAggregate([badEvent]);

		await expect(
			withCommit(
				{ outbox: createMockOutbox(), scope: createMockScope() },
				async (_ctx, enrollment) => enrolledResult(enrollment, "ok", [agg]),
			),
		).rejects.toThrow(/aggregateId/);
	});

	it("the harvest guard throws EventHarvestError, not a retryable InfrastructureError", async () => {
		const badEvent = createDomainEvent(
			"OrderCreated",
			{ orderId: "x" },
			{
				aggregateType: "MockOrder",
			},
		);
		const agg = createMockAggregate([badEvent]);

		const rejection = await withCommit(
			{ outbox: createMockOutbox(), scope: createMockScope() },
			async (_ctx, enrollment) => enrolledResult(enrollment, "ok", [agg]),
		).catch((e) => e);

		expect(rejection).toBeInstanceOf(EventHarvestError);
		expect(rejection).not.toBeInstanceOf(InfrastructureError);
	});

	it("throws if a harvested event is missing aggregateType (recordEvent guard)", async () => {
		const badEvent = createDomainEvent(
			"OrderCreated",
			{ orderId: "x" },
			{
				aggregateId: "x",
				// aggregateType missing → guard rejects
			},
		);
		const agg = createMockAggregate([badEvent]);

		await expect(
			withCommit(
				{ outbox: createMockOutbox(), scope: createMockScope() },
				async (_ctx, enrollment) => enrolledResult(enrollment, "ok", [agg]),
			),
		).rejects.toThrow(/aggregateType/);
	});

	it("guard error message names the event type and lists both missing fields", async () => {
		const badEvent = createDomainEvent("OrderCreated", { orderId: "x" });
		const agg = createMockAggregate([badEvent]);

		await expect(
			withCommit(
				{ outbox: createMockOutbox(), scope: createMockScope() },
				async (_ctx, enrollment) => enrolledResult(enrollment, "ok", [agg]),
			),
		).rejects.toThrow(
			/withCommit: event "OrderCreated" is missing aggregateId and aggregateType/,
		);
	});

	it("skips outbox.add and bus.publish when no aggregates emit events", async () => {
		const outbox = createMockOutbox();
		const bus = createMockBus();
		const agg = createMockAggregate([]);

		await withCommit(
			{ outbox, bus, scope: createMockScope() },
			async (_ctx, enrollment) => enrolledResult(enrollment, "ok", [agg]),
		);

		expect(outbox.added).toHaveLength(0);
		expect(bus.published).toHaveLength(0);
		// markPersisted still runs; keeps the lifecycle consistent even
		// for empty-event commits.
		expect(agg.markPersistedCalls).toBe(1);
	});

	it("rejects an eventful persisted commit that did not advance aggregate version", async () => {
		const outbox = createMockOutbox();
		const event = createDomainEvent(
			"OrderCreated",
			{ orderId: "o-1" },
			{ aggregateId: "o-1", aggregateType: "MockOrder" },
		);
		const aggregate = createMockAggregate([event], 5, 5);

		await expect(
			withCommit(
				{ outbox, scope: createMockScope() },
				async (_ctx, enrollment) =>
					enrolledResult(enrollment, "r", [aggregate]),
			),
		).rejects.toThrow(/did not advance/i);
		expect(outbox.added).toHaveLength(0);
	});

	describe("post-commit markPersisted isolation", () => {
		it("marks every aggregate persisted even when one onPersisted hook throws", async () => {
			const eventA = createDomainEvent(
				"OrderCreated",
				{ orderId: "a" },
				{ aggregateId: "a", aggregateType: "MockOrder" },
			);
			const eventB = createDomainEvent(
				"OrderCreated",
				{ orderId: "b" },
				{ aggregateId: "b", aggregateType: "MockOrder" },
			);
			const aggA = createMockAggregate([eventA]);
			const throwingA: MockAggregate = {
				...aggA,
				get pendingEvents() {
					return aggA.pendingEvents;
				},
				get markPersistedCalls() {
					return aggA.markPersistedCalls;
				},
				markPersisted(v) {
					aggA.markPersisted(v);
					// User-overridable onPersisted hooks can throw; the
					// post-commit loop must not abort for the peers.
					throw new Error("cache eviction failed");
				},
			};
			const aggB = createMockAggregate([eventB]);
			const bus = createMockBus();

			const result = await withCommit(
				{ outbox: createMockOutbox(), bus, scope: createMockScope() },
				async (_ctx, enrollment) =>
					enrolledResult(enrollment, "ok", [throwingA, aggB]),
			);

			// Committed result survives; B's pending events were flushed
			// (no double emission on the next commit); publish still ran.
			expect(result).toBe("ok");
			expect(aggB.markPersistedCalls).toBe(1);
			expect(aggB.pendingEvents).toHaveLength(0);
			expect(bus.published).toHaveLength(1);
		});

		it("reports a post-commit persistence failure via onPersistError with the failing aggregate", async () => {
			const event = createDomainEvent(
				"OrderCreated",
				{ orderId: "a" },
				{ aggregateId: "a", aggregateType: "MockOrder" },
			);
			const base = createMockAggregate([event]);
			const persistError = new Error("cache eviction failed");
			const throwing: MockAggregate = {
				...base,
				get pendingEvents() {
					return base.pendingEvents;
				},
				get markPersistedCalls() {
					return base.markPersistedCalls;
				},
				markPersisted(v) {
					base.markPersisted(v);
					throw persistError;
				},
			};
			const reported: Array<{ error: unknown; aggregate: unknown }> = [];

			const result = await withCommit(
				{
					outbox: createMockOutbox(),
					bus: createMockBus(),
					scope: createMockScope(),
					onPersistError: (error, aggregate) => {
						reported.push({ error, aggregate });
					},
				},
				async (_ctx, enrollment) =>
					enrolledResult(enrollment, "ok", [throwing]),
			);

			// The write committed; the persistence-cleanup failure is reported,
			// not thrown.
			expect(result).toBe("ok");
			expect(reported).toHaveLength(1);
			expect(reported[0]?.error).toBe(persistError);
			expect(reported[0]?.aggregate).toBe(throwing);
		});

		it("swallows a throwing onPersistError observer so the post-commit invariant holds", async () => {
			const eventA = createDomainEvent(
				"OrderCreated",
				{ orderId: "a" },
				{ aggregateId: "a", aggregateType: "MockOrder" },
			);
			const eventB = createDomainEvent(
				"OrderCreated",
				{ orderId: "b" },
				{ aggregateId: "b", aggregateType: "MockOrder" },
			);
			const aggA = createMockAggregate([eventA]);
			const throwingA: MockAggregate = {
				...aggA,
				get pendingEvents() {
					return aggA.pendingEvents;
				},
				get markPersistedCalls() {
					return aggA.markPersistedCalls;
				},
				markPersisted(v) {
					aggA.markPersisted(v);
					throw new Error("cache eviction failed");
				},
			};
			const aggB = createMockAggregate([eventB]);

			const result = await withCommit(
				{
					outbox: createMockOutbox(),
					bus: createMockBus(),
					scope: createMockScope(),
					onPersistError: () => {
						// A misbehaving observer must not break the invariant.
						throw new Error("observer blew up");
					},
				},
				async (_ctx, enrollment) =>
					enrolledResult(enrollment, "ok", [throwingA, aggB]),
			);

			// Peer B is still marked; the committed write still resolves.
			expect(result).toBe("ok");
			expect(aggB.markPersistedCalls).toBe(1);
			expect(aggB.pendingEvents).toHaveLength(0);
		});

		it("does not invoke onPersistError when persistence cleanup succeeds", async () => {
			const event = createDomainEvent(
				"OrderCreated",
				{ orderId: "a" },
				{ aggregateId: "a", aggregateType: "MockOrder" },
			);
			const agg = createMockAggregate([event]);
			let reported = 0;

			const result = await withCommit(
				{
					outbox: createMockOutbox(),
					bus: createMockBus(),
					scope: createMockScope(),
					onPersistError: () => {
						reported += 1;
					},
				},
				async (_ctx, enrollment) => enrolledResult(enrollment, "ok", [agg]),
			);

			expect(result).toBe("ok");
			expect(reported).toBe(0);
			expect(agg.markPersistedCalls).toBe(1);
		});

		it("neutralises an async (rejecting) onPersistError instead of leaking an unhandled rejection", async () => {
			// The observer is typed `=> void`, but a `void` return still admits
			// an async function: a rejecting one must not become an
			// unhandledRejection after a committed write.
			const event = createDomainEvent(
				"OrderCreated",
				{ orderId: "a" },
				{ aggregateId: "a", aggregateType: "MockOrder" },
			);
			const base = createMockAggregate([event]);
			const throwing: MockAggregate = {
				...base,
				get pendingEvents() {
					return base.pendingEvents;
				},
				get markPersistedCalls() {
					return base.markPersistedCalls;
				},
				markPersisted(v) {
					base.markPersisted(v);
					throw new Error("cleanup failed");
				},
			};

			const unhandled: unknown[] = [];
			const onUnhandled = (reason: unknown): void => {
				unhandled.push(reason);
			};
			// @ts-expect-error Node's process exists in the test runtime; the package stays Node-type-free.
			process.on("unhandledRejection", onUnhandled);
			try {
				const result = await withCommit(
					{
						outbox: createMockOutbox(),
						bus: createMockBus(),
						scope: createMockScope(),
						onPersistError: async () => {
							throw new Error("async sink down");
						},
					},
					async (_ctx, enrollment) =>
						enrolledResult(enrollment, "ok", [throwing]),
				);

				expect(result).toBe("ok");
				// A macrotask tick lets any un-swallowed rejection surface.
				await new Promise((resolve) => setTimeout(resolve, 0));
				expect(unhandled).toEqual([]);
			} finally {
				// @ts-expect-error Node's process exists in the test runtime; the package stays Node-type-free.
				process.off("unhandledRejection", onUnhandled);
			}
		});
	});

	describe("post-commit bus.publish failure", () => {
		function createFailingBus(error: unknown): EventBus<TestEvent> {
			return {
				publish: async () => {
					throw error;
				},
				subscribe: () => () => {},
				subscribeAll: () => () => {},
				once: () => new Promise(() => {}),
			};
		}

		function createAggWithEvent(): MockAggregate {
			const event = createDomainEvent(
				"OrderCreated",
				{ orderId: "order-1" },
				{ aggregateId: "order-1", aggregateType: "MockOrder" },
			);
			return createMockAggregate([event]);
		}

		it("returns the committed result even when an in-process subscriber fails", async () => {
			// The tx committed and the outbox holds the events; a publish
			// failure is eventual consistency, not use-case failure. A
			// rejection here would make callers retry a committed write.
			const agg = createAggWithEvent();

			const result = await withCommit(
				{
					outbox: createMockOutbox(),
					bus: createFailingBus(new Error("smtp down")),
					scope: createMockScope(),
				},
				async (_ctx, enrollment) =>
					enrolledResult(enrollment, "order-123", [agg]),
			);

			expect(result).toBe("order-123");
			// The commit lifecycle completed: pending events are flushed.
			expect(agg.markPersistedCalls).toBe(1);
		});

		it("reports the publish error and the affected events via onPublishError", async () => {
			const agg = createAggWithEvent();
			const publishError = new Error("subscriber blew up");
			const reported: Array<{
				error: unknown;
				events: ReadonlyArray<TestEvent>;
			}> = [];

			await withCommit(
				{
					outbox: createMockOutbox(),
					bus: createFailingBus(publishError),
					scope: createMockScope(),
					onPublishError: (error, events) => {
						reported.push({ error, events });
					},
				},
				async (_ctx, enrollment) => enrolledResult(enrollment, "ok", [agg]),
			);

			expect(reported).toHaveLength(1);
			expect(reported[0]?.error).toBe(publishError);
			expect(reported[0]?.events.map((e) => e.type)).toEqual(["OrderCreated"]);
		});

		it("does not invoke onPublishError when publish succeeds", async () => {
			const agg = createAggWithEvent();
			let reported = 0;

			const result = await withCommit(
				{
					outbox: createMockOutbox(),
					bus: createMockBus(),
					scope: createMockScope(),
					onPublishError: () => {
						reported += 1;
					},
				},
				async (_ctx, enrollment) => enrolledResult(enrollment, "ok", [agg]),
			);

			expect(result).toBe("ok");
			expect(reported).toBe(0);
		});

		it("still resolves when the onPublishError hook itself throws", async () => {
			const agg = createAggWithEvent();

			const result = await withCommit(
				{
					outbox: createMockOutbox(),
					bus: createFailingBus(new Error("smtp down")),
					scope: createMockScope(),
					onPublishError: () => {
						throw new Error("observer hook is broken too");
					},
				},
				async (_ctx, enrollment) => enrolledResult(enrollment, "ok", [agg]),
			);

			expect(result).toBe("ok");
		});

		it("pre-commit failures still reject (outbox.add inside the tx)", async () => {
			const agg = createAggWithEvent();
			const outbox: Outbox<TestEvent> = {
				add: async () => {
					throw new Error("outbox write failed");
				},
				getPending: async () => [],
				markDispatched: async () => {},
			};

			await expect(
				withCommit(
					{ outbox, bus: createMockBus(), scope: createMockScope() },
					async (_ctx, enrollment) => enrolledResult(enrollment, "ok", [agg]),
				),
			).rejects.toThrow("outbox write failed");
			// Rolled back: pending events must survive for a retry.
			expect(agg.markPersistedCalls).toBe(0);
		});
	});
});

describe("commit enrollment lifecycle", () => {
	it("rejects save enrollment after delete enrollment in one transaction", async () => {
		const outbox = createMockOutbox();
		const deletionEvent = createDomainEvent(
			"OrderCreated",
			{ orderId: "inv-1" },
			{ aggregateId: "inv-1", aggregateType: "MockOrder" },
		);
		const aggregate = createMockAggregate([deletionEvent]);

		await expect(
			withCommit(
				{ outbox, scope: createMockScope() },
				async (_ctx, enrollment) => {
					enrollment.enrollDeleted(aggregate);
					enrollment.enrollSaved(aggregate);
					return { result: "r", commits: [] };
				},
			),
		).rejects.toBeInstanceOf(EventHarvestError);

		expect(outbox.added).toHaveLength(0);
		expect(aggregate.pendingEvents).toHaveLength(1);
		expect(aggregate.markPersistedCalls).toBe(0);
	});
});

describe("commit envelope positioning", () => {
	const eventFor = (orderId: string) =>
		createDomainEvent(
			"OrderCreated",
			{ orderId },
			{ aggregateId: "agg-1", aggregateType: "MockOrder" },
		);

	it("assigns a zero-based per-aggregate sequence", async () => {
		const outbox = createMockOutbox();
		const agg = createMockAggregate([eventFor("a"), eventFor("b")], 7);

		await withCommit(
			{ outbox, scope: createMockScope() },
			async (_ctx, enrollment) => enrolledResult(enrollment, "r", [agg]),
		);

		const [batch] = outbox.added;
		expect(batch?.map((message) => message.position.commitSequence)).toEqual([
			0, 1,
		]);
		expect(batch?.map((message) => message.position.aggregateVersion)).toEqual([
			7, 7,
		]);
	});

	it("sequences each aggregate independently", async () => {
		const outbox = createMockOutbox();
		const first = createMockAggregate([eventFor("a"), eventFor("b")], 3);
		const second = createMockAggregate([eventFor("c")], 9);

		await withCommit(
			{ outbox, scope: createMockScope() },
			async (_ctx, enrollment) =>
				enrolledResult(enrollment, "r", [first, second]),
		);

		const [batch] = outbox.added;
		expect(batch?.map((message) => message.position.commitSequence)).toEqual([
			0, 1, 0,
		]);
	});

	it("puts commit size on every candidate and leaves the predecessor to the outbox", async () => {
		const outbox = createMockOutbox();
		const agg = createMockAggregate([eventFor("a"), eventFor("b")], 7, 5);

		await withCommit(
			{ outbox, scope: createMockScope() },
			async (_ctx, enrollment) => enrolledResult(enrollment, "r", [agg]),
		);

		const [batch] = outbox.added;
		expect(batch?.map((message) => message.position.commitSize)).toEqual([
			2, 2,
		]);
		expect(
			batch?.map((message) =>
				Object.hasOwn(message.position, "previousEventfulAggregateVersion"),
			),
		).toEqual([false, false]);
	});
});
