import { describe, expect, it } from "vitest";
import {
	SnapshotSchemaMismatchError,
	UnfrozenEventError,
	UnreplayableAggregateError,
} from "../core/errors";
import type { Id } from "../core/id";
import {
	type AggregateSnapshot,
	type Version,
	withClockFactory,
} from "./aggregate";
import { type AggregateConfig, AggregateRoot } from "./aggregate-root";
import type { DomainEvent } from "./domain-event";

type TestId = Id<"TestId">;

type TestState = {
	value: number;
	status: "active" | "inactive";
};

class TestAggregate extends AggregateRoot<TestState, TestId> {
	protected readonly aggregateType = "TestAggregate";
	constructor(id: TestId, initialState: TestState, config?: AggregateConfig) {
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
		constructor(id: TestId, initialState: TestState) {
			super(id, initialState);
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
		aggregate.markPersisted(0 as Version);

		aggregate.cacheCosmetic(7);

		expect(aggregate.state.value).toBe(7);
		expect(aggregate.version).toBe(0);
		expect(aggregate.changedKeys.has("value")).toBe(true);
	});

	it("setStateWithoutVersionBump still validates the new state", () => {
		class Validated extends NamedMethodsAggregate {
			protected override validateState(state: TestState): void {
				if (state.value < 0) throw new Error("value must not be negative");
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

	it("the removed two-argument flag form is a compile error", () => {
		class Legacy extends AggregateRoot<TestState, TestId> {
			protected readonly aggregateType = "Legacy";
			legacyCall(): void {
				// @ts-expect-error the bumpVersion flag argument was replaced by setStateWithoutVersionBump
				this.setState({ ...this.state, value: 9 }, true);
			}
		}
		expect(typeof Legacy).toBe("function");
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

		it("should manually bump version", () => {
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

		it("the autoVersionBump config is gone (the named methods replaced it)", () => {
			// @ts-expect-error autoVersionBump was removed in v3; the OCC intent lives in the method name (setState bumps, setStateWithoutVersionBump does not)
			const config: AggregateConfig = { autoVersionBump: true };
			expect(config).toBeDefined();
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

	describe("Snapshots", () => {
		it("does not alias a shared clock Date into snapshotAt", () => {
			const fixed = new Date("2026-01-01T00:00:00Z");
			const snapshot = withClockFactory(
				() => fixed,
				() => TestAggregate.create("test-1" as TestId, 10).createSnapshot(),
			);

			expect(snapshot.snapshotAt.getTime()).toBe(
				new Date("2026-01-01T00:00:00Z").getTime(),
			);
			expect(snapshot.snapshotAt).not.toBe(fixed);
			fixed.setFullYear(2030);
			expect(snapshot.snapshotAt.getFullYear()).toBe(2026);
		});

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

		it("stamps schemaVersion 1 on snapshots by default", () => {
			const aggregate = TestAggregate.create("test-1" as TestId, 10);
			expect(aggregate.createSnapshot().schemaVersion).toBe(1);
		});

		it("stamps an overridden snapshotSchemaVersion", () => {
			class VersionedAggregate extends AggregateRoot<TestState, TestId> {
				protected readonly aggregateType = "VersionedAggregate";
				protected override readonly snapshotSchemaVersion = 3;
				constructor(id: TestId, initialState: TestState) {
					super(id, initialState);
				}
			}

			const aggregate = new VersionedAggregate("test-1" as TestId, {
				value: 1,
				status: "inactive",
			});
			expect(aggregate.createSnapshot().schemaVersion).toBe(3);
		});

		it("rejects a restore target carrying pending events (UnreplayableAggregateError), same guard as the event-sourced path", () => {
			// Rationale lives on assertRestoreTargetHasNoPendingEvents in
			// base-aggregate.ts; clearPendingEvents() first is the
			// deliberate-discard escape hatch.
			type Ev = DomainEvent<"Updated", { value: number }>;
			class EventfulAggregate extends AggregateRoot<TestState, TestId, Ev> {
				protected readonly aggregateType = "EventfulAggregate";
				constructor(id: TestId, state: TestState) {
					super(id, state);
				}
				update(value: number): void {
					this.commit(
						{ ...this.state, value },
						this.recordEvent("Updated", { value }),
					);
				}
			}

			const aggregate = new EventfulAggregate("test-1" as TestId, {
				value: 10,
				status: "inactive",
			});
			aggregate.update(20);
			const snapshot: AggregateSnapshot<TestState> = {
				state: { value: 42, status: "active" },
				version: 5 as Version,
				snapshotAt: new Date(),
			};

			expect(() => aggregate.restoreFromSnapshot(snapshot)).toThrow(
				UnreplayableAggregateError,
			);
			// Nothing moved: the guard fires before any assignment.
			expect(aggregate.state.value).toBe(20);
			expect(aggregate.version).toBe(1);
			expect(aggregate.pendingEvents).toHaveLength(1);
		});

		it("rejects a snapshot with a mismatched schemaVersion by default (SnapshotSchemaMismatchError)", () => {
			const aggregate = TestAggregate.create("test-1" as TestId, 10);
			const stale: AggregateSnapshot<TestState> = {
				state: { value: 42, status: "active" },
				version: 5 as Version,
				snapshotAt: new Date(),
				schemaVersion: 99,
			};

			expect(() => aggregate.restoreFromSnapshot(stale)).toThrow(
				SnapshotSchemaMismatchError,
			);
			// Nothing moved: the mismatch is detected before any assignment.
			expect(aggregate.state.value).toBe(10);
			expect(aggregate.persistedVersion).toBeUndefined();
		});

		it("treats a legacy snapshot without schemaVersion as schema 1", () => {
			const aggregate = TestAggregate.create("test-1" as TestId, 10);
			const legacy: AggregateSnapshot<TestState> = {
				state: { value: 42, status: "active" },
				version: 5 as Version,
				snapshotAt: new Date(),
				// no schemaVersion: written by an older kit version
			};

			aggregate.restoreFromSnapshot(legacy);

			expect(aggregate.state.value).toBe(42);
			expect(aggregate.version).toBe(5);
		});

		it("routes a mismatched snapshot through an overridden migrateSnapshotState", () => {
			class MigratingAggregate extends AggregateRoot<TestState, TestId> {
				protected readonly aggregateType = "MigratingAggregate";
				protected override readonly snapshotSchemaVersion = 2;

				constructor(id: TestId, initialState: TestState) {
					super(id, initialState);
				}

				protected override migrateSnapshotState(
					stored: unknown,
					storedSchemaVersion: number,
				): TestState {
					// v1 snapshots carried only { value }; status arrived in v2.
					if (storedSchemaVersion === 1) {
						const v1 = stored as { value: number };
						return { value: v1.value, status: "inactive" };
					}
					throw new Error(
						`no migration from snapshot schema ${storedSchemaVersion}`,
					);
				}
			}

			const aggregate = new MigratingAggregate("test-1" as TestId, {
				value: 0,
				status: "active",
			});
			const v1Snapshot = {
				state: { value: 42 } as unknown as TestState,
				version: 5 as Version,
				snapshotAt: new Date(),
				schemaVersion: 1,
			};

			aggregate.restoreFromSnapshot(v1Snapshot);

			expect(aggregate.state).toEqual({ value: 42, status: "inactive" });
			expect(aggregate.version).toBe(5);
			expect(aggregate.persistedVersion).toBe(5);
		});

		it("stamps snapshotAt via the installed clock factory", () => {
			// Deterministic tests pin occurredAt through withClockFactory;
			// snapshotAt must honor the same clock instead of a hard new Date().
			const fixed = new Date("2026-01-01T00:00:00Z");
			const aggregate = TestAggregate.create("test-1" as TestId, 10);

			const snapshot = withClockFactory(
				() => new Date(fixed.getTime()),
				() => aggregate.createSnapshot(),
			);

			expect(snapshot.snapshotAt.getTime()).toBe(fixed.getTime());
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

		it("should deep copy nested state in snapshot: no shared references", () => {
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

			const agg = new AggWithChildren("a-1" as TestId, {
				items: [{ id: "i1", qty: 2 }],
				status: "open",
			});
			const snapshot = agg.createSnapshot();

			// Mutate aggregate after snapshot
			agg.addItem({ id: "i2", qty: 5 });

			// Snapshot must be isolated
			expect(snapshot.state.items).toHaveLength(1);
			expect(agg.state.items).toHaveLength(2);
		});

		it("should deep-clone the snapshot when restoring: caller mutations don't leak in", () => {
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

			const agg = new AggWithChildren("a-1" as TestId, {
				items: [],
				status: "open",
			});
			agg.restoreFromSnapshot(snapshot);

			// Mutate the original snapshot AFTER restore. The aggregate must be isolated.
			snapshot.state.items[0]!.qty = 999;
			snapshot.state.items.push({ id: "i2", qty: 5 });

			expect(agg.state.items).toHaveLength(1);
			expect(agg.state.items[0]?.qty).toBe(2);
		});
	});

	describe("Snapshots with class-based child entities (toSnapshotState/fromSnapshotState)", () => {
		class LineItem {
			constructor(
				readonly sku: string,
				public qty: number,
			) {}

			increase(): void {
				this.qty += 1;
			}

			toPlainData(): { sku: string; qty: number } {
				return { sku: this.sku, qty: this.qty };
			}

			static fromPlainData(d: { sku: string; qty: number }): LineItem {
				return new LineItem(d.sku, d.qty);
			}
		}

		type CartState = { items: LineItem[] };
		type CartSnapshotState = { items: Array<{ sku: string; qty: number }> };

		class NaiveCart extends AggregateRoot<CartState, TestId> {
			protected readonly aggregateType = "NaiveCart";
			constructor(id: TestId, state: CartState) {
				super(id, state);
			}
		}

		class Cart extends AggregateRoot<
			CartState,
			TestId,
			never,
			CartSnapshotState
		> {
			protected readonly aggregateType = "Cart";
			constructor(id: TestId, state: CartState) {
				super(id, state);
			}

			protected override toSnapshotState(state: CartState): CartSnapshotState {
				return { items: state.items.map((i) => i.toPlainData()) };
			}

			protected override fromSnapshotState(
				stored: CartSnapshotState,
			): CartState {
				return { items: stored.items.map(LineItem.fromPlainData) };
			}
		}

		it("default createSnapshot fails fast with a descriptive error on class instances", () => {
			const cart = new NaiveCart("agg-1" as TestId, {
				items: [new LineItem("sku-a", 1)],
			});

			// Without the guard, structuredClone silently strips the prototype
			// and the snapshot breaks on first method call after restore.
			expect(() => cart.createSnapshot()).toThrow(
				/class instance \(LineItem\)/,
			);
			expect(() => cart.createSnapshot()).toThrow(/toSnapshotState/);
			expect(() => cart.createSnapshot()).toThrow(/items\[0\]/);
		});

		it("default createSnapshot fails fast on function-valued state members", () => {
			type FnState = { calc: () => number };
			class FnAggregate extends AggregateRoot<FnState, TestId> {
				protected readonly aggregateType = "FnAggregate";
				constructor(id: TestId, state: FnState) {
					super(id, state);
				}
			}
			const agg = new FnAggregate("agg-1" as TestId, { calc: () => 42 });

			// Previously: cryptic DataCloneError from structuredClone.
			expect(() => agg.createSnapshot()).toThrow(/function/);
			expect(() => agg.createSnapshot()).toThrow(/calc/);
		});

		it("overridden hooks produce a plain snapshot and revive class children on restore", () => {
			const cart = new Cart("agg-1" as TestId, {
				items: [new LineItem("sku-a", 2)],
			});

			const snapshot = cart.createSnapshot();
			expect(Object.getPrototypeOf(snapshot.state.items[0])).toBe(
				Object.prototype,
			);

			const restored = new Cart("agg-1" as TestId, { items: [] });
			restored.restoreFromSnapshot(snapshot);

			expect(restored.state.items[0]).toBeInstanceOf(LineItem);
			restored.state.items[0]?.increase();
			expect(restored.state.items[0]?.qty).toBe(3);
		});

		it("plain-data states snapshot exactly as before (no behaviour change)", () => {
			const aggregate = TestAggregate.create("agg-1" as TestId, 10);
			const snapshot = aggregate.createSnapshot();

			expect(snapshot.state).toEqual({ value: 10, status: "inactive" });
			expect(snapshot.version).toBe(aggregate.version);
		});

		it("fails fast on Error values in state (custom fields and subclasses do not survive structuredClone)", () => {
			class MyDomainishError extends Error {
				readonly code = 42;
			}
			type ErrState = { lastError: Error };
			class ErrAggregate extends AggregateRoot<ErrState, TestId> {
				protected readonly aggregateType = "ErrAggregate";
				constructor(id: TestId, state: ErrState) {
					super(id, state);
				}
			}

			const withSubclass = new ErrAggregate("agg-1" as TestId, {
				lastError: new MyDomainishError("boom"),
			});
			// structuredClone silently downgrades the subclass to a plain
			// Error (instanceof broken, .code gone), so it must fail fast instead.
			expect(() => withSubclass.createSnapshot()).toThrow(/Error/);
			expect(() => withSubclass.createSnapshot()).toThrow(/lastError/);
			expect(() => withSubclass.createSnapshot()).toThrow(/toSnapshotState/);

			const withPlainError = new ErrAggregate("agg-1" as TestId, {
				lastError: Object.assign(new Error("boom"), { code: 42 }),
			});
			expect(() => withPlainError.createSnapshot()).toThrow(/lastError/);
		});

		it("does not let a Symbol.toStringTag spoofer smuggle functions past the guard", () => {
			type SpoofState = { d: { f: () => number } };
			class SpoofAggregate extends AggregateRoot<SpoofState, TestId> {
				protected readonly aggregateType = "SpoofAggregate";
				constructor(id: TestId, state: SpoofState) {
					super(id, state);
				}
			}
			const agg = new SpoofAggregate("agg-1" as TestId, {
				d: Object.assign(
					{ f: () => 1 },
					{ [Symbol.toStringTag]: "Date" },
				) as unknown as SpoofState["d"],
			});

			// Previously the spoofed tag matched SNAPSHOT_SAFE_TAGS, the walk
			// skipped the object, and structuredClone later threw a pathless
			// DataCloneError. The guard must report the function with its path.
			expect(() => agg.createSnapshot()).toThrow(/function/);
			expect(() => agg.createSnapshot()).toThrow(/state\.d\.f/);
		});

		it("fails fast on enumerable symbol-keyed state (structuredClone silently drops symbol keys)", () => {
			const region = Symbol("region");
			type SymState = { value: number; [region]?: { zone: string } };
			class SymAggregate extends AggregateRoot<SymState, TestId> {
				protected readonly aggregateType = "SymAggregate";
				constructor(id: TestId, state: SymState) {
					super(id, state);
				}
			}
			const agg = new SymAggregate("agg-1" as TestId, {
				value: 1,
				[region]: { zone: "eu" },
			});

			expect(() => agg.createSnapshot()).toThrow(/symbol/i);
			expect(() => agg.createSnapshot()).toThrow(/toSnapshotState/);
		});

		it("ignores non-enumerable props, exactly like structuredClone does", () => {
			type PlainState = { value: number };
			class NonEnumAggregate extends AggregateRoot<PlainState, TestId> {
				protected readonly aggregateType = "NonEnumAggregate";
				constructor(id: TestId, state: PlainState) {
					super(id, state);
				}
			}
			const state: PlainState = { value: 1 };
			Object.defineProperty(state, "recompute", {
				value: () => 99,
				enumerable: false,
			});
			const agg = new NonEnumAggregate("agg-1" as TestId, state);

			// Non-enumerable members are deliberately excluded from
			// serialization: structuredClone drops them, so the guard
			// must not reject them.
			expect(() => agg.createSnapshot()).not.toThrow();
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
			// changedKeys dirty diff.
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

		it("applies the deep freeze to snapshot-restored state", () => {
			const source = new DeepFrozenAggregate("test-1" as TestId, {
				status: "open",
				items: [{ sku: "a", qty: 1 }],
			});
			source.addItem("b", 2);
			const snapshot = source.createSnapshot();

			const restored = new DeepFrozenAggregate("test-1" as TestId, {
				status: "open",
				items: [],
			});
			restored.restoreFromSnapshot(snapshot);

			expect(restored.state.items).toHaveLength(2);
			expect(Object.isFrozen(restored.state.items)).toBe(true);
			expect(Object.isFrozen(restored.state.items[0])).toBe(true);
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

			expect(() => agg.update(42, literal)).toThrow(UnfrozenEventError);
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

	describe("recordEvent helper", () => {
		type Recorded = DomainEvent<"Recorded", { v: number }>;

		class RecordingAggregate extends AggregateRoot<
			TestState,
			TestId,
			Recorded
		> {
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
					// pendingEvents is already empty here, by design.
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
			expect(() => new TestAggregate(null, state)).toThrow(
				"ID cannot be null or undefined",
			);
			// @ts-expect-error - testing invalid input
			expect(() => new TestAggregate(undefined, state)).toThrow(
				"ID cannot be null or undefined",
			);
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
					this.addDomainEvent(this.recordEvent("SomethingHappened", undefined));
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

			agg.clearPendingEvents();
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
					this.addDomainEvent(this.recordEvent("ValueUpdated", { newValue }));
				}
				public activate() {
					this.setState({ ...this.state, status: "active" });
					this.addDomainEvent(this.recordEvent("Activated", undefined));
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
			const firstEvent = agg.pendingEvents[0]!;
			expect(firstEvent.type).toBe("ValueUpdated");
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
					this.addDomainEvent(this.recordEvent("OnlyThis", { data: "hello" }));
				}
				public doWrong() {
					// @ts-expect-error - wrong event type is rejected by TEvent constraint
					this.recordEvent("WrongEvent", undefined);
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

	describe("persistedVersion + markRestored (Insert-vs-Update + OCC baseline)", () => {
		class RestoringAggregate extends TestAggregate {
			static reconstitute(
				id: TestId,
				state: TestState,
				version: Version,
			): RestoringAggregate {
				const agg = new RestoringAggregate(id, state);
				agg.markRestored(version);
				return agg;
			}
			public callMarkRestored(version: Version): void {
				this.markRestored(version);
			}
		}

		class HookSpyAggregate extends TestAggregate {
			public hookCalls: Version[] = [];
			protected override onPersisted(version: Version): void {
				this.hookCalls.push(version);
			}
			public callMarkRestored(version: Version): void {
				this.markRestored(version);
			}
		}

		it("persistedVersion is undefined on a freshly-constructed aggregate", () => {
			const agg = TestAggregate.create("id-1" as TestId, 42);

			expect(agg.version).toBe(0);
			expect(agg.persistedVersion).toBeUndefined();
		});

		it("persistedVersion stays undefined after mutations on a never-persisted aggregate", () => {
			// Factory + edit-before-save flow (setup wizard, profile editor).
			// `version` advances past 0 in memory; `persistedVersion` must
			// remain undefined so save() routes to INSERT, not a spurious
			// UPDATE that affects 0 rows and throws ConcurrencyConflictError.
			const agg = TestAggregate.create("id-1" as TestId, 42);
			agg.updateValue(100);
			agg.activate();

			expect(agg.version).toBe(2);
			expect(agg.persistedVersion).toBeUndefined();
		});

		it("markRestored sets both version and persistedVersion to the same value", () => {
			const agg = RestoringAggregate.reconstitute(
				"id-1" as TestId,
				{ value: 7, status: "active" },
				5 as Version,
			);

			expect(agg.version).toBe(5);
			expect(agg.persistedVersion).toBe(5);
		});

		it("markRestored does NOT fire the onPersisted hook", () => {
			const agg = new HookSpyAggregate("id-1" as TestId, {
				value: 1,
				status: "inactive",
			});
			agg.callMarkRestored(3 as Version);

			expect(agg.hookCalls).toEqual([]);
		});

		it("markPersisted updates persistedVersion AND fires onPersisted", () => {
			const agg = new HookSpyAggregate("id-1" as TestId, {
				value: 1,
				status: "inactive",
			});
			agg.updateValue(2);
			expect(agg.persistedVersion).toBeUndefined();

			agg.markPersisted(1 as Version);

			expect(agg.version).toBe(1);
			expect(agg.persistedVersion).toBe(1);
			expect(agg.hookCalls).toEqual([1]);
		});

		it("mutations bump version but do NOT touch persistedVersion (OCC baseline stays at load value)", () => {
			const agg = RestoringAggregate.reconstitute(
				"id-1" as TestId,
				{ value: 0, status: "inactive" },
				3 as Version,
			);

			expect(agg.persistedVersion).toBe(3);

			agg.updateValue(1);
			agg.updateValue(2);
			agg.activate();

			expect(agg.version).toBe(6);
			expect(agg.persistedVersion).toBe(3);
		});

		it("restoreFromSnapshot aligns persistedVersion to the snapshot version", () => {
			const agg = TestAggregate.create("id-1" as TestId, 42);
			expect(agg.persistedVersion).toBeUndefined();

			const snapshot: AggregateSnapshot<TestState> = {
				state: { value: 99, status: "active" },
				version: 7 as Version,
				snapshotAt: new Date(),
			};
			agg.restoreFromSnapshot(snapshot);

			expect(agg.version).toBe(7);
			expect(agg.persistedVersion).toBe(7);
		});

		it("restoreFromSnapshot failure (validateState throws) leaves state, version, and persistedVersion unchanged", () => {
			class StrictAggregate extends TestAggregate {
				protected override validateState(state: TestState): void {
					if (state.value < 0) {
						throw new Error("value must be non-negative");
					}
				}
			}

			const agg = new StrictAggregate("id-1" as TestId, {
				value: 10,
				status: "active",
			});
			// Establish a baseline so we can verify nothing moves on failure.
			agg.markPersisted(2 as Version);
			const stateBefore = agg.state;
			const versionBefore = agg.version;
			const baselineBefore = agg.persistedVersion;

			const invalidSnapshot: AggregateSnapshot<TestState> = {
				state: { value: -1, status: "active" },
				version: 99 as Version,
				snapshotAt: new Date(),
			};

			expect(() => agg.restoreFromSnapshot(invalidSnapshot)).toThrow(
				"value must be non-negative",
			);

			// validateState runs BEFORE _state is assigned and BEFORE
			// markRestored, so all three fields stay at their pre-call values.
			expect(agg.state).toBe(stateBefore);
			expect(agg.version).toBe(versionBefore);
			expect(agg.persistedVersion).toBe(baselineBefore);
		});

		it("multi-save cycle: persistedVersion advances on each markPersisted across multiple save iterations", () => {
			const agg = RestoringAggregate.reconstitute(
				"id-1" as TestId,
				{ value: 0, status: "inactive" },
				1 as Version,
			);
			expect(agg.persistedVersion).toBe(1);

			// First save cycle: mutate twice, then save at v3.
			agg.updateValue(10);
			agg.updateValue(20);
			expect(agg.version).toBe(3);
			expect(agg.persistedVersion).toBe(1); // baseline unchanged

			agg.markPersisted(3 as Version);
			expect(agg.version).toBe(3);
			expect(agg.persistedVersion).toBe(3); // baseline advanced

			// Second save cycle: one more mutation, save at v4.
			agg.activate();
			expect(agg.version).toBe(4);
			expect(agg.persistedVersion).toBe(3); // baseline tracks the NEW load-time value

			agg.markPersisted(4 as Version);
			expect(agg.version).toBe(4);
			expect(agg.persistedVersion).toBe(4);
		});
	});

	describe("dirty tracking (changedKeys / hasChanges)", () => {
		type Item = { id: string; qty: number };
		type DirtyState = {
			name: string;
			items: Item[];
			note?: string;
		};

		class DirtyAggregate extends AggregateRoot<DirtyState, TestId> {
			protected readonly aggregateType = "DirtyAggregate";
			constructor(id: TestId, state: DirtyState) {
				super(id, state);
			}

			static reconstitute(
				id: TestId,
				state: DirtyState,
				version: Version,
			): DirtyAggregate {
				const agg = new DirtyAggregate(id, state);
				agg.markRestored(version);
				return agg;
			}

			rename(name: string): void {
				this.setState({ ...this.state, name });
			}
			replaceItems(items: Item[]): void {
				this.setState({ ...this.state, items });
			}
			setNote(note: string | undefined): void {
				this.setState({ ...this.state, note });
			}
			removeNote(): void {
				const { note: _note, ...rest } = this.state;
				this.setState(rest);
			}
			/** Identical per-key values, new top-level object, version bump. */
			touch(): void {
				this.setState({ ...this.state });
			}
			setWholeState(state: DirtyState): void {
				this.setState(state);
			}
		}

		const baseState = (): DirtyState => ({
			name: "alpha",
			items: [{ id: "i1", qty: 2 }],
		});

		describe("insert path (never persisted)", () => {
			it("lists every current state key and reports hasChanges", () => {
				const agg = new DirtyAggregate("d-1" as TestId, baseState());

				expect(new Set(agg.changedKeys)).toEqual(new Set(["name", "items"]));
				expect(agg.hasChanges).toBe(true);
			});

			it("reports hasChanges true even for an empty-object state", () => {
				class EmptyAggregate extends AggregateRoot<
					Record<string, never>,
					TestId
				> {
					protected readonly aggregateType = "EmptyAggregate";
					constructor(id: TestId) {
						super(id, {});
					}
				}
				const agg = new EmptyAggregate("d-1" as TestId);

				expect(agg.changedKeys.size).toBe(0);
				// persistedVersion is undefined: the aggregate still needs its
				// INSERT, so hasChanges must not report "nothing to do".
				expect(agg.hasChanges).toBe(true);
			});

			it("tracks keys of the CURRENT state across pre-persist mutations", () => {
				const agg = new DirtyAggregate("d-1" as TestId, baseState());
				agg.setNote("hello");

				expect(new Set(agg.changedKeys)).toEqual(
					new Set(["name", "items", "note"]),
				);
			});
		});

		describe("baseline capture", () => {
			it("reconstitute yields empty changedKeys and hasChanges false", () => {
				const agg = DirtyAggregate.reconstitute(
					"d-1" as TestId,
					baseState(),
					3 as Version,
				);

				expect(agg.changedKeys.size).toBe(0);
				expect(agg.hasChanges).toBe(false);
			});

			it("restoreFromSnapshot captures the restored state as baseline", () => {
				const agg = new DirtyAggregate("d-1" as TestId, baseState());
				agg.restoreFromSnapshot({
					state: { name: "beta", items: [{ id: "i9", qty: 1 }] },
					version: 5 as Version,
					snapshotAt: new Date(),
				});

				expect(agg.changedKeys.size).toBe(0);
				expect(agg.hasChanges).toBe(false);
			});

			it("restoreFromSnapshot AFTER mutations resets the baseline", () => {
				const agg = DirtyAggregate.reconstitute(
					"d-1" as TestId,
					baseState(),
					1 as Version,
				);
				agg.rename("mutated");
				expect(agg.changedKeys.has("name")).toBe(true);

				agg.restoreFromSnapshot({
					state: { name: "fresh", items: [] },
					version: 2 as Version,
					snapshotAt: new Date(),
				});

				expect(agg.changedKeys.size).toBe(0);
				expect(agg.hasChanges).toBe(false);
			});
		});

		describe("diff semantics", () => {
			it("flags only the replaced key; spread-preserved collection refs stay clean", () => {
				const agg = DirtyAggregate.reconstitute(
					"d-1" as TestId,
					baseState(),
					1 as Version,
				);
				agg.rename("beta");

				// THE partial-write selling point: `{ ...state, name }` copies
				// the items array BY REFERENCE, so the items table needs no write.
				expect(new Set(agg.changedKeys)).toEqual(new Set(["name"]));
			});

			it("identical per-key values yield empty changedKeys but hasChanges true via the version delta", () => {
				const agg = DirtyAggregate.reconstitute(
					"d-1" as TestId,
					baseState(),
					1 as Version,
				);
				agg.touch();

				expect(agg.changedKeys.size).toBe(0);
				// The version was bumped past persistedVersion. Skipping save()
				// here would let withCommit's markPersisted desync the OCC
				// baseline from the DB row → false ConcurrencyConflictError on
				// the next save. hasChanges must therefore stay true.
				expect(agg.version).not.toBe(agg.persistedVersion);
				expect(agg.hasChanges).toBe(true);
			});

			it("a deep-equal but newly-referenced value reports dirty (false-positive direction only)", () => {
				const agg = DirtyAggregate.reconstitute(
					"d-1" as TestId,
					baseState(),
					1 as Version,
				);
				agg.replaceItems([...agg.state.items]);

				expect(new Set(agg.changedKeys)).toEqual(new Set(["items"]));
			});

			it("an added key is dirty", () => {
				const agg = DirtyAggregate.reconstitute(
					"d-1" as TestId,
					baseState(),
					1 as Version,
				);
				agg.setNote("added");

				expect(new Set(agg.changedKeys)).toEqual(new Set(["note"]));
			});

			it("a removed key is dirty", () => {
				const agg = DirtyAggregate.reconstitute(
					"d-1" as TestId,
					{ ...baseState(), note: "present" },
					1 as Version,
				);
				agg.removeNote();

				expect(new Set(agg.changedKeys)).toEqual(new Set(["note"]));
			});

			it("a removed key whose value was undefined is dirty (presence, not value)", () => {
				// Naive `baseline[k] !== current[k]` compares
				// `undefined !== undefined` and misses this removal; the diff
				// must compare key PRESENCE as well.
				const agg = DirtyAggregate.reconstitute(
					"d-1" as TestId,
					{ ...baseState(), note: undefined },
					1 as Version,
				);
				agg.removeNote();

				expect(new Set(agg.changedKeys)).toEqual(new Set(["note"]));
			});

			it("in-place nested mutation is invisible (documented shallow contract)", () => {
				const agg = DirtyAggregate.reconstitute(
					"d-1" as TestId,
					baseState(),
					1 as Version,
				);
				// Top-level freeze does not freeze the nested array; pushing
				// into it bypasses freezeShallow AND the diff. Same contract.
				(agg.state.items as Item[]).push({ id: "i2", qty: 9 });

				expect(agg.changedKeys.size).toBe(0);
			});
		});

		describe("edge-shaped states (keyless, undefined-admitting, event-only)", () => {
			it("keyless primitive state: hasChanges falls back to reference comparison", () => {
				class PrimitiveAggregate extends AggregateRoot<string, TestId> {
					protected readonly aggregateType = "PrimitiveAggregate";
					constructor(id: TestId, state: string) {
						super(id, state);
					}
					static reconstitute(
						id: TestId,
						state: string,
						version: Version,
					): PrimitiveAggregate {
						const agg = new PrimitiveAggregate(id, state);
						agg.markRestored(version);
						return agg;
					}
					replaceNoBump(next: string): void {
						this.setStateWithoutVersionBump(next);
					}
				}

				const agg = PrimitiveAggregate.reconstitute(
					"d-1" as TestId,
					"alpha",
					1 as Version,
				);
				expect(agg.hasChanges).toBe(false);

				// The per-key diff cannot see primitives (no own keys)…
				agg.replaceNoBump("beta");
				expect(agg.changedKeys.size).toBe(0);
				// …but hasChanges must not report a false negative: the
				// reference fallback catches the replaced state even without
				// a version bump.
				expect(agg.hasChanges).toBe(true);

				// Same primitive value compares equal: still a safe skip.
				const clean = PrimitiveAggregate.reconstitute(
					"d-2" as TestId,
					"alpha",
					1 as Version,
				);
				clean.replaceNoBump("alpha");
				expect(clean.hasChanges).toBe(false);
			});

			it("a TState that admits undefined does not conflate with the never-persisted sentinel", () => {
				type MaybeState = { value: number } | undefined;
				class MaybeAggregate extends AggregateRoot<MaybeState, TestId> {
					protected readonly aggregateType = "MaybeAggregate";
					constructor(id: TestId, state: MaybeState) {
						super(id, state);
					}
					static reconstitute(
						id: TestId,
						state: MaybeState,
						version: Version,
					): MaybeAggregate {
						const agg = new MaybeAggregate(id, state);
						agg.markRestored(version);
						return agg;
					}
					set(next: MaybeState): void {
						this.setState(next);
					}
				}

				const agg = MaybeAggregate.reconstitute(
					"d-1" as TestId,
					undefined,
					1 as Version,
				);
				// Restored with undefined state: the baseline IS captured, so
				// the aggregate is clean, not stuck on the insert path.
				expect(agg.hasChanges).toBe(false);
				expect(agg.changedKeys.size).toBe(0);

				agg.set({ value: 1 });
				// keyof an undefined-admitting union collapses to never at the
				// type level; the runtime set still carries the key.
				expect((agg.changedKeys as ReadonlySet<string>).has("value")).toBe(
					true,
				);
				expect(agg.hasChanges).toBe(true);
			});

			it("an event recorded without a state change makes hasChanges true (pending-events clause)", () => {
				type Deleted = DomainEvent<"Deleted", { reason: string }>;
				class DeletingDirty extends AggregateRoot<DirtyState, TestId, Deleted> {
					protected readonly aggregateType = "DeletingDirty";
					constructor(id: TestId, state: DirtyState) {
						super(id, state);
					}
					static reconstitute(
						id: TestId,
						state: DirtyState,
						version: Version,
					): DeletingDirty {
						const agg = new DeletingDirty(id, state);
						agg.markRestored(version);
						return agg;
					}
					recordDeletion(reason: string): void {
						// Sanctioned decoupled path: event only, no state change,
						// no version bump (repository.md hard-delete pattern).
						this.addDomainEvent(this.recordEvent("Deleted", { reason }));
					}
				}

				const agg = DeletingDirty.reconstitute(
					"d-1" as TestId,
					baseState(),
					1 as Version,
				);
				expect(agg.hasChanges).toBe(false);

				agg.recordDeletion("gdpr");

				expect(agg.changedKeys.size).toBe(0);
				expect(agg.version).toBe(agg.persistedVersion);
				// The unflushed event still needs its trip through withCommit.
				expect(agg.hasChanges).toBe(true);

				agg.markPersisted(agg.version);
				expect(agg.hasChanges).toBe(false);
			});
		});

		describe("persistence lifecycle", () => {
			it("markPersisted re-baselines: changedKeys empties, hasChanges false", () => {
				const agg = DirtyAggregate.reconstitute(
					"d-1" as TestId,
					baseState(),
					1 as Version,
				);
				agg.rename("beta");
				expect(agg.changedKeys.has("name")).toBe(true);

				agg.markPersisted(agg.version);

				expect(agg.changedKeys.size).toBe(0);
				expect(agg.hasChanges).toBe(false);
			});

			it("two consecutive mutate→markPersisted cycles diff against the moved baseline", () => {
				const agg = DirtyAggregate.reconstitute(
					"d-1" as TestId,
					baseState(),
					1 as Version,
				);

				agg.rename("beta");
				expect(new Set(agg.changedKeys)).toEqual(new Set(["name"]));
				agg.markPersisted(agg.version);

				agg.replaceItems([{ id: "i2", qty: 1 }]);
				// Cycle 2 must diff against the post-save baseline: "name"
				// (changed in cycle 1) is clean now, only "items" is dirty.
				expect(new Set(agg.changedKeys)).toEqual(new Set(["items"]));
			});

			it("the markRestored override preserves version + persistedVersion semantics", () => {
				const agg = DirtyAggregate.reconstitute(
					"d-1" as TestId,
					baseState(),
					5 as Version,
				);

				expect(agg.version).toBe(5);
				expect(agg.persistedVersion).toBe(5);
				expect(agg.changedKeys.size).toBe(0);
			});

			it("clearPendingEvents does not touch the baseline", () => {
				const agg = DirtyAggregate.reconstitute(
					"d-1" as TestId,
					baseState(),
					1 as Version,
				);
				agg.rename("beta");
				const before = new Set(agg.changedKeys);

				agg.clearPendingEvents();

				expect(new Set(agg.changedKeys)).toEqual(before);
			});

			it("a failed validateState leaves changedKeys unchanged", () => {
				class GuardedAggregate extends DirtyAggregate {
					protected override validateState(state: DirtyState): void {
						if (state.name === "") throw new Error("name required");
					}
					static reconstituteGuarded(
						id: TestId,
						state: DirtyState,
						version: Version,
					): GuardedAggregate {
						const agg = new GuardedAggregate(id, state);
						agg.markRestored(version);
						return agg;
					}
				}
				const agg = GuardedAggregate.reconstituteGuarded(
					"d-1" as TestId,
					baseState(),
					1 as Version,
				);
				agg.setNote("ok");
				const before = new Set(agg.changedKeys);

				expect(() => agg.rename("")).toThrow("name required");

				expect(new Set(agg.changedKeys)).toEqual(before);
			});

			it("commit() marks the mutated key and records the event", () => {
				type Renamed = DomainEvent<"Renamed", { name: string }>;
				class CommittingDirty extends AggregateRoot<
					DirtyState,
					TestId,
					Renamed
				> {
					protected readonly aggregateType = "CommittingDirty";
					constructor(id: TestId, state: DirtyState) {
						super(id, state);
					}
					static reconstitute(
						id: TestId,
						state: DirtyState,
						version: Version,
					): CommittingDirty {
						const agg = new CommittingDirty(id, state);
						agg.markRestored(version);
						return agg;
					}
					renameWithEvent(name: string): void {
						this.commit(
							{ ...this.state, name },
							this.recordEvent("Renamed", { name }),
						);
					}
				}
				const agg = CommittingDirty.reconstitute(
					"d-1" as TestId,
					baseState(),
					1 as Version,
				);

				agg.renameWithEvent("beta");

				expect(new Set(agg.changedKeys)).toEqual(new Set(["name"]));
				expect(agg.pendingEvents).toHaveLength(1);
				expect(agg.hasChanges).toBe(true);
			});
		});

		describe("encapsulation", () => {
			it("repeated access between mutations is consistent", () => {
				const agg = DirtyAggregate.reconstitute(
					"d-1" as TestId,
					baseState(),
					1 as Version,
				);
				agg.rename("beta");

				expect(new Set(agg.changedKeys)).toEqual(new Set(agg.changedKeys));
				expect(agg.changedKeys.has("name")).toBe(true);
				expect(agg.changedKeys.has("name")).toBe(true);
			});

			it("recomputes after the baseline moves: no stale set is ever served", () => {
				const agg = DirtyAggregate.reconstitute(
					"d-1" as TestId,
					baseState(),
					1 as Version,
				);
				agg.replaceItems([{ id: "i2", qty: 1 }]);
				// Read the dirty set…
				expect(agg.changedKeys.has("items")).toBe(true);

				// …then move the baseline; the next read must reflect it.
				agg.markPersisted(agg.version);
				expect(agg.changedKeys.size).toBe(0);
			});

			it("mutating a returned set cannot poison subsequent reads", () => {
				const agg = DirtyAggregate.reconstitute(
					"d-1" as TestId,
					baseState(),
					1 as Version,
				);

				const leaked = agg.changedKeys as Set<string>;
				leaked.add("items");

				expect(agg.changedKeys.size).toBe(0);
			});
		});
	});
});
