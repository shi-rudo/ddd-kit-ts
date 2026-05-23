import { describe, expect, it } from "vitest";
import type { Id } from "../core/id";
import { isBaseError } from "@shirudo/base-error";
import { DomainError, MissingHandlerError } from "../core/errors";
import {
	EventSourcedAggregate,
	type EventSourcedAggregateConfig,
} from "./event-sourced-aggregate";
import {
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

class TestEventSourcedAggregate extends EventSourcedAggregate<
	TestState,
	TestEvent,
	TestId
> {
	constructor(
		id: TestId,
		initialState: TestState,
		config?: EventSourcedAggregateConfig,
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

		it("should not bump version when autoVersionBump is disabled", () => {
			class ManualVersionAggregate extends TestEventSourcedAggregate {
				constructor(id: TestId, initialState: TestState) {
					super(id, initialState, { autoVersionBump: false });
				}

				public testBumpVersion(): void {
					this.bumpVersion();
				}
			}

			const initialState: TestState = { value: 10, status: "inactive" };
			const aggregate = new ManualVersionAggregate("test-1" as TestId, initialState);

			aggregate.updateValue(20);
			expect(aggregate.version).toBe(0); // No auto-bump

			aggregate.testBumpVersion();
			expect(aggregate.version).toBe(1); // Manual bump
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
			// handler — that's a configuration / programming error, not a
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

			// State and version unchanged — no pending event added
			expect(aggregate.stateSnapshot()).toEqual(before);
			expect(aggregate.versionSnapshot()).toBe(versionBefore);
			expect(aggregate.hasPendingEvents()).toBe(false);
		});
	});

	describe("loadFromHistory", () => {
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

	describe("markPersisted (post-save hook)", () => {
		it("updates the version and clears pending events", () => {
			const aggregate = TestEventSourcedAggregate.create("test-1" as TestId, 10);
			aggregate.updateValue(20);

			expect(aggregate.version).toBeGreaterThan(0);
			expect(aggregate.pendingEvents.length).toBeGreaterThan(0);

			aggregate.markPersisted(99 as Version);

			expect(aggregate.version).toBe(99);
			expect(aggregate.pendingEvents).toHaveLength(0);
			expect(aggregate.hasPendingEvents()).toBe(false);
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

	describe("Helper methods", () => {
		it("should check if aggregate has pending events", () => {
			const aggregate = TestEventSourcedAggregate.create("test-1" as TestId, 10);

			expect(aggregate.hasPendingEvents()).toBe(true);
			expect(aggregate.getEventCount()).toBe(1);

			aggregate.clearPendingEvents();

			expect(aggregate.hasPendingEvents()).toBe(false);
			expect(aggregate.getEventCount()).toBe(0);
		});

		it("should get latest event", () => {
			const aggregate = TestEventSourcedAggregate.create("test-1" as TestId, 10);

			const latest = aggregate.getLatestEvent();
			expect(latest).toBeDefined();
			expect(latest?.type).toBe("TestEventCreated");

			aggregate.updateValue(20);

			const newLatest = aggregate.getLatestEvent();
			expect(newLatest?.type).toBe("TestEventUpdated");
		});

		it("should return undefined for latest event when no events exist", () => {
			const initialState: TestState = { value: 10, status: "inactive" };
			const aggregate = new TestEventSourcedAggregate("test-1" as TestId, initialState);

			expect(aggregate.getLatestEvent()).toBeUndefined();
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
});
