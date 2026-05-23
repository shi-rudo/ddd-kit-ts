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
		this.setState({ ...this.state, value: newValue }, true);
	}

	activate(): void {
		this.setState({ ...this.state, status: "active" }, true);
	}

	deactivate(): void {
		this.setState({ ...this.state, status: "inactive" }, true);
	}

	updateWithSetState(newValue: number): void {
		this.setState({ ...this.state, value: newValue }, true);
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
					this.setState({ ...this.state, value: newValue });
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
					this.setState({ ...this.state, value: newValue }, false);
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

		it("should deep copy nested state in snapshot — no shared references", () => {
			type StateWithChildren = {
				items: { id: string; qty: number }[];
				status: string;
			};

			class AggWithChildren extends AggregateRoot<StateWithChildren, TestId> {
				constructor(id: TestId, state: StateWithChildren) {
					super(id, state);
				}
				addItem(item: { id: string; qty: number }) {
					this.setState({ ...this.state, items: [...this._state.items, item] });
				}
			}

			const agg = new AggWithChildren("a-1" as TestId, { items: [{ id: "i1", qty: 2 }], status: "open" });
			const snapshot = agg.createSnapshot();

			// Mutate aggregate after snapshot
			agg.addItem({ id: "i2", qty: 5 });

			// Snapshot must be isolated
			expect(snapshot.state.items).toHaveLength(1);
			expect(agg.state.items).toHaveLength(2);
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

		it("does not leak the internal state reference through the getter", () => {
			const aggregate = TestAggregate.create("test-1" as TestId, 10);
			const leaked = aggregate.state as { value: number };

			expect(() => {
				leaked.value = 999;
			}).toThrow();

			expect(aggregate.state.value).toBe(10);
		});
	});

	describe("commit() — record-after-mutation helper", () => {
		type Ev = { type: "Updated"; value: number };

		class CommitAggregate extends AggregateRoot<TestState, TestId, Ev> {
			constructor(id: TestId, state: TestState) {
				super(id, state);
			}
			update(value: number, ev: Ev | readonly Ev[] = []): void {
				this.commit({ ...this.state, value }, ev);
			}
			recordOnly(ev: Ev): void {
				// Forces "record before mutation" — would only be possible by
				// calling addDomainEvent directly. commit() never does this.
				this.addDomainEvent(ev);
			}
		}

		class FailingValidator extends AggregateRoot<TestState, TestId, Ev> {
			constructor(id: TestId, state: TestState) {
				super(id, state);
			}
			protected validateState(state: TestState): void {
				if (state.value < 0) throw new Error("negative");
			}
			tryCommit(value: number, ev: Ev): void {
				this.commit({ ...this.state, value }, ev);
			}
		}

		it("mutates state, then records the event, in that order", () => {
			const agg = new CommitAggregate("test-1" as TestId, {
				value: 10,
				status: "inactive",
			});
			agg.update(42, { type: "Updated", value: 42 });

			expect(agg.state.value).toBe(42);
			expect(agg.domainEvents).toHaveLength(1);
			expect(agg.domainEvents[0]).toEqual({ type: "Updated", value: 42 });
		});

		it("does NOT record the event when state validation throws", () => {
			const agg = new FailingValidator("test-1" as TestId, {
				value: 10,
				status: "inactive",
			});

			expect(() =>
				agg.tryCommit(-1, { type: "Updated", value: -1 }),
			).toThrow("negative");

			// State unchanged AND no event queued — the validateState-throws-
			// before-addDomainEvent path is enforced by commit().
			expect(agg.state.value).toBe(10);
			expect(agg.domainEvents).toHaveLength(0);
		});

		it("accepts multiple events and records them in order", () => {
			const agg = new CommitAggregate("test-1" as TestId, {
				value: 10,
				status: "inactive",
			});
			agg.update(99, [
				{ type: "Updated", value: 99 },
				{ type: "Updated", value: 100 },
			]);

			expect(agg.state.value).toBe(99);
			expect(agg.domainEvents.map((e) => e.value)).toEqual([99, 100]);
		});

		it("accepts no events (state change only)", () => {
			const agg = new CommitAggregate("test-1" as TestId, {
				value: 10,
				status: "inactive",
			});
			agg.update(7);

			expect(agg.state.value).toBe(7);
			expect(agg.domainEvents).toHaveLength(0);
		});

		it("always bumps the version, regardless of the autoVersionBump config", () => {
			// commit() is the opt-in path that explicitly couples state +
			// event recording. Recording an event implies 'this is a
			// version-worthy change'. The aggregate's autoVersionBump config
			// governs the un-coupled setState path, not this one.
			class NoAutoBumpAgg extends CommitAggregate {
				constructor(id: TestId, state: TestState) {
					// autoVersionBump = false (the default), the trap that
					// silently broke OCC for callers using commit().
					super(id, state);
				}
			}

			const agg = new NoAutoBumpAgg("test-1" as TestId, {
				value: 10,
				status: "inactive",
			});
			expect(agg.version).toBe(0);

			agg.update(11, { type: "Updated", value: 11 });

			expect(agg.version).toBe(1);
		});

		it("bumps the version exactly once even when committing multiple events", () => {
			const agg = new CommitAggregate("test-1" as TestId, {
				value: 10,
				status: "inactive",
			});
			expect(agg.version).toBe(0);

			agg.update(11, [
				{ type: "Updated", value: 11 },
				{ type: "Updated", value: 12 },
			]);

			// One state transition = one version bump, regardless of how
			// many events accompany it.
			expect(agg.version).toBe(1);
		});
	});

	describe("markPersisted (post-save hook)", () => {
		class EventingAggregate extends AggregateRoot<TestState, TestId, {
			type: "TestRecorded";
			value: number;
		}> {
			constructor(id: TestId, state: TestState) {
				super(id, state);
			}
			recordEvent(value: number): void {
				this.addDomainEvent({ type: "TestRecorded", value });
			}
		}

		it("updates the version and clears recorded domain events", () => {
			const aggregate = new EventingAggregate("test-1" as TestId, {
				value: 10,
				status: "inactive",
			});
			aggregate.recordEvent(1);
			aggregate.recordEvent(2);

			expect(aggregate.domainEvents.length).toBe(2);

			aggregate.markPersisted(42 as Version);

			expect(aggregate.version).toBe(42);
			expect(aggregate.domainEvents).toHaveLength(0);
		});

		it("can be invoked on a fresh aggregate without events", () => {
			const aggregate = TestAggregate.create("test-1" as TestId, 10);
			aggregate.markPersisted(7 as Version);
			expect(aggregate.version).toBe(7);
			expect(aggregate.domainEvents).toHaveLength(0);
		});
	});

	describe("domainEvents getter encapsulation", () => {
		it("does not leak the internal domainEvents array", () => {
			const aggregate = TestAggregate.create("test-1" as TestId, 10);
			const eventsBefore = aggregate.domainEvents.length;

			// Cast-around the ReadonlyArray contract and try to push directly
			const leaked = aggregate.domainEvents as unknown as unknown[];
			expect(() => leaked.push({ fake: "event" })).toThrow();

			expect(aggregate.domainEvents.length).toBe(eventsBefore);
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
					this.setState({ ...this.state, value });
				}
			}

			const agg = new ValidatedAggregate("id-1" as TestId, { value: 10, status: "inactive" });

			expect(() => agg.update(-5)).toThrow("Value cannot be negative");
		});

		it("should manage domain events", () => {
			type EvT = { type: "SomethingHappened" };
			class EventAggregate extends AggregateRoot<TestState, TestId, EvT> {
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
					this.setState({ ...this.state, value: newValue }, true);
					this.addDomainEvent({ type: "ValueUpdated", newValue });
				}
				public activate() {
					this.setState({ ...this.state, status: "active" }, true);
					this.addDomainEvent({ type: "Activated" });
				}
			}

			const agg = new TypedEventAggregate("id-1" as TestId, { value: 10, status: "inactive" });

			agg.updateValue(42);
			agg.activate();

			expect(agg.domainEvents).toHaveLength(2);
			expect(agg.domainEvents[0]).toEqual({ type: "ValueUpdated", newValue: 42 });
			expect(agg.domainEvents[1]).toEqual({ type: "Activated" });

			// domainEvents is typed — access event-specific fields without cast
			const firstEvent = agg.domainEvents[0]!;
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
