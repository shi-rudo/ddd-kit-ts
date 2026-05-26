import { describe, expect, it } from "vitest";
import type { Id } from "../core/id";
import {
	AggregateRoot,
	type AggregateConfig,
} from "./aggregate-root";
import type { AggregateSnapshot, Version } from "./aggregate";
import type { DomainEvent } from "./domain-event";

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
				protected readonly aggregateType = "AutoVersionAggregate";
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
				protected readonly aggregateType = "ManualVersionAggregate";
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
				protected readonly aggregateType = "AggWithChildren";
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

		it("should deep-clone the snapshot when restoring — caller mutations don't leak in", () => {
			type StateWithChildren = {
				items: { id: string; qty: number }[];
				status: string;
			};

			class AggWithChildren extends AggregateRoot<StateWithChildren, TestId> {
				protected readonly aggregateType = "AggWithChildren";
				constructor(id: TestId, state: StateWithChildren) {
					super(id, state);
				}
			}

			const snapshot: AggregateSnapshot<StateWithChildren> = {
				state: { items: [{ id: "i1", qty: 2 }], status: "open" },
				version: 5 as Version,
				snapshotAt: new Date(),
			};

			const agg = new AggWithChildren("a-1" as TestId, { items: [], status: "open" });
			agg.restoreFromSnapshot(snapshot);

			// Mutate the original snapshot AFTER restore — the aggregate must be isolated.
			snapshot.state.items[0]!.qty = 999;
			snapshot.state.items.push({ id: "i2", qty: 5 });

			expect(agg.state.items).toHaveLength(1);
			expect(agg.state.items[0]?.qty).toBe(2);
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
				// Forces "record before mutation" — would only be possible by
				// calling addDomainEvent directly. commit() never does this.
				this.addDomainEvent(ev);
			}
			recordTestEvent(value: number): Ev {
				return this.recordEvent("Updated", { value });
			}
		}

		class FailingValidator extends AggregateRoot<TestState, TestId, Ev> {
			protected readonly aggregateType = "FailingValidator";

			constructor(id: TestId, state: TestState) {
				super(id, state);
			}
			protected validateState(state: TestState): void {
				if (state.value < 0) throw new Error("negative");
			}
			tryCommit(value: number, ev: Ev): void {
				this.commit({ ...this.state, value }, ev);
			}
			recordTestEvent(value: number): Ev {
				return this.recordEvent("Updated", { value });
			}
		}

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

			// State unchanged AND no event queued — the validateState-throws-
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

	describe("recordEvent helper", () => {
		type Recorded = DomainEvent<"Recorded", { v: number }>;

		class RecordingAggregate extends AggregateRoot<TestState, TestId, Recorded> {
			protected readonly aggregateType = "RecordingAggregate";

			constructor(id: TestId, initialState: TestState) {
				super(id, initialState);
			}

			fire(v: number): Recorded {
				return this.recordEvent("Recorded", { v });
			}
		}

		it("auto-injects aggregateId from this.id", () => {
			const agg = new RecordingAggregate("r-1" as TestId, {
				value: 0,
				status: "inactive",
			});
			const event = agg.fire(7);
			expect(event.aggregateId).toBe("r-1");
		});

		it("auto-injects aggregateType from the static declaration", () => {
			const agg = new RecordingAggregate("r-1" as TestId, {
				value: 0,
				status: "inactive",
			});
			const event = agg.fire(7);
			expect(event.aggregateType).toBe("RecordingAggregate");
		});

		it("preserves the payload exactly", () => {
			const agg = new RecordingAggregate("r-1" as TestId, {
				value: 0,
				status: "inactive",
			});
			const event = agg.fire(42);
			expect(event.type).toBe("Recorded");
			expect(event.payload).toEqual({ v: 42 });
		});
	});

	describe("markPersisted (post-save hook)", () => {
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
				this.addDomainEvent(this.recordEvent("TestRecorded", { value }));
			}
		}

		it("updates the version and clears recorded domain events", () => {
			const aggregate = new EventingAggregate("test-1" as TestId, {
				value: 10,
				status: "inactive",
			});
			aggregate.addTestEvent(1);
			aggregate.addTestEvent(2);

			expect(aggregate.pendingEvents.length).toBe(2);

			aggregate.markPersisted(42 as Version);

			expect(aggregate.version).toBe(42);
			expect(aggregate.pendingEvents).toHaveLength(0);
		});

		it("can be invoked on a fresh aggregate without events", () => {
			const aggregate = TestAggregate.create("test-1" as TestId, 10);
			aggregate.markPersisted(7 as Version);
			expect(aggregate.version).toBe(7);
			expect(aggregate.pendingEvents).toHaveLength(0);
		});

		it("calls the onPersisted hook after clearing pendingEvents", () => {
			// onPersisted is the framework-safe subclass extension point.
			// It fires AFTER pendingEvents is cleared, so a subclass can't
			// accidentally read stale events when implementing the hook.
			class HookingAggregate extends AggregateRoot<
				TestState,
				TestId,
				TestRecorded
			> {
				protected readonly aggregateType = "HookingAggregate";
				public hookCalls: Array<{
					version: Version;
					pendingLengthDuringHook: number;
				}> = [];

				constructor(id: TestId, state: TestState) {
					super(id, state);
				}
				addTestEvent(value: number): void {
					this.addDomainEvent(this.recordEvent("TestRecorded", { value }));
				}
				protected override onPersisted(version: Version): void {
					this.hookCalls.push({
						version,
						pendingLengthDuringHook: this.pendingEvents.length,
					});
				}
			}

			const aggregate = new HookingAggregate("hook-1" as TestId, {
				value: 0,
				status: "inactive",
			});
			aggregate.addTestEvent(1);
			aggregate.addTestEvent(2);

			aggregate.markPersisted(99 as Version);

			expect(aggregate.hookCalls).toHaveLength(1);
			expect(aggregate.hookCalls[0]!.version).toBe(99);
			// Critical: pendingEvents is already empty when the hook runs.
			// This is what makes onPersisted the safe extension point.
			expect(aggregate.hookCalls[0]!.pendingLengthDuringHook).toBe(0);
		});

		it("documents the footgun: overriding markPersisted without super leaks pendingEvents (use onPersisted instead)", () => {
			// NEGATIVE example: this is the bug pattern hit in production.
			// A subclass overrides markPersisted directly, forgets to call
			// super, and the framework's pendingEvents cleanup never runs.
			// Next save re-dispatches the same events through the outbox.
			class BuggyAggregate extends AggregateRoot<
				TestState,
				TestId,
				TestRecorded
			> {
				protected readonly aggregateType = "BuggyAggregate";
				public sideEffectFired = false;
				constructor(id: TestId, state: TestState) {
					super(id, state);
				}
				addTestEvent(value: number): void {
					this.addDomainEvent(this.recordEvent("TestRecorded", { value }));
				}
				// ❌ This is the bug: override without super.markPersisted(version)
				public override markPersisted(_version: Version): void {
					this.sideEffectFired = true;
					// MISSING: super.markPersisted(_version)
					// pendingEvents stays populated. Catastrophic under withCommit.
				}
			}

			const buggy = new BuggyAggregate("bug-1" as TestId, {
				value: 0,
				status: "inactive",
			});
			buggy.addTestEvent(1);
			buggy.markPersisted(5 as Version);

			expect(buggy.sideEffectFired).toBe(true);
			// THE BUG: pendingEvents was NOT cleared.
			expect(buggy.pendingEvents).toHaveLength(1);

			// ✅ The fix: same intent via onPersisted, framework cleanup
			// runs first, side-effect still fires.
			class FixedAggregate extends AggregateRoot<
				TestState,
				TestId,
				TestRecorded
			> {
				protected readonly aggregateType = "FixedAggregate";
				public sideEffectFired = false;
				constructor(id: TestId, state: TestState) {
					super(id, state);
				}
				addTestEvent(value: number): void {
					this.addDomainEvent(this.recordEvent("TestRecorded", { value }));
				}
				protected override onPersisted(_version: Version): void {
					this.sideEffectFired = true;
					// pendingEvents is already empty here — by design.
				}
			}

			const fixed = new FixedAggregate("fix-1" as TestId, {
				value: 0,
				status: "inactive",
			});
			fixed.addTestEvent(1);
			fixed.markPersisted(5 as Version);

			expect(fixed.sideEffectFired).toBe(true);
			expect(fixed.pendingEvents).toHaveLength(0);
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
		it("should throw if ID is null or undefined", () => {
			const state = { value: 10, status: "inactive" as const };
			// @ts-expect-error - testing invalid input
			expect(() => new TestAggregate(null, state)).toThrow("ID cannot be null or undefined");
			// @ts-expect-error - testing invalid input
			expect(() => new TestAggregate(undefined, state)).toThrow("ID cannot be null or undefined");
		});

		it("should validate state changes", () => {
			class ValidatedAggregate extends AggregateRoot<TestState, TestId> {
				protected readonly aggregateType = "ValidatedAggregate";
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
			type EvT = DomainEvent<"SomethingHappened", void>;
			class EventAggregate extends AggregateRoot<TestState, TestId, EvT> {
				protected readonly aggregateType = "EventAggregate";
				constructor(id: TestId, initialState: TestState) {
					super(id, initialState);
				}
				public doSomething() {
					this.addDomainEvent(this.recordEvent("SomethingHappened", undefined));
				}
			}

			const agg = new EventAggregate("id-1" as TestId, { value: 10, status: "inactive" });

			expect(agg.pendingEvents).toHaveLength(0);
			agg.doSomething();
			expect(agg.pendingEvents).toHaveLength(1);
			expect(agg.pendingEvents[0]?.type).toBe("SomethingHappened");

			agg.clearPendingEvents();
			expect(agg.pendingEvents).toHaveLength(0);
		});

		it("should support typed domain events via TEvent parameter", () => {
			type TestEvent =
				| DomainEvent<"ValueUpdated", { newValue: number }>
				| DomainEvent<"Activated", void>;

			class TypedEventAggregate extends AggregateRoot<TestState, TestId, TestEvent> {
				protected readonly aggregateType = "TypedEventAggregate";
				constructor(id: TestId, initialState: TestState) {
					super(id, initialState);
				}
				public updateValue(newValue: number) {
					this.setState({ ...this.state, value: newValue }, true);
					this.addDomainEvent(this.recordEvent("ValueUpdated", { newValue }));
				}
				public activate() {
					this.setState({ ...this.state, status: "active" }, true);
					this.addDomainEvent(this.recordEvent("Activated", undefined));
				}
			}

			const agg = new TypedEventAggregate("id-1" as TestId, { value: 10, status: "inactive" });

			agg.updateValue(42);
			agg.activate();

			expect(agg.pendingEvents).toHaveLength(2);
			expect(agg.pendingEvents[0]?.type).toBe("ValueUpdated");
			expect((agg.pendingEvents[0] as Extract<TestEvent, { type: "ValueUpdated" }>).payload).toEqual({ newValue: 42 });
			expect(agg.pendingEvents[1]?.type).toBe("Activated");

			// pendingEvents is typed — access event-specific fields without cast
			const firstEvent = agg.pendingEvents[0]!;
			expect(firstEvent.type).toBe("ValueUpdated");
		});

		it("should reject wrong event types at compile time with TEvent", () => {
			type StrictEvent = DomainEvent<"OnlyThis", { data: string }>;

			class StrictAggregate extends AggregateRoot<TestState, TestId, StrictEvent> {
				protected readonly aggregateType = "StrictAggregate";
				constructor(id: TestId, initialState: TestState) {
					super(id, initialState);
				}
				public doCorrect() {
					this.addDomainEvent(this.recordEvent("OnlyThis", { data: "hello" }));
				}
				public doWrong() {
					// @ts-expect-error - wrong event type is rejected by TEvent constraint
					this.recordEvent("WrongEvent", undefined);
				}
			}

			const agg = new StrictAggregate("id-1" as TestId, { value: 1, status: "inactive" });
			agg.doCorrect();
			expect(agg.pendingEvents).toHaveLength(1);
			expect(agg.pendingEvents[0]?.type).toBe("OnlyThis");
			expect(agg.pendingEvents[0]?.payload).toEqual({ data: "hello" });
		});
	});
});
