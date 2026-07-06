import { describe, expect, it } from "vitest";
import type { Version } from "../aggregate/aggregate";
import type { IAggregateRoot } from "../aggregate/aggregate-root";
import { createDomainEvent, type DomainEvent } from "../aggregate/domain-event";
import {
	AggregateDeletedError,
	ConcurrencyConflictError,
	EventHarvestError,
	InfrastructureError,
	UnenrolledChangesError,
} from "../core/errors";
import type { Id } from "../core/id";
import type { EventBus, Outbox } from "../events/ports";
import type { TransactionScope } from "../repo/scope";
import {
	CommitError,
	NestedUnitOfWorkError,
	RollbackError,
	TransactionClosedError,
	UnitOfWork,
	type UnitOfWorkSession,
} from "./unit-of-work";

type TestEvent = DomainEvent<"OrderCreated", { orderId: string }>;
type TestId = Id<"TestId">;

type MockAggregate = IAggregateRoot<TestId, TestEvent> & {
	markPersistedCalls: number;
};

function createMockAggregate(
	id: string,
	events: TestEvent[] = [],
): MockAggregate {
	let pending: TestEvent[] = [...events];
	let calls = 0;
	return {
		id: id as TestId,
		version: 1 as Version,
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

function testEvent(orderId: string): TestEvent {
	return createDomainEvent(
		"OrderCreated",
		{ orderId },
		{ aggregateId: orderId, aggregateType: "MockOrder" },
	);
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

/** Minimal UoW-style repository: save/delete enroll with the session. */
class FakeOrderRepository {
	constructor(
		public readonly tx: unknown,
		private readonly session: UnitOfWorkSession<TestEvent>,
	) {}

	async save(aggregate: MockAggregate): Promise<void> {
		this.session.enrollSaved(aggregate);
	}

	async delete(aggregate: MockAggregate): Promise<void> {
		this.session.enrollDeleted(aggregate);
	}
}

function createUow(overrides?: {
	scope?: TransactionScope<undefined>;
	outbox?: Outbox<TestEvent>;
	bus?: EventBus<TestEvent>;
}) {
	const outbox = overrides?.outbox ?? createMockOutbox();
	const bus = overrides?.bus ?? createMockBus();
	const scope = overrides?.scope ?? createMockScope();
	const uow = new UnitOfWork({
		scope,
		outbox,
		bus,
		repositories: {
			orders: (tx: undefined, session: UnitOfWorkSession<TestEvent>) =>
				new FakeOrderRepository(tx, session),
		},
	});
	return { uow, outbox, bus, scope };
}

/** Harvested events are stamped with the aggregate's commit version. */
function stamped(
	event: TestEvent,
	aggregateVersion = 1,
	commitSequence = 0,
): TestEvent {
	return { ...event, aggregateVersion, commitSequence };
}

describe("UnitOfWork", () => {
	describe("transaction lifecycle", () => {
		it("commits on success and returns the callback's result", async () => {
			const callOrder: string[] = [];
			const scope: TransactionScope<undefined> = {
				transactional: async <T>(fn: (_ctx: undefined) => Promise<T>) => {
					callOrder.push("tx-start");
					const result = await fn(undefined);
					callOrder.push("tx-commit");
					return result;
				},
			};
			const { uow } = createUow({ scope });

			const result = await uow.run(async () => {
				callOrder.push("work");
				return "order-123";
			});

			expect(result).toBe("order-123");
			expect(callOrder).toEqual(["tx-start", "work", "tx-commit"]);
		});

		it("rolls back on callback error: error passes through unchanged, no markPersisted", async () => {
			const { uow } = createUow();
			const agg = createMockAggregate("o-1", [testEvent("o-1")]);
			const boom = new Error("domain rule violated");

			await expect(
				uow.run(async ({ repositories }) => {
					await repositories.orders.save(agg);
					throw boom;
				}),
			).rejects.toBe(boom);

			expect(agg.markPersistedCalls).toBe(0);
			expect(agg.pendingEvents).toHaveLength(1);
		});

		it("a repository ConcurrencyConflictError passes through as the same instance (stays distinguishable)", async () => {
			const { uow } = createUow();
			const conflict = new ConcurrencyConflictError({ aggregateType: "Order", aggregateId: "o-1", expectedVersion: 3, actualVersion: 4 });

			await expect(
				uow.run(async () => {
					throw conflict;
				}),
			).rejects.toBe(conflict);
		});

		it("a scope that fails before the callback runs passes its error through unwrapped", async () => {
			const txOpenError = new Error("could not open transaction");
			const scope: TransactionScope<undefined> = {
				transactional: async () => {
					throw txOpenError;
				},
			};
			const { uow } = createUow({ scope });

			await expect(uow.run(async () => "unreachable")).rejects.toBe(
				txOpenError,
			);
		});
	});

	describe("repository context", () => {
		it("every repository factory receives the same transaction handle", async () => {
			type FakeTx = { id: string };
			const tx: FakeTx = { id: "tx-42" };
			const scope: TransactionScope<FakeTx> = {
				transactional: async <T>(fn: (ctx: FakeTx) => Promise<T>) => fn(tx),
			};
			const seen: FakeTx[] = [];
			const uow = new UnitOfWork({
				scope,
				outbox: createMockOutbox(),
				repositories: {
					a: (handle: FakeTx) => {
						seen.push(handle);
						return { handle };
					},
					b: (handle: FakeTx) => {
						seen.push(handle);
						return { handle };
					},
				},
			});

			await uow.run(async ({ repositories, rawTransaction }) => {
				expect(repositories.a.handle).toBe(tx);
				expect(repositories.b.handle).toBe(tx);
				expect(rawTransaction).toBe(tx);
				return undefined;
			});

			expect(seen).toEqual([tx, tx]);
		});

		it("constructs fresh repositories per run", async () => {
			let constructed = 0;
			const uow = new UnitOfWork({
				scope: createMockScope(),
				outbox: createMockOutbox(),
				repositories: {
					orders: () => {
						constructed += 1;
						return {};
					},
				},
			});

			await uow.run(async () => undefined);
			await uow.run(async () => undefined);

			expect(constructed).toBe(2);
		});
	});

	describe("enrollment + post-commit lifecycle", () => {
		it("saved aggregates: events harvested into the outbox, markPersisted after commit, publish last", async () => {
			const callOrder: string[] = [];
			const scope: TransactionScope<undefined> = {
				transactional: async <T>(fn: (_ctx: undefined) => Promise<T>) => {
					callOrder.push("tx-start");
					const result = await fn(undefined);
					callOrder.push("tx-commit");
					return result;
				},
			};
			const outbox: Outbox<TestEvent> & { added: TestEvent[][] } = {
				added: [],
				add: async (events) => {
					callOrder.push("outbox.add");
					outbox.added.push([...events]);
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
			const event = testEvent("o-1");
			let pending: TestEvent[] = [event];
			const agg: IAggregateRoot<TestId, TestEvent> = {
				id: "o-1" as TestId,
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
			const uow = new UnitOfWork({
				scope,
				outbox,
				bus,
				repositories: {
					orders: (tx: undefined, session: UnitOfWorkSession<TestEvent>) =>
						new FakeOrderRepository(tx, session),
				},
			});

			await uow.run(async ({ repositories }) => {
				callOrder.push("work");
				await repositories.orders.save(agg as MockAggregate);
				return undefined;
			});

			expect(callOrder).toEqual([
				"tx-start",
				"work",
				"outbox.add",
				"tx-commit",
				"markPersisted",
				"bus.publish",
			]);
			expect(outbox.added).toEqual([[stamped(event)]]);
		});

		it("forwards a post-commit persistence failure to onPersistError with the aggregate", async () => {
			const event = testEvent("o-1");
			let pending: TestEvent[] = [event];
			const persistError = new Error("cache eviction failed");
			const agg: IAggregateRoot<TestId, TestEvent> = {
				id: "o-1" as TestId,
				version: 1 as Version,
				persistedVersion: undefined,
				get pendingEvents() {
					return pending;
				},
				clearPendingEvents() {
					pending = [];
				},
				markPersisted() {
					pending = [];
					throw persistError;
				},
			};
			const reported: Array<{ error: unknown; aggregate: unknown }> = [];
			const uow = new UnitOfWork({
				scope: createMockScope(),
				outbox: createMockOutbox(),
				bus: createMockBus(),
				onPersistError: (error, aggregate) => {
					reported.push({ error, aggregate });
				},
				repositories: {
					orders: (tx: undefined, session: UnitOfWorkSession<TestEvent>) =>
						new FakeOrderRepository(tx, session),
				},
			});

			// The committed write resolves; the cleanup failure is observed.
			await expect(
				uow.run(async ({ repositories }) => {
					await repositories.orders.save(agg as MockAggregate);
					return "ok";
				}),
			).resolves.toBe("ok");
			expect(reported).toHaveLength(1);
			expect(reported[0]?.error).toBe(persistError);
			expect(reported[0]?.aggregate).toBe(agg);
		});

		it("saving the same instance twice harvests its events once and markPersists once", async () => {
			const { uow, outbox } = createUow();
			const event = testEvent("o-1");
			const agg = createMockAggregate("o-1", [event]);

			await uow.run(async ({ repositories }) => {
				await repositories.orders.save(agg);
				await repositories.orders.save(agg);
				return undefined;
			});

			expect((outbox as Outbox<TestEvent> & { added: TestEvent[][] }).added)
				.toEqual([[stamped(event)]]);
			expect(agg.markPersistedCalls).toBe(1);
		});

		it("deleted aggregates: recorded deletion events are harvested into the outbox", async () => {
			const { uow, outbox } = createUow();
			const deletionEvent = testEvent("o-1");
			const agg = createMockAggregate("o-1", [deletionEvent]);

			await uow.run(async ({ repositories }) => {
				await repositories.orders.delete(agg);
				return undefined;
			});

			expect((outbox as Outbox<TestEvent> & { added: TestEvent[][] }).added)
				.toEqual([[stamped(deletionEvent)]]);
		});

		it("saving an aggregate after deleting it in the same unit of work throws AggregateDeletedError", async () => {
			const { uow } = createUow();
			const agg = createMockAggregate("o-1");

			await expect(
				uow.run(async ({ repositories }) => {
					await repositories.orders.delete(agg);
					await repositories.orders.save(agg);
					return undefined;
				}),
			).rejects.toBeInstanceOf(AggregateDeletedError);

			// The violation aborted the unit of work: nothing was committed.
			expect(agg.markPersistedCalls).toBe(0);
		});

		it("the use case can enroll manually via context.session", async () => {
			const { uow, outbox } = createUow();
			const event = testEvent("o-1");
			const agg = createMockAggregate("o-1", [event]);

			await uow.run(async ({ session }) => {
				// e.g. a write performed on the raw tx, no repository involved
				session.enrollSaved(agg);
				return undefined;
			});

			expect((outbox as Outbox<TestEvent> & { added: TestEvent[][] }).added)
				.toEqual([[stamped(event)]]);
			expect(agg.markPersistedCalls).toBe(1);
		});
	});

	describe("session seal + scope retries", () => {
		it("an enrollment arriving AFTER the callback resolved throws instead of being silently dropped", async () => {
			// The un-awaited-save footgun: `void repo.save(order)` inside the
			// callback can execute its enrollSaved while withCommit is still
			// writing the outbox. The harvest snapshot is already taken; a
			// silently-accepted enrollment would never reach the outbox. The
			// session is sealed the moment the callback resolves, so the late
			// enrollment crashes loud instead.
			const lateAggregate = createMockAggregate("late-1", [
				testEvent("late-1"),
			]);
			let leakedSession!: UnitOfWorkSession<TestEvent>;
			let lateEnrollError: unknown;
			const outbox: Outbox<TestEvent> = {
				add: async () => {},
				getPending: async () => [],
				markDispatched: async () => {},
			};
			const scope: TransactionScope<undefined> = {
				transactional: async <T>(fn: (_ctx: undefined) => Promise<T>) => {
					const result = await fn(undefined);
					// We are now past the callback (and past harvest), still
					// inside the transaction - the window in question.
					try {
						leakedSession.enrollSaved(lateAggregate);
					} catch (e) {
						lateEnrollError = e;
					}
					return result;
				},
			};
			const { uow } = createUow({ scope, outbox });

			await uow.run(async ({ session }) => {
				leakedSession = session;
				return undefined;
			});

			expect(lateEnrollError).toBeInstanceOf(TransactionClosedError);
		});

		it("a retrying TransactionScope gets a FRESH session per attempt: rolled-back enrollments never reach the outbox", async () => {
			// Serialization-retry wrappers (CockroachDB-style) re-invoke the
			// transactional callback. State from the aborted attempt -
			// enrollments, identity-map entries, error flags - must not leak
			// into the retry.
			const retryableFailure = new Error("40001 serialization failure");
			const scope: TransactionScope<undefined> = {
				transactional: async <T>(fn: (_ctx: undefined) => Promise<T>) => {
					try {
						return await fn(undefined);
					} catch (e) {
						if (e === retryableFailure) {
							return await fn(undefined); // retry
						}
						throw e;
					}
				},
			};
			const outbox = createMockOutbox();
			const { uow } = createUow({ scope, outbox });
			const event1 = testEvent("a-1");
			const event2 = testEvent("a-2");
			const attempt1Aggregate = createMockAggregate("a-1", [event1]);
			const attempt2Aggregate = createMockAggregate("a-2", [event2]);
			let attempt = 0;

			const result = await uow.run(async ({ repositories }) => {
				attempt += 1;
				if (attempt === 1) {
					await repositories.orders.save(attempt1Aggregate);
					throw retryableFailure; // attempt 1 rolls back
				}
				await repositories.orders.save(attempt2Aggregate);
				return "second-attempt";
			});

			expect(result).toBe("second-attempt");
			// Only the committed attempt's events were harvested; the
			// rolled-back attempt's enrollment did not leak into the retry.
			expect(outbox.added).toEqual([[stamped(event2)]]);
			expect(attempt1Aggregate.markPersistedCalls).toBe(0);
			expect(attempt2Aggregate.markPersistedCalls).toBe(1);
		});
	});

	describe("close: context invalidation", () => {
		it("context.repositories access after run() settles throws TransactionClosedError", async () => {
			const { uow } = createUow();
			let leaked!: Parameters<Parameters<typeof uow.run>[0]>[0];

			await uow.run(async (context) => {
				leaked = context;
				return undefined;
			});

			expect(() => leaked.repositories).toThrow(TransactionClosedError);
			expect(() => leaked.rawTransaction).toThrow(TransactionClosedError);
		});

		it("session.enrollSaved after close throws TransactionClosedError (also after rollback)", async () => {
			const { uow } = createUow();
			let leakedSession!: UnitOfWorkSession<TestEvent>;

			await expect(
				uow.run(async ({ session }) => {
					leakedSession = session;
					throw new Error("rolled back");
				}),
			).rejects.toThrow("rolled back");

			expect(() =>
				leakedSession.enrollSaved(createMockAggregate("o-1")),
			).toThrow(TransactionClosedError);
			expect(() =>
				leakedSession.enrollDeleted(createMockAggregate("o-1")),
			).toThrow(TransactionClosedError);
		});
	});

	describe("nesting + reuse", () => {
		it("run() inside run() on the same instance throws NestedUnitOfWorkError and rolls back the outer work", async () => {
			const { uow } = createUow();
			const agg = createMockAggregate("o-1", [testEvent("o-1")]);

			await expect(
				uow.run(async ({ repositories }) => {
					await repositories.orders.save(agg);
					// A nested run would NOT join the outer transaction.
					await uow.run(async () => undefined);
					return undefined;
				}),
			).rejects.toBeInstanceOf(NestedUnitOfWorkError);

			expect(agg.markPersistedCalls).toBe(0);
			expect(agg.pendingEvents).toHaveLength(1);
		});

		it("sequential reuse of the same instance works", async () => {
			const { uow } = createUow();

			expect(await uow.run(async () => 1)).toBe(1);
			expect(await uow.run(async () => 2)).toBe(2);
		});

		it("the instance is usable again after a failed run", async () => {
			const { uow } = createUow();

			await expect(
				uow.run(async () => {
					throw new Error("first attempt failed");
				}),
			).rejects.toThrow("first attempt failed");

			expect(await uow.run(async () => "second attempt")).toBe(
				"second attempt",
			);
		});
	});

	describe("identity map integration", () => {
		class OrderAggregate implements IAggregateRoot<TestId, TestEvent> {
			public readonly version = 1 as Version;
			public readonly persistedVersion: Version | undefined = undefined;
			public markPersistedCalls = 0;
			private pending: TestEvent[];

			constructor(
				public readonly id: TestId,
				events: TestEvent[] = [],
			) {
				this.pending = [...events];
			}

			get pendingEvents(): ReadonlyArray<TestEvent> {
				return this.pending;
			}
			clearPendingEvents(): void {
				this.pending = [];
			}
			markPersisted(_v: Version): void {
				this.pending = [];
				this.markPersistedCalls += 1;
			}
		}

		/** Identity-map-aware repository over an in-memory row store. */
		class CachingOrderRepository {
			public hydrations = 0;

			constructor(
				private readonly rows: Map<string, TestEvent[]>,
				private readonly session: UnitOfWorkSession<TestEvent>,
			) {}

			async getById(id: TestId): Promise<OrderAggregate | null> {
				const cached = this.session.identityMap.get(OrderAggregate, id);
				if (cached) return cached;
				// Deleted in this unit of work = uniformly not-found, even
				// when the physical delete is deferred and the row is still
				// visible inside the transaction.
				if (this.session.identityMap.isDeleted(OrderAggregate, id)) {
					return null;
				}

				const row = this.rows.get(id);
				if (!row) return null;
				this.hydrations += 1;
				const order = new OrderAggregate(id, row);
				this.session.identityMap.set(OrderAggregate, id, order);
				return order;
			}

			async save(order: OrderAggregate): Promise<void> {
				this.session.enrollSaved(order);
			}

			async delete(order: OrderAggregate): Promise<void> {
				// ONE call: enrollDeleted tombstones the identity map itself
				// (keyed on the instance's concrete class) - no second manual
				// identityMap.delete() leg to forget.
				this.session.enrollDeleted(order);
			}
		}

		function createCachingUow(rows: Map<string, TestEvent[]>) {
			const outbox = createMockOutbox();
			const repos: CachingOrderRepository[] = [];
			const uow = new UnitOfWork({
				scope: createMockScope(),
				outbox,
				repositories: {
					orders: (_tx: undefined, session: UnitOfWorkSession<TestEvent>) => {
						const repo = new CachingOrderRepository(rows, session);
						repos.push(repo);
						return repo;
					},
				},
			});
			return { uow, outbox, repos };
		}

		it("two getById calls return the SAME instance with one hydration; saving via both refs marks persisted once", async () => {
			const event = testEvent("o-1");
			const rows = new Map([["o-1", [event]]]);
			const { uow, outbox, repos } = createCachingUow(rows);

			await uow.run(async ({ repositories }) => {
				const a = await repositories.orders.getById("o-1" as TestId);
				const b = await repositories.orders.getById("o-1" as TestId);

				expect(a).not.toBeNull();
				expect(b).toBe(a);

				await repositories.orders.save(a as OrderAggregate);
				await repositories.orders.save(b as OrderAggregate);
				return undefined;
			});

			expect(repos[0]?.hydrations).toBe(1);
			// One instance → one harvest, one markPersisted.
			expect(outbox.added).toEqual([[stamped(event)]]);
		});

		it("session.identityMap access after close throws TransactionClosedError", async () => {
			const { uow } = createCachingUow(new Map());
			let leakedSession!: UnitOfWorkSession<TestEvent>;

			await uow.run(async ({ session }) => {
				leakedSession = session;
				return undefined;
			});

			expect(() => leakedSession.identityMap).toThrow(TransactionClosedError);
		});

		it("a directly-leaked IdentityMap reference is cleared on close (no stale instances into a later operation)", async () => {
			const event = testEvent("o-1");
			const rows = new Map([["o-1", [event]]]);
			const { uow } = createCachingUow(rows);
			let leakedMap!: ReturnType<
				() => UnitOfWorkSession<TestEvent>["identityMap"]
			>;

			await uow.run(async ({ repositories, session }) => {
				await repositories.orders.getById("o-1" as TestId);
				leakedMap = session.identityMap; // captured while open
				expect(leakedMap.has(OrderAggregate, "o-1" as TestId)).toBe(true);
				return undefined;
			});

			expect(leakedMap.has(OrderAggregate, "o-1" as TestId)).toBe(false);
		});

		it("after delete, getById reads uniformly as null - even when the physical delete is deferred", async () => {
			const event = testEvent("o-1");
			// The row store deliberately keeps the row: simulates a repo
			// whose physical delete is deferred within the transaction.
			const rows = new Map([["o-1", [event]]]);
			const { uow } = createCachingUow(rows);

			const probe = await uow.run(async ({ repositories }) => {
				const order = await repositories.orders.getById("o-1" as TestId);
				await repositories.orders.delete(order as OrderAggregate);

				// Row still visible in the tx; the isDeleted check makes a
				// read-only probe behave like not-found instead of crashing
				// at registration.
				return repositories.orders.getById("o-1" as TestId);
			});

			expect(probe).toBeNull();
		});

		it("deletion is final across INSTANCES: saving a re-created aggregate with the same class+id throws", async () => {
			const rows = new Map([["o-1", [testEvent("o-1")]]]);
			const { uow } = createCachingUow(rows);

			await expect(
				uow.run(async ({ repositories }) => {
					const order = await repositories.orders.getById("o-1" as TestId);
					await repositories.orders.delete(order as OrderAggregate);

					// A DIFFERENT instance with the same logical identity, e.g.
					// re-created via a static factory after the delete. The
					// instance-keyed gate cannot see it; the class+id tombstone
					// (recorded automatically by enrollDeleted) must.
					const resurrected = new OrderAggregate("o-1" as TestId);
					await repositories.orders.save(resurrected);
					return undefined;
				}),
			).rejects.toBeInstanceOf(AggregateDeletedError);
		});

		it("a deleted aggregate's events are harvested, but markPersisted (and thus onPersisted) never fires for it", async () => {
			const event = testEvent("o-1");
			const rows = new Map([["o-1", [event]]]);
			const { uow, outbox } = createCachingUow(rows);
			let deletedOrder!: OrderAggregate;

			await uow.run(async ({ repositories }) => {
				deletedOrder = (await repositories.orders.getById(
					"o-1" as TestId,
				)) as OrderAggregate;
				await repositories.orders.delete(deletedOrder);
				return undefined;
			});

			// Deletion event reached the outbox...
			expect(outbox.added).toEqual([[stamped(event)]]);
			// ...but the post-save lifecycle did NOT run for the deleted
			// aggregate: no markPersisted, no onPersisted cache-fill lie.
			expect(deletedOrder.markPersistedCalls).toBe(0);
			// Pending events are still cleared so a later commit cannot
			// re-emit them.
			expect(deletedOrder.pendingEvents).toHaveLength(0);
		});
	});

	describe("commit/rollback error labeling", () => {
		it("an outbox failure after the callback completed surfaces as CommitError with the cause attached", async () => {
			const outboxError = new Error("outbox write failed");
			const outbox: Outbox<TestEvent> = {
				add: async () => {
					throw outboxError;
				},
				getPending: async () => [],
				markDispatched: async () => {},
			};
			const { uow } = createUow({ outbox });
			const agg = createMockAggregate("o-1", [testEvent("o-1")]);

			const rejection = await uow
				.run(async ({ repositories }) => {
					await repositories.orders.save(agg);
					return undefined;
				})
				.then(
					() => undefined,
					(e: unknown) => e,
				);

			expect(rejection).toBeInstanceOf(CommitError);
			expect((rejection as CommitError).cause).toBe(outboxError);
			expect(agg.markPersistedCalls).toBe(0);
		});

		it("a commit-phase failure (callback resolved, transactional rejected) surfaces as CommitError", async () => {
			const commitFailure = new Error("serialization failure at COMMIT");
			const scope: TransactionScope<undefined> = {
				transactional: async <T>(fn: (_ctx: undefined) => Promise<T>) => {
					await fn(undefined);
					throw commitFailure;
				},
			};
			const { uow } = createUow({ scope });

			const rejection = await uow
				.run(async () => "completed")
				.then(
					() => undefined,
					(e: unknown) => e,
				);

			expect(rejection).toBeInstanceOf(CommitError);
			expect((rejection as CommitError).cause).toBe(commitFailure);
		});

		it("a deterministic harvest-guard violation surfaces as EventHarvestError, not a retryable CommitError", async () => {
			// An event missing aggregateId is a recordEvent/createDomainEvent
			// misuse: deterministic, fails identically on every retry. It must
			// NOT be wrapped in CommitError (an InfrastructureError a retry
			// loop would spin on forever).
			const badEvent = createDomainEvent("OrderCreated", { orderId: "x" }, {
				aggregateType: "MockOrder",
			}) as TestEvent;
			const agg = createMockAggregate("x", [badEvent]);
			const { uow } = createUow();

			const rejection = await uow
				.run(async ({ repositories }) => {
					await repositories.orders.save(agg);
					return undefined;
				})
				.then(
					() => undefined,
					(e: unknown) => e,
				);

			expect(rejection).toBeInstanceOf(EventHarvestError);
			expect(rejection).not.toBeInstanceOf(CommitError);
			expect(rejection).not.toBeInstanceOf(InfrastructureError);
			expect(agg.markPersistedCalls).toBe(0);
		});

		it("a wrapping scope that nests the harvest-guard error still surfaces EventHarvestError, not CommitError", async () => {
			// The harvest guard throws inside scope.transactional(), so a
			// scope that wraps its callback's rejection nests the
			// EventHarvestError in its cause chain. run() must still treat it
			// as the deterministic, non-retryable failure it is.
			const scope: TransactionScope<undefined> = {
				transactional: async <T>(fn: (_ctx: undefined) => Promise<T>) => {
					try {
						return await fn(undefined);
					} catch (e) {
						throw new Error("driver wrapped the failure", { cause: e });
					}
				},
			};
			const badEvent = createDomainEvent("OrderCreated", { orderId: "x" }, {
				aggregateType: "MockOrder",
			}) as TestEvent;
			const agg = createMockAggregate("x", [badEvent]);
			const { uow } = createUow({ scope });

			const rejection = await uow
				.run(async ({ repositories }) => {
					await repositories.orders.save(agg);
					return undefined;
				})
				.then(
					() => undefined,
					(e: unknown) => e,
				);

			expect(rejection).toBeInstanceOf(EventHarvestError);
			expect(rejection).not.toBeInstanceOf(InfrastructureError);
		});

		it("a scope that WRAPS the callback's error passes the wrapper through (not a RollbackError)", async () => {
			const original = new Error("callback failed");
			const wrapper = new Error("driver wrapped it", { cause: original });
			const scope: TransactionScope<undefined> = {
				transactional: async <T>(fn: (_ctx: undefined) => Promise<T>) => {
					try {
						return await fn(undefined);
					} catch {
						throw wrapper;
					}
				},
			};
			const { uow } = createUow({ scope });

			await expect(
				uow.run(async () => {
					throw original;
				}),
			).rejects.toBe(wrapper);
		});

		it("a callback that throws undefined does not let a no-cause scope error masquerade as a wrapper (RollbackError, not pass-through)", async () => {
			// `(plainError).cause` is undefined; with a thrown-undefined
			// callback error, a naive chain walk would find
			// undefined === undefined and pass the rollback failure through
			// as a mere wrapper of the callback error.
			const rollbackFailure = new Error("ROLLBACK failed"); // no cause
			const scope: TransactionScope<undefined> = {
				transactional: async <T>(fn: (_ctx: undefined) => Promise<T>) => {
					try {
						return await fn(undefined);
					} catch {
						throw rollbackFailure;
					}
				},
			};
			const { uow } = createUow({ scope });

			const rejection = await uow
				.run(async () => {
					throw undefined;
				})
				.then(
					() => undefined,
					(e: unknown) => e,
				);

			expect(rejection).toBeInstanceOf(RollbackError);
			expect((rejection as RollbackError).rollbackCause).toBe(
				rollbackFailure,
			);
		});

		it("a throwing `cause` getter on the scope's error cannot replace the real failure", async () => {
			const original = new Error("callback failed");
			const hostile = new Error("driver error");
			Object.defineProperty(hostile, "cause", {
				get() {
					throw new Error("lazy deserialization blew up");
				},
			});
			const scope: TransactionScope<undefined> = {
				transactional: async <T>(fn: (_ctx: undefined) => Promise<T>) => {
					try {
						return await fn(undefined);
					} catch {
						throw hostile;
					}
				},
			};
			const { uow } = createUow({ scope });

			const rejection = await uow
				.run(async () => {
					throw original;
				})
				.then(
					() => undefined,
					(e: unknown) => e,
				);

			// The getter's exception must not become the rejection; the
			// hostile error is treated as not-wrapping → RollbackError with
			// both failures preserved.
			expect(rejection).toBeInstanceOf(RollbackError);
			expect((rejection as RollbackError).cause).toBe(original);
			expect((rejection as RollbackError).rollbackCause).toBe(hostile);
		});

		it("callback failed AND scope rejected with an unrelated error: RollbackError carrying both", async () => {
			const original = new ConcurrencyConflictError({ aggregateType: "Order", aggregateId: "o-1", expectedVersion: 3, actualVersion: 4 });
			const rollbackFailure = new Error("ROLLBACK failed: connection lost");
			const scope: TransactionScope<undefined> = {
				transactional: async <T>(fn: (_ctx: undefined) => Promise<T>) => {
					try {
						return await fn(undefined);
					} catch {
						throw rollbackFailure;
					}
				},
			};
			const { uow } = createUow({ scope });

			const rejection = await uow
				.run(async () => {
					throw original;
				})
				.then(
					() => undefined,
					(e: unknown) => e,
				);

			expect(rejection).toBeInstanceOf(RollbackError);
			// Primary error preserved as the cause (cause-chain helpers
			// still find the ConcurrencyConflictError)...
			expect((rejection as RollbackError).cause).toBe(original);
			// ...and the scope's own failure rides along.
			expect((rejection as RollbackError).rollbackCause).toBe(
				rollbackFailure,
			);
		});
	});

	describe("cancellation (AbortSignal)", () => {
		it("an already-aborted signal rejects run() before opening a transaction", async () => {
			let txOpened = false;
			const scope: TransactionScope<undefined> = {
				transactional: async <T>(fn: (_ctx: undefined) => Promise<T>) => {
					txOpened = true;
					return fn(undefined);
				},
			};
			const { uow } = createUow({ scope });

			const ac = new AbortController();
			ac.abort(new Error("client gave up"));

			let workRan = false;
			await expect(
				uow.run(
					async () => {
						workRan = true;
						return "x";
					},
					{ signal: ac.signal },
				),
			).rejects.toThrow("client gave up");

			expect(txOpened).toBe(false);
			expect(workRan).toBe(false);
		});

		it("rejects with a real Error, not undefined, when a non-spec signal has no reason", async () => {
			const { uow } = createUow();
			// A spec-compliant AbortSignal always populates `reason` when
			// aborted; a minimal polyfill might not. The pre-flight must not
			// `throw undefined`.
			const polyfillSignal = { aborted: true, reason: undefined } as AbortSignal;

			await expect(
				uow.run(async () => "x", { signal: polyfillSignal }),
			).rejects.toBeInstanceOf(Error);
		});

		it("exposes the signal on the context for cooperative checks", async () => {
			const { uow } = createUow();
			const ac = new AbortController();

			let seen: AbortSignal | undefined;
			await uow.run(
				async (ctx) => {
					seen = ctx.signal;
					return "ok";
				},
				{ signal: ac.signal },
			);

			expect(seen).toBe(ac.signal);
		});

		it("forwards the signal to the TransactionScope's transactional options", async () => {
			let receivedOpts: { signal?: AbortSignal } | undefined;
			const scope: TransactionScope<undefined> = {
				transactional: async <T>(
					fn: (_ctx: undefined) => Promise<T>,
					opts?: { signal?: AbortSignal },
				) => {
					receivedOpts = opts;
					return fn(undefined);
				},
			};
			const { uow } = createUow({ scope });
			const ac = new AbortController();

			await uow.run(async () => "ok", { signal: ac.signal });

			expect(receivedOpts?.signal).toBe(ac.signal);
		});

		it("a cooperative abort mid-work rolls back: error passes through, no markPersisted", async () => {
			const outbox = createMockOutbox();
			const { uow } = createUow({ outbox });
			const agg = createMockAggregate("order-1", [testEvent("order-1")]);
			const ac = new AbortController();

			await expect(
				uow.run(
					async (ctx) => {
						await ctx.repositories.orders.save(agg);
						ac.abort(new Error("deadline exceeded"));
						if (ctx.signal?.aborted) throw ctx.signal.reason;
						return "unreachable";
					},
					{ signal: ac.signal },
				),
			).rejects.toThrow("deadline exceeded");

			expect(agg.markPersistedCalls).toBe(0);
			expect(outbox.added).toHaveLength(0);
		});

		it("runs normally when no signal is supplied (backwards compatible)", async () => {
			const { uow } = createUow();
			const result = await uow.run(async () => "ok");
			expect(result).toBe("ok");
		});
	});

	describe("enrollment guard: events recorded after load but never enrolled", () => {
		// A dummy class token to register instances under, simulating a
		// repository's getById path (identityMap.set after hydration).
		class MockOrder {}

		/** A loadable aggregate with a directly-pushable pending list. */
		function loadable(id: string, initialEvents: TestEvent[] = []) {
			const pending: TestEvent[] = [...initialEvents];
			return {
				id: id as TestId,
				version: 1 as Version,
				persistedVersion: undefined as Version | undefined,
				get pendingEvents(): ReadonlyArray<TestEvent> {
					return pending;
				},
				clearPendingEvents(): void {
					pending.length = 0;
				},
				markPersisted(_v: Version): void {
					pending.length = 0;
				},
				record(e: TestEvent): void {
					pending.push(e);
				},
			};
		}

		it("throws UnenrolledChangesError when events are recorded after load and never enrolled", async () => {
			const agg = loadable("o-1"); // loaded clean
			const { uow } = createUow();

			const rejection = await uow
				.run(async ({ session }) => {
					session.identityMap.set(MockOrder, agg.id, agg); // getById
					agg.record(testEvent("o-1")); // a domain method records an event
					// ...but the repo's save (and thus enrollSaved) is never called
					return undefined;
				})
				.then(
					() => undefined,
					(e: unknown) => e,
				);

			expect(rejection).toBeInstanceOf(UnenrolledChangesError);
			expect(rejection).not.toBeInstanceOf(InfrastructureError);
		});

		it("does not throw when the mutated aggregate was enrolled", async () => {
			const agg = loadable("o-1");
			const { uow } = createUow();

			const result = await uow.run(async ({ session }) => {
				session.identityMap.set(MockOrder, agg.id, agg);
				agg.record(testEvent("o-1"));
				session.enrollSaved(agg); // saved
				return "ok";
			});

			expect(result).toBe("ok");
		});

		it("does not throw on a read-only load (no events recorded)", async () => {
			const agg = loadable("o-1");
			const { uow } = createUow();

			const result = await uow.run(async ({ session }) => {
				session.identityMap.set(MockOrder, agg.id, agg);
				return "read-only";
			});

			expect(result).toBe("read-only");
		});

		it("does not false-positive on a dirty reconstitution that already carried events but gained none", async () => {
			// Reconstituted with events already in pendingEvents; the use case
			// only reads it. No NEW events after load, so no enrollment is owed.
			const agg = loadable("o-1", [testEvent("o-1")]);
			const { uow } = createUow();

			const result = await uow.run(async ({ session }) => {
				session.identityMap.set(MockOrder, agg.id, agg);
				return "read-only-dirty";
			});

			expect(result).toBe("read-only-dirty");
		});

		it("does not throw when the mutated aggregate was deleted", async () => {
			const agg = loadable("o-1");
			const { uow } = createUow();

			const result = await uow.run(async ({ session }) => {
				session.identityMap.set(MockOrder, agg.id, agg);
				agg.record(testEvent("o-1"));
				session.enrollDeleted(agg);
				return "deleted";
			});

			expect(result).toBe("deleted");
		});
	});
});
