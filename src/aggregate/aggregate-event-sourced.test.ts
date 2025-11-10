import { describe, expect, it } from "vitest";
import { err, ok } from "../core/result";
import type { Id } from "../core/id";
import {
	AggregateEventSourced,
	type AggregateEventSourcedConfig,
} from "./aggregate-event-sourced";
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

class TestAggregateEventSourced extends AggregateEventSourced<
	TestState,
	TestEvent,
	TestId
> {
	constructor(
		id: TestId,
		initialState: TestState,
		config?: AggregateEventSourcedConfig,
	) {
		super(id, initialState, config);
	}

	static create(id: TestId, value: number): TestAggregateEventSourced {
		const initialState: TestState = {
			value,
			status: "inactive",
		};
		const aggregate = new TestAggregateEventSourced(id, initialState);
		const result = aggregate.apply(
			createDomainEvent("TestEventCreated", { value }) as TestEventCreated,
		);
		if (!result.ok) {
			throw new Error(result.error);
		}
		return aggregate;
	}

	updateValue(newValue: number): void {
		const result = this.apply(
			createDomainEvent("TestEventUpdated", { newValue }) as TestEventUpdated,
		);
		if (!result.ok) {
			throw new Error(result.error);
		}
	}

	activate(): void {
		const result = this.apply(
			createDomainEvent("TestEventActivated", {}) as TestEventActivated,
		);
		if (!result.ok) {
			throw new Error(result.error);
		}
	}

	deactivate(): void {
		const result = this.apply(
			createDomainEvent("TestEventDeactivated", {}) as TestEventDeactivated,
		);
		if (!result.ok) {
			throw new Error(result.error);
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

class ValidatingAggregate extends AggregateEventSourced<
	TestState,
	TestEvent,
	TestId
> {
	constructor(id: TestId, initialState: TestState) {
		super(id, initialState);
	}

	protected validateEvent(event: TestEvent): ReturnType<
		AggregateEventSourced<TestState, TestEvent, TestId>["validateEvent"]
	> {
		if (event.type === "TestEventInvalid") {
			return err("Invalid event type");
		}
		return ok(true);
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

describe("AggregateEventSourced", () => {
	describe("Automatic version bumping", () => {
		it("should automatically bump version when applying new events", () => {
			const aggregate = TestAggregateEventSourced.create("test-1" as TestId, 10);

			expect(aggregate.version).toBe(1); // After creation event

			aggregate.updateValue(20);
			expect(aggregate.version).toBe(2);

			aggregate.activate();
			expect(aggregate.version).toBe(3);
		});

		it("should not bump version when autoVersionBump is disabled", () => {
			class ManualVersionAggregate extends TestAggregateEventSourced {
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

		it("should not bump version when loading from history", () => {
			const aggregate = TestAggregateEventSourced.create("test-1" as TestId, 10);
			const initialVersion = aggregate.version;

			const history: TestEvent[] = [
				createDomainEvent("TestEventUpdated", { newValue: 20 }) as TestEventUpdated,
				createDomainEvent("TestEventActivated", {}) as TestEventActivated,
			];

			aggregate.loadFromHistory(history);

			// Version should be set to history length, not bumped per event
			expect(aggregate.version).toBe(history.length);
			expect(aggregate.version).not.toBe(initialVersion + history.length);
		});
	});

	describe("Event validation", () => {
		it("should apply events when validation passes", () => {
			const aggregate = TestAggregateEventSourced.create("test-1" as TestId, 10);

			aggregate.updateValue(20);

			expect(aggregate.state.value).toBe(20);
		});

		it("should return error result when validation fails", () => {
			class TestValidatingAggregate extends ValidatingAggregate {
				public testApply(event: TestEvent) {
					return this.apply(event);
				}
			}

			const initialState: TestState = { value: 10, status: "inactive" };
			const aggregate = new TestValidatingAggregate("test-1" as TestId, initialState);

			const result = aggregate.testApply(
				createDomainEvent("TestEventInvalid", {}) as TestEventInvalid,
			);

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toContain("Event validation failed");
			}
		});

		it("should throw error when validation fails with applyUnsafe", () => {
			class TestValidatingAggregate extends ValidatingAggregate {
				public testApplyUnsafe(event: TestEvent): void {
					this.applyUnsafe(event);
				}
			}

			const initialState: TestState = { value: 10, status: "inactive" };
			const aggregate = new TestValidatingAggregate("test-1" as TestId, initialState);

			expect(() => {
				aggregate.testApplyUnsafe(
					createDomainEvent("TestEventInvalid", {}) as TestEventInvalid,
				);
			}).toThrow(/Event validation failed/);
		});

		it("should allow custom validation logic", () => {
			class CustomValidatingAggregate extends AggregateEventSourced<
				TestState,
				TestEvent,
				TestId
			> {
				constructor(id: TestId, initialState: TestState) {
					super(id, initialState);
				}

				protected validateEvent(event: TestEvent): ReturnType<
					AggregateEventSourced<TestState, TestEvent, TestId>["validateEvent"]
				> {
					if (
						event.type === "TestEventActivated" &&
						this.state.status === "active"
					) {
						return err("Already active");
					}
					return ok(true);
				}

				public testApply(event: TestEvent) {
					return this.apply(event);
				}

				public testApplyUnsafe(event: TestEvent): void {
					this.applyUnsafe(event);
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

			const result = aggregate.testApply(
				createDomainEvent("TestEventActivated", {}) as TestEventActivated,
			);

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toContain("Already active");
			}

			expect(() => {
				aggregate.testApplyUnsafe(
					createDomainEvent("TestEventActivated", {}) as TestEventActivated,
				);
			}).toThrow(/Already active/);
		});
	});

	describe("loadFromHistory", () => {
		it("should set version to history length", () => {
			const initialState: TestState = { value: 10, status: "inactive" };
			const aggregate = new TestAggregateEventSourced("test-1" as TestId, initialState);

			const history: TestEvent[] = [
				createDomainEvent("TestEventUpdated", { newValue: 20 }) as TestEventUpdated,
				createDomainEvent("TestEventActivated", {}) as TestEventActivated,
				createDomainEvent("TestEventUpdated", { newValue: 30 }) as TestEventUpdated,
			];

			const result = aggregate.loadFromHistory(history);

			expect(result.ok).toBe(true);
			expect(aggregate.version).toBe(history.length);
			expect(aggregate.state.value).toBe(30);
			expect(aggregate.state.status).toBe("active");
		});

		it("should handle empty history", () => {
			const initialState: TestState = { value: 10, status: "inactive" };
			const aggregate = new TestAggregateEventSourced("test-1" as TestId, initialState);

			const result = aggregate.loadFromHistory([]);

			expect(result.ok).toBe(true);
			expect(aggregate.version).toBe(0);
		});
	});

	describe("Helper methods", () => {
		it("should check if aggregate has pending events", () => {
			const aggregate = TestAggregateEventSourced.create("test-1" as TestId, 10);

			expect(aggregate.hasPendingEvents()).toBe(true);
			expect(aggregate.getEventCount()).toBe(1);

			aggregate.clearPendingEvents();

			expect(aggregate.hasPendingEvents()).toBe(false);
			expect(aggregate.getEventCount()).toBe(0);
		});

		it("should get latest event", () => {
			const aggregate = TestAggregateEventSourced.create("test-1" as TestId, 10);

			const latest = aggregate.getLatestEvent();
			expect(latest).toBeDefined();
			expect(latest?.type).toBe("TestEventCreated");

			aggregate.updateValue(20);

			const newLatest = aggregate.getLatestEvent();
			expect(newLatest?.type).toBe("TestEventUpdated");
		});

		it("should return undefined for latest event when no events exist", () => {
			const initialState: TestState = { value: 10, status: "inactive" };
			const aggregate = new TestAggregateEventSourced("test-1" as TestId, initialState);

			expect(aggregate.getLatestEvent()).toBeUndefined();
		});
	});

	describe("Snapshots", () => {
		it("should create snapshot with current state and version", () => {
			const aggregate = TestAggregateEventSourced.create("test-1" as TestId, 10);
			aggregate.updateValue(20);
			aggregate.activate();

			const snapshot = aggregate.createSnapshot();

			expect(snapshot.state.value).toBe(20);
			expect(snapshot.state.status).toBe("active");
			expect(snapshot.version).toBe(3);
			expect(snapshot.snapshotAt).toBeInstanceOf(Date);
		});

		it("should restore from snapshot with events", () => {
			const aggregate1 = TestAggregateEventSourced.create("test-1" as TestId, 10);
			aggregate1.updateValue(20);
			aggregate1.activate();

			const snapshot = aggregate1.createSnapshot();

			// Create new aggregate and restore from snapshot
			const initialState: TestState = { value: 0, status: "inactive" };
			const aggregate2 = new TestAggregateEventSourced("test-1" as TestId, initialState);

			const eventsAfterSnapshot: TestEvent[] = [
				createDomainEvent("TestEventUpdated", { newValue: 30 }) as TestEventUpdated,
			];

			const result = aggregate2.restoreFromSnapshotWithEvents(snapshot, eventsAfterSnapshot);

			expect(result.ok).toBe(true);
			expect(aggregate2.state.value).toBe(30); // Updated by event after snapshot
			expect(aggregate2.state.status).toBe("active"); // From snapshot
			expect(aggregate2.version).toBe(4); // Snapshot version + events after
		});

		it("should restore from snapshot with no events after", () => {
			const aggregate1 = TestAggregateEventSourced.create("test-1" as TestId, 10);
			aggregate1.updateValue(20);

			const snapshot = aggregate1.createSnapshot();

			const initialState: TestState = { value: 0, status: "inactive" };
			const aggregate2 = new TestAggregateEventSourced("test-1" as TestId, initialState);

			const result = aggregate2.restoreFromSnapshotWithEvents(snapshot, []);

			expect(result.ok).toBe(true);
			expect(aggregate2.state.value).toBe(20);
			expect(aggregate2.version).toBe(2);
		});
	});
});

