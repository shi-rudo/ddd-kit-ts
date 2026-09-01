import { isBaseError } from "@shirudo/base-error";
import { describe, expect, it, vi } from "vite-plus/test";
import {
	DirectStateMutationError,
	DomainError,
	ForeignEventError,
	HandlerReturnedNoStateError,
	HostileStateKeyError,
	MisaddressedEventError,
	MissingHandlerError,
	UnmintedEventError,
	UnreplayableAggregateError,
} from "../../errors/kit-errors";
import {
	type AnyDomainEvent,
	createUncommittedDomainEvent,
	isMintedEvent,
	isUncommittedDomainEvent,
	type UncommittedDomainEventOf,
} from "../event/domain-event";
import type { Id } from "../identity/id";
import { createDomainEvent, type DomainEvent, type Version } from "./aggregate";
import type { AggregateConfig } from "./base-aggregate";
import {
	EventSourcedAggregate as ProductionEventSourcedAggregate,
	reconstituteAggregateFromHistory,
} from "./event-sourced-aggregate";
import { pendingEventLifecycleCapabilityFor } from "./pending-event-lifecycle";

function acknowledgePersisted(aggregate: object, version: Version): void {
	const capability = pendingEventLifecycleCapabilityFor(aggregate);
	if (!capability) throw new Error("Missing test persistence capability");
	capability.acknowledge(
		(aggregate as { pendingEvents: ReadonlyArray<AnyDomainEvent> })
			.pendingEvents,
		version,
	);
}

function discardPendingEvents(aggregate: object): void {
	const capability = pendingEventLifecycleCapabilityFor(aggregate);
	if (!capability) throw new Error("Missing test persistence capability");
	capability.discardPendingEvents(
		(aggregate as { pendingEvents: ReadonlyArray<AnyDomainEvent> })
			.pendingEvents,
	);
}

/** White-box fixture only: production aggregate subclasses keep `state` protected. */
abstract class EventSourcedAggregate<
	TState,
	TId extends Id<string>,
	TEvent extends AnyDomainEvent,
> extends ProductionEventSourcedAggregate<TState, TId, TEvent> {
	public override get state(): TState {
		return super.state;
	}
}

type TestId = Id<"TestId">;

type TestState = {
	value: number;
	status: "active" | "inactive";
};

type TestEventCreated = DomainEvent<"TestEventCreated", { value: number }>;
type TestEventUpdated = DomainEvent<"TestEventUpdated", { newValue: number }>;
type TestEventActivated = DomainEvent<
	"TestEventActivated",
	Record<string, never>
>;
type TestEventDeactivated = DomainEvent<
	"TestEventDeactivated",
	Record<string, never>
>;
type TestEventInvalid = DomainEvent<"TestEventInvalid", Record<string, never>>;

type TestEvent =
	| TestEventCreated
	| TestEventUpdated
	| TestEventActivated
	| TestEventDeactivated
	| TestEventInvalid;
type TestEventDecision = UncommittedDomainEventOf<TestEvent>;
type TestEventCreatedDecision = UncommittedDomainEventOf<TestEventCreated>;
type TestEventUpdatedDecision = UncommittedDomainEventOf<TestEventUpdated>;

class InvalidTestEventError extends DomainError<"INVALID_TEST_EVENT"> {
	constructor(reason: string) {
		super({
			code: "INVALID_TEST_EVENT",
			message: `Invalid test event: ${reason}`,
		});
	}
}

class AlreadyActiveError extends DomainError<"ALREADY_ACTIVE"> {
	constructor() {
		super({ code: "ALREADY_ACTIVE", message: "Already active" });
	}
}

class NegativeValueError extends DomainError<"NEGATIVE_VALUE"> {
	constructor() {
		super({ code: "NEGATIVE_VALUE", message: "value must not be negative" });
	}
}

const testHandlers = {
	TestEventCreated: (
		state: TestState,
		event: TestEventCreatedDecision,
	): TestState => ({
		...state,
		value: event.payload.value,
	}),
	TestEventUpdated: (
		state: TestState,
		event: TestEventUpdatedDecision,
	): TestState => ({
		...state,
		value: event.payload.newValue,
	}),
	TestEventActivated: (state: TestState): TestState => ({
		...state,
		status: "active",
	}),
	TestEventDeactivated: (state: TestState): TestState => ({
		...state,
		status: "inactive",
	}),
	TestEventInvalid: (state: TestState): TestState => state,
};

class TestEventSourcedAggregate extends EventSourcedAggregate<
	TestState,
	TestId,
	TestEvent
> {
	protected readonly aggregateType = "TestEventSourcedAggregate";

	constructor(
		id: TestId,
		initialState: TestState,
		config?: AggregateConfig<TestState>,
	) {
		super(id, initialState, config);
	}

	static create(id: TestId, value: number): TestEventSourcedAggregate {
		const initialState: TestState = {
			value,
			status: "inactive",
		};
		const aggregate = new TestEventSourcedAggregate(id, initialState);
		aggregate.apply(
			createDomainEvent("TestEventCreated", { value }) as TestEventCreated,
		);
		return aggregate;
	}

	updateValue(newValue: number): void {
		this.apply(
			createDomainEvent("TestEventUpdated", { newValue }) as TestEventUpdated,
		);
	}

	activate(): void {
		this.apply(
			createDomainEvent("TestEventActivated", {}) as TestEventActivated,
		);
	}

	deactivate(): void {
		this.apply(
			createDomainEvent("TestEventDeactivated", {}) as TestEventDeactivated,
		);
	}

	protected readonly handlers = testHandlers;
}

class ValidatingAggregate extends EventSourcedAggregate<
	TestState,
	TestId,
	TestEvent
> {
	protected readonly aggregateType = "ValidatingAggregate";

	constructor(id: TestId, initialState: TestState) {
		super(id, initialState);
	}

	protected validateEvent(event: TestEventDecision): void {
		if (event.type === "TestEventInvalid") {
			throw new InvalidTestEventError("forbidden event type");
		}
	}

	// The handler throws too: replay does not run validateEvent, so the
	// replay-corruption tests get their mid-stream DomainError from the
	// handler (a corrupt row a handler can name), while the apply-path
	// tests still exercise validateEvent above.
	protected readonly handlers = {
		...testHandlers,
		TestEventInvalid: (): TestState => {
			throw new InvalidTestEventError("forbidden event type");
		},
	};
}

describe("EventSourcedAggregate", () => {
	describe("Automatic version bumping", () => {
		it("should automatically bump version when applying new events", () => {
			const aggregate = TestEventSourcedAggregate.create(
				"test-1" as TestId,
				10,
			);

			expect(aggregate.version).toBe(1); // After creation event

			aggregate.updateValue(20);
			expect(aggregate.version).toBe(2);

			aggregate.activate();
			expect(aggregate.version).toBe(3);
		});

		it("should advance version by history.length on top of the existing version (not stomp it)", () => {
			const aggregate = TestEventSourcedAggregate.create(
				"test-1" as TestId,
				10,
			);
			// Catch-up replay requires a persisted baseline; a fresh
			// factory-created target throws UnreplayableAggregateError.
			acknowledgePersisted(aggregate, aggregate.version);
			const initialVersion = aggregate.version; // 1 after creation

			const history: TestEvent[] = [
				createDomainEvent("TestEventUpdated", {
					newValue: 20,
				}) as TestEventUpdated,
				createDomainEvent("TestEventActivated", {}) as TestEventActivated,
			];

			aggregate.replayHistory(history);

			// Additive: version = startVersion + history.length (1 + 2 = 3)
			expect(aggregate.version).toBe(initialVersion + history.length);
		});
	});

	describe("Event validation", () => {
		it("should apply events when validation passes", () => {
			const aggregate = TestEventSourcedAggregate.create(
				"test-1" as TestId,
				10,
			);

			aggregate.updateValue(20);

			expect(aggregate.state.value).toBe(20);
		});

		it("should throw the subclass's DomainError when validation fails", () => {
			class TestValidatingAggregate extends ValidatingAggregate {
				public testApply(event: TestEvent): void {
					this.apply(event);
				}
			}

			const initialState: TestState = { value: 10, status: "inactive" };
			const aggregate = new TestValidatingAggregate(
				"test-1" as TestId,
				initialState,
			);

			expect(() => {
				aggregate.testApply(
					createDomainEvent("TestEventInvalid", {}) as TestEventInvalid,
				);
			}).toThrow(InvalidTestEventError);
		});

		it("should allow custom validation logic that throws DomainError", () => {
			class CustomValidatingAggregate extends EventSourcedAggregate<
				TestState,
				TestId,
				TestEvent
			> {
				protected readonly aggregateType = "CustomValidatingAggregate";

				constructor(id: TestId, initialState: TestState) {
					super(id, initialState);
				}

				protected validateEvent(event: TestEventDecision): void {
					if (
						event.type === "TestEventActivated" &&
						this.state.status === "active"
					) {
						throw new AlreadyActiveError();
					}
				}

				public testApply(event: TestEvent): void {
					this.apply(event);
				}

				protected readonly handlers = testHandlers;
			}

			const initialState: TestState = { value: 10, status: "active" };
			const aggregate = new CustomValidatingAggregate(
				"test-1" as TestId,
				initialState,
			);

			expect(() => {
				aggregate.testApply(
					createDomainEvent("TestEventActivated", {}) as TestEventActivated,
				);
			}).toThrow(AlreadyActiveError);
		});

		it("should throw MissingHandlerError when no handler is registered", () => {
			class HandlerlessAggregate extends EventSourcedAggregate<
				TestState,
				TestId,
				TestEvent
			> {
				protected readonly aggregateType = "HandlerlessAggregate";

				constructor(id: TestId, initialState: TestState) {
					super(id, initialState);
				}

				public testApply(event: TestEvent): void {
					this.apply(event);
				}

				// Intentionally missing handler for TestEventUpdated
				protected readonly handlers = {
					TestEventCreated: (s: TestState): TestState => s,
				} as unknown as Record<
					TestEvent["type"],
					(s: TestState, e: TestEventDecision) => TestState
				>;
			}

			const aggregate = new HandlerlessAggregate("test-1" as TestId, {
				value: 0,
				status: "inactive",
			});

			expect(() => {
				aggregate.testApply(
					createDomainEvent("TestEventUpdated", {
						newValue: 1,
					}) as TestEventUpdated,
				);
			}).toThrow(MissingHandlerError);
		});

		it("MissingHandlerError is a BaseError but NOT a DomainError (programming bug)", () => {
			// MissingHandlerError signals a subclass forgot to register a
			// handler: that's a configuration / programming error, not a
			// domain-invariant violation. It must not be catchable via
			// `instanceof DomainError` at the App-Service boundary, so a
			// 'catch domain errors → HTTP 400' handler can't mask the bug.
			const error = new MissingHandlerError("Foo");
			expect(isBaseError(error)).toBe(true);
			expect(error).not.toBeInstanceOf(DomainError);
		});

		it("MissingHandlerError thrown during replayHistory propagates (not caught as DomainError)", () => {
			class HandlerlessReplay extends EventSourcedAggregate<
				TestState,
				TestId,
				TestEvent
			> {
				protected readonly aggregateType = "HandlerlessReplay";

				constructor(id: TestId, initialState: TestState) {
					super(id, initialState);
				}
				protected readonly handlers = {} as unknown as Record<
					TestEvent["type"],
					(s: TestState, e: TestEventDecision) => TestState
				>;
			}

			const aggregate = new HandlerlessReplay("test-1" as TestId, {
				value: 0,
				status: "inactive",
			});

			// replayHistory only catches DomainError; a MissingHandlerError
			// (programming bug) should propagate up unwrapped, not get
			// silently wrapped into Result.Err.
			expect(() => {
				aggregate.replayHistory([
					createDomainEvent("TestEventCreated", {
						value: 1,
					}) as TestEventCreated,
				]);
			}).toThrow(MissingHandlerError);
		});

		it("should not mutate state if handler throws", () => {
			class ThrowingHandlerAggregate extends EventSourcedAggregate<
				TestState,
				TestId,
				TestEvent
			> {
				protected readonly aggregateType = "ThrowingHandlerAggregate";

				constructor(id: TestId, initialState: TestState) {
					super(id, initialState);
				}

				public testApply(event: TestEvent): void {
					this.apply(event);
				}

				public stateSnapshot(): TestState {
					return this.state;
				}

				public versionSnapshot(): number {
					return this.version;
				}

				protected readonly handlers = {
					TestEventCreated: (state: TestState): TestState => state,
					TestEventUpdated: (): TestState => {
						throw new Error("handler boom");
					},
					TestEventActivated: (state: TestState): TestState => state,
					TestEventDeactivated: (state: TestState): TestState => state,
					TestEventInvalid: (state: TestState): TestState => state,
				};
			}

			const aggregate = new ThrowingHandlerAggregate("test-1" as TestId, {
				value: 10,
				status: "inactive",
			});
			const before = aggregate.stateSnapshot();
			const versionBefore = aggregate.versionSnapshot();

			expect(() =>
				aggregate.testApply(
					createDomainEvent("TestEventUpdated", {
						newValue: 99,
					}) as TestEventUpdated,
				),
			).toThrow("handler boom");

			// State and version unchanged, no pending event added
			expect(aggregate.stateSnapshot()).toEqual(before);
			expect(aggregate.versionSnapshot()).toBe(versionBefore);
			expect(aggregate.pendingEvents).toHaveLength(0);
		});
	});

	describe("corrupt event types colliding with Object.prototype members", () => {
		// The handlers map is an object literal, so a naive property get for
		// event.type === "toString" returns Object.prototype.toString, which
		// passes a truthiness check and gets invoked as a handler, silently
		// corrupting state. All such types must yield MissingHandlerError.
		class TrapAggregate extends EventSourcedAggregate<
			TestState,
			TestId,
			TestEvent
		> {
			protected readonly aggregateType = "TrapAggregate";

			constructor(id: TestId, initialState: TestState) {
				super(id, initialState);
			}

			public testApply(event: TestEvent): void {
				this.apply(event);
			}

			protected readonly handlers = {
				TestEventCreated: (s: TestState): TestState => s,
			} as unknown as Record<
				TestEvent["type"],
				(s: TestState, e: TestEventDecision) => TestState
			>;
		}

		const corruptTypes = [
			"toString",
			"constructor",
			"hasOwnProperty",
			"__proto__",
			"valueOf",
		] as const;

		for (const corruptType of corruptTypes) {
			it(`throws MissingHandlerError for event.type "${corruptType}" and leaves state intact`, () => {
				const aggregate = new TrapAggregate("test-1" as TestId, {
					value: 7,
					status: "inactive",
				});

				const corrupt = createDomainEvent(corruptType, {
					evil: true,
				}) as unknown as TestEvent;

				expect(() => aggregate.testApply(corrupt)).toThrow(MissingHandlerError);
				expect(aggregate.state).toEqual({ value: 7, status: "inactive" });
				expect(aggregate.version).toBe(0);
			});
		}

		it("propagates MissingHandlerError from replayHistory for a corrupt stream row", () => {
			const aggregate = new TrapAggregate("test-1" as TestId, {
				value: 7,
				status: "inactive",
			});

			const corrupt = createDomainEvent("toString", {
				evil: true,
			}) as unknown as TestEvent;

			expect(() => aggregate.replayHistory([corrupt])).toThrow(
				MissingHandlerError,
			);
			expect(aggregate.state).toEqual({ value: 7, status: "inactive" });
		});
	});

	describe("replayHistory", () => {
		it("rolls back state when a mid-stream event throws a DomainError (all-or-nothing)", () => {
			const aggregate = new ValidatingAggregate("test-1" as TestId, {
				value: 10,
				status: "inactive",
			});

			const result = aggregate.replayHistory([
				createDomainEvent("TestEventUpdated", {
					newValue: 99,
				}) as TestEventUpdated,
				createDomainEvent("TestEventInvalid", {}) as TestEventInvalid,
			]);

			expect(result.isErr()).toBe(true);
			// The valid first event must not leak into state: all or nothing.
			expect(aggregate.state).toEqual({ value: 10, status: "inactive" });
			expect(aggregate.version).toBe(0);
		});

		it("rolls back state when a mid-stream row propagates a non-domain error", () => {
			const aggregate = new ValidatingAggregate("test-1" as TestId, {
				value: 10,
				status: "inactive",
			});

			expect(() =>
				aggregate.replayHistory([
					createDomainEvent("TestEventUpdated", {
						newValue: 99,
					}) as TestEventUpdated,
					// Unregistered type → MissingHandlerError (propagates, not err)
					createDomainEvent("Bogus", {}) as unknown as TestEvent,
				]),
			).toThrow(MissingHandlerError);

			expect(aggregate.state).toEqual({ value: 10, status: "inactive" });
		});

		it("should set version to history length on a fresh aggregate", () => {
			const initialState: TestState = { value: 10, status: "inactive" };
			const aggregate = new TestEventSourcedAggregate(
				"test-1" as TestId,
				initialState,
			);

			const history: TestEvent[] = [
				createDomainEvent("TestEventUpdated", {
					newValue: 20,
				}) as TestEventUpdated,
				createDomainEvent("TestEventActivated", {}) as TestEventActivated,
				createDomainEvent("TestEventUpdated", {
					newValue: 30,
				}) as TestEventUpdated,
			];

			const result = aggregate.replayHistory(history);

			expect(result.isOk()).toBe(true);
			expect(aggregate.version).toBe(history.length); // 0 + 3 = 3
			expect(aggregate.state.value).toBe(30);
			expect(aggregate.state.status).toBe("active");
		});

		it("throws UnreplayableAggregateError when the aggregate carries pending events", () => {
			// A factory-created aggregate holds an unpersisted creation event.
			// Replaying stored history onto the same object would mix an
			// uncommitted decision with facts from a different stream baseline.
			const aggregate = TestEventSourcedAggregate.create(
				"test-1" as TestId,
				10,
			);
			expect(aggregate.pendingEvents).toHaveLength(1);

			const history: TestEvent[] = [
				createDomainEvent("TestEventUpdated", {
					newValue: 20,
				}) as TestEventUpdated,
			];

			const thrown = ((): unknown => {
				try {
					aggregate.replayHistory(history);
					return undefined;
				} catch (e) {
					return e;
				}
			})();
			expect(thrown).toBeInstanceOf(UnreplayableAggregateError);
			expect((thrown as Error).message).toContain(
				"discard this dirty instance",
			);
			expect((thrown as Error).message).toContain("fresh aggregate");
			// Crash-loud programming bug, never a Result Err, and nothing moved.
			expect(aggregate.version).toBe(1);
			expect(aggregate.state.value).toBe(10);
		});

		it("allows clean additive replay without carrying a persistence flag", () => {
			const aggregate = TestEventSourcedAggregate.create(
				"test-1" as TestId,
				10,
			);
			discardPendingEvents(aggregate);
			expect(aggregate.version).toBe(1);

			const result = aggregate.replayHistory([
				createDomainEvent("TestEventUpdated", {
					newValue: 20,
				}) as TestEventUpdated,
			]);
			expect(result.isOk()).toBe(true);
			expect(aggregate.version).toBe(2);
		});

		it("should advance version additively on a persisted aggregate (catch-up replay)", () => {
			const aggregate = TestEventSourcedAggregate.create(
				"test-1" as TestId,
				10,
			);
			expect(aggregate.version).toBe(1); // created event
			// Simulate the post-commit lifecycle: the creation event is now
			// part of the persisted stream, so catching up is legitimate.
			acknowledgePersisted(aggregate, aggregate.version);

			const history: TestEvent[] = [
				createDomainEvent("TestEventUpdated", {
					newValue: 20,
				}) as TestEventUpdated,
				createDomainEvent("TestEventUpdated", {
					newValue: 30,
				}) as TestEventUpdated,
			];

			const result = aggregate.replayHistory(history);

			expect(result.isOk()).toBe(true);
			expect(aggregate.version).toBe(3); // 1 + 2, not 2 (the bug stomped it)
		});

		it("should handle empty history", () => {
			const initialState: TestState = { value: 10, status: "inactive" };
			const aggregate = new TestEventSourcedAggregate(
				"test-1" as TestId,
				initialState,
			);

			const result = aggregate.replayHistory([]);

			expect(result.isOk()).toBe(true);
			expect(aggregate.version).toBe(0);
		});

		it("keeps version zero on empty history while persistence lifecycle stays external", () => {
			const initialState: TestState = { value: 10, status: "inactive" };
			const aggregate = new TestEventSourcedAggregate(
				"test-1" as TestId,
				initialState,
			);

			const result = aggregate.replayHistory([]);

			expect(result.isOk()).toBe(true);
			// markReconstituted(0) would flip repository routing from INSERT to
			// UPDATE against a row that does not exist.
		});

		it("runs the freshness guard before the empty-history fast path", () => {
			// A dirty replay target is the same misuse whether the stream
			// happens to be empty or not; a data-dependent guard would make
			// the bug intermittent (fine in dev, throwing in prod).
			const aggregate = TestEventSourcedAggregate.create(
				"test-1" as TestId,
				10,
			);
			expect(aggregate.version).toBe(1);

			expect(() => aggregate.replayHistory([])).toThrow(
				UnreplayableAggregateError,
			);
		});

		it("allows empty history for a persisted aggregate (no-op catch-up)", () => {
			const aggregate = TestEventSourcedAggregate.create(
				"test-1" as TestId,
				10,
			);
			acknowledgePersisted(aggregate, aggregate.version);

			const result = aggregate.replayHistory([]);

			expect(result.isOk()).toBe(true);
			expect(aggregate.version).toBe(1); // 1 + 0 = 1
		});

		it("should return Err containing the DomainError on validation failure", () => {
			const initialState: TestState = { value: 10, status: "inactive" };
			const aggregate = new ValidatingAggregate(
				"test-1" as TestId,
				initialState,
			);

			const history: TestEvent[] = [
				createDomainEvent("TestEventInvalid", {}) as TestEventInvalid,
			];

			const result = aggregate.replayHistory(history);

			expect(result.isErr()).toBe(true);
			if (result.isErr()) {
				expect(result.error).toBeInstanceOf(InvalidTestEventError);
			}
		});
	});

	describe("opt-in deep freeze (deepFreezeState via constructor config)", () => {
		type NestedEsState = {
			items: string[];
			meta: { note: string };
		};
		type ItemAdded = DomainEvent<"ItemAdded", { item: string }>;

		class DeepFrozenEsAggregate extends EventSourcedAggregate<
			NestedEsState,
			TestId,
			ItemAdded
		> {
			protected readonly aggregateType = "DeepFrozenEsAggregate";

			constructor(id: TestId, initialState: NestedEsState) {
				super(id, initialState, { deepFreezeState: true });
			}

			addItem(item: string): void {
				this.apply(createDomainEvent("ItemAdded", { item }) as ItemAdded);
			}

			protected readonly handlers = {
				ItemAdded: (
					state: NestedEsState,
					event: UncommittedDomainEventOf<ItemAdded>,
				): NestedEsState => ({
					...state,
					items: [...state.items, event.payload.item],
				}),
			};
		}

		it("deep-freezes handler-produced state so nested outside writes throw", () => {
			const aggregate = new DeepFrozenEsAggregate("test-1" as TestId, {
				items: [],
				meta: { note: "n" },
			});

			aggregate.addItem("a");

			expect(Object.isFrozen(aggregate.state.items)).toBe(true);
			expect(Object.isFrozen(aggregate.state.meta)).toBe(true);
			expect(() => {
				(aggregate.state.items as string[]).push("hacked");
			}).toThrow();
			expect(aggregate.state.items).toEqual(["a"]);
		});
	});

	describe("kit-internal persistence acknowledgement", () => {
		it("clears pending events without rewriting the domain version", () => {
			const aggregate = TestEventSourcedAggregate.create(
				"test-1" as TestId,
				10,
			);
			aggregate.updateValue(20);

			expect(aggregate.version).toBeGreaterThan(0);
			expect(aggregate.pendingEvents.length).toBeGreaterThan(0);

			acknowledgePersisted(aggregate, 99 as Version);

			expect(aggregate.version).toBe(2);
			expect(aggregate.pendingEvents).toHaveLength(0);
		});
	});

	describe("pendingEvents getter encapsulation", () => {
		it("does not leak the internal pendingEvents array", () => {
			const aggregate = TestEventSourcedAggregate.create(
				"test-1" as TestId,
				10,
			);
			const eventsBefore = aggregate.pendingEvents.length;

			const leaked = aggregate.pendingEvents as unknown as unknown[];
			expect(() => leaked.push({ fake: "event" })).toThrow();

			expect(aggregate.pendingEvents.length).toBe(eventsBefore);
		});
	});
});

describe("replay trusts history", () => {
	// Today's decision rule forbids activating an already-active
	// aggregate; the history below was recorded before that rule
	// existed. Replay must load it anyway: history is accepted fact.
	class RuleTighteningAggregate extends EventSourcedAggregate<
		TestState,
		TestId,
		TestEvent
	> {
		protected readonly aggregateType = "RuleTighteningAggregate";

		constructor(id: TestId, initialState: TestState) {
			super(id, initialState);
		}

		protected validateEvent(event: TestEventDecision): void {
			if (
				event.type === "TestEventActivated" &&
				this.state.status === "active"
			) {
				throw new AlreadyActiveError();
			}
		}

		public testApply(event: TestEvent): void {
			this.apply(event);
		}

		protected readonly handlers = testHandlers;
	}

	it("replays history that today's decision rules would reject", () => {
		const agg = new RuleTighteningAggregate("test-1" as TestId, {
			value: 0,
			status: "inactive",
		});

		const result = agg.replayHistory([
			createDomainEvent("TestEventActivated", {}) as TestEventActivated,
			createDomainEvent("TestEventActivated", {}) as TestEventActivated,
		]);

		expect(result.isOk()).toBe(true);
		expect(agg.state.status).toBe("active");
		expect(agg.version).toBe(2);
	});

	it("still validates the same rule for NEW facts through apply()", () => {
		const agg = new RuleTighteningAggregate("test-1" as TestId, {
			value: 0,
			status: "active",
		});

		expect(() => {
			agg.testApply(
				createDomainEvent("TestEventActivated", {}) as TestEventActivated,
			);
		}).toThrow(AlreadyActiveError);
	});

	it("throws on a replayed event addressed to another aggregate id: corruption, not a domain rejection", () => {
		const agg = new RuleTighteningAggregate("test-1" as TestId, {
			value: 10,
			status: "inactive",
		});

		// An InfrastructureError, so it PROPAGATES instead of riding the
		// Result channel: a generic corrupted-stream Err handler must not
		// absorb a wrong-stream read as an expected business rejection.
		expect(() =>
			agg.replayHistory([
				createDomainEvent(
					"TestEventUpdated",
					{ newValue: 99 },
					{ aggregateId: "someone-else" },
				) as TestEventUpdated,
			]),
		).toThrow(ForeignEventError);
		// Same all-or-nothing rollback as every other replay failure.
		expect(agg.state).toEqual({ value: 10, status: "inactive" });
		expect(agg.version).toBe(0);
	});

	it("throws on a replayed event of another aggregate type", () => {
		const agg = new RuleTighteningAggregate("test-1" as TestId, {
			value: 10,
			status: "inactive",
		});

		expect(() =>
			agg.replayHistory([
				createDomainEvent(
					"TestEventUpdated",
					{ newValue: 99 },
					{ aggregateId: "test-1", aggregateType: "SomeoneElse" },
				) as TestEventUpdated,
			]),
		).toThrow(ForeignEventError);
	});

	it("throws a wiring error from apply() when a new event is addressed to another aggregate", () => {
		// Without the guard, a hand-built event with a foreign address
		// would be recorded and committed, and the NEXT load of this
		// stream would reject it, poisoning the stream. A wiring error
		// (MisaddressedEventError), not ForeignEventError: a wrong new
		// event is a bug in today's code, not corrupted infrastructure.
		const agg = new RuleTighteningAggregate("test-1" as TestId, {
			value: 10,
			status: "inactive",
		});

		expect(() => {
			agg.testApply(
				createDomainEvent(
					"TestEventUpdated",
					{ newValue: 99 },
					{ aggregateId: "someone-else" },
				) as TestEventUpdated,
			);
		}).toThrow(MisaddressedEventError);
		expect(() => {
			agg.testApply(
				createDomainEvent(
					"TestEventUpdated",
					{ newValue: 99 },
					{ aggregateId: "test-1", aggregateType: "SomeoneElse" },
				) as TestEventUpdated,
			);
		}).toThrow(MisaddressedEventError);
		// Nothing recorded, nothing bumped: the stream stays clean.
		expect(agg.pendingEvents).toHaveLength(0);
		expect(agg.version).toBe(0);
		expect(agg.state.value).toBe(10);
	});

	it("apply() stamps missing address fields, so recorded events are always fully addressed", () => {
		// Without the stamp an address-less event mutates state and then
		// fails far away: at harvest (withCommit) or on the next load
		// (replay guard).
		const agg = new RuleTighteningAggregate("test-1" as TestId, {
			value: 10,
			status: "inactive",
		});

		agg.testApply(
			createDomainEvent("TestEventUpdated", {
				newValue: 42,
			}) as TestEventUpdated,
		);

		expect(agg.state.value).toBe(42);
		expect(agg.pendingEvents).toHaveLength(1);
		const recorded = agg.pendingEvents[0];
		expect(recorded?.aggregateId).toBe("test-1");
		expect(recorded?.aggregateType).toBe("RuleTighteningAggregate");
		expect(Object.isFrozen(recorded)).toBe(true);
	});

	it("keeps an address-stamped decision uncommitted until the shell records it", () => {
		const agg = new RuleTighteningAggregate("test-1" as TestId, {
			value: 10,
			status: "inactive",
		});
		const decision = createUncommittedDomainEvent("TestEventUpdated", {
			newValue: 42,
		});

		agg.testApply(decision as unknown as TestEventUpdated);

		const pending = agg.pendingEvents[0];
		expect(pending?.aggregateId).toBe("test-1");
		expect(pending?.aggregateType).toBe("RuleTighteningAggregate");
		expect(pending).not.toHaveProperty("eventId");
		expect(pending).not.toHaveProperty("occurredAt");
		expect(isUncommittedDomainEvent(pending as object)).toBe(true);
		expect(isMintedEvent(pending as object)).toBe(false);
	});

	it("rejects a hand-rolled mutable event before anything moves", () => {
		// createDomainEvent deep-freezes and defensively copies; a bare
		// literal bypasses that, and a mutable payload could diverge from
		// the state change it records. Rejected BEFORE validate/dispatch,
		// so state, version, and pendingEvents stay clean.
		const agg = new RuleTighteningAggregate("test-1" as TestId, {
			value: 10,
			status: "inactive",
		});
		const minted = createDomainEvent("TestEventUpdated", {
			newValue: 99,
		}) as TestEventUpdated;
		const literal = {
			...minted,
			payload: { newValue: 99 },
		} as TestEventUpdated;

		expect(() => agg.testApply(literal)).toThrow(UnmintedEventError);
		expect(agg.state.value).toBe(10);
		expect(agg.version).toBe(0);
		expect(agg.pendingEvents).toHaveLength(0);

		// A frozen shell with mutable nested data is equally rejected:
		// the mint marker checks provenance, not frozen-ness, so no
		// shallow-freeze trick can smuggle a mutable graph past it.
		const frozenShellMutablePayload = Object.freeze({
			...minted,
			payload: { newValue: 99 },
		}) as TestEventUpdated;
		expect(() => agg.testApply(frozenShellMutablePayload)).toThrow(
			UnmintedEventError,
		);
		const frozenShellMutableMetadata = Object.freeze({
			...minted,
			metadata: { correlationId: "mutable" },
		}) as TestEventUpdated;
		expect(() => agg.testApply(frozenShellMutableMetadata)).toThrow(
			UnmintedEventError,
		);
	});

	it("recognizes events minted by another copy of the kit via the cooperative brand", async () => {
		// A duplicate npm dependency or a plugin bundle loads a second
		// copy of the kit whose WeakSet this instance cannot see. Such an
		// event carries the shared mint brand instead; the gate accepts it.
		// The brand is cooperative by design (the gate catches accidental
		// literals, it is not a security boundary).
		const agg = new RuleTighteningAggregate("test-1" as TestId, {
			value: 0,
			status: "inactive",
		});
		vi.resetModules();
		const foreignDomainEventModule = await import("../event/domain-event");
		const foreignInstanceEvent = foreignDomainEventModule.createDomainEvent(
			"TestEventUpdated",
			{ newValue: 3 },
		) as TestEventUpdated;

		agg.testApply(foreignInstanceEvent);

		expect(agg.state.value).toBe(3);
	});

	it("accepts the address-stamped copy apply() mints for address-less events", () => {
		// The stamped copy is kit-derived from a minted event and adopted
		// into the mint marker; the gate must not reject apply's own work.
		const agg = new RuleTighteningAggregate("test-1" as TestId, {
			value: 0,
			status: "inactive",
		});
		agg.testApply(
			createDomainEvent("TestEventUpdated", {
				newValue: 5,
			}) as TestEventUpdated,
		);
		expect(agg.pendingEvents).toHaveLength(1);
		expect(agg.pendingEvents[0]?.aggregateId).toBe("test-1");
	});

	it("preserves the cooperative mint brand on address-stamped copies", async () => {
		const agg = new RuleTighteningAggregate("test-1" as TestId, {
			value: 0,
			status: "inactive",
		});
		agg.testApply(
			createDomainEvent("TestEventUpdated", {
				newValue: 5,
			}) as TestEventUpdated,
		);
		const stamped = agg.pendingEvents[0];
		expect(stamped).toBeDefined();

		// Re-evaluate domain-event.ts with a fresh module-private WeakSet,
		// as a duplicate package installation or plugin bundle would. Only
		// the shared Symbol.for brand can establish provenance there.
		vi.resetModules();
		const foreignDomainEventModule = await import("../event/domain-event");

		expect(foreignDomainEventModule.isMintedEvent(stamped as TestEvent)).toBe(
			true,
		);
	});

	it("replay accepts plain unfrozen objects from storage adapters", () => {
		// The immutability gate guards the RECORDING paths only: replay
		// input comes from storage drivers as plain rows and never enters
		// pendingEvents, so it is not required to be frozen.
		const agg = new RuleTighteningAggregate("test-1" as TestId, {
			value: 0,
			status: "inactive",
		});
		const minted = createDomainEvent("TestEventUpdated", {
			newValue: 7,
		}) as TestEventUpdated;
		const row = { ...minted, payload: { newValue: 7 } } as TestEventUpdated;

		const result = agg.replayHistory([row]);

		expect(result.isOk()).toBe(true);
		expect(agg.state.value).toBe(7);
	});

	it("accepts replayed events that carry the matching address", () => {
		const agg = new RuleTighteningAggregate("test-1" as TestId, {
			value: 10,
			status: "inactive",
		});

		const result = agg.replayHistory([
			createDomainEvent(
				"TestEventUpdated",
				{ newValue: 99 },
				{ aggregateId: "test-1", aggregateType: "RuleTighteningAggregate" },
			) as TestEventUpdated,
		]);

		expect(result.isOk()).toBe(true);
		expect(agg.state.value).toBe(99);
	});
});

describe("validateState on the apply path", () => {
	const rejectNegativeValue = (state: TestState): void => {
		if (state.value < 0) throw new NegativeValueError();
	};

	const guarded = (initialState: TestState): TestEventSourcedAggregate =>
		new TestEventSourcedAggregate("test-1" as TestId, initialState, {
			validateState: rejectNegativeValue,
		});

	it("rejects a new fact whose resulting state fails validateState", () => {
		const agg = guarded({ value: 1, status: "inactive" });

		expect(() => agg.updateValue(-5)).toThrow(NegativeValueError);
	});

	it("leaves state, version, and pendingEvents untouched when validateState rejects", () => {
		const agg = guarded({ value: 1, status: "inactive" });
		agg.updateValue(2);

		expect(() => agg.updateValue(-5)).toThrow(NegativeValueError);

		expect(agg.state.value).toBe(2);
		expect(agg.version).toBe(1);
		expect(agg.pendingEvents).toHaveLength(1);
	});

	it("runs validateState on the initial state by default", () => {
		expect(() => guarded({ value: -1, status: "inactive" })).toThrow(
			NegativeValueError,
		);
	});

	it("does not run validateState on a trusted initial state, but on the next fact", () => {
		const restored = new TestEventSourcedAggregate(
			"test-1" as TestId,
			{ value: -3, status: "inactive" },
			{ validateState: rejectNegativeValue, trustInitialState: true },
		);

		expect(restored.state.value).toBe(-3);
		expect(() => restored.updateValue(-4)).toThrow(NegativeValueError);
		restored.updateValue(4);
		expect(restored.state.value).toBe(4);
	});

	it("replays history without running validateState", () => {
		const agg = guarded({ value: 1, status: "inactive" });

		const result = agg.replayHistory([
			createDomainEvent("TestEventUpdated", {
				newValue: -9,
			}) as TestEventUpdated,
		]);

		expect(result.isOk()).toBe(true);
		expect(agg.state.value).toBe(-9);
		expect(agg.version).toBe(1);
	});

	it("hands the validator the frozen fold result, so a mutating validator fails loudly", () => {
		// A validator that normalizes instead of rejecting: it must fail on
		// the frozen candidate instead of storing its own edit.
		const normalizeInPlace = (state: TestState): void => {
			if (state.value < 0) {
				(state as { value: number }).value = -state.value;
			}
		};
		const agg = new TestEventSourcedAggregate(
			"test-1" as TestId,
			{ value: 1, status: "inactive" },
			{ validateState: normalizeInPlace },
		);

		expect(() => agg.updateValue(-5)).toThrow(TypeError);

		expect(agg.state.value).toBe(1);
		expect(agg.version).toBe(0);
		expect(agg.pendingEvents).toHaveLength(0);
	});

	it("keeps the injected validator on apply() when a prototype member shares its name", () => {
		class ShadowingAggregate extends TestEventSourcedAggregate {}
		// JavaScript consumers can still attach a same-named prototype method.
		Object.defineProperty(ShadowingAggregate.prototype, "validateState", {
			value: () => {},
		});
		const agg = new ShadowingAggregate(
			"test-1" as TestId,
			{ value: 1, status: "inactive" },
			{ validateState: rejectNegativeValue },
		);

		expect(() => agg.updateValue(-5)).toThrow(NegativeValueError);
	});
});

describe("a handler that returns no state", () => {
	class ForgetfulAggregate extends EventSourcedAggregate<
		TestState,
		TestId,
		TestEvent
	> {
		protected readonly aggregateType = "ForgetfulAggregate";

		constructor(id: TestId, initialState: TestState) {
			super(id, initialState);
		}

		updateValue(newValue: number): void {
			this.apply(
				createDomainEvent("TestEventUpdated", { newValue }) as TestEventUpdated,
			);
		}

		protected readonly handlers = {
			...testHandlers,
			// A fold without a return statement: the classic missing-return bug.
			TestEventUpdated: (): TestState => undefined as unknown as TestState,
		};
	}

	it("throws HandlerReturnedNoStateError from apply() and leaves the aggregate untouched", () => {
		const agg = new ForgetfulAggregate("test-1" as TestId, {
			value: 1,
			status: "inactive",
		});

		expect(() => agg.updateValue(2)).toThrow(HandlerReturnedNoStateError);

		expect(agg.state).toEqual({ value: 1, status: "inactive" });
		expect(agg.version).toBe(0);
		expect(agg.pendingEvents).toHaveLength(0);
	});

	it("carries the event type and the wiring code", () => {
		const agg = new ForgetfulAggregate("test-1" as TestId, {
			value: 1,
			status: "inactive",
		});

		let caught: unknown;
		try {
			agg.updateValue(2);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(HandlerReturnedNoStateError);
		expect(isBaseError(caught)).toBe(true);
		expect(caught).not.toBeInstanceOf(DomainError);
		expect((caught as HandlerReturnedNoStateError).code).toBe(
			"HANDLER_RETURNED_NO_STATE",
		);
		expect((caught as HandlerReturnedNoStateError).eventType).toBe(
			"TestEventUpdated",
		);
	});

	it("propagates HandlerReturnedNoStateError from replayHistory after rolling back", () => {
		const agg = new ForgetfulAggregate("test-1" as TestId, {
			value: 1,
			status: "inactive",
		});

		expect(() =>
			agg.replayHistory([
				createDomainEvent("TestEventActivated", {}) as TestEventActivated,
				createDomainEvent("TestEventUpdated", {
					newValue: 2,
				}) as TestEventUpdated,
			]),
		).toThrow(HandlerReturnedNoStateError);

		expect(agg.state).toEqual({ value: 1, status: "inactive" });
		expect(agg.version).toBe(0);
	});
});

describe("hostile own keys on the fold result", () => {
	// JSON.parse creates an own "__proto__" DATA key, the shape of a hostile
	// stream row or request body that a handler folds into state.
	const hostileState = (): TestState =>
		JSON.parse(
			'{"value":1,"status":"inactive","__proto__":{"isAdmin":true}}',
		) as TestState;

	class HostileFoldAggregate extends TestEventSourcedAggregate {
		protected override readonly handlers = {
			...testHandlers,
			TestEventUpdated: (): TestState => hostileState(),
		};
	}

	it("rejects a fold result with an own __proto__ key on apply() and leaves the aggregate untouched", () => {
		const agg = new HostileFoldAggregate("test-1" as TestId, {
			value: 0,
			status: "inactive",
		});

		expect(() => agg.updateValue(1)).toThrow(HostileStateKeyError);

		expect(agg.state).toEqual({ value: 0, status: "inactive" });
		expect(agg.version).toBe(0);
		expect(agg.pendingEvents).toHaveLength(0);
		expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
	});

	it("rejects a replayed row that folds into a hostile state after rolling back", () => {
		const agg = new HostileFoldAggregate("test-1" as TestId, {
			value: 0,
			status: "inactive",
		});

		expect(() =>
			agg.replayHistory([
				createDomainEvent("TestEventActivated", {}) as TestEventActivated,
				createDomainEvent("TestEventUpdated", {
					newValue: 1,
				}) as TestEventUpdated,
			]),
		).toThrow(HostileStateKeyError);

		expect(agg.state).toEqual({ value: 0, status: "inactive" });
		expect(agg.version).toBe(0);
	});

	it("checks the root level only: a nested own __proto__ key passes", () => {
		class NestedAggregate extends TestEventSourcedAggregate {
			protected override readonly handlers = {
				...testHandlers,
				TestEventUpdated: (): TestState =>
					({
						value: 1,
						status: "inactive",
						nested: JSON.parse('{"__proto__":{"isAdmin":true}}'),
					}) as TestState,
			};
		}
		const agg = new NestedAggregate("test-1" as TestId, {
			value: 0,
			status: "inactive",
		});

		agg.updateValue(1);

		expect(agg.state.value).toBe(1);
	});

	it("skips a class-instance state, which is an ownership transfer", () => {
		class InstanceState {
			value = 1;
			status: "active" | "inactive" = "inactive";
		}
		class InstanceAggregate extends TestEventSourcedAggregate {
			protected override readonly handlers = {
				...testHandlers,
				TestEventUpdated: (): TestState => {
					const state = new InstanceState();
					Object.defineProperty(state, "__proto__", {
						value: { isAdmin: true },
						enumerable: true,
					});
					return state;
				},
			};
		}
		const agg = new InstanceAggregate("test-1" as TestId, {
			value: 0,
			status: "inactive",
		});

		agg.updateValue(1);

		expect(agg.state.value).toBe(1);
	});
});

describe("markReconstituted on an event-sourced aggregate", () => {
	class RestoringAggregate extends TestEventSourcedAggregate {
		restore(version: number): void {
			this.markReconstituted(version as Version);
		}
	}

	it("rejects markReconstituted while decisions are pending", () => {
		const agg = new RestoringAggregate("test-1" as TestId, {
			value: 1,
			status: "inactive",
		});
		agg.updateValue(2);

		expect(() => agg.restore(7)).toThrow(UnreplayableAggregateError);

		expect(agg.version).toBe(1);
		expect(agg.pendingEvents).toHaveLength(1);
	});

	it("rolls back state and version when a handler records a decision during replay", () => {
		class ReentrantAggregate extends TestEventSourcedAggregate {
			protected override readonly handlers = {
				...testHandlers,
				TestEventActivated: (state: TestState): TestState => {
					this.apply(
						createDomainEvent("TestEventUpdated", {
							newValue: 9,
						}) as TestEventUpdated,
					);
					return { ...state, status: "active" };
				},
			};
		}
		const agg = new ReentrantAggregate("test-1" as TestId, {
			value: 1,
			status: "inactive",
		});

		expect(() =>
			agg.replayHistory([
				createDomainEvent("TestEventActivated", {}) as TestEventActivated,
			]),
		).toThrow(UnreplayableAggregateError);

		expect(agg.state).toEqual({ value: 1, status: "inactive" });
		expect(agg.version).toBe(0);
		expect(agg.pendingEvents).toHaveLength(0);
	});
});

describe("state changes only through events", () => {
	class BypassingAggregate extends TestEventSourcedAggregate {
		overwrite(value: number): void {
			this.setState({ ...this.state, value });
		}
	}

	it("rejects setState on an event-sourced aggregate", () => {
		const agg = new BypassingAggregate("test-1" as TestId, {
			value: 1,
			status: "inactive",
		});

		expect(() => agg.overwrite(2)).toThrow(DirectStateMutationError);

		expect(agg.state).toEqual({ value: 1, status: "inactive" });
		expect(agg.version).toBe(0);
		expect(agg.pendingEvents).toHaveLength(0);
	});

	it("names the aggregate and carries the wiring code", () => {
		const agg = new BypassingAggregate("test-1" as TestId, {
			value: 1,
			status: "inactive",
		});

		let caught: unknown;
		try {
			agg.overwrite(2);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(DirectStateMutationError);
		expect(caught).not.toBeInstanceOf(DomainError);
		expect((caught as DirectStateMutationError).code).toBe(
			"DIRECT_STATE_MUTATION",
		);
		expect((caught as DirectStateMutationError).aggregateId).toBe("test-1");
	});
});

const activated = (): TestEventActivated =>
	createDomainEvent("TestEventActivated", {}) as TestEventActivated;

const updated = (newValue: number): TestEventUpdated =>
	createDomainEvent("TestEventUpdated", { newValue }) as TestEventUpdated;

describe("apply and replay bookkeeping", () => {
	class ApplyingAggregate extends TestEventSourcedAggregate {
		applyEvent(event: TestEvent): void {
			this.apply(event);
		}
	}

	const fresh = (): ApplyingAggregate =>
		new ApplyingAggregate("test-1" as TestId, { value: 1, status: "inactive" });

	const lifecycleOf = (aggregate: object) => {
		const capability = pendingEventLifecycleCapabilityFor(aggregate);
		if (!capability) throw new Error("Missing test lifecycle capability");
		return capability;
	};

	it("keeps a fully addressed new event as the same object", () => {
		const agg = fresh();
		const event = createDomainEvent(
			"TestEventUpdated",
			{ newValue: 2 },
			{ aggregateId: "test-1", aggregateType: "TestEventSourcedAggregate" },
		) as TestEventUpdated;

		agg.applyEvent(event);

		expect(agg.pendingEvents[0]).toBe(event);
	});

	it("stamps the missing half of a partial address and keeps the identity", () => {
		const agg = fresh();
		const event = createDomainEvent(
			"TestEventUpdated",
			{ newValue: 2 },
			{ eventId: "evt-partial", aggregateId: "test-1" },
		) as TestEventUpdated;

		agg.applyEvent(event);

		const recorded = agg.pendingEvents[0];
		expect(recorded).not.toBe(event);
		expect(recorded?.aggregateType).toBe("TestEventSourcedAggregate");
		expect((recorded as TestEventUpdated).eventId).toBe("evt-partial");
		expect(isMintedEvent(recorded as object)).toBe(true);
	});

	it("stamps the missing id of a partial address that names only the type", () => {
		const agg = fresh();
		const event = createDomainEvent(
			"TestEventUpdated",
			{ newValue: 2 },
			{ aggregateType: "TestEventSourcedAggregate" },
		) as TestEventUpdated;

		agg.applyEvent(event);

		const recorded = agg.pendingEvents[0];
		expect(recorded).not.toBe(event);
		expect(recorded?.aggregateId).toBe("test-1");
		expect(recorded?.aggregateType).toBe("TestEventSourcedAggregate");
	});

	it("keeps persistedVersion undefined after an empty history on a fresh aggregate", () => {
		const agg = fresh();

		expect(agg.replayHistory([]).isOk()).toBe(true);

		expect(lifecycleOf(agg).persistedVersion()).toBeUndefined();
	});

	it("applies a new fact on top of a restored version", () => {
		const agg = fresh();
		expect(agg.replayHistory([activated(), updated(2)]).isOk()).toBe(true);

		agg.updateValue(4);

		expect(agg.version).toBe(3);
		expect(agg.state.value).toBe(4);
		expect(agg.pendingEvents).toHaveLength(1);
		expect(lifecycleOf(agg).persistedVersion()).toBe(2);
	});

	it("rolls back a foreign row to the restored baseline after earlier rows folded", () => {
		const agg = fresh();
		expect(agg.replayHistory([activated()]).isOk()).toBe(true);
		const foreign = createDomainEvent(
			"TestEventUpdated",
			{ newValue: 9 },
			{ aggregateId: "other", aggregateType: "TestEventSourcedAggregate" },
		) as TestEventUpdated;

		expect(() => agg.replayHistory([updated(5), foreign])).toThrow(
			ForeignEventError,
		);

		expect(agg.state).toEqual({ value: 1, status: "active" });
		expect(agg.version).toBe(1);
		expect(lifecycleOf(agg).persistedVersion()).toBe(1);
	});

	it.each([
		["first", (invalid: TestEventInvalid) => [invalid, updated(5)]],
		["last", (invalid: TestEventInvalid) => [updated(5), invalid]],
	])(
		"rolls back to the restored baseline when the %s row of a catch-up fails",
		(_position, history) => {
			const agg = new ValidatingAggregate("test-1" as TestId, {
				value: 1,
				status: "inactive",
			});
			expect(agg.replayHistory([activated()]).isOk()).toBe(true);
			const invalid = createDomainEvent(
				"TestEventInvalid",
				{},
			) as TestEventInvalid;

			const result = agg.replayHistory(history(invalid));

			expect(result.isErr()).toBe(true);
			expect(agg.state).toEqual({ value: 1, status: "active" });
			expect(agg.version).toBe(1);
			expect(lifecycleOf(agg).persistedVersion()).toBe(1);
		},
	);

	it("deep-freezes replayed state when deepFreezeState is on", () => {
		type Shelf = { items: Array<{ sku: string }> };
		type ItemAdded = DomainEvent<"ItemAdded", { sku: string }>;
		class ShelfAggregate extends EventSourcedAggregate<
			Shelf,
			TestId,
			ItemAdded
		> {
			protected readonly aggregateType = "ShelfAggregate";
			constructor(id: TestId) {
				super(id, { items: [] }, { deepFreezeState: true });
			}
			protected readonly handlers = {
				ItemAdded: (
					state: Shelf,
					event: UncommittedDomainEventOf<ItemAdded>,
				): Shelf => ({ items: [...state.items, { sku: event.payload.sku }] }),
			};
		}
		const shelf = new ShelfAggregate("shelf-1" as TestId);

		const result = shelf.replayHistory([
			createDomainEvent("ItemAdded", { sku: "sku-1" }) as ItemAdded,
		]);

		expect(result.isOk()).toBe(true);
		expect(Object.isFrozen(shelf.state.items)).toBe(true);
		expect(Object.isFrozen(shelf.state.items[0])).toBe(true);
	});
});

describe("replay routes a foreign-copy domain rejection into the Result", () => {
	// Structurally a DomainError from another loaded kit copy: not
	// instanceof this copy's class, but category "DOMAIN".
	class ForeignCopyDomainError extends Error {
		readonly category = "DOMAIN";
		readonly code = "FOREIGN_COPY_REJECTION";
	}

	class ForeignCopyAggregate extends TestEventSourcedAggregate {
		protected override readonly handlers = {
			...testHandlers,
			TestEventInvalid: (): TestState => {
				throw new ForeignCopyDomainError("rejected by another copy");
			},
		};
	}

	it("returns Err and rolls back instead of throwing", () => {
		const agg = new ForeignCopyAggregate("test-1" as TestId, {
			value: 1,
			status: "inactive",
		});

		const result = agg.replayHistory([
			createDomainEvent("TestEventActivated", {}) as TestEventActivated,
			createDomainEvent("TestEventInvalid", {}) as TestEventInvalid,
		]);

		expect(result.isErr()).toBe(true);
		if (result.isErr()) {
			expect(result.error).toBeInstanceOf(ForeignCopyDomainError);
		}
		expect(agg.state).toEqual({ value: 1, status: "inactive" });
		expect(agg.version).toBe(0);
	});
});

describe("reconstituteAggregateFromHistory", () => {
	const bare = (): TestEventSourcedAggregate =>
		new TestEventSourcedAggregate("test-1" as TestId, {
			value: 1,
			status: "inactive",
		});

	it("yields the folded aggregate on success", () => {
		const result = reconstituteAggregateFromHistory(bare, [
			activated(),
			updated(5),
		]);

		expect(result.isOk()).toBe(true);
		if (!result.isOk()) return;
		expect(result.value.state).toEqual({ value: 5, status: "active" });
		expect(result.value.version).toBe(2);
		expect(result.value.pendingEvents).toHaveLength(0);
	});

	it("yields nothing when a row is rejected: the caller holds no rolled-back instance", () => {
		let built = 0;
		const create = (): ValidatingAggregate => {
			built += 1;
			return new ValidatingAggregate("test-1" as TestId, {
				value: 1,
				status: "inactive",
			});
		};

		const result = reconstituteAggregateFromHistory(create, [
			activated(),
			createDomainEvent("TestEventInvalid", {}) as TestEventInvalid,
		]);

		expect(result.isErr()).toBe(true);
		expect(built).toBe(1);
		expect(result).not.toHaveProperty("value");
	});

	it("lets a throwing creator propagate: the creator runs outside the Result", () => {
		const rejectAll = (): void => {
			throw new NegativeValueError();
		};
		const createRejected = (): TestEventSourcedAggregate =>
			new TestEventSourcedAggregate(
				"test-1" as TestId,
				{ value: -1, status: "inactive" },
				{ validateState: rejectAll },
			);

		expect(() =>
			reconstituteAggregateFromHistory(createRejected, [activated()]),
		).toThrow(NegativeValueError);
	});

	it("throws for a foreign row, like replayHistory", () => {
		const foreign = createDomainEvent(
			"TestEventUpdated",
			{ newValue: 9 },
			{ aggregateId: "other", aggregateType: "TestEventSourcedAggregate" },
		) as TestEventUpdated;

		expect(() => reconstituteAggregateFromHistory(bare, [foreign])).toThrow(
			ForeignEventError,
		);
	});

	it("folds a tail onto the instance the creator restored", () => {
		const restoredAtTwo = (): TestEventSourcedAggregate => {
			const agg = bare();
			expect(agg.replayHistory([activated(), updated(2)]).isOk()).toBe(true);
			return agg;
		};

		const result = reconstituteAggregateFromHistory(restoredAtTwo, [
			updated(3),
		]);

		expect(result.isOk()).toBe(true);
		if (!result.isOk()) return;
		expect(result.value.version).toBe(3);
		expect(result.value.state.value).toBe(3);
	});
});

describe("one version write path", () => {
	class ObservingAggregate extends TestEventSourcedAggregate {
		readonly observed: number[] = [];

		protected override setVersion(version: Version): void {
			this.observed.push(version);
			super.setVersion(version);
		}
	}

	class LimitedAggregate extends TestEventSourcedAggregate {
		protected override setVersion(version: Version): void {
			if (version > 1) throw new Error("version limit");
			super.setVersion(version);
		}
	}

	it("lets a setVersion override observe the version a replay restores, once", () => {
		const agg = new ObservingAggregate("test-1" as TestId, {
			value: 1,
			status: "inactive",
		});

		expect(agg.replayHistory([activated(), updated(2)]).isOk()).toBe(true);
		agg.updateValue(3);

		expect(agg.observed).toEqual([2, 3]);
	});

	it("leaves state, pending list, and version untouched when the version write throws on apply", () => {
		const agg = new LimitedAggregate("test-1" as TestId, {
			value: 1,
			status: "inactive",
		});
		agg.updateValue(2);

		expect(() => agg.updateValue(3)).toThrow("version limit");

		expect(agg.state.value).toBe(2);
		expect(agg.version).toBe(1);
		expect(agg.pendingEvents).toHaveLength(1);
	});

	it("rolls a replay back when the version write throws at its final marker", () => {
		const agg = new LimitedAggregate("test-1" as TestId, {
			value: 1,
			status: "inactive",
		});

		expect(() => agg.replayHistory([activated(), updated(5)])).toThrow(
			"version limit",
		);

		expect(agg.state).toEqual({ value: 1, status: "inactive" });
		expect(agg.version).toBe(0);
		expect(agg.pendingEvents).toHaveLength(0);
	});
});
