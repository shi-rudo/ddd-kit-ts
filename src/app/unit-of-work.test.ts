import { describe, expect, it } from "vitest";
import type { Version } from "../aggregate/aggregate";
import type { IAggregateRoot } from "../aggregate/aggregate-root";
import { createDomainEvent, type DomainEvent } from "../aggregate/domain-event";
import { ConcurrencyConflictError } from "../core/errors";
import type { Id } from "../core/id";
import type { EventBus, Outbox } from "../events/ports";
import type { TransactionScope } from "../repo/scope";
import {
	AggregateDeletedError,
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
			const conflict = new ConcurrencyConflictError("Order", "o-1", 3, 4);

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

			await uow.run(async ({ repositories, transaction }) => {
				expect(repositories.a.handle).toBe(tx);
				expect(repositories.b.handle).toBe(tx);
				expect(transaction).toBe(tx);
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
			expect(outbox.added).toEqual([[event]]);
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
				.toEqual([[event]]);
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
				.toEqual([[deletionEvent]]);
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
				.toEqual([[event]]);
			expect(agg.markPersistedCalls).toBe(1);
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
			expect(() => leaked.transaction).toThrow(TransactionClosedError);
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

		it("callback failed AND scope rejected with an unrelated error: RollbackError carrying both", async () => {
			const original = new ConcurrencyConflictError("Order", "o-1", 3, 4);
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
});
