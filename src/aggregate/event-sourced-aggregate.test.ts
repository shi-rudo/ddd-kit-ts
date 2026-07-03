import { describe, expect, it } from "vitest";
import type { Id } from "../core/id";
import { isBaseError } from "@shirudo/base-error";
import { DomainError, MissingHandlerError } from "../core/errors";
import { EventSourcedAggregate } from "./event-sourced-aggregate";
import {
	type AggregateSnapshot,
	createDomainEvent,
	type DomainEvent,
	type Version,
} from "./aggregate";

type TestId = Id<"TestId">;

type TestState = {
	value: number;
	status: "active" | "inactive";
};

type TestEventCreated = DomainEvent<"TestEventCreated", { value: number }>;
type TestEventUpdated = DomainEvent<"TestEventUpdated", { newValue: number }>;
type TestEventActivated = DomainEvent<"TestEventActivated", {}>;
type TestEventDeactivated = DomainEvent<"TestEventDeactivated", {}>;
type TestEventInvalid = DomainEvent<"TestEventInvalid", {}>;

type TestEvent =
	| TestEventCreated
	| TestEventUpdated
	| TestEventActivated
	| TestEventDeactivated
	| TestEventInvalid;

class InvalidTestEventError extends DomainError {
	constructor(reason: string) {
		super(`Invalid test event: ${reason}`);
	}
}

class AlreadyActiveError extends DomainError {
	constructor() {
		super("Already active");
	}
}

class NegativeValueError extends DomainError {
	constructor() {
		super("value must not be negative");
	}
}

class TestEventSourcedAggregate extends EventSourcedAggregate<
	TestState,
	TestEvent,
	TestId
> {
	protected readonly aggregateType = "TestEventSourcedAggregate";

	constructor(id: TestId, initialState: TestState) {
		super(id, initialState);
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

	protected readonly handlers = {
		TestEventCreated: (state: TestState, event: TestEventCreated): TestState => ({
			...state,
			value: event.payload.value,
		}),
		TestEventUpdated: (
			state: TestState,
			event: TestEventUpdated,
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

class ValidatingAggregate extends EventSourcedAggregate<
	TestState,
	TestEvent,
	TestId
> {
	protected readonly aggregateType = "ValidatingAggregate";

	constructor(id: TestId, initialState: TestState) {
		super(id, initialState);
	}

	protected validateEvent(event: TestEvent): void {
		if (event.type === "TestEventInvalid") {
			throw new InvalidTestEventError("forbidden event type");
		}
	}

	protected readonly handlers = {
		TestEventCreated: (state: TestState, event: TestEventCreated): TestState => ({
			...state,
			value: event.payload.value,
		}),
		TestEventUpdated: (
			state: TestState,
			event: TestEventUpdated,
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

describe("EventSourcedAggregate", () => {
	describe("Automatic version bumping", () => {
		it("should automatically bump version when applying new events", () => {
			const aggregate = TestEventSourcedAggregate.create("test-1" as TestId, 10);

			expect(aggregate.version).toBe(1); // After creation event

			aggregate.updateValue(20);
			expect(aggregate.version).toBe(2);

			aggregate.activate();
			expect(aggregate.version).toBe(3);
		});

		it("should advance version by history.length on top of the existing version (not stomp it)", () => {
			const aggregate = TestEventSourcedAggregate.create("test-1" as TestId, 10);
			const initialVersion = aggregate.version; // 1 after creation

			const history: TestEvent[] = [
				createDomainEvent("TestEventUpdated", { newValue: 20 }) as TestEventUpdated,
				createDomainEvent("TestEventActivated", {}) as TestEventActivated,
			];

			aggregate.loadFromHistory(history);

			// Additive: version = startVersion + history.length (1 + 2 = 3)
			expect(aggregate.version).toBe(initialVersion + history.length);
		});
	});

	describe("Event validation", () => {
		it("should apply events when validation passes", () => {
			const aggregate = TestEventSourcedAggregate.create("test-1" as TestId, 10);

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

				protected validateEvent(event: TestEvent): void {
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
						event: TestEventCreated,
					): TestState => ({
						...state,
						value: event.payload.value,
					}),
					TestEventUpdated: (
						state: TestState,
						event: TestEventUpdated,
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
					(s: TestState, e: TestEvent) => TestState
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
					(s: TestState, e: TestEvent) => TestState
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
				(s: TestState, e: TestEvent) => TestState
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

				expect(() => aggregate.testApply(corrupt)).toThrow(
					MissingHandlerError,
				);
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
			// Never-persisted sentinel survives → follow-up save() routes to INSERT.
			expect(aggregate.persistedVersion).toBeUndefined();
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
			const aggregate = new TestEventSourcedAggregate("test-1" as TestId, initialState);

			const history: TestEvent[] = [
				createDomainEvent("TestEventUpdated", { newValue: 20 }) as TestEventUpdated,
				createDomainEvent("TestEventActivated", {}) as TestEventActivated,
				createDomainEvent("TestEventUpdated", { newValue: 30 }) as TestEventUpdated,
			];

			const result = aggregate.loadFromHistory(history);

			expect(result.isOk()).toBe(true);
			expect(aggregate.version).toBe(history.length); // 0 + 3 = 3
			expect(aggregate.state.value).toBe(30);
			expect(aggregate.state.status).toBe("active");
		});

		it("should advance version additively when called on a non-zero aggregate", () => {
			const aggregate = TestEventSourcedAggregate.create("test-1" as TestId, 10);
			expect(aggregate.version).toBe(1); // created event

			const history: TestEvent[] = [
				createDomainEvent("TestEventUpdated", { newValue: 20 }) as TestEventUpdated,
				createDomainEvent("TestEventUpdated", { newValue: 30 }) as TestEventUpdated,
			];

			const result = aggregate.loadFromHistory(history);

			expect(result.isOk()).toBe(true);
			expect(aggregate.version).toBe(3); // 1 + 2, not 2 (the bug stomped it)
		});

		it("should handle empty history", () => {
			const initialState: TestState = { value: 10, status: "inactive" };
			const aggregate = new TestEventSourcedAggregate("test-1" as TestId, initialState);

			const result = aggregate.loadFromHistory([]);

			expect(result.isOk()).toBe(true);
			expect(aggregate.version).toBe(0);
		});

		it("keeps the never-persisted sentinel on empty history (save must still INSERT)", () => {
			const initialState: TestState = { value: 10, status: "inactive" };
			const aggregate = new TestEventSourcedAggregate(
				"test-1" as TestId,
				initialState,
			);
			expect(aggregate.persistedVersion).toBeUndefined();

			const result = aggregate.loadFromHistory([]);

			expect(result.isOk()).toBe(true);
			// markRestored(0) would flip repository routing from INSERT to
			// UPDATE against a row that does not exist.
			expect(aggregate.persistedVersion).toBeUndefined();
		});

		it("should leave the aggregate's pre-existing version untouched on empty history", () => {
			const aggregate = TestEventSourcedAggregate.create("test-1" as TestId, 10);
			expect(aggregate.version).toBe(1);

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

			expect("changedKeys" in aggregate).toBe(false);
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
				this.apply(
					createDomainEvent("ItemAdded", { item }) as ItemAdded,
				);
			}

			protected readonly handlers = {
				ItemAdded: (
					state: NestedEsState,
					event: ItemAdded,
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

	describe("markPersisted (post-save hook)", () => {
		it("updates the version and clears pending events", () => {
			const aggregate = TestEventSourcedAggregate.create("test-1" as TestId, 10);
			aggregate.updateValue(20);

			expect(aggregate.version).toBeGreaterThan(0);
			expect(aggregate.pendingEvents.length).toBeGreaterThan(0);

			aggregate.markPersisted(99 as Version);

			expect(aggregate.version).toBe(99);
			expect(aggregate.pendingEvents).toHaveLength(0);
		});

		it("calls the onPersisted hook after clearing pendingEvents", () => {
			class HookingAggregate extends TestEventSourcedAggregate {
				public hookCalls: Array<{
					version: Version;
					pendingLengthDuringHook: number;
				}> = [];
				protected override onPersisted(version: Version): void {
					this.hookCalls.push({
						version,
						pendingLengthDuringHook: this.pendingEvents.length,
					});
				}
			}

			const aggregate = new HookingAggregate("hook-1" as TestId, {
				value: 10,
				status: "inactive",
			});
			aggregate.updateValue(20);

			aggregate.markPersisted(99 as Version);

			expect(aggregate.hookCalls).toHaveLength(1);
			expect(aggregate.hookCalls[0]!.version).toBe(99);
			// onPersisted runs AFTER pendingEvents is cleared, so subclass
			// hook code can never accidentally read stale events.
			expect(aggregate.hookCalls[0]!.pendingLengthDuringHook).toBe(0);
		});

		it("documents the footgun: overriding markPersisted without super leaks pendingEvents (use onPersisted instead)", () => {
			// NEGATIVE example: this is the bug pattern observed in
			// production usage. Override markPersisted directly, forget
			// super, framework cleanup never runs, next withCommit
			// re-dispatches the same events.
			class BuggyAggregate extends TestEventSourcedAggregate {
				public sideEffectFired = false;
				public override markPersisted(_version: Version): void {
					this.sideEffectFired = true;
					// MISSING: super.markPersisted(_version)
				}
			}

			const buggy = new BuggyAggregate("bug-1" as TestId, {
				value: 10,
				status: "inactive",
			});
			buggy.updateValue(20);
			buggy.markPersisted(7 as Version);

			expect(buggy.sideEffectFired).toBe(true);
			// THE BUG: events still in pendingEvents.
			expect(buggy.pendingEvents.length).toBeGreaterThan(0);

			// ✅ Same intent via onPersisted: framework cleans up first.
			class FixedAggregate extends TestEventSourcedAggregate {
				public sideEffectFired = false;
				protected override onPersisted(_version: Version): void {
					this.sideEffectFired = true;
				}
			}

			const fixed = new FixedAggregate("fix-1" as TestId, {
				value: 10,
				status: "inactive",
			});
			fixed.updateValue(20);
			fixed.markPersisted(7 as Version);

			expect(fixed.sideEffectFired).toBe(true);
			expect(fixed.pendingEvents).toHaveLength(0);
		});
	});

	describe("pendingEvents getter encapsulation", () => {
		it("does not leak the internal pendingEvents array", () => {
			const aggregate = TestEventSourcedAggregate.create("test-1" as TestId, 10);
			const eventsBefore = aggregate.pendingEvents.length;

			const leaked = aggregate.pendingEvents as unknown as unknown[];
			expect(() => leaked.push({ fake: "event" })).toThrow();

			expect(aggregate.pendingEvents.length).toBe(eventsBefore);
		});
	});

	describe("Snapshots", () => {
		it("should create snapshot with current state and version", () => {
			const aggregate = TestEventSourcedAggregate.create("test-1" as TestId, 10);
			aggregate.updateValue(20);
			aggregate.activate();

			const snapshot = aggregate.createSnapshot();

			expect(snapshot.state.value).toBe(20);
			expect(snapshot.state.status).toBe("active");
			expect(snapshot.version).toBe(3);
			expect(snapshot.snapshotAt).toBeInstanceOf(Date);
		});

		it("should restore from snapshot with events", () => {
			const aggregate1 = TestEventSourcedAggregate.create("test-1" as TestId, 10);
			aggregate1.updateValue(20);
			aggregate1.activate();

			const snapshot = aggregate1.createSnapshot();

			// Create new aggregate and restore from snapshot
			const initialState: TestState = { value: 0, status: "inactive" };
			const aggregate2 = new TestEventSourcedAggregate("test-1" as TestId, initialState);

			const eventsAfterSnapshot: TestEvent[] = [
				createDomainEvent("TestEventUpdated", { newValue: 30 }) as TestEventUpdated,
			];

			const result = aggregate2.restoreFromSnapshotWithEvents(snapshot, eventsAfterSnapshot);

			expect(result.isOk()).toBe(true);
			expect(aggregate2.state.value).toBe(30); // Updated by event after snapshot
			expect(aggregate2.state.status).toBe("active"); // From snapshot
			expect(aggregate2.version).toBe(4); // Snapshot version + events after
		});

		it("should restore from snapshot with no events after", () => {
			const aggregate1 = TestEventSourcedAggregate.create("test-1" as TestId, 10);
			aggregate1.updateValue(20);

			const snapshot = aggregate1.createSnapshot();

			const initialState: TestState = { value: 0, status: "inactive" };
			const aggregate2 = new TestEventSourcedAggregate("test-1" as TestId, initialState);

			const result = aggregate2.restoreFromSnapshotWithEvents(snapshot, []);

			expect(result.isOk()).toBe(true);
			expect(aggregate2.state.value).toBe(20);
			expect(aggregate2.version).toBe(2);
		});

		it("should deep-clone the snapshot when restoring: caller mutations don't leak in", () => {
			const snapshot: AggregateSnapshot<TestState> = {
				state: { value: 42, status: "active" },
				version: 5 as Version,
				snapshotAt: new Date(),
			};

			const initialState: TestState = { value: 0, status: "inactive" };
			const aggregate = new TestEventSourcedAggregate("test-1" as TestId, initialState);
			const result = aggregate.restoreFromSnapshotWithEvents(snapshot, []);

			expect(result.isOk()).toBe(true);

			// Mutate the original snapshot AFTER restore. The aggregate must be isolated.
			snapshot.state.value = 999;
			snapshot.state.status = "inactive";

			expect(aggregate.state.value).toBe(42);
			expect(aggregate.state.status).toBe("active");
		});

		it("returns Err and leaves the aggregate untouched when the snapshot state violates validateState", () => {
			// A corrupt snapshot store must not reconstitute an invalid
			// aggregate: restoreFromSnapshotWithEvents has to run the same
			// validateState guard AggregateRoot.restoreFromSnapshot runs.
			// With zero events after the snapshot no validateEvent runs
			// either, so this is the path where corruption slips through.
			class StateValidatingAggregate extends EventSourcedAggregate<
				TestState,
				TestEvent,
				TestId
			> {
				protected readonly aggregateType = "StateValidatingAggregate";

				constructor(id: TestId, initialState: TestState) {
					super(id, initialState);
				}

				protected validateState(state: TestState): void {
					if (state.value < 0) {
						throw new NegativeValueError();
					}
				}

				protected readonly handlers = {
					TestEventCreated: (
						state: TestState,
						event: TestEventCreated,
					): TestState => ({ ...state, value: event.payload.value }),
					TestEventUpdated: (
						state: TestState,
						event: TestEventUpdated,
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

			const originalState: TestState = { value: 5, status: "inactive" };
			const aggregate = new StateValidatingAggregate(
				"test-1" as TestId,
				originalState,
			);
			const originalVersion = aggregate.version;

			const corrupt: AggregateSnapshot<TestState> = {
				state: { value: -1, status: "active" },
				version: 7 as Version,
				snapshotAt: new Date(),
			};

			// Zero events after the snapshot: without the guard, NO
			// validation at all would run on this path.
			const bare = aggregate.restoreFromSnapshotWithEvents(corrupt, []);
			expect(bare.isErr()).toBe(true);
			if (bare.isErr()) {
				expect(bare.error).toBeInstanceOf(NegativeValueError);
			}
			expect(aggregate.state).toEqual(originalState);
			expect(aggregate.version).toBe(originalVersion);
			expect(aggregate.persistedVersion).toBeUndefined();

			// Same guard when valid events follow the corrupt snapshot.
			const withEvents = aggregate.restoreFromSnapshotWithEvents(corrupt, [
				createDomainEvent("TestEventUpdated", {
					newValue: 30,
				}) as TestEventUpdated,
			]);
			expect(withEvents.isErr()).toBe(true);
			expect(aggregate.state).toEqual(originalState);
			expect(aggregate.version).toBe(originalVersion);
		});

		it("should roll back state + version when an event mid-stream fails validation", () => {
			// aggregate1 produces a snapshot at v=3, value=20, status=active
			const aggregate1 = TestEventSourcedAggregate.create("test-1" as TestId, 10);
			aggregate1.updateValue(20);
			aggregate1.activate();
			const snapshot = aggregate1.createSnapshot();

			// aggregate2 starts in a different state; the failed restore must leave it untouched
			const originalState: TestState = { value: 555, status: "inactive" };
			const aggregate2 = new ValidatingAggregate(
				"test-1" as TestId,
				originalState,
			);
			const originalVersion = aggregate2.version;

			const eventsAfterSnapshot: TestEvent[] = [
				createDomainEvent("TestEventUpdated", {
					newValue: 30,
				}) as TestEventUpdated,
				createDomainEvent("TestEventInvalid", {}) as TestEventInvalid, // rejected
				createDomainEvent("TestEventUpdated", {
					newValue: 40,
				}) as TestEventUpdated,
			];

			const result = aggregate2.restoreFromSnapshotWithEvents(
				snapshot,
				eventsAfterSnapshot,
			);

			// Result reports the failure
			expect(result.isErr()).toBe(true);

			// And the aggregate is back to its pre-call state (atomic restore)
			expect(aggregate2.state).toEqual(originalState);
			expect(aggregate2.version).toBe(originalVersion);
		});
	});

	describe("Snapshots with class-based child entities (toSnapshotState/fromSnapshotState)", () => {
		class LineItem {
			constructor(
				readonly sku: string,
				public qty: number,
			) {}

			toPlainData(): { sku: string; qty: number } {
				return { sku: this.sku, qty: this.qty };
			}

			static fromPlainData(d: { sku: string; qty: number }): LineItem {
				return new LineItem(d.sku, d.qty);
			}
		}

		type CartState = { items: LineItem[] };
		type CartSnapshotState = { items: Array<{ sku: string; qty: number }> };
		type ItemAdded = DomainEvent<"ItemAdded", { sku: string }>;
		type CartEvent = ItemAdded;

		class Cart extends EventSourcedAggregate<
			CartState,
			CartEvent,
			TestId,
			CartSnapshotState
		> {
			protected readonly aggregateType = "Cart";

			constructor(id: TestId, state: CartState) {
				super(id, state);
			}

			protected readonly handlers = {
				ItemAdded: (state: CartState, e: ItemAdded): CartState => ({
					items: [...state.items, new LineItem(e.payload.sku, 1)],
				}),
			};

			protected override toSnapshotState(state: CartState): CartSnapshotState {
				return { items: state.items.map((i) => i.toPlainData()) };
			}

			protected override fromSnapshotState(
				stored: CartSnapshotState,
			): CartState {
				return { items: stored.items.map(LineItem.fromPlainData) };
			}
		}

		it("restoreFromSnapshotWithEvents revives class children and replays events on top", () => {
			const cart = new Cart("agg-1" as TestId, {
				items: [new LineItem("sku-a", 2)],
			});
			const snapshot = cart.createSnapshot();
			expect(Object.getPrototypeOf(snapshot.state.items[0])).toBe(
				Object.prototype,
			);

			const restored = new Cart("agg-1" as TestId, { items: [] });
			const result = restored.restoreFromSnapshotWithEvents(snapshot, [
				createDomainEvent("ItemAdded", { sku: "sku-b" }) as ItemAdded,
			]);

			expect(result.isOk()).toBe(true);
			expect(restored.state.items[0]).toBeInstanceOf(LineItem);
			expect(restored.state.items[0]?.toPlainData()).toEqual({
				sku: "sku-a",
				qty: 2,
			});
			expect(restored.state.items[1]?.sku).toBe("sku-b");
		});

		it("default createSnapshot fails fast on a Promise in state instead of DataCloneError", () => {
			type JobState = { pending: Promise<number> };
			class JobAggregate extends EventSourcedAggregate<
				JobState,
				CartEvent,
				TestId
			> {
				protected readonly aggregateType = "JobAggregate";
				constructor(id: TestId, state: JobState) {
					super(id, state);
				}
				protected readonly handlers = {
					ItemAdded: (s: JobState): JobState => s,
				};
			}
			const agg = new JobAggregate("agg-1" as TestId, {
				pending: Promise.resolve(1),
			});

			expect(() => agg.createSnapshot()).toThrow(/Promise/);
			expect(() => agg.createSnapshot()).toThrow(/toSnapshotState/);
		});
	});

	describe("persistedVersion + markRestored (Insert-vs-Update + OCC baseline)", () => {
		it("persistedVersion is undefined on a freshly-constructed aggregate", () => {
			const agg = new TestEventSourcedAggregate("id-1" as TestId, {
				value: 0,
				status: "inactive",
			});

			expect(agg.version).toBe(0);
			expect(agg.persistedVersion).toBeUndefined();
		});

		it("persistedVersion stays undefined after apply()-ing new events on a never-persisted aggregate", () => {
			// Factory + edit-before-save flow. `version` advances past 0
			// in memory; `persistedVersion` must remain undefined so save()
			// routes to INSERT / append-from-zero, not a stream-revision
			// check against a stream that doesn't exist.
			const agg = TestEventSourcedAggregate.create("id-1" as TestId, 42);
			agg.updateValue(100);
			agg.activate();

			expect(agg.version).toBe(3);
			expect(agg.persistedVersion).toBeUndefined();
		});

		it("markRestored does NOT fire the onPersisted hook", () => {
			class HookSpyAggregate extends TestEventSourcedAggregate {
				public hookCalls: Version[] = [];
				protected override onPersisted(version: Version): void {
					this.hookCalls.push(version);
				}
				public callMarkRestored(version: Version): void {
					this.markRestored(version);
				}
			}

			const agg = new HookSpyAggregate("id-1" as TestId, {
				value: 1,
				status: "inactive",
			});
			agg.callMarkRestored(3 as Version);

			expect(agg.hookCalls).toEqual([]);
		});

		it("loadFromHistory aligns persistedVersion to the final post-replay version", () => {
			const agg = new TestEventSourcedAggregate("id-1" as TestId, {
				value: 0,
				status: "inactive",
			});
			expect(agg.persistedVersion).toBeUndefined();

			const history: TestEvent[] = [
				createDomainEvent("TestEventCreated", { value: 1 }) as TestEventCreated,
				createDomainEvent("TestEventUpdated", { newValue: 2 }) as TestEventUpdated,
				createDomainEvent("TestEventActivated", {}) as TestEventActivated,
			];

			const result = agg.loadFromHistory(history);
			expect(result.isOk()).toBe(true);
			expect(agg.version).toBe(3);
			expect(agg.persistedVersion).toBe(3); // baseline = post-replay version
		});

		it("new events after loadFromHistory bump version but not persistedVersion", () => {
			const agg = new TestEventSourcedAggregate("id-1" as TestId, {
				value: 0,
				status: "inactive",
			});
			const history: TestEvent[] = [
				createDomainEvent("TestEventCreated", { value: 1 }) as TestEventCreated,
				createDomainEvent("TestEventUpdated", { newValue: 2 }) as TestEventUpdated,
			];
			agg.loadFromHistory(history);
			expect(agg.persistedVersion).toBe(2);

			// Domain method appends a new event.
			agg.updateValue(99);

			expect(agg.version).toBe(3);
			expect(agg.persistedVersion).toBe(2); // OCC baseline unchanged
			expect(agg.pendingEvents).toHaveLength(1);
		});

		it("markPersisted updates persistedVersion AND fires onPersisted", () => {
			class HookSpyAggregate extends TestEventSourcedAggregate {
				public hookCalls: Version[] = [];
				protected override onPersisted(version: Version): void {
					this.hookCalls.push(version);
				}
			}

			const agg = new HookSpyAggregate("id-1" as TestId, {
				value: 0,
				status: "inactive",
			});
			agg.updateValue(1);
			expect(agg.persistedVersion).toBeUndefined();

			agg.markPersisted(1 as Version);

			expect(agg.version).toBe(1);
			expect(agg.persistedVersion).toBe(1);
			expect(agg.hookCalls).toEqual([1]);
		});

		it("restoreFromSnapshotWithEvents aligns persistedVersion to the final version", () => {
			const agg = new TestEventSourcedAggregate("id-1" as TestId, {
				value: 0,
				status: "inactive",
			});

			const snapshot: AggregateSnapshot<TestState> = {
				state: { value: 50, status: "active" },
				version: 5 as Version,
				snapshotAt: new Date(),
			};
			const eventsAfterSnapshot: TestEvent[] = [
				createDomainEvent("TestEventUpdated", { newValue: 51 }) as TestEventUpdated,
				createDomainEvent("TestEventUpdated", { newValue: 52 }) as TestEventUpdated,
			];

			const result = agg.restoreFromSnapshotWithEvents(snapshot, eventsAfterSnapshot);
			expect(result.isOk()).toBe(true);
			expect(agg.version).toBe(7);
			expect(agg.persistedVersion).toBe(7);
		});

		it("loadFromHistory failure preserves persistedVersion at the pre-call baseline", () => {
			const agg = new ValidatingAggregate("id-1" as TestId, {
				value: 0,
				status: "inactive",
			});
			// Establish a prior persisted baseline.
			agg.markPersisted(2 as Version);
			const baselineBefore = agg.persistedVersion;

			// Second event triggers ValidatingAggregate.validateEvent.
			const history: TestEvent[] = [
				createDomainEvent("TestEventUpdated", { newValue: 1 }) as TestEventUpdated,
				createDomainEvent("TestEventInvalid", {}) as TestEventInvalid,
			];

			const result = agg.loadFromHistory(history);
			expect(result.isErr()).toBe(true);
			// persistedVersion is invariant during the loop and the final
			// markRestored is only called on the success path, so the
			// baseline stays where it was before loadFromHistory was called.
			expect(agg.persistedVersion).toBe(baselineBefore);
		});

		it("loadFromHistory failure on a fresh aggregate keeps persistedVersion undefined", () => {
			const agg = new ValidatingAggregate("id-1" as TestId, {
				value: 0,
				status: "inactive",
			});
			expect(agg.persistedVersion).toBeUndefined();

			const history: TestEvent[] = [
				createDomainEvent("TestEventUpdated", { newValue: 1 }) as TestEventUpdated,
				createDomainEvent("TestEventInvalid", {}) as TestEventInvalid,
			];

			const result = agg.loadFromHistory(history);
			expect(result.isErr()).toBe(true);
			// The "never persisted" sentinel survives a failed load: a
			// follow-up save() must still route to INSERT, not UPDATE
			// against a baseline that loadFromHistory never wrote.
			expect(agg.persistedVersion).toBeUndefined();
		});

		it("multi-save cycle: persistedVersion advances on each markPersisted across save iterations", () => {
			const agg = TestEventSourcedAggregate.create("id-1" as TestId, 10);
			// First save: create event landed at v1.
			expect(agg.version).toBe(1);
			expect(agg.persistedVersion).toBeUndefined();

			agg.markPersisted(1 as Version);
			expect(agg.persistedVersion).toBe(1);

			// Second save cycle: one more event, then save at v2.
			agg.updateValue(20);
			expect(agg.version).toBe(2);
			expect(agg.persistedVersion).toBe(1);

			agg.markPersisted(2 as Version);
			expect(agg.persistedVersion).toBe(2);

			// Third save cycle: another event, save at v3.
			agg.activate();
			expect(agg.version).toBe(3);
			expect(agg.persistedVersion).toBe(2);

			agg.markPersisted(3 as Version);
			expect(agg.persistedVersion).toBe(3);
		});

		it("restoreFromSnapshotWithEvents rolls back persistedVersion when an event fails mid-stream", () => {
			const agg = new ValidatingAggregate("id-1" as TestId, {
				value: 0,
				status: "inactive",
			});
			// Establish a prior persisted baseline.
			agg.markPersisted(2 as Version);
			const baselineBeforeRestore = agg.persistedVersion;

			const snapshot: AggregateSnapshot<TestState> = {
				state: { value: 50, status: "active" },
				version: 5 as Version,
				snapshotAt: new Date(),
			};
			// Second event triggers validateEvent in ValidatingAggregate.
			const eventsAfterSnapshot: TestEvent[] = [
				createDomainEvent("TestEventUpdated", { newValue: 51 }) as TestEventUpdated,
				createDomainEvent("TestEventInvalid", {}) as TestEventInvalid,
			];

			const result = agg.restoreFromSnapshotWithEvents(snapshot, eventsAfterSnapshot);
			expect(result.isErr()).toBe(true);
			// Rolled back: persistedVersion is back to the pre-call baseline.
			expect(agg.persistedVersion).toBe(baselineBeforeRestore);
		});
	});
});
