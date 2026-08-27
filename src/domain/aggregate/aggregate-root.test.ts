import { describe, expect, it, vi } from "vite-plus/test";
import {
	InvalidVersionError,
	MisaddressedEventError,
	MissingEntityIdError,
	PendingEventBatchMismatchError,
	UnmintedEventError,
	UnreplayableAggregateError,
} from "../../errors/kit-errors";
import {
	type AnyDomainEvent,
	createDomainEvent,
	type DomainEvent,
	type PendingDomainEvent,
} from "../event/domain-event";
import type { Id } from "../identity/id";
import type { Version } from "./aggregate";
import {
	type AggregateConfig,
	AggregateRoot as ProductionAggregateRoot,
} from "./aggregate-root";
import { pendingEventLifecycleCapabilityFor } from "./pending-event-lifecycle";
import { pendingEventRecordingCapabilityFor } from "./pending-event-recording";

function lifecycleOf(aggregate: object) {
	const capability = pendingEventLifecycleCapabilityFor(aggregate);
	if (!capability) throw new Error("Missing test persistence capability");
	return capability;
}

function acknowledgePersisted(aggregate: object, version: Version): void {
	lifecycleOf(aggregate).acknowledge(
		(aggregate as { pendingEvents: ReadonlyArray<AnyDomainEvent> })
			.pendingEvents,
		version,
	);
}

function discardPendingEvents(aggregate: object): void {
	lifecycleOf(aggregate).discardPendingEvents(
		(aggregate as { pendingEvents: ReadonlyArray<AnyDomainEvent> })
			.pendingEvents,
	);
}

describe("version guards", () => {
	type Noted = DomainEvent<"Noted", { value: number }>;

	class RestorableAggregate extends AggregateRoot<TestState, TestId, Noted> {
		protected readonly aggregateType = "RestorableAggregate";

		constructor(id: TestId, initialState: TestState) {
			super(id, initialState);
		}

		note(value: number): void {
			this.addDomainEvent(
				createDomainEvent(
					"Noted",
					{ value },
					{ aggregateId: this.id, aggregateType: this.aggregateType },
				),
			);
		}

		restore(version: number): void {
			this.markRestored(version as Version);
		}

		force(version: number): void {
			this.setVersion(version as Version);
		}

		advance(): void {
			this.bumpVersion();
		}
	}

	const fresh = (): RestorableAggregate =>
		new RestorableAggregate("test-1" as TestId, {
			value: 10,
			status: "inactive",
		});

	it.each([
		["NaN", Number.NaN],
		["a negative number", -1],
		["a fraction", 1.5],
	])("rejects %s on markRestored and keeps the version", (_label, value) => {
		const aggregate = fresh();

		expect(() => aggregate.restore(value)).toThrow(InvalidVersionError);

		expect(aggregate.version).toBe(0);
		expect(lifecycleOf(aggregate).persistedVersion()).toBeUndefined();
	});

	it("rejects a version below the current one on markRestored", () => {
		const aggregate = fresh();
		aggregate.advance();
		aggregate.advance();

		expect(() => aggregate.restore(1)).toThrow(InvalidVersionError);

		expect(aggregate.version).toBe(2);
	});

	it("restores a row persisted at version zero onto a fresh instance", () => {
		const aggregate = fresh();

		aggregate.restore(0);

		expect(aggregate.version).toBe(0);
		expect(lifecycleOf(aggregate).persistedVersion()).toBe(0);
	});

	it("accepts a restore at the current version", () => {
		const aggregate = fresh();
		aggregate.restore(5);

		aggregate.restore(5);

		expect(aggregate.version).toBe(5);
		expect(lifecycleOf(aggregate).persistedVersion()).toBe(5);
	});

	it("rejects markRestored while decisions are pending", () => {
		const aggregate = fresh();
		aggregate.note(1);

		expect(() => aggregate.restore(5)).toThrow(UnreplayableAggregateError);

		expect(aggregate.version).toBe(0);
		expect(aggregate.pendingEvents).toHaveLength(1);
	});

	it("records a valid restore as the persisted version", () => {
		const aggregate = fresh();

		aggregate.restore(5);

		expect(aggregate.version).toBe(5);
		expect(lifecycleOf(aggregate).persistedVersion()).toBe(5);
	});

	it("rejects an invalid version on setVersion", () => {
		const aggregate = fresh();

		expect(() => aggregate.force(Number.NaN)).toThrow(InvalidVersionError);

		expect(aggregate.version).toBe(0);
	});

	it("rejects an invalid committed version on acknowledge", () => {
		const aggregate = fresh();
		aggregate.advance();
		aggregate.note(1);

		expect(() =>
			lifecycleOf(aggregate).acknowledge(
				aggregate.pendingEvents,
				Number.NaN as Version,
			),
		).toThrow(InvalidVersionError);

		expect(aggregate.pendingEvents).toHaveLength(1);
		expect(lifecycleOf(aggregate).persistedVersion()).toBeUndefined();
	});

	it("records the committed version as persisted on acknowledge", () => {
		const aggregate = fresh();
		aggregate.advance();
		aggregate.note(1);

		lifecycleOf(aggregate).acknowledge(aggregate.pendingEvents, 1 as Version);

		expect(aggregate.pendingEvents).toHaveLength(0);
		expect(lifecycleOf(aggregate).persistedVersion()).toBe(1);
	});
});

/** White-box fixture only: production aggregate subclasses keep `state` protected. */
abstract class AggregateRoot<
	TState,
	TId extends Id<string>,
	TEvent extends AnyDomainEvent = never,
> extends ProductionAggregateRoot<TState, TId, TEvent> {
	public override get state(): TState {
		return super.state;
	}
}

type TestId = Id<"TestId">;

type TestState = {
	value: number;
	status: "active" | "inactive";
};

class TestAggregate extends AggregateRoot<TestState, TestId> {
	protected readonly aggregateType = "TestAggregate";
	constructor(
		id: TestId,
		initialState: TestState,
		config?: AggregateConfig<TestState>,
	) {
		super(id, initialState, config);
	}

	static create(id: TestId, value: number): TestAggregate {
		const initialState: TestState = {
			value,
			status: "inactive",
		};
		return new TestAggregate(id, initialState);
	}

	updateValue(newValue: number): void {
		this.setState({ ...this.state, value: newValue });
	}

	activate(): void {
		this.setState({ ...this.state, status: "active" });
	}

	deactivate(): void {
		this.setState({ ...this.state, status: "inactive" });
	}

	updateWithSetState(newValue: number): void {
		this.setState({ ...this.state, value: newValue });
	}
}

describe("setState OCC contract (named methods, no flag argument)", () => {
	class NamedMethodsAggregate extends AggregateRoot<TestState, TestId> {
		protected readonly aggregateType = "NamedMethodsAggregate";
		constructor(
			id: TestId,
			initialState: TestState,
			config?: AggregateConfig<TestState>,
		) {
			super(id, initialState, config);
		}

		rename(value: number): void {
			this.setState({ ...this.state, value });
		}

		cacheCosmetic(value: number): void {
			this.setStateWithoutVersionBump({ ...this.state, value });
		}
	}

	const fresh = () =>
		new NamedMethodsAggregate("agg-1" as TestId, {
			value: 1,
			status: "inactive",
		});

	it("setState(next) advances the OCC version (the safe default)", () => {
		const aggregate = fresh();

		aggregate.rename(2);

		expect(aggregate.state.value).toBe(2);
		expect(aggregate.version).toBe(1);
	});

	it("setStateWithoutVersionBump(next) mutates and marks dirty but keeps the version", () => {
		const aggregate = fresh();
		acknowledgePersisted(aggregate, 0 as Version);

		aggregate.cacheCosmetic(7);

		expect(aggregate.state.value).toBe(7);
		expect(aggregate.version).toBe(0);
	});

	it("setStateWithoutVersionBump still validates the new state", () => {
		class Validated extends NamedMethodsAggregate {
			constructor(id: TestId, initialState: TestState) {
				super(id, initialState, {
					validateState: (state) => {
						if (state.value < 0) throw new Error("value must not be negative");
					},
				});
			}
			breakIt(): void {
				this.setStateWithoutVersionBump({ ...this.state, value: -1 });
			}
		}
		const aggregate = new Validated("agg-1" as TestId, {
			value: 1,
			status: "inactive",
		});

		expect(() => aggregate.breakIt()).toThrow("must not be negative");
		expect(aggregate.state.value).toBe(1);
	});

	it("a polymorphic Entity-typed call gets the safe bumping default", () => {
		// Before the redesign this path threw a TypeError; with the flag
		// gone, the same signature as Entity.setState means the safe
		// (bumping) behavior applies instead of a runtime guard.
		const aggregate = fresh();
		(
			aggregate as unknown as {
				setState(newState: TestState): void;
			}
		).setState({ value: 99, status: "active" });

		expect(aggregate.state.value).toBe(99);
		expect(aggregate.version).toBe(1);
	});
});

describe("AggregateRoot (without Event Sourcing)", () => {
	describe("Basic functionality", () => {
		it("should create aggregate with id and initial state", () => {
			const aggregate = TestAggregate.create("test-1" as TestId, 10);

			expect(aggregate.id).toBe("test-1");
			expect(aggregate.state.value).toBe(10);
			expect(aggregate.state.status).toBe("inactive");
			expect(aggregate.version).toBe(0);
		});

		it("should allow direct state mutation", () => {
			const aggregate = TestAggregate.create("test-1" as TestId, 10);

			aggregate.updateValue(20);

			expect(aggregate.state.value).toBe(20);
			expect(aggregate.version).toBe(1);
		});

		it("should support setState helper method", () => {
			const aggregate = TestAggregate.create("test-1" as TestId, 10);

			aggregate.updateWithSetState(30);

			expect(aggregate.state.value).toBe(30);
		});
	});

	describe("Version management", () => {
		it("version should not be externally assignable", () => {
			const aggregate = TestAggregate.create("test-1" as TestId, 10);

			// Version should be readable
			expect(aggregate.version).toBe(0);

			// After domain operation, version should increase
			aggregate.updateValue(20);
			expect(aggregate.version).toBe(1);

			// Direct assignment should not be possible at runtime
			// (TypeScript readonly prevents compile-time, but we verify runtime encapsulation)
			expect(() => {
				(aggregate as any).version = 99;
			}).toThrow();
		});

		it("advances the version by one per state change", () => {
			const aggregate = TestAggregate.create("test-1" as TestId, 10);

			expect(aggregate.version).toBe(0);

			aggregate.updateValue(20);
			expect(aggregate.version).toBe(1);

			aggregate.activate();
			expect(aggregate.version).toBe(2);
		});

		it("states the OCC intent in the method name: bump by default, loud opt-out", () => {
			class ExplicitAggregate extends AggregateRoot<TestState, TestId> {
				protected readonly aggregateType = "ExplicitAggregate";
				constructor(id: TestId, initialState: TestState) {
					super(id, initialState);
				}

				public updateValue(newValue: number): void {
					this.setState({ ...this.state, value: newValue });
				}

				public updateCosmetic(newValue: number): void {
					// Explicit opt-OUT: acceptable only for data whose loss under
					// a concurrent write is acceptable.
					this.setStateWithoutVersionBump({ ...this.state, value: newValue });
				}
			}

			const aggregate = new ExplicitAggregate("test-1" as TestId, {
				value: 10,
				status: "inactive",
			});

			aggregate.updateValue(20);
			expect(aggregate.version).toBe(1);

			aggregate.updateCosmetic(30);
			expect(aggregate.version).toBe(1); // explicit no-bump, no silent default
			expect(aggregate.state.value).toBe(30);
		});

		it("manual bumpVersion stays available for subclass orchestration", () => {
			class ManualVersionAggregate extends AggregateRoot<TestState, TestId> {
				protected readonly aggregateType = "ManualVersionAggregate";
				constructor(id: TestId, initialState: TestState) {
					super(id, initialState);
				}

				public testBumpVersion(): void {
					this.bumpVersion();
				}

				public updateValue(newValue: number): void {
					this.setStateWithoutVersionBump({ ...this.state, value: newValue });
				}
			}

			const initialState: TestState = { value: 10, status: "inactive" };
			const aggregate = new ManualVersionAggregate(
				"test-1" as TestId,
				initialState,
			);

			aggregate.updateValue(20);
			expect(aggregate.version).toBe(0); // explicit no-bump

			aggregate.testBumpVersion();
			expect(aggregate.version).toBe(1); // Manual bump
		});
	});

	describe("State immutability", () => {
		it("should expose state as readonly", () => {
			const aggregate = TestAggregate.create("test-1" as TestId, 10);

			const state = aggregate.state;
			// TypeScript should prevent: state.value = 999;
			expect(state.value).toBe(10);
		});

		it("replaces the state through a domain method", () => {
			const aggregate = TestAggregate.create("test-1" as TestId, 10);

			aggregate.updateValue(20);

			expect(aggregate.state.value).toBe(20);
		});

		it("does not leak the internal state reference through the getter", () => {
			const aggregate = TestAggregate.create("test-1" as TestId, 10);
			const leaked = aggregate.state as { value: number };

			expect(() => {
				leaked.value = 999;
			}).toThrow();

			expect(aggregate.state.value).toBe(10);
		});
	});

	describe("opt-in deep freeze (deepFreezeState config)", () => {
		type NestedState = {
			status: string;
			items: Array<{ sku: string; qty: number }>;
		};

		class DeepFrozenAggregate extends AggregateRoot<NestedState, TestId> {
			protected readonly aggregateType = "DeepFrozenAggregate";

			constructor(id: TestId, initialState: NestedState) {
				super(id, initialState, { deepFreezeState: true });
			}

			static reconstitute(
				id: TestId,
				state: NestedState,
				version: Version,
			): DeepFrozenAggregate {
				const aggregate = new DeepFrozenAggregate(id, state);
				aggregate.markRestored(version);
				return aggregate;
			}

			addItem(sku: string, qty: number): void {
				this.setState({
					...this.state,
					items: [...this.state.items, { sku, qty }],
				});
			}
		}

		it("freezes nested state so external nested mutation throws instead of bypassing invariants", () => {
			const aggregate = new DeepFrozenAggregate("test-1" as TestId, {
				status: "open",
				items: [{ sku: "a", qty: 1 }],
			});

			// Without the opt-in this push would silently mutate aggregate
			// internals, bypass validateState, the version bump AND the
			// adapter projection and Unit-of-Work mutation guards.
			expect(() => {
				(aggregate.state.items as Array<unknown>).push({
					sku: "hacked",
					qty: 9,
				});
			}).toThrow();
			expect(aggregate.state.items).toHaveLength(1);

			const first = aggregate.state.items[0];
			expect(Object.isFrozen(first)).toBe(true);
		});

		it("keeps the deep freeze across setState mutations", () => {
			const aggregate = new DeepFrozenAggregate("test-1" as TestId, {
				status: "open",
				items: [],
			});

			aggregate.addItem("a", 1);

			expect(aggregate.state.items).toHaveLength(1);
			expect(Object.isFrozen(aggregate.state.items)).toBe(true);
			expect(Object.isFrozen(aggregate.state.items[0])).toBe(true);
			expect(aggregate.version).toBe(1);
		});
	});

	describe("commit(): record-after-mutation helper", () => {
		type Ev = DomainEvent<"Updated", { value: number }>;

		class CommitAggregate extends AggregateRoot<TestState, TestId, Ev> {
			protected readonly aggregateType = "CommitAggregate";

			constructor(id: TestId, state: TestState) {
				super(id, state);
			}
			update(value: number, ev: Ev | readonly Ev[] = []): void {
				this.commit({ ...this.state, value }, ev);
			}
			recordOnly(ev: Ev): void {
				// Forces "record before mutation", which would only be possible by
				// calling addDomainEvent directly. commit() never does this.
				this.addDomainEvent(ev);
			}
			recordTestEvent(value: number): Ev {
				return createDomainEvent(
					"Updated",
					{ value },
					{
						aggregateId: this.id,
						aggregateType: this.aggregateType,
					},
				);
			}
		}

		class FailingValidator extends AggregateRoot<TestState, TestId, Ev> {
			protected readonly aggregateType = "FailingValidator";

			constructor(id: TestId, state: TestState) {
				super(id, state, {
					validateState: (candidate) => {
						if (candidate.value < 0) throw new Error("negative");
					},
				});
			}
			tryCommit(value: number, ev: Ev): void {
				this.commit({ ...this.state, value }, ev);
			}
			recordTestEvent(value: number): Ev {
				return createDomainEvent(
					"Updated",
					{ value },
					{
						aggregateId: this.id,
						aggregateType: this.aggregateType,
					},
				);
			}
		}

		it("rejects a hand-rolled mutable event BEFORE the state moves", () => {
			// The immutability gate runs over the event list before
			// setState: a rejected event must not leave a mutated aggregate
			// without its recorded fact.
			const agg = new CommitAggregate("test-1" as TestId, {
				value: 10,
				status: "inactive",
			});
			const minted = agg.recordTestEvent(42);
			const literal = { ...minted, payload: { value: 42 } } as Ev;

			expect(() => agg.update(42, literal)).toThrow(UnmintedEventError);
			expect(agg.state.value).toBe(10);
			expect(agg.version).toBe(0);
			expect(agg.pendingEvents).toHaveLength(0);
		});

		it("mutates state, then records the event, in that order", () => {
			const agg = new CommitAggregate("test-1" as TestId, {
				value: 10,
				status: "inactive",
			});
			agg.update(42, agg.recordTestEvent(42));

			expect(agg.state.value).toBe(42);
			expect(agg.pendingEvents).toHaveLength(1);
			expect(agg.pendingEvents[0]?.type).toBe("Updated");
			expect(agg.pendingEvents[0]?.payload).toEqual({ value: 42 });
		});

		it("does NOT record the event when state validation throws", () => {
			const agg = new FailingValidator("test-1" as TestId, {
				value: 10,
				status: "inactive",
			});

			expect(() => agg.tryCommit(-1, agg.recordTestEvent(-1))).toThrow(
				"negative",
			);

			// State unchanged AND no event queued: the validateState-throws-
			// before-addDomainEvent path is enforced by commit().
			expect(agg.state.value).toBe(10);
			expect(agg.pendingEvents).toHaveLength(0);
		});

		it("accepts multiple events and records them in order", () => {
			const agg = new CommitAggregate("test-1" as TestId, {
				value: 10,
				status: "inactive",
			});
			agg.update(99, [agg.recordTestEvent(99), agg.recordTestEvent(100)]);

			expect(agg.state.value).toBe(99);
			expect(agg.pendingEvents.map((e) => e.payload.value)).toEqual([99, 100]);
		});

		it("accepts no events (state change only)", () => {
			const agg = new CommitAggregate("test-1" as TestId, {
				value: 10,
				status: "inactive",
			});
			agg.update(7);

			expect(agg.state.value).toBe(7);
			expect(agg.pendingEvents).toHaveLength(0);
		});

		it("always bumps the version (commit is never a no-bump mutation)", () => {
			// commit() couples state + event recording; recording an event
			// implies "this is a version-worthy change", so the bump is
			// unconditional by design.
			const agg = new CommitAggregate("test-1" as TestId, {
				value: 10,
				status: "inactive",
			});
			expect(agg.version).toBe(0);

			agg.update(11, agg.recordTestEvent(11));

			expect(agg.version).toBe(1);
		});

		it("bumps the version exactly once even when committing multiple events", () => {
			const agg = new CommitAggregate("test-1" as TestId, {
				value: 10,
				status: "inactive",
			});
			expect(agg.version).toBe(0);

			agg.update(11, [agg.recordTestEvent(11), agg.recordTestEvent(12)]);

			// One state transition = one version bump, regardless of how
			// many events accompany it.
			expect(agg.version).toBe(1);
		});
	});

	describe("createEvent", () => {
		type Recorded = DomainEvent<"Recorded", { v: number }>;

		class DecidingAggregate extends AggregateRoot<TestState, TestId, Recorded> {
			protected readonly aggregateType = "DecidingAggregate";

			// biome-ignore lint/complexity/noUselessConstructor: the protected base constructor must be exposed to this test
			constructor(id: TestId, initialState: TestState) {
				super(id, initialState);
			}

			decide(v: number): PendingDomainEvent<Recorded> {
				return this.createEvent("Recorded", { v });
			}
		}

		it("stamps the aggregate address and leaves identity and time to the shell", () => {
			const agg = new DecidingAggregate("r-1" as TestId, {
				value: 0,
				status: "inactive",
			});

			const event = agg.decide(42);

			expect(event.aggregateId).toBe("r-1");
			expect(event.aggregateType).toBe("DecidingAggregate");
			expect(event.type).toBe("Recorded");
			expect(event.payload).toEqual({ v: 42 });
			expect(event).not.toHaveProperty("eventId");
			expect(event).not.toHaveProperty("occurredAt");
		});
	});

	describe("kit-internal persistence acknowledgement", () => {
		type TestRecorded = DomainEvent<"TestRecorded", { value: number }>;

		class EventingAggregate extends AggregateRoot<
			TestState,
			TestId,
			TestRecorded
		> {
			protected readonly aggregateType = "EventingAggregate";
			constructor(id: TestId, state: TestState) {
				super(id, state);
			}
			addTestEvent(value: number): void {
				this.addDomainEvent(
					createDomainEvent(
						"TestRecorded",
						{ value },
						{
							aggregateId: this.id,
							aggregateType: this.aggregateType,
						},
					),
				);
			}
		}

		it("clears the exact recorded batch without rewriting the domain version", () => {
			const aggregate = new EventingAggregate("test-1" as TestId, {
				value: 10,
				status: "inactive",
			});
			aggregate.addTestEvent(1);
			aggregate.addTestEvent(2);

			expect(aggregate.pendingEvents.length).toBe(2);

			acknowledgePersisted(aggregate, 42 as Version);

			expect(aggregate.version).toBe(0);
			expect(aggregate.pendingEvents).toHaveLength(0);
		});

		it("can be invoked on a fresh aggregate without events", () => {
			const aggregate = TestAggregate.create("test-1" as TestId, 10);
			acknowledgePersisted(aggregate, 7 as Version);
			expect(aggregate.version).toBe(0);
			expect(aggregate.pendingEvents).toHaveLength(0);
		});

		it("rejects an acknowledged batch in a different order than the pending prefix", () => {
			const aggregate = new EventingAggregate("test-1" as TestId, {
				value: 10,
				status: "inactive",
			});
			aggregate.addTestEvent(1);
			aggregate.addTestEvent(2);
			const reversed = [...aggregate.pendingEvents].reverse();

			expect(() =>
				lifecycleOf(aggregate).acknowledge(reversed, 1 as Version),
			).toThrow(PendingEventBatchMismatchError);

			expect(aggregate.pendingEvents).toHaveLength(2);
		});

		it("rejects an acknowledged batch longer than the pending list", () => {
			const aggregate = new EventingAggregate("test-1" as TestId, {
				value: 10,
				status: "inactive",
			});
			aggregate.addTestEvent(1);
			const pending = aggregate.pendingEvents;

			let caught: unknown;
			try {
				lifecycleOf(aggregate).acknowledge(
					[...pending, ...pending],
					1 as Version,
				);
			} catch (error) {
				caught = error;
			}

			expect(caught).toBeInstanceOf(PendingEventBatchMismatchError);
			const mismatch = caught as PendingEventBatchMismatchError;
			expect(mismatch.code).toBe("PENDING_EVENT_BATCH_MISMATCH");
			expect(mismatch.aggregateId).toBe("test-1");
			expect(mismatch.batchLength).toBe(2);
			expect(mismatch.pendingLength).toBe(1);
			expect(aggregate.pendingEvents).toHaveLength(1);
		});

		it("rejects a discarded batch that carries a foreign event", () => {
			const aggregate = new EventingAggregate("test-1" as TestId, {
				value: 10,
				status: "inactive",
			});
			aggregate.addTestEvent(1);
			const foreign = createDomainEvent("TestRecorded", { value: 99 });

			expect(() =>
				lifecycleOf(aggregate).discardPendingEvents([foreign]),
			).toThrow(PendingEventBatchMismatchError);

			expect(aggregate.pendingEvents).toHaveLength(1);
		});

		it("acknowledges a strict prefix and keeps the newer events pending", () => {
			const aggregate = new EventingAggregate("test-1" as TestId, {
				value: 10,
				status: "inactive",
			});
			aggregate.addTestEvent(1);
			const enrolled = aggregate.pendingEvents;
			aggregate.addTestEvent(2);

			lifecycleOf(aggregate).acknowledge(enrolled, 1 as Version);

			expect(aggregate.pendingEvents).toHaveLength(1);
			expect(aggregate.pendingEvents[0]?.payload.value).toBe(2);
			expect(lifecycleOf(aggregate).persistedVersion()).toBe(1);
		});

		it("resolves the lifecycle capability from a second copy of the module", async () => {
			const aggregate = TestAggregate.create("test-1" as TestId, 10);

			// A duplicate package installation re-evaluates the module; its
			// copy must find the capability this copy registered.
			vi.resetModules();
			const foreignModule = await import("./pending-event-lifecycle");
			expect(
				foreignModule.pendingEventLifecycleCapabilityFor(aggregate),
			).toBeDefined();
		});
	});

	describe("pendingEvents getter encapsulation", () => {
		it("does not leak the internal pendingEvents array", () => {
			const aggregate = TestAggregate.create("test-1" as TestId, 10);
			const eventsBefore = aggregate.pendingEvents.length;

			// Cast-around the ReadonlyArray contract and try to push directly
			const leaked = aggregate.pendingEvents as unknown as unknown[];
			expect(() => leaked.push({ fake: "event" })).toThrow();

			expect(aggregate.pendingEvents.length).toBe(eventsBefore);
		});
	});

	describe("Enhancements", () => {
		it("rejects a null or undefined id with a coded wiring error", () => {
			const state = { value: 10, status: "inactive" as const };
			// @ts-expect-error - testing invalid input
			expect(() => new TestAggregate(null, state)).toThrow(
				MissingEntityIdError,
			);
			// @ts-expect-error - testing invalid input
			expect(() => new TestAggregate(undefined, state)).toThrow(
				MissingEntityIdError,
			);
		});

		it("should validate state changes", () => {
			class ValidatedAggregate extends AggregateRoot<TestState, TestId> {
				protected readonly aggregateType = "ValidatedAggregate";
				constructor(id: TestId, initialState: TestState) {
					super(id, initialState, {
						validateState: (state) => {
							if (state.value < 0) {
								throw new Error("Value cannot be negative");
							}
						},
					});
				}
				public update(value: number) {
					this.setState({ ...this.state, value });
				}
			}

			const agg = new ValidatedAggregate("id-1" as TestId, {
				value: 10,
				status: "inactive",
			});

			expect(() => agg.update(-5)).toThrow("Value cannot be negative");
		});

		it("should manage domain events", () => {
			type EvT = DomainEvent<"SomethingHappened", void>;
			class EventAggregate extends AggregateRoot<TestState, TestId, EvT> {
				protected readonly aggregateType = "EventAggregate";
				constructor(id: TestId, initialState: TestState) {
					super(id, initialState);
				}
				public doSomething() {
					this.addDomainEvent(
						createDomainEvent("SomethingHappened", undefined, {
							aggregateId: this.id,
							aggregateType: this.aggregateType,
						}),
					);
				}
			}

			const agg = new EventAggregate("id-1" as TestId, {
				value: 10,
				status: "inactive",
			});

			expect(agg.pendingEvents).toHaveLength(0);
			agg.doSomething();
			expect(agg.pendingEvents).toHaveLength(1);
			expect(agg.pendingEvents[0]?.type).toBe("SomethingHappened");

			discardPendingEvents(agg);
			expect(agg.pendingEvents).toHaveLength(0);
		});

		it("should support typed domain events via TEvent parameter", () => {
			type TestEvent =
				| DomainEvent<"ValueUpdated", { newValue: number }>
				| DomainEvent<"Activated", void>;

			class TypedEventAggregate extends AggregateRoot<
				TestState,
				TestId,
				TestEvent
			> {
				protected readonly aggregateType = "TypedEventAggregate";
				constructor(id: TestId, initialState: TestState) {
					super(id, initialState);
				}
				public updateValue(newValue: number) {
					this.setState({ ...this.state, value: newValue });
					this.addDomainEvent(
						createDomainEvent(
							"ValueUpdated",
							{ newValue },
							{
								aggregateId: this.id,
								aggregateType: this.aggregateType,
							},
						),
					);
				}
				public activate() {
					this.setState({ ...this.state, status: "active" });
					this.addDomainEvent(
						createDomainEvent("Activated", undefined, {
							aggregateId: this.id,
							aggregateType: this.aggregateType,
						}),
					);
				}
			}

			const agg = new TypedEventAggregate("id-1" as TestId, {
				value: 10,
				status: "inactive",
			});

			agg.updateValue(42);
			agg.activate();

			expect(agg.pendingEvents).toHaveLength(2);
			expect(agg.pendingEvents[0]?.type).toBe("ValueUpdated");
			expect(
				(agg.pendingEvents[0] as Extract<TestEvent, { type: "ValueUpdated" }>)
					.payload,
			).toEqual({ newValue: 42 });
			expect(agg.pendingEvents[1]?.type).toBe("Activated");

			// pendingEvents is typed: access event-specific fields without cast
			expect(agg.pendingEvents[0]?.type).toBe("ValueUpdated");
		});

		it("should reject wrong event types at compile time with TEvent", () => {
			type StrictEvent = DomainEvent<"OnlyThis", { data: string }>;

			class StrictAggregate extends AggregateRoot<
				TestState,
				TestId,
				StrictEvent
			> {
				protected readonly aggregateType = "StrictAggregate";
				constructor(id: TestId, initialState: TestState) {
					super(id, initialState);
				}
				public doCorrect() {
					this.addDomainEvent(
						createDomainEvent(
							"OnlyThis",
							{ data: "hello" },
							{
								aggregateId: this.id,
								aggregateType: this.aggregateType,
							},
						),
					);
				}
				public doWrong() {
					// @ts-expect-error - wrong event type is rejected by TEvent constraint
					this.createEvent("WrongEvent", undefined);
				}
			}

			const agg = new StrictAggregate("id-1" as TestId, {
				value: 1,
				status: "inactive",
			});
			agg.doCorrect();
			expect(agg.pendingEvents).toHaveLength(1);
			expect(agg.pendingEvents[0]?.type).toBe("OnlyThis");
			expect(agg.pendingEvents[0]?.payload).toEqual({ data: "hello" });
		});
	});
});

describe("createEvent options and pending-event bookkeeping", () => {
	type Noted = DomainEvent<"Noted", { value: number }>;

	class BookkeepingAggregate extends AggregateRoot<TestState, TestId, Noted> {
		protected readonly aggregateType = "BookkeepingAggregate";

		// biome-ignore lint/complexity/noUselessConstructor: the protected base constructor must be exposed to this test
		constructor(id: TestId, initialState: TestState) {
			super(id, initialState);
		}

		decide(value: number, schemaVersion?: number): void {
			this.commit(
				{ ...this.state, value },
				this.createEvent(
					"Noted",
					{ value },
					schemaVersion === undefined ? undefined : { version: schemaVersion },
				),
			);
		}

		appendRaw(event: unknown): void {
			this.addDomainEvent(event as PendingDomainEvent<Noted>);
		}

		appendBypassingStamp(event: unknown): void {
			this.appendStampedEvent(event as PendingDomainEvent<Noted>);
		}
	}

	const fresh = (): BookkeepingAggregate =>
		new BookkeepingAggregate("test-1" as TestId, {
			value: 0,
			status: "inactive",
		});

	it("passes the payload schema version through createEvent", () => {
		const aggregate = fresh();

		aggregate.decide(1);
		aggregate.decide(2, 3);

		expect(aggregate.pendingEvents[0]?.version).toBe(1);
		expect(aggregate.pendingEvents[1]?.version).toBe(3);
	});

	it("rejects a hand-rolled event on addDomainEvent", () => {
		const aggregate = fresh();

		expect(() =>
			aggregate.appendRaw({ type: "Noted", payload: { value: 1 }, version: 1 }),
		).toThrow(UnmintedEventError);

		expect(aggregate.pendingEvents).toHaveLength(0);
	});

	it("rejects a pending event that bypassed stamping when recording", () => {
		const aggregate = fresh();
		const recording = pendingEventRecordingCapabilityFor(aggregate);
		if (!recording) throw new Error("Missing test recording capability");
		aggregate.appendBypassingStamp({
			type: "Noted",
			payload: { value: 1 },
			version: 1,
		});

		expect(() =>
			recording.record((_event, index) => ({
				eventId: `event-${index}`,
				occurredAt: new Date("2027-04-05T06:07:08.000Z"),
			})),
		).toThrow(UnmintedEventError);
	});

	it("reports the pending count across add, record, and acknowledge", () => {
		const aggregate = fresh();
		const lifecycle = lifecycleOf(aggregate);
		const recording = pendingEventRecordingCapabilityFor(aggregate);
		if (!recording) throw new Error("Missing test recording capability");

		aggregate.decide(1);
		aggregate.decide(2);
		expect(lifecycle.pendingEventCount()).toBe(2);

		recording.record((_event, index) => ({
			eventId: `event-${index}`,
			occurredAt: new Date("2027-04-05T06:07:08.000Z"),
		}));
		expect(lifecycle.pendingEventCount()).toBe(2);

		lifecycle.acknowledge(aggregate.pendingEvents.slice(0, 1), 2 as Version);
		expect(lifecycle.pendingEventCount()).toBe(1);
	});
});

describe("event address on the state-stored path", () => {
	type Noted = DomainEvent<"Noted", { value: number }>;

	class AddressedAggregate extends AggregateRoot<TestState, TestId, Noted> {
		protected readonly aggregateType = "AddressedAggregate";

		constructor(id: TestId, initialState: TestState) {
			super(id, initialState);
		}

		commitWith(event: PendingDomainEvent<Noted>): void {
			this.commit({ ...this.state, value: this.state.value + 1 }, event);
		}

		record(event: PendingDomainEvent<Noted>): void {
			this.addDomainEvent(event);
		}

		decide(value: number): void {
			this.commit(
				{ ...this.state, value },
				this.createEvent("Noted", { value }),
			);
		}
	}

	const fresh = (): AddressedAggregate =>
		new AddressedAggregate("test-1" as TestId, {
			value: 0,
			status: "inactive",
		});

	it("rejects a committed event addressed to another aggregate before the state moves", () => {
		const aggregate = fresh();
		const foreign = createDomainEvent(
			"Noted",
			{ value: 1 },
			{ aggregateId: "someone-else", aggregateType: "AddressedAggregate" },
		);

		expect(() => aggregate.commitWith(foreign)).toThrow(MisaddressedEventError);

		expect(aggregate.state.value).toBe(0);
		expect(aggregate.version).toBe(0);
		expect(aggregate.pendingEvents).toHaveLength(0);
	});

	it("rejects an appended event of another aggregate type", () => {
		const aggregate = fresh();
		const foreign = createDomainEvent(
			"Noted",
			{ value: 1 },
			{ aggregateId: "test-1", aggregateType: "Other" },
		);

		expect(() => aggregate.record(foreign)).toThrow(MisaddressedEventError);

		expect(aggregate.pendingEvents).toHaveLength(0);
	});

	it("stamps a missing address from the aggregate on commit", () => {
		const aggregate = fresh();

		aggregate.commitWith(createDomainEvent("Noted", { value: 1 }));

		const recorded = aggregate.pendingEvents[0];
		expect(recorded?.aggregateId).toBe("test-1");
		expect(recorded?.aggregateType).toBe("AddressedAggregate");
		expect(recorded?.payload).toEqual({ value: 1 });
	});

	it("keeps a fully addressed event as the same object", () => {
		const aggregate = fresh();
		const addressed = createDomainEvent(
			"Noted",
			{ value: 1 },
			{ aggregateId: "test-1", aggregateType: "AddressedAggregate" },
		);

		aggregate.record(addressed);

		expect(aggregate.pendingEvents[0]).toBe(addressed);
	});

	it("keeps a createEvent decision as the same object", () => {
		const aggregate = fresh();

		aggregate.decide(5);

		const decision = aggregate.pendingEvents[0];
		expect(decision?.aggregateId).toBe("test-1");
		expect(decision?.aggregateType).toBe("AddressedAggregate");
		expect(aggregate.state.value).toBe(5);
	});
});
