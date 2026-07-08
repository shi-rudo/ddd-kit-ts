import { describe, expect, it } from "vitest";
import type { IAggregateRoot } from "../aggregate/aggregate-root";
import type { Version } from "../aggregate/aggregate";
import { createDomainEvent, type DomainEvent } from "../aggregate/domain-event";
import { EventHarvestError, InfrastructureError } from "../core/errors";
import type { Id } from "../core/id";
import type { EventBus, Outbox } from "../events/ports";
import type { TransactionScope } from "../repo/scope";
import { withCommit } from "./handler";

type TestEvent = DomainEvent<"OrderCreated", { orderId: string }>;
type TestId = Id<"TestId">;

type MockAggregate = IAggregateRoot<TestId, TestEvent> & {
	markPersistedCalls: number;
};

function createMockAggregate(
	events: TestEvent[],
	version = 1,
): MockAggregate {
	let pending: TestEvent[] = [...events];
	let calls = 0;
	return {
		id: "agg-1" as TestId,
		version: version as Version,
		persistedVersion: undefined,
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

function createMockOutbox(): Outbox<TestEvent> & { added: TestEvent[][] } {
	const added: TestEvent[][] = [];
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
		once: () => new Promise(() => {}),
	};
}

/** Harvested events carry the commit version and the harvest index. */
function stamped(
	event: TestEvent,
	aggregateVersion = 1,
	commitSequence = 0,
): TestEvent {
	return { ...event, aggregateVersion, commitSequence };
}

describe("withCommit", () => {
	it("returns the result from the function", async () => {
		const result = await withCommit(
			{ outbox: createMockOutbox(), scope: createMockScope() },
			async () => ({ result: "order-123", aggregates: [] }),
		);

		expect(result).toBe("order-123");
	});

	it("harvests pendingEvents from the returned aggregates into the outbox", async () => {
		const outbox = createMockOutbox();
		const event = createDomainEvent("OrderCreated", { orderId: "order-1" }, { aggregateId: "order-1", aggregateType: "MockOrder" });
		const agg = createMockAggregate([event]);

		await withCommit(
			{ outbox, scope: createMockScope() },
			async () => ({ result: "ok", aggregates: [agg] }),
		);

		expect(outbox.added).toHaveLength(1);
		expect(outbox.added[0]).toEqual([stamped(event)]);
	});

	it("publishes harvested events to the bus when provided", async () => {
		const outbox = createMockOutbox();
		const bus = createMockBus();
		const event = createDomainEvent("OrderCreated", { orderId: "order-1" }, { aggregateId: "order-1", aggregateType: "MockOrder" });
		const agg = createMockAggregate([event]);

		await withCommit(
			{ outbox, bus, scope: createMockScope() },
			async () => ({ result: "ok", aggregates: [agg] }),
		);

		expect(bus.published).toHaveLength(1);
		expect(bus.published[0]).toEqual([stamped(event)]);
	});

	it("works without a bus", async () => {
		const outbox = createMockOutbox();
		const event = createDomainEvent("OrderCreated", { orderId: "order-1" }, { aggregateId: "order-1", aggregateType: "MockOrder" });
		const agg = createMockAggregate([event]);

		const result = await withCommit(
			{ outbox, scope: createMockScope() },
			async () => ({ result: "ok", aggregates: [agg] }),
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

		await withCommit(
			{ outbox: createMockOutbox(), scope },
			async () => {
				callOrder.push("fn");
				return { result: "ok", aggregates: [] };
			},
		);

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
			createDomainEvent("OrderCreated", { orderId: "order-1" }, { aggregateId: "order-1", aggregateType: "MockOrder" }),
		]);

		await expect(
			withCommit(
				{ outbox, scope: createMockScope() },
				async () => ({ result: "ok", aggregates: [agg] }),
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
			once: () => new Promise(() => {}),
		};
		// A specifically-instrumented mock that records when markPersisted is called.
		let pending: TestEvent[] = [
			createDomainEvent("OrderCreated", { orderId: "o-1" }, { aggregateId: "o-1", aggregateType: "MockOrder" }),
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

		await withCommit(
			{ outbox, bus, scope },
			async () => {
				callOrder.push("fn");
				return { result: "ok", aggregates: [agg] };
			},
		);

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
		await withCommit(
			{ outbox: createMockOutbox(), scope },
			async (ctx) => {
				received = ctx;
				return { result: ctx.id, aggregates: [] };
			},
		);

		expect(received).toBe(tx);
	});

	it("calls markPersisted only AFTER the tx commits (not on a rolled-back tx)", async () => {
		const scope = createMockScope();
		const agg = createMockAggregate([
			createDomainEvent("OrderCreated", { orderId: "o-1" }, { aggregateId: "o-1", aggregateType: "MockOrder" }),
		]);

		await expect(
			withCommit(
				{ outbox: createMockOutbox(), scope },
				async () => {
					throw new Error("write failed");
				},
			),
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
			withCommit(
				{ outbox, bus, scope },
				async () => {
					throw new Error("write failed");
				},
			),
		).rejects.toThrow("write failed");

		expect(bus.published).toHaveLength(0);
	});

	it("calls markPersisted on EACH returned aggregate", async () => {
		const a = createMockAggregate([
			createDomainEvent("OrderCreated", { orderId: "a" }, { aggregateId: "a", aggregateType: "MockOrder" }),
		]);
		const b = createMockAggregate([
			createDomainEvent("OrderCreated", { orderId: "b" }, { aggregateId: "b", aggregateType: "MockOrder" }),
		]);

		await withCommit(
			{ outbox: createMockOutbox(), scope: createMockScope() },
			async () => ({ result: "ok", aggregates: [a, b] }),
		);

		expect(a.markPersistedCalls).toBe(1);
		expect(b.markPersistedCalls).toBe(1);
		expect(a.pendingEvents).toHaveLength(0);
		expect(b.pendingEvents).toHaveLength(0);
	});

	describe("aggregateVersion stamping at harvest", () => {
		it("stamps each harvested event with its aggregate's commit version (outbox AND bus)", async () => {
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
				async () => ({ result: "ok", aggregates: [agg] }),
			);

			expect(outbox.added[0]?.[0]?.aggregateVersion).toBe(7);
			expect(bus.published[0]?.[0]?.aggregateVersion).toBe(7);
			// The stamped copy keeps everything else intact.
			expect(outbox.added[0]?.[0]?.eventId).toBe(event.eventId);
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
				async () => ({ result: "ok", aggregates: [aggA, aggB] }),
			);

			expect(
				outbox.added[0]?.map((e) => [e.aggregateId, e.aggregateVersion]),
			).toEqual([
				["a", 3],
				["b", 11],
			]);
		});

		it("never overwrites a pre-set aggregateVersion (when it is ≤ the commit version)", async () => {
			const outbox = createMockOutbox();
			const preStamped = createDomainEvent(
				"OrderCreated",
				{ orderId: "o-1" },
				{
					aggregateId: "o-1",
					aggregateType: "MockOrder",
					aggregateVersion: 5,
				},
			);
			const agg = createMockAggregate([preStamped], 7);

			await withCommit(
				{ outbox, scope: createMockScope() },
				async () => ({ result: "ok", aggregates: [agg] }),
			);

			expect(outbox.added[0]?.[0]?.aggregateVersion).toBe(5);
			// The version survives, but the harvest still stamps the
			// commitSequence onto a frozen copy.
			expect(outbox.added[0]?.[0]?.commitSequence).toBe(0);
		});

		it("an event with BOTH stamps pre-set passes through as the SAME object (no copy)", async () => {
			const outbox = createMockOutbox();
			const fullyStamped = createDomainEvent(
				"OrderCreated",
				{ orderId: "o-1" },
				{
					aggregateId: "o-1",
					aggregateType: "MockOrder",
					aggregateVersion: 5,
					commitSequence: 0,
				},
			);
			const agg = createMockAggregate([fullyStamped], 7);

			await withCommit(
				{ outbox, scope: createMockScope() },
				async () => ({ result: "ok", aggregates: [agg] }),
			);

			expect(outbox.added[0]?.[0]).toBe(fullyStamped);
		});

		it("rejects a pre-set aggregateVersion AHEAD of the commit version (leaked fixture guard)", async () => {
			// A pre-set ahead of the commit version is always a leaked
			// replay fixture or a copied options object - and consumers key
			// idempotency watermarks on this number, so it must fail fast
			// (same posture as the aggregateId/aggregateType guard).
			const leaked = createDomainEvent(
				"OrderCreated",
				{ orderId: "o-1" },
				{
					aggregateId: "o-1",
					aggregateType: "MockOrder",
					aggregateVersion: 42,
				},
			);
			const agg = createMockAggregate([leaked], 7);

			await expect(
				withCommit(
					{ outbox: createMockOutbox(), scope: createMockScope() },
					async () => ({ result: "ok", aggregates: [agg] }),
				),
			).rejects.toThrow(
				/aggregateVersion \(42\) AHEAD of its aggregate's commit version \(7\)/,
			);
			// Rolled back: pending events survive for a corrected retry.
			expect(agg.pendingEvents).toHaveLength(1);
		});

		it("stamps onto a frozen copy; the aggregate's own pending events stay untouched", async () => {
			const outbox = createMockOutbox();
			const event = createDomainEvent(
				"OrderCreated",
				{ orderId: "o-1" },
				{ aggregateId: "o-1", aggregateType: "MockOrder" },
			);
			const agg = createMockAggregate([event], 7);

			await withCommit(
				{ outbox, scope: createMockScope() },
				async () => ({ result: "ok", aggregates: [agg] }),
			);

			// The original event object was never mutated...
			expect(event.aggregateVersion).toBeUndefined();
			// ...and the stamped copy is frozen like the original.
			const stamped = outbox.added[0]?.[0];
			expect(Object.isFrozen(stamped)).toBe(true);
			expect(stamped).not.toBe(event);
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
			async () => ({
				result: "ok",
				aggregates: [savedAgg, deletedAgg],
				deleted: [deletedAgg],
			}),
		);

		// Both aggregates' events were harvested, in array order.
		expect(outbox.added).toEqual([[stamped(savedEvent), stamped(deletionEvent)]]);
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
		const e1 = createDomainEvent("OrderCreated", { orderId: "a-evt-1" }, { aggregateId: "a-evt-1", aggregateType: "MockOrder" });
		const e2 = createDomainEvent("OrderCreated", { orderId: "a-evt-2" }, { aggregateId: "a-evt-2", aggregateType: "MockOrder" });
		const e3 = createDomainEvent("OrderCreated", { orderId: "b-evt-1" }, { aggregateId: "b-evt-1", aggregateType: "MockOrder" });
		const e4 = createDomainEvent("OrderCreated", { orderId: "c-evt-1" }, { aggregateId: "c-evt-1", aggregateType: "MockOrder" });

		const aggA = createMockAggregate([e1, e2]);
		const aggB = createMockAggregate([e3]);
		const aggC = createMockAggregate([e4]);

		const outbox = createMockOutbox();
		const bus = createMockBus();

		await withCommit(
			{ outbox, bus, scope: createMockScope() },
			async () => ({ result: "ok", aggregates: [aggA, aggB, aggC] }),
		);

		// Sequences restart per aggregate: [e1, e2] on A, [e3] on B, [e4] on C.
		const expected = [
			stamped(e1, 1, 0),
			stamped(e2, 1, 1),
			stamped(e3, 1, 0),
			stamped(e4, 1, 0),
		];
		expect(outbox.added).toEqual([expected]);
		expect(bus.published).toEqual([expected]);
	});

	it("dedupes aggregates by reference: same instance twice harvests events once and markPersists once", async () => {
		// A use case that touches the same aggregate via two repository
		// references (same identity-map entry) would otherwise double-
		// harvest its events through the outbox and call markPersisted
		// twice. Dedupe is by JavaScript object identity; distinct
		// instances with the same logical id are NOT detected here.
		const event = createDomainEvent("OrderCreated", { orderId: "o-1" }, { aggregateId: "o-1", aggregateType: "MockOrder" });
		const agg = createMockAggregate([event]);

		const outbox = createMockOutbox();
		const bus = createMockBus();

		await withCommit(
			{ outbox, bus, scope: createMockScope() },
			async () => ({ result: "ok", aggregates: [agg, agg, agg] }),
		);

		// Event harvested exactly once.
		expect(outbox.added).toEqual([[stamped(event)]]);
		expect(bus.published).toEqual([[stamped(event)]]);
		// markPersisted called exactly once on the deduped aggregate.
		expect(agg.markPersistedCalls).toBe(1);
	});

	it("throws if a harvested event is missing aggregateId (recordEvent guard)", async () => {
		// A direct createDomainEvent without aggregateId would silently
		// break downstream routing. The guard catches it at the harvest
		// boundary with a diagnostic message naming the event type and
		// the missing field.
		const badEvent = createDomainEvent("OrderCreated", { orderId: "x" }, {
			// aggregateType set, aggregateId NOT set → guard rejects
			aggregateType: "MockOrder",
		});
		const agg = createMockAggregate([badEvent]);

		await expect(
			withCommit(
				{ outbox: createMockOutbox(), scope: createMockScope() },
				async () => ({ result: "ok", aggregates: [agg] }),
			),
		).rejects.toThrow(/aggregateId/);
	});

	it("the harvest guard throws EventHarvestError, not a retryable InfrastructureError", async () => {
		const badEvent = createDomainEvent("OrderCreated", { orderId: "x" }, {
			aggregateType: "MockOrder",
		});
		const agg = createMockAggregate([badEvent]);

		const rejection = await withCommit(
			{ outbox: createMockOutbox(), scope: createMockScope() },
			async () => ({ result: "ok", aggregates: [agg] }),
		).catch((e) => e);

		expect(rejection).toBeInstanceOf(EventHarvestError);
		expect(rejection).not.toBeInstanceOf(InfrastructureError);
	});

	it("throws if a harvested event is missing aggregateType (recordEvent guard)", async () => {
		const badEvent = createDomainEvent("OrderCreated", { orderId: "x" }, {
			aggregateId: "x",
			// aggregateType missing → guard rejects
		});
		const agg = createMockAggregate([badEvent]);

		await expect(
			withCommit(
				{ outbox: createMockOutbox(), scope: createMockScope() },
				async () => ({ result: "ok", aggregates: [agg] }),
			),
		).rejects.toThrow(/aggregateType/);
	});

	it("guard error message names the event type and lists both missing fields", async () => {
		const badEvent = createDomainEvent("OrderCreated", { orderId: "x" });
		const agg = createMockAggregate([badEvent]);

		await expect(
			withCommit(
				{ outbox: createMockOutbox(), scope: createMockScope() },
				async () => ({ result: "ok", aggregates: [agg] }),
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
			async () => ({ result: "ok", aggregates: [agg] }),
		);

		expect(outbox.added).toHaveLength(0);
		expect(bus.published).toHaveLength(0);
		// markPersisted still runs; keeps the lifecycle consistent even
		// for empty-event commits.
		expect(agg.markPersistedCalls).toBe(1);
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
				async () => ({ result: "ok", aggregates: [throwingA, aggB] }),
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
				async () => ({ result: "ok", aggregates: [throwing] }),
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
				async () => ({ result: "ok", aggregates: [throwingA, aggB] }),
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
				async () => ({ result: "ok", aggregates: [agg] }),
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
					async () => ({ result: "ok", aggregates: [throwing] }),
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
				async () => ({ result: "order-123", aggregates: [agg] }),
			);

			expect(result).toBe("order-123");
			// The commit lifecycle completed: pending events are flushed.
			expect(agg.markPersistedCalls).toBe(1);
		});

		it("reports the publish error and the affected events via onPublishError", async () => {
			const agg = createAggWithEvent();
			const publishError = new Error("subscriber blew up");
			const reported: Array<{ error: unknown; events: ReadonlyArray<TestEvent> }> =
				[];

			await withCommit(
				{
					outbox: createMockOutbox(),
					bus: createFailingBus(publishError),
					scope: createMockScope(),
					onPublishError: (error, events) => {
						reported.push({ error, events });
					},
				},
				async () => ({ result: "ok", aggregates: [agg] }),
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
				async () => ({ result: "ok", aggregates: [agg] }),
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
				async () => ({ result: "ok", aggregates: [agg] }),
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
					async () => ({ result: "ok", aggregates: [agg] }),
				),
			).rejects.toThrow("outbox write failed");
			// Rolled back: pending events must survive for a retry.
			expect(agg.markPersistedCalls).toBe(0);
		});
	});
});

describe("deleted must be a subset of aggregates", () => {
	it("throws EventHarvestError inside the transaction when a deleted aggregate is not listed in aggregates", async () => {
		const outbox = createMockOutbox();
		const deletionEvent = createDomainEvent(
			"OrderCreated",
			{ orderId: "inv-1" },
			{ aggregateId: "inv-1", aggregateType: "MockOrder" },
		);
		const listed = createMockAggregate([]);
		const forgotten = createMockAggregate([deletionEvent]);

		await expect(
			withCommit(
				{ outbox, scope: createMockScope() },
				async () => ({
					result: "r",
					aggregates: [listed],
					deleted: [forgotten],
				}),
			),
		).rejects.toBeInstanceOf(EventHarvestError);

		// The guard fires inside the transaction: nothing reached the outbox
		// and the forgotten aggregate keeps its pending events (no silent
		// loss, no stale double-emit source).
		expect(outbox.added).toHaveLength(0);
		expect(forgotten.pendingEvents).toHaveLength(1);
	});
});

describe("commitSequence stamping", () => {
	const eventFor = (orderId: string, options?: object) =>
		createDomainEvent(
			"OrderCreated",
			{ orderId },
			{ aggregateId: "agg-1", aggregateType: "MockOrder", ...options },
		);

	it("stamps a zero-based per-aggregate sequence onto the harvested copies", async () => {
		const outbox = createMockOutbox();
		const agg = createMockAggregate([eventFor("a"), eventFor("b")], 7);

		await withCommit(
			{ outbox, scope: createMockScope() },
			async () => ({ result: "r", aggregates: [agg] }),
		);

		const [batch] = outbox.added;
		expect(batch?.map((e) => e.commitSequence)).toEqual([0, 1]);
		expect(batch?.map((e) => e.aggregateVersion)).toEqual([7, 7]);
	});

	it("sequences each aggregate independently", async () => {
		const outbox = createMockOutbox();
		const first = createMockAggregate([eventFor("a"), eventFor("b")], 3);
		const second = createMockAggregate([eventFor("c")], 9);

		await withCommit(
			{ outbox, scope: createMockScope() },
			async () => ({ result: "r", aggregates: [first, second] }),
		);

		const [batch] = outbox.added;
		expect(batch?.map((e) => e.commitSequence)).toEqual([0, 1, 0]);
	});

	it("a pre-set commitSequence is never overwritten (same rule as aggregateVersion)", async () => {
		const outbox = createMockOutbox();
		const agg = createMockAggregate(
			[eventFor("a", { commitSequence: 7 }), eventFor("b")],
			2,
		);

		await withCommit(
			{ outbox, scope: createMockScope() },
			async () => ({ result: "r", aggregates: [agg] }),
		);

		const [batch] = outbox.added;
		expect(batch?.map((e) => e.commitSequence)).toEqual([7, 1]);
	});

	it("an event with a pre-set aggregateVersion still receives its commitSequence", async () => {
		const outbox = createMockOutbox();
		const agg = createMockAggregate(
			[eventFor("a", { aggregateVersion: 1 }), eventFor("b")],
			2,
		);

		await withCommit(
			{ outbox, scope: createMockScope() },
			async () => ({ result: "r", aggregates: [agg] }),
		);

		const [batch] = outbox.added;
		expect(batch?.map((e) => e.commitSequence)).toEqual([0, 1]);
		expect(batch?.map((e) => e.aggregateVersion)).toEqual([1, 2]);
	});
});
