import { describe, expect, it, vi } from "vite-plus/test";
import type { IAggregateRoot, Version } from "../aggregate/aggregate";
import { AggregateRoot } from "../aggregate/aggregate-root";
import {
	type AnyDomainEvent,
	createDomainEvent,
	type DomainEvent,
} from "../aggregate/domain-event";
import {
	pendingEventLifecycleCapabilityFor,
	registerPendingEventLifecycleCapability,
} from "../aggregate/pending-event-lifecycle";
import {
	AggregateDeletedError,
	ConcurrencyConflictError,
	EventHarvestError,
	InfrastructureError,
	UnenrolledChangesError,
} from "../core/errors";
import type { Id } from "../core/id";
import type { EventBus, EventCommitCandidate, Outbox } from "../events/ports";
import type { AggregateClass } from "../repo/identity-map";
import type { PersistenceModel } from "../repo/persistence-model";
import type { TransactionScope } from "../repo/scope";
import {
	type AggregatePersistenceWrite,
	AggregateTrackingError,
	type AggregateWriteRegistration,
	CommitError,
	defineRepository as defineExplicitRepository,
	InvalidRepositoryAdapterError,
	NestedUnitOfWorkError,
	type PhysicalRemovalRegistration,
	type RepositoryDefinition,
	type RepositoryDefinitionOptions,
	type RepositoryTracking,
	RollbackError,
	TransactionClosedError,
	UnitOfWork,
} from "./unit-of-work";

type TestEvent = DomainEvent<"OrderCreated", { orderId: string }>;
type TestId = Id<"TestId">;

function observeAcknowledgements(
	aggregate: object,
	onAcknowledge: () => void,
): void {
	const lifecycle = pendingEventLifecycleCapabilityFor(aggregate);
	if (!lifecycle) throw new Error("missing aggregate event lifecycle");
	registerPendingEventLifecycleCapability(aggregate, {
		acknowledge: (events) => {
			lifecycle.acknowledge(events);
			onAcknowledge();
		},
		discardPendingEvents: (events) => lifecycle.discardPendingEvents(events),
	});
}

class MockAggregate extends AggregateRoot<
	Readonly<Record<string, never>>,
	TestId,
	TestEvent
> {
	protected readonly aggregateType = "MockOrder";
	private _acknowledgementCount = 0;

	constructor(id: string, events: TestEvent[]) {
		super(id as TestId, {});
		this.setVersion(1 as Version);
		for (const event of events) this.addDomainEvent(event);
		observeAcknowledgements(this, () => {
			this._acknowledgementCount += 1;
		});
	}

	public get acknowledgementCount(): number {
		return this._acknowledgementCount;
	}

	public change(event?: TestEvent): void {
		this.commit(this.state, event);
	}
}

function createMockAggregate(
	id: string,
	events: TestEvent[] = [],
): MockAggregate {
	return new MockAggregate(id, events);
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

/** Minimal UoW-style repository: writes only register lifecycle intent. */
class FakeOrderRepository {
	constructor(
		public readonly tx: unknown,
		private readonly tracking: RepositoryTracking<MockAggregate>,
	) {}

	trackLoaded(aggregate: MockAggregate): MockAggregate {
		return this.tracking.trackLoaded(aggregate);
	}
}

function versionPersistenceModel<
	TAggregate extends IAggregateRoot<Id<string>, AnyDomainEvent>,
>(): PersistenceModel<TAggregate, Version, Version | undefined> {
	return {
		capture: (aggregate) => aggregate.version,
		changes: (baseline, aggregate) =>
			baseline === aggregate.version ? undefined : aggregate.version,
		isEmpty: (change) => change === undefined,
	};
}

class TestRepositoryError extends InfrastructureError<"TEST_REPOSITORY_ERROR"> {
	constructor(cause: unknown) {
		super({
			code: "TEST_REPOSITORY_ERROR",
			message: "The test repository failed",
			cause,
		});
	}
}

function mapTestRepositoryError(error: unknown): InfrastructureError {
	return error instanceof InfrastructureError
		? error
		: new TestRepositoryError(error);
}

type TestRepositoryPort<
	TRepository extends object,
	TAggregate extends IAggregateRoot<Id<string>, AnyDomainEvent>,
	TRemoval extends boolean,
> = Omit<TRepository, "add" | "update" | "remove"> &
	AggregateWriteRegistration<TAggregate> &
	(TRemoval extends true ? PhysicalRemovalRegistration<TAggregate> : object);

type TestRepositoryDefinitionOptions<
	TCtx,
	TRepository extends object,
	TAggregate extends IAggregateRoot<Id<string>, AnyDomainEvent>,
	TBaseline,
	TChangeSet,
	TRemoval extends boolean,
> = Omit<
	RepositoryDefinitionOptions<
		TCtx,
		TestRepositoryPort<TRepository, TAggregate, TRemoval>,
		TAggregate,
		TBaseline,
		TChangeSet,
		TRemoval
	>,
	"mapError"
> & {
	readonly mapError?: RepositoryDefinitionOptions<
		TCtx,
		TestRepositoryPort<TRepository, TAggregate, TRemoval>,
		TAggregate,
		TBaseline,
		TChangeSet,
		TRemoval
	>["mapError"];
	readonly create: (
		transaction: TCtx,
		tracking: RepositoryTracking<TAggregate>,
	) => TRepository;
};

/** Keeps behavior-focused fixtures terse; the public port contract has its own tests. */
function defineTestRepository<
	TCtx,
	TRepository extends object,
	TAggregate extends IAggregateRoot<Id<string>, AnyDomainEvent>,
	TBaseline,
	TChangeSet,
	TRemoval extends boolean = false,
>(
	definition: TestRepositoryDefinitionOptions<
		TCtx,
		TRepository,
		TAggregate,
		TBaseline,
		TChangeSet,
		TRemoval
	>,
): RepositoryDefinition<
	TCtx,
	TestRepositoryPort<TRepository, TAggregate, TRemoval>,
	TAggregate,
	TBaseline,
	TChangeSet,
	TRemoval
> {
	const build = defineExplicitRepository<
		TestRepositoryPort<TRepository, TAggregate, TRemoval>
	>() as unknown as (
		options: RepositoryDefinitionOptions<
			TCtx,
			TestRepositoryPort<TRepository, TAggregate, TRemoval>,
			TAggregate,
			TBaseline,
			TChangeSet,
			TRemoval
		>,
	) => RepositoryDefinition<
		TCtx,
		TestRepositoryPort<TRepository, TAggregate, TRemoval>,
		TAggregate,
		TBaseline,
		TChangeSet,
		TRemoval
	>;
	return build({
		...definition,
		mapError: definition.mapError ?? mapTestRepositoryError,
	});
}

function createUow(overrides?: {
	scope?: TransactionScope<undefined>;
	outbox?: Outbox<TestEvent>;
	bus?: EventBus<TestEvent>;
	onTracking?: (tracking: RepositoryTracking<MockAggregate>) => void;
}) {
	const outbox = overrides?.outbox ?? createMockOutbox();
	const bus = overrides?.bus ?? createMockBus();
	const scope = overrides?.scope ?? createMockScope();
	const uow = new UnitOfWork({
		scope,
		outbox,
		bus,
		repositories: {
			orders: defineTestRepository({
				aggregate: MockAggregate,
				persistence: versionPersistenceModel<MockAggregate>(),
				physicalRemoval: true,
				flush: async () => {},
				create: (tx: undefined, tracking) => {
					overrides?.onTracking?.(tracking);
					return new FakeOrderRepository(tx, tracking);
				},
			}),
		},
	});
	return { uow, outbox, bus, scope };
}

/** Expected persistence envelope for one harvested event. */
function stamped(
	event: TestEvent,
	aggregateVersion = 1,
	commitSequence = 0,
): EventCommitCandidate<TestEvent> {
	return {
		event,
		source: {
			aggregateId: event.aggregateId ?? event.payload.orderId,
			aggregateType: event.aggregateType ?? "MockOrder",
		},
		position: {
			aggregateVersion,
			commitSequence,
			commitSize: 1,
		},
	};
}

async function expectTrackingFailure(
	execution: Promise<unknown>,
	reason: AggregateTrackingError["reason"],
): Promise<void> {
	const rejection = await execution.then(
		() => undefined,
		(error: unknown) => error,
	);
	expect(rejection).toBeInstanceOf(AggregateTrackingError);
	expect(rejection).toMatchObject({
		code: "AGGREGATE_TRACKING",
		category: "WIRING",
		retryable: false,
		reason,
	});
}

describe("UnitOfWork", () => {
	describe("v3 aggregate tracking", () => {
		it("derives adapter changes at flush while preserving event-only commits", async () => {
			type State = Readonly<{ value: number }>;
			class ProjectedAggregate extends AggregateRoot<State, TestId, TestEvent> {
				protected readonly aggregateType = "ProjectedAggregate";

				constructor(id: TestId, value: number) {
					super(id, { value });
					this.setVersion(1 as Version);
				}

				get persistenceValue(): number {
					return this.state.value;
				}

				changeValue(value: number): void {
					this.commit({ value });
				}

				changePersistenceOnly(value: number): void {
					this.setStateWithoutVersionBump({ value });
				}

				announce(event: TestEvent): void {
					this.commit(this.state, event);
				}
			}

			type Change = number | undefined;
			const derived: Change[] = [];
			const writes: AggregatePersistenceWrite<ProjectedAggregate, Change>[] =
				[];
			const model: PersistenceModel<ProjectedAggregate, number, Change> = {
				capture: (aggregate) => aggregate.persistenceValue,
				changes: (baseline, aggregate) => {
					const change =
						baseline === aggregate.persistenceValue
							? undefined
							: aggregate.persistenceValue;
					derived.push(change);
					return change;
				},
				isEmpty: (change) => change === undefined,
			};
			const stateOnly = new ProjectedAggregate("state" as TestId, 1);
			const eventOnly = new ProjectedAggregate("event" as TestId, 1);
			const unregisteredState = new ProjectedAggregate(
				"unregistered" as TestId,
				1,
			);
			const event = testEvent("event");
			const outbox = createMockOutbox();
			const uow = new UnitOfWork({
				scope: createMockScope(),
				outbox,
				repositories: {
					projected: defineTestRepository({
						aggregate: ProjectedAggregate,
						persistence: model,
						flush: async (_tx: undefined, write) => {
							writes.push(write);
						},
						create: (_tx: undefined, tracking) => ({
							load: (aggregate: ProjectedAggregate) =>
								tracking.trackLoaded(aggregate),
							update: (_aggregate: ProjectedAggregate) => {
								throw new Error("facade must own update");
							},
						}),
					}),
				},
			});

			await uow.run(async ({ repositories }) => {
				repositories.projected.load(stateOnly);
				stateOnly.changeValue(2);
				repositories.projected.update(stateOnly);

				repositories.projected.load(eventOnly);
				eventOnly.announce(event);
				repositories.projected.update(eventOnly);
			});

			expect(derived).toContain(2);
			expect(derived).toContain(undefined);
			expect(writes).toHaveLength(2);
			expect(writes[0]).toMatchObject({
				intent: "update",
				aggregateId: "state",
				expectedVersion: 1,
				version: 2,
				changes: { value: 2, empty: false },
				events: [],
			});
			expect(writes[1]).toMatchObject({
				intent: "update",
				aggregateId: "event",
				expectedVersion: 1,
				version: 2,
				changes: { value: undefined, empty: true },
				events: [event],
			});
			expect(Object.isFrozen(writes[0])).toBe(true);
			expect(Object.isFrozen(writes[0]?.events)).toBe(true);
			expect(outbox.added).toEqual([[stamped(event, 2)]]);

			await expect(
				uow.run(async ({ repositories }) => {
					repositories.projected.load(unregisteredState);
					unregisteredState.changePersistenceOnly(2);
				}),
			).rejects.toBeInstanceOf(UnenrolledChangesError);
		});

		it("flushes writes in registration order rather than load order", async () => {
			const firstLoaded = createMockAggregate("first-loaded");
			const secondLoaded = createMockAggregate("second-loaded");
			const flushed: string[] = [];
			const uow = new UnitOfWork({
				scope: createMockScope(),
				outbox: createMockOutbox(),
				repositories: {
					orders: defineTestRepository({
						aggregate: MockAggregate,
						persistence: versionPersistenceModel<MockAggregate>(),
						create: (_tx: undefined, tracking) =>
							new FakeOrderRepository(undefined, tracking),
						flush: async (_tx: undefined, write) => {
							flushed.push(write.aggregateId);
						},
					}),
				},
			});

			await uow.run(async ({ repositories }) => {
				repositories.orders.trackLoaded(firstLoaded);
				repositories.orders.trackLoaded(secondLoaded);
				secondLoaded.change();
				repositories.orders.update(secondLoaded);
				firstLoaded.change();
				repositories.orders.update(firstLoaded);
			});

			expect(flushed).toEqual(["second-loaded", "first-loaded"]);
		});

		it("rolls back when an aggregate changes while its flush is in flight", async () => {
			const aggregate = createMockAggregate("order-1");
			const outbox = createMockOutbox();
			const uow = new UnitOfWork({
				scope: createMockScope(),
				outbox,
				repositories: {
					orders: defineTestRepository({
						aggregate: MockAggregate,
						persistence: versionPersistenceModel<MockAggregate>(),
						create: (_tx: undefined, tracking) =>
							new FakeOrderRepository(undefined, tracking),
						flush: async () => {
							aggregate.change(testEvent("order-1"));
						},
					}),
				},
			});

			await expectTrackingFailure(
				uow.run(async ({ repositories }) => {
					repositories.orders.add(aggregate);
				}),
				"mutated_after_registration",
			);
			expect(outbox.added).toHaveLength(0);
			expect(aggregate.acknowledgementCount).toBe(0);
		});

		it("captures the expected version when an aggregate is loaded", async () => {
			const { uow } = createUow();
			const aggregate = createMockAggregate("o-1");

			await expect(
				uow.run(async ({ repositories }) => {
					repositories.orders.trackLoaded(aggregate);
					aggregate.change();
					return undefined;
				}),
			).rejects.toBeInstanceOf(UnenrolledChangesError);
		});

		it("registers add and update intent without performing durable I/O", async () => {
			const { uow } = createUow();
			const fresh = createMockAggregate("new-1");
			const loaded = createMockAggregate("loaded-1");

			await expect(
				uow.run(async ({ repositories }) => {
					repositories.orders.add(fresh);
					repositories.orders.trackLoaded(loaded);
					loaded.change();
					repositories.orders.update(loaded);
					return "registered";
				}),
			).resolves.toBe("registered");
		});

		it("owns standard write methods even when an adapter defines implementations", async () => {
			const event = testEvent("o-1");
			const aggregate = createMockAggregate("o-1", [event]);
			const outbox = createMockOutbox();
			let adapterAddCalls = 0;
			let adapterRemoveCalls = 0;
			const uow = new UnitOfWork({
				scope: createMockScope(),
				outbox,
				repositories: {
					orders: defineTestRepository({
						aggregate: MockAggregate,
						persistence: versionPersistenceModel<MockAggregate>(),
						flush: async () => {},
						create: () => ({
							add: async (_aggregate: MockAggregate) => {
								adapterAddCalls += 1;
							},
							remove: (_aggregate: MockAggregate) => {
								adapterRemoveCalls += 1;
							},
						}),
					}),
				},
			});

			await uow.run(async ({ repositories }) => {
				const registration: void = repositories.orders.add(aggregate);
				expect(registration).toBeUndefined();
				expect("remove" in repositories.orders).toBe(false);
				// @ts-expect-error physical removal stays absent without an explicit opt-in
				expect(repositories.orders.remove).toBeUndefined();
			});

			expect(adapterAddCalls).toBe(0);
			expect(adapterRemoveCalls).toBe(0);
			expect(outbox.added).toEqual([[stamped(event)]]);
			expect(aggregate.acknowledgementCount).toBe(1);
		});

		it("does not flush when commit enrollment rejects and the caller catches it", async () => {
			const lookalike = {
				id: "lookalike-1" as TestId,
				version: 1 as Version,
				pendingEvents: [],
			} as unknown as MockAggregate;
			let flushCalls = 0;
			const uow = new UnitOfWork({
				scope: createMockScope(),
				outbox: createMockOutbox(),
				repositories: {
					orders: defineTestRepository({
						aggregate: MockAggregate,
						persistence: versionPersistenceModel<MockAggregate>(),
						create: () => ({}),
						flush: async () => {
							flushCalls += 1;
						},
					}),
				},
			});

			await expect(
				uow.run(async ({ repositories }) => {
					expect(() => repositories.orders.add(lookalike)).toThrow(
						EventHarvestError,
					);
					return "continued";
				}),
			).resolves.toBe("continued");

			expect(flushCalls).toBe(0);
		});

		it("rejects update for an aggregate that was not loaded", async () => {
			const { uow } = createUow();

			await expectTrackingFailure(
				uow.run(async ({ repositories }) => {
					repositories.orders.update(createMockAggregate("o-1"));
					return undefined;
				}),
				"not_loaded",
			);
		});

		it("rejects add for an aggregate that was loaded", async () => {
			const { uow } = createUow();
			const aggregate = createMockAggregate("o-1");

			await expectTrackingFailure(
				uow.run(async ({ repositories }) => {
					repositories.orders.trackLoaded(aggregate);
					repositories.orders.add(aggregate);
					return undefined;
				}),
				"loaded_as_new",
			);
		});

		it("rejects adding one aggregate instance through two repository definitions", async () => {
			const aggregate = createMockAggregate("o-1");
			let flushCalls = 0;
			const definition = () =>
				defineTestRepository({
					aggregate: MockAggregate,
					persistence: versionPersistenceModel<MockAggregate>(),
					create: () => ({}),
					flush: async () => {
						flushCalls += 1;
					},
				});
			const uow = new UnitOfWork({
				scope: createMockScope(),
				outbox: createMockOutbox(),
				repositories: {
					primary: definition(),
					secondary: definition(),
				},
			});

			await expectTrackingFailure(
				uow.run(async ({ repositories }) => {
					repositories.primary.add(aggregate);
					repositories.secondary.add(aggregate);
				}),
				"different_repository",
			);
			expect(flushCalls).toBe(0);
		});

		it("rejects conflicting write intents", async () => {
			const { uow } = createUow();
			const aggregate = createMockAggregate("o-1");

			await expectTrackingFailure(
				uow.run(async ({ repositories }) => {
					repositories.orders.trackLoaded(aggregate);
					aggregate.change();
					repositories.orders.update(aggregate);
					repositories.orders.remove(aggregate);
					return undefined;
				}),
				"conflicting_intent",
			);
		});

		it("rejects domain mutation after write intent was registered", async () => {
			const { uow, outbox } = createUow();
			const aggregate = createMockAggregate("o-1");

			await expectTrackingFailure(
				uow.run(async ({ repositories }) => {
					repositories.orders.trackLoaded(aggregate);
					aggregate.change();
					repositories.orders.update(aggregate);
					aggregate.change(testEvent("o-1"));
					return undefined;
				}),
				"mutated_after_registration",
			);
			expect(
				(
					outbox as Outbox<TestEvent> & {
						added: EventCommitCandidate<TestEvent>[][];
					}
				).added,
			).toHaveLength(0);
		});

		it("also seals a newly added aggregate against later mutation", async () => {
			const { uow } = createUow();
			const aggregate = createMockAggregate("o-1");

			await expectTrackingFailure(
				uow.run(async ({ repositories }) => {
					repositories.orders.add(aggregate);
					aggregate.change();
					return undefined;
				}),
				"mutated_after_registration",
			);
		});

		it("discards loaded instances when an attempt rolls back", async () => {
			const { uow } = createUow();
			const first = createMockAggregate("o-1");
			const second = createMockAggregate("o-1");

			await expect(
				uow.run(async ({ repositories }) => {
					repositories.orders.trackLoaded(first);
					throw new Error("roll back");
				}),
			).rejects.toThrow("roll back");

			await expect(
				uow.run(async ({ repositories }) => {
					repositories.orders.trackLoaded(second);
					return second;
				}),
			).resolves.toBe(second);
		});
	});

	describe("transaction lifecycle", () => {
		it("supports a state-stored AggregateRoot without event sourcing", async () => {
			type PlainState = Readonly<{ name: string }>;
			class PlainAggregate extends AggregateRoot<PlainState, TestId> {
				protected readonly aggregateType = "PlainAggregate";

				constructor(id: TestId) {
					super(id, { name: "before" });
				}

				public rename(name: string): void {
					this.setState({ name });
				}
			}

			const aggregate = new PlainAggregate("plain-1" as TestId);
			aggregate.rename("after");
			const outbox = createMockOutbox();
			const uow = new UnitOfWork({
				scope: createMockScope(),
				outbox,
				repositories: {
					plain: defineTestRepository({
						aggregate: PlainAggregate,
						persistence: versionPersistenceModel<PlainAggregate>(),
						flush: async () => {},
						create: () => ({
							add: (_plain: PlainAggregate) => {},
						}),
					}),
				},
			});

			await uow.run(async ({ repositories }) => {
				repositories.plain.add(aggregate);
			});

			expect(aggregate.pendingEvents).toEqual([]);
			expect(outbox.added).toEqual([]);
		});

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

		it("rolls back on callback error: error passes through unchanged, no acknowledgement", async () => {
			const { uow } = createUow();
			const agg = createMockAggregate("o-1", [testEvent("o-1")]);
			const boom = new Error("domain rule violated");

			await expect(
				uow.run(async ({ repositories }) => {
					repositories.orders.add(agg);
					throw boom;
				}),
			).rejects.toBe(boom);

			expect(agg.acknowledgementCount).toBe(0);
			expect(agg.pendingEvents).toHaveLength(1);
		});

		it("a repository ConcurrencyConflictError passes through as the same instance (stays distinguishable)", async () => {
			const { uow } = createUow();
			const conflict = new ConcurrencyConflictError({
				aggregateType: "Order",
				aggregateId: "o-1",
				expectedVersion: 3,
				actualVersion: 4,
			});

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
		it.each([
			[null, "null"],
			[() => undefined, "function"],
		] as const)(
			"rejects the non-adapter factory result %s",
			async (factoryResult, receivedType) => {
				const uow = new UnitOfWork({
					scope: createMockScope(),
					outbox: createMockOutbox(),
					repositories: {
						orders: defineTestRepository({
							aggregate: MockAggregate,
							persistence: versionPersistenceModel<MockAggregate>(),
							flush: async () => {},
							// Deliberately defeat the static boundary to exercise the runtime
							// guard for JavaScript consumers and dishonest assertions.
							create: () => factoryResult as unknown as object,
						}),
					},
				});

				await expect(uow.run(async () => undefined)).rejects.toMatchObject({
					constructor: InvalidRepositoryAdapterError,
					code: "INVALID_REPOSITORY_ADAPTER",
					category: "WIRING",
					repository: "orders",
					receivedType,
				});
			},
		);

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
					a: defineTestRepository({
						aggregate: MockAggregate,
						persistence: versionPersistenceModel<MockAggregate>(),
						flush: async () => {},
						create: (handle: FakeTx) => {
							seen.push(handle);
							return { handle };
						},
					}),
					b: defineTestRepository({
						aggregate: MockAggregate,
						persistence: versionPersistenceModel<MockAggregate>(),
						flush: async () => {},
						create: (handle: FakeTx) => {
							seen.push(handle);
							return { handle };
						},
					}),
				},
			});

			await uow.run(async ({ repositories }) => {
				expect(repositories.a.handle).toBe(tx);
				expect(repositories.b.handle).toBe(tx);
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
					orders: defineTestRepository({
						aggregate: MockAggregate,
						persistence: versionPersistenceModel<MockAggregate>(),
						flush: async () => {},
						create: () => {
							constructed += 1;
							return {};
						},
					}),
				},
			});

			await uow.run(async () => undefined);
			await uow.run(async () => undefined);

			expect(constructed).toBe(2);
		});

		function createReflectiveUow() {
			return new UnitOfWork({
				scope: createMockScope(),
				outbox: createMockOutbox(),
				repositories: {
					orders: defineTestRepository({
						aggregate: MockAggregate,
						persistence: versionPersistenceModel<MockAggregate>(),
						flush: async () => {},
						create: () =>
							Object.defineProperties(
								{ label: "orders", read: (): string => "initial" },
								{
									fixed: {
										value: "fixed",
										enumerable: true,
										configurable: false,
									},
								},
							),
					}),
				},
			});
		}

		it("allows application-local facade properties", async () => {
			await createReflectiveUow().run(async ({ repositories }) => {
				const repository = repositories.orders as typeof repositories.orders &
					Record<string, unknown>;
				Object.defineProperty(repository, "inspectionTag", {
					value: "scoped",
					enumerable: true,
					configurable: false,
				});

				expect(repository.inspectionTag).toBe("scoped");
				expect(Reflect.ownKeys(repository)).toContain("inspectionTag");
			});
		});

		it("protects Unit-of-Work lifecycle operations from reflection", async () => {
			await createReflectiveUow().run(async ({ repositories }) => {
				const repository = repositories.orders as typeof repositories.orders &
					Record<string, unknown>;

				expect(() =>
					Object.defineProperty(repository, "remove", {
						value: () => undefined,
						configurable: false,
					}),
				).toThrow(TypeError);
				expect(Reflect.set(repository, "remove", () => undefined)).toBe(false);
				expect("remove" in repository).toBe(false);
			});
		});

		it("deletes facade shadows before forwarded adapter properties", async () => {
			await createReflectiveUow().run(async ({ repositories }) => {
				const repository = repositories.orders as typeof repositories.orders &
					Record<string, unknown>;
				Object.defineProperty(repository, "label", {
					value: "facade label",
					configurable: true,
				});

				expect(repository.label).toBe("facade label");
				expect(Reflect.deleteProperty(repository, "label")).toBe(true);
				expect(repository.label).toBe("orders");
				expect(Reflect.deleteProperty(repository, "label")).toBe(true);
				expect(repository.label).toBeUndefined();
				expect("label" in repository).toBe(false);
				expect(Reflect.ownKeys(repository)).not.toContain("label");
			});
		});

		it("uses a replacement method after a forwarded method was cached", async () => {
			await createReflectiveUow().run(async ({ repositories }) => {
				const cachedRead = repositories.orders.read;
				expect(cachedRead()).toBe("initial");

				repositories.orders.read = () => "replacement";

				expect(repositories.orders.read()).toBe("replacement");
			});
		});

		it("preserves non-configurable adapter properties while freezing", async () => {
			await createReflectiveUow().run(async ({ repositories }) => {
				const repository = repositories.orders as typeof repositories.orders &
					Record<string, unknown>;

				expect(Reflect.deleteProperty(repository, "fixed")).toBe(false);
				expect(repository.fixed).toBe("fixed");
				expect(() => Object.freeze(repository)).not.toThrow();
				expect(Object.isFrozen(repository)).toBe(true);
			});
		});
	});

	describe("enrollment + post-commit lifecycle", () => {
		it("does not harvest or acknowledge a fresh aggregate that was never added", async () => {
			const { uow, outbox } = createUow();
			const event = testEvent("o-unsaved");
			const aggregate = createMockAggregate("o-unsaved", [event]);

			await expect(
				uow.run(async () => {
					// Constructing and mutating an aggregate is not persistence proof.
					// No repository add means no Unit-of-Work-owned commit token.
					return aggregate.id;
				}),
			).resolves.toBe("o-unsaved");

			expect(
				(
					outbox as Outbox<TestEvent> & {
						added: EventCommitCandidate<TestEvent>[][];
					}
				).added,
			).toEqual([]);
			expect(aggregate.pendingEvents).toEqual([event]);
			expect(aggregate.acknowledgementCount).toBe(0);
		});

		it("saved aggregates: events harvested, application observer after commit, publish last", async () => {
			const callOrder: string[] = [];
			const scope: TransactionScope<undefined> = {
				transactional: async <T>(fn: (_ctx: undefined) => Promise<T>) => {
					callOrder.push("tx-start");
					const result = await fn(undefined);
					callOrder.push("tx-commit");
					return result;
				},
			};
			const outbox: Outbox<TestEvent> & {
				added: EventCommitCandidate<TestEvent>[][];
			} = {
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
				subscribeAll: () => () => {},
				once: () => new Promise(() => {}),
			};
			const event = testEvent("o-1");
			const agg = createMockAggregate("o-1", [event]);
			const uow = new UnitOfWork({
				scope,
				outbox,
				bus,
				onPersisted: () => {
					callOrder.push("onPersisted");
				},
				repositories: {
					orders: defineTestRepository({
						aggregate: MockAggregate,
						persistence: versionPersistenceModel<MockAggregate>(),
						flush: async () => {
							callOrder.push("repository.flush");
						},
						create: (tx: undefined, tracking) =>
							new FakeOrderRepository(tx, tracking),
					}),
				},
			});

			await uow.run(async ({ repositories }) => {
				callOrder.push("work");
				repositories.orders.add(agg);
				return undefined;
			});

			expect(callOrder).toEqual([
				"tx-start",
				"work",
				"repository.flush",
				"outbox.add",
				"tx-commit",
				"onPersisted",
				"bus.publish",
			]);
			expect(outbox.added).toEqual([[stamped(event)]]);
		});

		it("forwards a post-commit application observer failure to onPersistError", async () => {
			const event = testEvent("o-1");
			const persistError = new Error("cache eviction failed");
			const agg = createMockAggregate("o-1", [event]);
			const reported: Array<{ error: unknown; aggregate: unknown }> = [];
			const uow = new UnitOfWork({
				scope: createMockScope(),
				outbox: createMockOutbox(),
				bus: createMockBus(),
				onPersisted: () => {
					throw persistError;
				},
				onPersistError: (error, aggregate) => {
					reported.push({ error, aggregate });
				},
				repositories: {
					orders: defineTestRepository({
						aggregate: MockAggregate,
						persistence: versionPersistenceModel<MockAggregate>(),
						flush: async () => {},
						create: (tx: undefined, tracking) =>
							new FakeOrderRepository(tx, tracking),
					}),
				},
			});

			// The committed write resolves; the cleanup failure is observed.
			await expect(
				uow.run(async ({ repositories }) => {
					repositories.orders.add(agg);
					return "ok";
				}),
			).resolves.toBe("ok");
			expect(reported).toHaveLength(1);
			expect(reported[0]?.error).toBe(persistError);
			expect(reported[0]?.aggregate).toBe(agg);
		});

		it("forwards the post-commit timeout and execution context", async () => {
			vi.useFakeTimers();
			const agg = createMockAggregate("o-1");
			const reported: unknown[] = [];
			let signal: AbortSignal | undefined;
			let observerStarted!: () => void;
			const started = new Promise<void>((resolve) => {
				observerStarted = resolve;
			});
			const uow = new UnitOfWork({
				scope: createMockScope(),
				outbox: createMockOutbox(),
				postCommitTimeoutMs: 5,
				onPersisted: (_aggregate, _version, context) => {
					signal = context.signal;
					observerStarted();
					return new Promise<void>(() => {});
				},
				onPersistError: (error) => reported.push(error),
				repositories: {
					orders: defineTestRepository({
						aggregate: MockAggregate,
						persistence: versionPersistenceModel<MockAggregate>(),
						flush: async () => {},
						create: (tx: undefined, tracking) =>
							new FakeOrderRepository(tx, tracking),
					}),
				},
			});

			const execution = uow.run(async ({ repositories }) => {
				repositories.orders.add(agg);
				return "committed";
			});

			try {
				await started;
				await vi.advanceTimersByTimeAsync(5);
				await expect(execution).resolves.toBe("committed");
				expect(signal?.aborted).toBe(true);
				expect(reported).toHaveLength(1);
				expect((reported[0] as Error).name).toBe("TimeoutError");
			} finally {
				vi.useRealTimers();
			}
		});

		it("saving the same instance twice harvests its events once and markPersists once", async () => {
			const { uow, outbox } = createUow();
			const event = testEvent("o-1");
			const agg = createMockAggregate("o-1", [event]);

			await uow.run(async ({ repositories }) => {
				repositories.orders.add(agg);
				repositories.orders.add(agg);
				return undefined;
			});

			expect(
				(
					outbox as Outbox<TestEvent> & {
						added: EventCommitCandidate<TestEvent>[][];
					}
				).added,
			).toEqual([[stamped(event)]]);
			expect(agg.acknowledgementCount).toBe(1);
		});

		it("deleted aggregates: recorded deletion events are harvested into the outbox", async () => {
			const { uow, outbox } = createUow();
			const deletionEvent = testEvent("o-1");
			const agg = createMockAggregate("o-1");

			await uow.run(async ({ repositories }) => {
				repositories.orders.trackLoaded(agg);
				agg.change(deletionEvent);
				repositories.orders.remove(agg);
				return undefined;
			});

			expect(
				(
					outbox as Outbox<TestEvent> & {
						added: EventCommitCandidate<TestEvent>[][];
					}
				).added,
			).toEqual([[stamped(deletionEvent, 2)]]);
		});

		it("saving an aggregate after deleting it in the same unit of work throws AggregateDeletedError", async () => {
			const { uow } = createUow();
			const agg = createMockAggregate("o-1");

			await expect(
				uow.run(async ({ repositories }) => {
					repositories.orders.trackLoaded(agg);
					repositories.orders.remove(agg);
					repositories.orders.update(agg);
					return undefined;
				}),
			).rejects.toBeInstanceOf(AggregateDeletedError);

			// The violation aborted the unit of work: nothing was committed.
			expect(agg.acknowledgementCount).toBe(0);
		});

		it("repository add registration stays inside the Unit of Work", async () => {
			const { uow, outbox } = createUow();
			const event = testEvent("o-1");
			const agg = createMockAggregate("o-1", [event]);

			await uow.run(async ({ repositories }) => {
				repositories.orders.add(agg);
				return undefined;
			});

			expect(
				(
					outbox as Outbox<TestEvent> & {
						added: EventCommitCandidate<TestEvent>[][];
					}
				).added,
			).toEqual([[stamped(event)]]);
			expect(agg.acknowledgementCount).toBe(1);
		});
	});

	describe("session seal + scope retries", () => {
		it("adapter tracking is closed as soon as the callback resolves", async () => {
			// A leaked adapter session must not accept registration after the
			// callback settled. The harvest snapshot is already taken, so the
			// session is sealed at callback completion and fails loudly.
			const lateAggregate = createMockAggregate("late-1", [
				testEvent("late-1"),
			]);
			let leakedTracking!: RepositoryTracking<MockAggregate>;
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
						leakedTracking.trackLoaded(lateAggregate);
					} catch (e) {
						lateEnrollError = e;
					}
					return result;
				},
			};
			const { uow } = createUow({
				scope,
				outbox,
				onTracking: (tracking) => {
					leakedTracking = tracking;
				},
			});

			await uow.run(async () => undefined);

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
					repositories.orders.add(attempt1Aggregate);
					throw retryableFailure; // attempt 1 rolls back
				}
				repositories.orders.add(attempt2Aggregate);
				return "second-attempt";
			});

			expect(result).toBe("second-attempt");
			// Only the committed attempt's events were harvested; the
			// rolled-back attempt's enrollment did not leak into the retry.
			expect(outbox.added).toEqual([[stamped(event2)]]);
			expect(attempt1Aggregate.acknowledgementCount).toBe(0);
			expect(attempt2Aggregate.acknowledgementCount).toBe(1);
		});

		it("reuses the same immutable event identity when the transaction retries after flush", async () => {
			const outbox = createMockOutbox();
			let transactionAttempt = 0;
			const scope: TransactionScope<undefined> = {
				transactional: async <T>(fn: (_ctx: undefined) => Promise<T>) => {
					const firstOutboxLength = outbox.added.length;
					const firstResult = await fn(undefined);
					transactionAttempt += 1;
					if (transactionAttempt === 1) {
						// The database rolls attempt one back, including its outbox row,
						// then re-invokes the transactional callback.
						outbox.added.length = firstOutboxLength;
						return fn(undefined);
					}
					return firstResult;
				},
			};
			const event = testEvent("retry-same-event");
			const aggregate = createMockAggregate("retry-same-event", [event]);
			const { uow } = createUow({ scope, outbox });

			await uow.run(async ({ repositories }) => {
				repositories.orders.add(aggregate);
			});

			expect(outbox.added).toHaveLength(1);
			expect(outbox.added[0]?.[0]?.event).toBe(event);
			expect(aggregate.pendingEvents).toHaveLength(0);
			expect(aggregate.acknowledgementCount).toBe(1);
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
		});

		it("adapter tracking after rollback throws TransactionClosedError", async () => {
			let leakedTracking!: RepositoryTracking<MockAggregate>;
			const { uow } = createUow({
				onTracking: (tracking) => {
					leakedTracking = tracking;
				},
			});

			await expect(
				uow.run(async () => {
					throw new Error("rolled back");
				}),
			).rejects.toThrow("rolled back");

			expect(() =>
				leakedTracking.trackLoaded(createMockAggregate("o-1")),
			).toThrow(TransactionClosedError);
		});

		it("invalidates repository reads, cached methods, and getters after close", async () => {
			let getterCalls = 0;
			class ReadRepository {
				readonly #value = "transactional-read";

				read(): string {
					return this.#value;
				}

				get status(): string {
					getterCalls += 1;
					return this.#value;
				}
			}
			const uow = new UnitOfWork({
				scope: createMockScope(),
				outbox: createMockOutbox(),
				repositories: {
					orders: defineTestRepository({
						aggregate: MockAggregate,
						persistence: versionPersistenceModel<MockAggregate>(),
						flush: async () => {},
						create: () => new ReadRepository(),
					}),
				},
			});
			let leaked!: Pick<ReadRepository, "read" | "status">;
			let cachedRead!: () => string;

			await uow.run(async ({ repositories }) => {
				leaked = repositories.orders;
				cachedRead = repositories.orders.read;
				expect(leaked.read()).toBe("transactional-read");
				expect(leaked.status).toBe("transactional-read");
			});

			const callsWhileOpen = getterCalls;
			expect(() => leaked.read()).toThrow(TransactionClosedError);
			expect(() => cachedRead()).toThrow(TransactionClosedError);
			expect(() => leaked.status).toThrow(TransactionClosedError);
			expect(getterCalls).toBe(callsWhileOpen);
		});
	});

	describe("nesting + reuse", () => {
		it("run() inside run() on the same instance throws NestedUnitOfWorkError and rolls back the outer work", async () => {
			const { uow } = createUow();
			const agg = createMockAggregate("o-1", [testEvent("o-1")]);

			await expect(
				uow.run(async ({ repositories }) => {
					repositories.orders.add(agg);
					// A nested run would NOT join the outer transaction.
					await uow.run(async () => undefined);
					return undefined;
				}),
			).rejects.toBeInstanceOf(NestedUnitOfWorkError);

			expect(agg.acknowledgementCount).toBe(0);
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
		class OrderAggregate extends AggregateRoot<
			Readonly<Record<string, never>>,
			TestId,
			TestEvent
		> {
			protected readonly aggregateType = "MockOrder";
			private _acknowledgementCount = 0;

			constructor(id: TestId, events: TestEvent[] = []) {
				super(id, {});
				this.setVersion(1 as Version);
				void events;
				observeAcknowledgements(this, () => {
					this._acknowledgementCount += 1;
				});
			}

			public change(event: TestEvent): void {
				this.commit(this.state, event);
			}

			public get acknowledgementCount(): number {
				return this._acknowledgementCount;
			}
		}

		/** Identity-map-aware repository over an in-memory row store. */
		class CachingOrderRepository {
			public hydrations = 0;

			constructor(
				private readonly rows: Map<string, TestEvent[]>,
				private readonly tracking: RepositoryTracking<OrderAggregate>,
			) {}

			get trackedIdentities(): RepositoryTracking<OrderAggregate>["identityMap"] {
				return this.tracking.identityMap;
			}

			async findById(id: TestId): Promise<OrderAggregate | null> {
				const cached = this.tracking.identityMap.get(OrderAggregate, id);
				if (cached) return cached;
				// Deleted in this unit of work = uniformly not-found, even
				// when the physical delete is deferred and the row is still
				// visible inside the transaction.
				if (this.tracking.identityMap.isDeleted(OrderAggregate, id)) {
					return null;
				}

				const row = this.rows.get(id);
				if (!row) return null;
				this.hydrations += 1;
				const order = new OrderAggregate(id, row);
				return this.tracking.trackLoaded(order);
			}
		}

		function createCachingUow(rows: Map<string, TestEvent[]>) {
			const outbox = createMockOutbox();
			const repos: CachingOrderRepository[] = [];
			const uow = new UnitOfWork({
				scope: createMockScope(),
				outbox,
				repositories: {
					orders: defineTestRepository({
						aggregate: OrderAggregate,
						persistence: versionPersistenceModel<OrderAggregate>(),
						physicalRemoval: true,
						flush: async () => {},
						create: (_tx: undefined, tracking) => {
							const repo = new CachingOrderRepository(rows, tracking);
							repos.push(repo);
							return repo;
						},
					}),
				},
			});
			return { uow, outbox, repos };
		}

		it("two findById calls return the SAME instance with one hydration; saving via both refs marks persisted once", async () => {
			const event = testEvent("o-1");
			const rows = new Map([["o-1", [event]]]);
			const { uow, outbox, repos } = createCachingUow(rows);

			await uow.run(async ({ repositories }) => {
				const a = await repositories.orders.findById("o-1" as TestId);
				const b = await repositories.orders.findById("o-1" as TestId);

				expect(a).not.toBeNull();
				expect(b).toBe(a);

				(a as OrderAggregate).change(event);
				repositories.orders.update(a as OrderAggregate);
				repositories.orders.update(b as OrderAggregate);
				return undefined;
			});

			expect(repos[0]?.hydrations).toBe(1);
			// One instance → one harvest, one acknowledgement.
			expect(outbox.added).toEqual([[stamped(event, 2)]]);
		});

		it("tracking.identityMap access after close throws TransactionClosedError", async () => {
			const { uow } = createCachingUow(new Map());
			let repository!: Pick<CachingOrderRepository, "trackedIdentities">;

			await uow.run(async ({ repositories }) => {
				repository = repositories.orders;
				return undefined;
			});

			expect(() => repository.trackedIdentities).toThrow(
				TransactionClosedError,
			);
		});

		it("a directly-leaked IdentityMap reference is cleared on close (no stale instances into a later operation)", async () => {
			const event = testEvent("o-1");
			const rows = new Map([["o-1", [event]]]);
			const { uow } = createCachingUow(rows);
			let leakedMap!: ReturnType<
				() => RepositoryTracking<OrderAggregate>["identityMap"]
			>;

			await uow.run(async ({ repositories }) => {
				await repositories.orders.findById("o-1" as TestId);
				leakedMap = repositories.orders.trackedIdentities; // captured while open
				expect(leakedMap.has(OrderAggregate, "o-1" as TestId)).toBe(true);
				return undefined;
			});

			expect(leakedMap.has(OrderAggregate, "o-1" as TestId)).toBe(false);
		});

		it("after delete, findById reads uniformly as null, even when the physical delete is deferred", async () => {
			const event = testEvent("o-1");
			// The row store deliberately keeps the row: simulates a repo
			// whose physical delete is deferred within the transaction.
			const rows = new Map([["o-1", [event]]]);
			const { uow } = createCachingUow(rows);

			const probe = await uow.run(async ({ repositories }) => {
				const order = await repositories.orders.findById("o-1" as TestId);
				repositories.orders.remove(order as OrderAggregate);

				// Row still visible in the tx; the isDeleted check makes a
				// read-only probe behave like not-found instead of crashing
				// at registration.
				return repositories.orders.findById("o-1" as TestId);
			});

			expect(probe).toBeNull();
		});

		it("deletion is final across INSTANCES: saving a re-created aggregate with the same class+id throws", async () => {
			const rows = new Map([["o-1", [testEvent("o-1")]]]);
			const { uow } = createCachingUow(rows);

			await expect(
				uow.run(async ({ repositories }) => {
					const order = await repositories.orders.findById("o-1" as TestId);
					repositories.orders.remove(order as OrderAggregate);

					// A DIFFERENT instance with the same logical identity, e.g.
					// re-created via a static factory after the delete. The
					// instance-keyed gate cannot see it; the class+id tombstone
					// (recorded automatically by enrollDeleted) must.
					const resurrected = new OrderAggregate("o-1" as TestId);
					repositories.orders.update(resurrected);
					return undefined;
				}),
			).rejects.toBeInstanceOf(AggregateDeletedError);
		});

		it("a deleted aggregate's events are harvested without saved acknowledgement or observation", async () => {
			const event = testEvent("o-1");
			const rows = new Map([["o-1", [event]]]);
			const { uow, outbox } = createCachingUow(rows);
			let deletedOrder!: OrderAggregate;

			await uow.run(async ({ repositories }) => {
				deletedOrder = (await repositories.orders.findById(
					"o-1" as TestId,
				)) as OrderAggregate;
				deletedOrder.change(event);
				repositories.orders.remove(deletedOrder);
				return undefined;
			});

			// Deletion event reached the outbox...
			expect(outbox.added).toEqual([[stamped(event, 2)]]);
			// ...but the saved-aggregate lifecycle did NOT run for the deleted
			// aggregate: no saved acknowledgement or cache-fill observer lie.
			expect(deletedOrder.acknowledgementCount).toBe(0);
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
					repositories.orders.add(agg);
					return undefined;
				})
				.then(
					() => undefined,
					(e: unknown) => e,
				);

			expect(rejection).toBeInstanceOf(CommitError);
			expect((rejection as CommitError).cause).toBe(outboxError);
			expect(agg.acknowledgementCount).toBe(0);
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
			const badEvent = createDomainEvent(
				"OrderCreated",
				{ orderId: "x" },
				{
					aggregateType: "MockOrder",
				},
			) as TestEvent;
			const agg = createMockAggregate("x", [badEvent]);
			const { uow } = createUow();

			const rejection = await uow
				.run(async ({ repositories }) => {
					repositories.orders.add(agg);
					return undefined;
				})
				.then(
					() => undefined,
					(e: unknown) => e,
				);

			expect(rejection).toBeInstanceOf(EventHarvestError);
			expect(rejection).not.toBeInstanceOf(CommitError);
			expect(rejection).not.toBeInstanceOf(InfrastructureError);
			expect(agg.acknowledgementCount).toBe(0);
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
			const badEvent = createDomainEvent(
				"OrderCreated",
				{ orderId: "x" },
				{
					aggregateType: "MockOrder",
				},
			) as TestEvent;
			const agg = createMockAggregate("x", [badEvent]);
			const { uow } = createUow({ scope });

			const rejection = await uow
				.run(async ({ repositories }) => {
					repositories.orders.add(agg);
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
			expect((rejection as RollbackError).rollbackCause).toBe(rollbackFailure);
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
			const original = new ConcurrencyConflictError({
				aggregateType: "Order",
				aggregateId: "o-1",
				expectedVersion: 3,
				actualVersion: 4,
			});
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
			expect((rejection as RollbackError).rollbackCause).toBe(rollbackFailure);
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
			const polyfillSignal = {
				aborted: true,
				reason: undefined,
			} as AbortSignal;

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

		it("a cooperative abort mid-work rolls back: error passes through, no acknowledgement", async () => {
			const outbox = createMockOutbox();
			const { uow } = createUow({ outbox });
			const agg = createMockAggregate("order-1", [testEvent("order-1")]);
			const ac = new AbortController();

			await expect(
				uow.run(
					async (ctx) => {
						ctx.repositories.orders.add(agg);
						ac.abort(new Error("deadline exceeded"));
						if (ctx.signal?.aborted) throw ctx.signal.reason;
						return "unreachable";
					},
					{ signal: ac.signal },
				),
			).rejects.toThrow("deadline exceeded");

			expect(agg.acknowledgementCount).toBe(0);
			expect(outbox.added).toHaveLength(0);
		});

		it("runs normally when no signal is supplied (backwards compatible)", async () => {
			const { uow } = createUow();
			const result = await uow.run(async () => "ok");
			expect(result).toBe("ok");
		});
	});

	describe("enrollment guard: events recorded after load but never enrolled", () => {
		/** A loadable state-stored aggregate with a test-only event recorder. */
		function loadable(id: string, initialEvents: TestEvent[] = []) {
			class LoadableAggregate extends AggregateRoot<
				Readonly<Record<string, never>>,
				TestId,
				TestEvent
			> {
				protected readonly aggregateType = "MockOrder";

				constructor() {
					super(id as TestId, {});
					this.setVersion(1 as Version);
					for (const event of initialEvents) this.addDomainEvent(event);
				}

				public record(event: TestEvent): void {
					this.commit(this.state, event);
				}
			}

			return new LoadableAggregate();
		}

		function createLoadableUow(aggregate: ReturnType<typeof loadable>) {
			type Loadable = ReturnType<typeof loadable>;
			return new UnitOfWork({
				scope: createMockScope(),
				outbox: createMockOutbox(),
				repositories: {
					orders: defineTestRepository({
						aggregate: aggregate.constructor as AggregateClass<Loadable>,
						persistence: versionPersistenceModel<Loadable>(),
						physicalRemoval: true,
						flush: async () => {},
						create: (_tx: undefined, tracking) => ({
							trackLoaded: (loaded: Loadable) => tracking.trackLoaded(loaded),
						}),
					}),
				},
			});
		}

		it("throws UnenrolledChangesError when events are recorded after load and never enrolled", async () => {
			const agg = loadable("o-1"); // loaded clean
			const uow = createLoadableUow(agg);

			const rejection = await uow
				.run(async ({ repositories }) => {
					repositories.orders.trackLoaded(agg); // findById
					agg.record(testEvent("o-1")); // a domain method records an event
					// ...but repository.update is never called
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
			const uow = createLoadableUow(agg);

			const result = await uow.run(async ({ repositories }) => {
				repositories.orders.trackLoaded(agg);
				agg.record(testEvent("o-1"));
				repositories.orders.update(agg);
				return "ok";
			});

			expect(result).toBe("ok");
		});

		it("does not throw on a read-only load (no events recorded)", async () => {
			const agg = loadable("o-1");
			const uow = createLoadableUow(agg);

			const result = await uow.run(async ({ repositories }) => {
				repositories.orders.trackLoaded(agg);
				return "read-only";
			});

			expect(result).toBe("read-only");
		});

		it("does not false-positive on a dirty reconstitution that already carried events but gained none", async () => {
			// Reconstituted with events already in pendingEvents; the use case
			// only reads it. No NEW events after load, so no enrollment is owed.
			const agg = loadable("o-1", [testEvent("o-1")]);
			const uow = createLoadableUow(agg);

			const result = await uow.run(async ({ repositories }) => {
				repositories.orders.trackLoaded(agg);
				return "read-only-dirty";
			});

			expect(result).toBe("read-only-dirty");
		});

		it("does not throw when the mutated aggregate was deleted", async () => {
			const agg = loadable("o-1");
			const uow = createLoadableUow(agg);

			const result = await uow.run(async ({ repositories }) => {
				repositories.orders.trackLoaded(agg);
				agg.record(testEvent("o-1"));
				repositories.orders.remove(agg);
				return "deleted";
			});

			expect(result).toBe("deleted");
		});
	});
});
