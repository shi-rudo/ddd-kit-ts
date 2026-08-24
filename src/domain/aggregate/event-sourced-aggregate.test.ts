import { isBaseError } from "@shirudo/base-error";
import { describe, expect, it, vi } from "vite-plus/test";
import {
	DomainError,
	ForeignEventError,
	HandlerReturnedNoStateError,
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
import { EventSourcedAggregate as ProductionEventSourcedAggregate } from "./event-sourced-aggregate";
import { pendingEventLifecycleCapabilityFor } from "./pending-event-lifecycle";

function acknowledgePersisted(aggregate: object, version: Version): void {
	const capability = pendingEventLifecycleCapabilityFor(aggregate);
	if (!capability) throw new Error("Missing test persistence capability");
	void version;
	capability.acknowledge(
		(aggregate as { pendingEvents: ReadonlyArray<unknown> }).pendingEvents,
	);
}

function discardPendingEvents(aggregate: object): void {
	const capability = pendingEventLifecycleCapabilityFor(aggregate);
	if (!capability) throw new Error("Missing test persistence capability");
	capability.discardPendingEvents(
		(aggregate as { pendingEvents: ReadonlyArray<unknown> }).pendingEvents,
	);
}

/** White-box fixture only: production aggregate subclasses keep `state` protected. */
abstract class EventSourcedAggregate<
	TState,
	TEvent extends AnyDomainEvent,
	TId extends Id<string>,
> extends ProductionEventSourcedAggregate<TState, TEvent, TId> {
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
	TestEvent,
	TestId
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

	replayLikeLegacy(event: TestEventUpdated): void {
		// @ts-expect-error the isNew flag argument is gone: apply() always records; replay goes through loadFromHistory
		this.apply(event, false);
	}

	protected readonly handlers = testHandlers;
}

class ValidatingAggregate extends EventSourcedAggregate<
	TestState,
	TestEvent,
	TestId
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

			aggregate.loadFromHistory(history);

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
				TestEvent,
				TestId
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

				protected readonly handlers = {
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
				TestEvent,
				TestId
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

		it("MissingHandlerError thrown during loadFromHistory propagates (not caught as DomainError)", () => {
			class HandlerlessReplay extends EventSourcedAggregate<
				TestState,
				TestEvent,
				TestId
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

			// loadFromHistory only catches DomainError; a MissingHandlerError
			// (programming bug) should propagate up unwrapped, not get
			// silently wrapped into Result.Err.
			expect(() => {
				aggregate.loadFromHistory([
					createDomainEvent("TestEventCreated", {
						value: 1,
					}) as TestEventCreated,
				]);
			}).toThrow(MissingHandlerError);
		});

		it("should not mutate state if handler throws", () => {
			class ThrowingHandlerAggregate extends EventSourcedAggregate<
				TestState,
				TestEvent,
				TestId
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
			TestEvent,
			TestId
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

		it("propagates MissingHandlerError from loadFromHistory for a corrupt stream row", () => {
			const aggregate = new TrapAggregate("test-1" as TestId, {
				value: 7,
				status: "inactive",
			});

			const corrupt = createDomainEvent("toString", {
				evil: true,
			}) as unknown as TestEvent;

			expect(() => aggregate.loadFromHistory([corrupt])).toThrow(
				MissingHandlerError,
			);
			expect(aggregate.state).toEqual({ value: 7, status: "inactive" });
		});
	});

	describe("loadFromHistory", () => {
		it("rolls back state when a mid-stream event throws a DomainError (all-or-nothing)", () => {
			const aggregate = new ValidatingAggregate("test-1" as TestId, {
				value: 10,
				status: "inactive",
			});

			const result = aggregate.loadFromHistory([
				createDomainEvent("TestEventUpdated", {
					newValue: 99,
				}) as TestEventUpdated,
				createDomainEvent("TestEventInvalid", {}) as TestEventInvalid,
			]);

			expect(result.isErr()).toBe(true);
			// The valid first event must not leak into state, the same
			// all-or-nothing contract as restoreFromSnapshotWithEvents.
			expect(aggregate.state).toEqual({ value: 10, status: "inactive" });
			expect(aggregate.version).toBe(0);
		});

		it("rolls back state when a mid-stream row propagates a non-domain error", () => {
			const aggregate = new ValidatingAggregate("test-1" as TestId, {
				value: 10,
				status: "inactive",
			});

			expect(() =>
				aggregate.loadFromHistory([
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

			const result = aggregate.loadFromHistory(history);

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
					aggregate.loadFromHistory(history);
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

			const result = aggregate.loadFromHistory([
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

			const result = aggregate.loadFromHistory(history);

			expect(result.isOk()).toBe(true);
			expect(aggregate.version).toBe(3); // 1 + 2, not 2 (the bug stomped it)
		});

		it("should handle empty history", () => {
			const initialState: TestState = { value: 10, status: "inactive" };
			const aggregate = new TestEventSourcedAggregate(
				"test-1" as TestId,
				initialState,
			);

			const result = aggregate.loadFromHistory([]);

			expect(result.isOk()).toBe(true);
			expect(aggregate.version).toBe(0);
		});

		it("keeps version zero on empty history while persistence lifecycle stays external", () => {
			const initialState: TestState = { value: 10, status: "inactive" };
			const aggregate = new TestEventSourcedAggregate(
				"test-1" as TestId,
				initialState,
			);

			const result = aggregate.loadFromHistory([]);

			expect(result.isOk()).toBe(true);
			// markRestored(0) would flip repository routing from INSERT to
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

			expect(() => aggregate.loadFromHistory([])).toThrow(
				UnreplayableAggregateError,
			);
		});

		it("allows empty history for a persisted aggregate (no-op catch-up)", () => {
			const aggregate = TestEventSourcedAggregate.create(
				"test-1" as TestId,
				10,
			);
			acknowledgePersisted(aggregate, aggregate.version);

			const result = aggregate.loadFromHistory([]);

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

			const result = aggregate.loadFromHistory(history);

			expect(result.isErr()).toBe(true);
			if (result.isErr()) {
				expect(result.error).toBeInstanceOf(InvalidTestEventError);
			}
		});
	});

	describe("dirty-tracking isolation", () => {
		it("has no changedKeys/hasChanges: pendingEvents IS the change record", () => {
			// Dirty tracking lives on AggregateRoot only. An event-sourced
			// aggregate's change record is its pendingEvents; partial-write
			// repos type against the concrete state-stored class instead.
			const aggregate = TestEventSourcedAggregate.create(
				"test-1" as TestId,
				10,
			);
			expect("hasChanges" in aggregate).toBe(false);
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
			ItemAdded,
			TestId
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

		it("does not expose acknowledgement or event disposal on aggregates", () => {
			const aggregate = new TestEventSourcedAggregate("test-1" as TestId, {
				value: 10,
				status: "inactive",
			});

			expect("markPersisted" in aggregate).toBe(false);
			expect("clearPendingEvents" in aggregate).toBe(false);
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
		TestEvent,
		TestId
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

		protected readonly handlers = {
			TestEventCreated: (
				state: TestState,
				event: TestEventCreatedDecision,
			): TestState => ({ ...state, value: event.payload.value }),
			TestEventUpdated: (
				state: TestState,
				event: TestEventUpdatedDecision,
			): TestState => ({ ...state, value: event.payload.newValue }),
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
	}

	it("replays history that today's decision rules would reject", () => {
		const agg = new RuleTighteningAggregate("test-1" as TestId, {
			value: 0,
			status: "inactive",
		});

		const result = agg.loadFromHistory([
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
			agg.loadFromHistory([
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
			agg.loadFromHistory([
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
		// The recordEvent guarantee, now by construction on apply itself:
		// an address-less event cannot mutate state and then fail later
		// at harvest (withCommit) or on the next load (replay guard).
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

	it("recognizes events minted by another copy of the kit via the cooperative brand", () => {
		// A duplicate npm dependency or a plugin bundle loads a second
		// copy of the kit whose WeakSet this instance cannot see. Such an
		// event carries the global-registry mint brand instead; the gate
		// accepts it. The brand is cooperative by design (the gate catches
		// accidental literals, it is not a security boundary).
		const agg = new RuleTighteningAggregate("test-1" as TestId, {
			value: 0,
			status: "inactive",
		});
		const minted = createDomainEvent("TestEventUpdated", {
			newValue: 3,
		}) as TestEventUpdated;
		// Simulate instance B's output: same shape, same brand, foreign WeakSet.
		const foreignInstanceEvent = { ...minted };
		Object.defineProperty(
			foreignInstanceEvent,
			Symbol.for("@shirudo/ddd-kit.mintedEvent"),
			{ value: true, enumerable: false },
		);
		Object.freeze(foreignInstanceEvent);

		agg.testApply(foreignInstanceEvent as TestEventUpdated);

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

		const result = agg.loadFromHistory([row]);

		expect(result.isOk()).toBe(true);
		expect(agg.state.value).toBe(7);
	});

	it("accepts replayed events that carry the matching address", () => {
		const agg = new RuleTighteningAggregate("test-1" as TestId, {
			value: 10,
			status: "inactive",
		});

		const result = agg.loadFromHistory([
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

	it("replays history without running validateState", () => {
		const agg = guarded({ value: 1, status: "inactive" });

		const result = agg.loadFromHistory([
			createDomainEvent("TestEventUpdated", {
				newValue: -9,
			}) as TestEventUpdated,
		]);

		expect(result.isOk()).toBe(true);
		expect(agg.state.value).toBe(-9);
		expect(agg.version).toBe(1);
	});
});

describe("a handler that returns no state", () => {
	class ForgetfulAggregate extends EventSourcedAggregate<
		TestState,
		TestEvent,
		TestId
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

	it("propagates HandlerReturnedNoStateError from loadFromHistory after rolling back", () => {
		const agg = new ForgetfulAggregate("test-1" as TestId, {
			value: 1,
			status: "inactive",
		});

		expect(() =>
			agg.loadFromHistory([
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
