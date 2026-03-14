import { describe, expect, it } from "vitest";
import type { Id } from "../core/id";
import {
	AggregateRoot,
	type AggregateConfig,
} from "./aggregate-root";
import type { Version } from "./aggregate";

type TestId = Id<"TestId">;

type TestState = {
	value: number;
	status: "active" | "inactive";
};

class TestAggregate extends AggregateRoot<TestState, TestId> {
	constructor(
		id: TestId,
		initialState: TestState,
		config?: AggregateConfig,
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
		this._state = { ...this._state, value: newValue };
		this.bumpVersion();
	}

	activate(): void {
		this._state = { ...this._state, status: "active" };
		this.bumpVersion();
	}

	deactivate(): void {
		this._state = { ...this._state, status: "inactive" };
		this.bumpVersion();
	}

	updateWithSetState(newValue: number): void {
		this.setState({ ...this._state, value: newValue }, true);
	}
}

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
		it("should manually bump version", () => {
			const aggregate = TestAggregate.create("test-1" as TestId, 10);

			expect(aggregate.version).toBe(0);

			aggregate.updateValue(20);
			expect(aggregate.version).toBe(1);

			aggregate.activate();
			expect(aggregate.version).toBe(2);
		});

		it("should support automatic version bumping with config", () => {
			class AutoVersionAggregate extends AggregateRoot<TestState, TestId> {
				constructor(id: TestId, initialState: TestState) {
					super(id, initialState, { autoVersionBump: true });
				}

				public updateValue(newValue: number): void {
					this.setState({ ...this._state, value: newValue });
				}
			}

			const initialState: TestState = { value: 10, status: "inactive" };
			const aggregate = new AutoVersionAggregate("test-1" as TestId, initialState);

			aggregate.updateValue(20);
			expect(aggregate.version).toBe(1); // Auto-bumped via setState
		});

		it("should not auto-bump when disabled", () => {
			class ManualVersionAggregate extends AggregateRoot<TestState, TestId> {
				constructor(id: TestId, initialState: TestState) {
					super(id, initialState, { autoVersionBump: false });
				}

				public testBumpVersion(): void {
					this.bumpVersion();
				}

				public updateValue(newValue: number): void {
					this.setState({ ...this._state, value: newValue }, false);
				}
			}

			const initialState: TestState = { value: 10, status: "inactive" };
			const aggregate = new ManualVersionAggregate("test-1" as TestId, initialState);

			aggregate.updateValue(20);
			expect(aggregate.version).toBe(0); // No auto-bump

			aggregate.testBumpVersion();
			expect(aggregate.version).toBe(1); // Manual bump
		});
	});

	describe("Snapshots", () => {
		it("should create snapshot with current state and version", () => {
			const aggregate = TestAggregate.create("test-1" as TestId, 10);
			aggregate.updateValue(20);
			aggregate.activate();

			const snapshot = aggregate.createSnapshot();

			expect(snapshot.state.value).toBe(20);
			expect(snapshot.state.status).toBe("active");
			expect(snapshot.version).toBe(2);
			expect(snapshot.snapshotAt).toBeInstanceOf(Date);
		});

		it("should restore from snapshot", () => {
			const aggregate1 = TestAggregate.create("test-1" as TestId, 10);
			aggregate1.updateValue(20);
			aggregate1.activate();

			const snapshot = aggregate1.createSnapshot();

			// Create new aggregate and restore from snapshot
			const initialState: TestState = { value: 0, status: "inactive" };
			const aggregate2 = new TestAggregate("test-1" as TestId, initialState);

			aggregate2.restoreFromSnapshot(snapshot);

			expect(aggregate2.state.value).toBe(20);
			expect(aggregate2.state.status).toBe("active");
			expect(aggregate2.version).toBe(2);
		});

		it("should not mutate original state when creating snapshot", () => {
			const aggregate = TestAggregate.create("test-1" as TestId, 10);

			const snapshot = aggregate.createSnapshot();
			(snapshot.state as any).value = 999; // Try to mutate snapshot

			expect(aggregate.state.value).toBe(10); // Original unchanged
		});
	});

	describe("State immutability", () => {
		it("should expose state as readonly", () => {
			const aggregate = TestAggregate.create("test-1" as TestId, 10);

			const state = aggregate.state;
			// TypeScript should prevent: state.value = 999;
			expect(state.value).toBe(10);
		});

		it("should allow mutation through protected _state", () => {
			const aggregate = TestAggregate.create("test-1" as TestId, 10);

			aggregate.updateValue(20);

			expect(aggregate.state.value).toBe(20);
		});
	});

	describe("Enhancements", () => {
		it("should throw if ID is null or undefined", () => {
			const state = { value: 10, status: "inactive" as const };
			// @ts-expect-error - testing invalid input
			expect(() => new TestAggregate(null, state)).toThrow("ID cannot be null or undefined");
			// @ts-expect-error - testing invalid input
			expect(() => new TestAggregate(undefined, state)).toThrow("ID cannot be null or undefined");
		});

		it("should validate state changes", () => {
			class ValidatedAggregate extends AggregateRoot<TestState, TestId> {
				constructor(id: TestId, initialState: TestState) {
					super(id, initialState);
				}
				protected validateState(state: TestState): void {
					if (state.value < 0) {
						throw new Error("Value cannot be negative");
					}
				}
				public update(value: number) {
					this.setState({ ...this._state, value });
				}
			}

			const agg = new ValidatedAggregate("id-1" as TestId, { value: 10, status: "inactive" });

			expect(() => agg.update(-5)).toThrow("Value cannot be negative");
		});

		it("should manage domain events", () => {
			class EventAggregate extends AggregateRoot<TestState, TestId> {
				constructor(id: TestId, initialState: TestState) {
					super(id, initialState);
				}
				public doSomething() {
					this.addDomainEvent({ type: "SomethingHappened" });
				}
			}

			const agg = new EventAggregate("id-1" as TestId, { value: 10, status: "inactive" });

			expect(agg.domainEvents).toHaveLength(0);
			agg.doSomething();
			expect(agg.domainEvents).toHaveLength(1);
			expect(agg.domainEvents[0]).toEqual({ type: "SomethingHappened" });

			agg.clearDomainEvents();
			expect(agg.domainEvents).toHaveLength(0);
		});

		it("should support typed domain events via TEvent parameter", () => {
			type TestEvent =
				| { type: "ValueUpdated"; newValue: number }
				| { type: "Activated" };

			class TypedEventAggregate extends AggregateRoot<TestState, TestId, TestEvent> {
				constructor(id: TestId, initialState: TestState) {
					super(id, initialState);
				}
				public updateValue(newValue: number) {
					this._state = { ...this._state, value: newValue };
					this.addDomainEvent({ type: "ValueUpdated", newValue });
					this.bumpVersion();
				}
				public activate() {
					this._state = { ...this._state, status: "active" };
					this.addDomainEvent({ type: "Activated" });
					this.bumpVersion();
				}
			}

			const agg = new TypedEventAggregate("id-1" as TestId, { value: 10, status: "inactive" });

			agg.updateValue(42);
			agg.activate();

			expect(agg.domainEvents).toHaveLength(2);
			expect(agg.domainEvents[0]).toEqual({ type: "ValueUpdated", newValue: 42 });
			expect(agg.domainEvents[1]).toEqual({ type: "Activated" });

			// domainEvents is typed — access event-specific fields without cast
			const firstEvent = agg.domainEvents[0];
			expect(firstEvent.type).toBe("ValueUpdated");
		});

		it("should reject wrong event types at compile time with TEvent", () => {
			type StrictEvent = { type: "OnlyThis"; data: string };

			class StrictAggregate extends AggregateRoot<TestState, TestId, StrictEvent> {
				constructor(id: TestId, initialState: TestState) {
					super(id, initialState);
				}
				public doCorrect() {
					this.addDomainEvent({ type: "OnlyThis", data: "hello" });
				}
				public doWrong() {
					// @ts-expect-error - wrong event type is rejected by TEvent constraint
					this.addDomainEvent({ type: "WrongEvent" });
				}
			}

			const agg = new StrictAggregate("id-1" as TestId, { value: 1, status: "inactive" });
			agg.doCorrect();
			expect(agg.domainEvents).toHaveLength(1);
			expect(agg.domainEvents[0]).toEqual({ type: "OnlyThis", data: "hello" });
		});
	});
});
