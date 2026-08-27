import { describe, expect, it, vi } from "vite-plus/test";
import type { Version } from "../../domain/aggregate/aggregate";
import { EventSourcedAggregate } from "../../domain/aggregate/event-sourced-aggregate";
import {
	createDomainEvent,
	type DomainEvent,
	type UncommittedDomainEventOf,
} from "../../domain/event/domain-event";
import { SnapshotTimeValidationError } from "../../domain/event/domain-event-errors";
import type { Id } from "../../domain/identity/id";
import {
	DomainError,
	InvalidVersionError,
	SnapshotCorruptedError,
	type SnapshotSchemaMismatchError,
} from "../../errors/kit-errors";
import {
	captureAggregateSnapshot,
	defineSnapshotModel,
	reconstituteAggregateFromSnapshot,
} from "./snapshot-model";

type OrderId = Id<"Order">;

interface Order {
	readonly id: OrderId;
	readonly version: Version;
	readonly state: { readonly status: string };
}

const model = defineSnapshotModel({
	aggregateType: "Order",
	schemaVersion: 2,
	capture: (order: Order) => ({ status: order.state.status }),
	reconstitute: (
		id: OrderId,
		state: { readonly status: string },
		version: Version,
	): Order => ({ id, state, version }),
});

describe("adapter-owned snapshot models", () => {
	it("rejects invalid model identities and schema versions at definition time", () => {
		expect(() => defineSnapshotModel({ ...model, aggregateType: "" })).toThrow(
			/aggregateType/,
		);
		expect(() => defineSnapshotModel({ ...model, schemaVersion: 0 })).toThrow(
			/schemaVersion/,
		);
		expect(() => defineSnapshotModel({ ...model, schemaVersion: 1.5 })).toThrow(
			/schemaVersion/,
		);
	});

	it("rejects a class-based model whose methods would vanish in the spread", () => {
		class OrderSnapshotModelClass {
			readonly aggregateType = "Order";
			readonly schemaVersion = 2;
			capture(order: Order): { readonly status: string } {
				return { status: order.state.status };
			}
			reconstitute(
				id: OrderId,
				state: { readonly status: string },
				version: Version,
			): Order {
				return { id, state, version };
			}
		}

		expect(() => defineSnapshotModel(new OrderSnapshotModelClass())).toThrow(
			/SnapshotModel\.capture is missing or not a function/,
		);
	});

	it("captures a detached snapshot envelope from an aggregate", () => {
		const state = { status: "placed" };
		const order: Order = {
			id: "order-1" as OrderId,
			state,
			version: 4 as Version,
		};
		const snapshotAt = new Date("2026-07-29T10:00:00.000Z");

		const snapshot = captureAggregateSnapshot(model, order, snapshotAt);

		expect(snapshot).toEqual({
			state: { status: "placed" },
			version: 4,
			snapshotAt,
			schemaVersion: 2,
		});
		expect(snapshot.state).not.toBe(state);
		expect(snapshot.snapshotAt).not.toBe(snapshotAt);
	});

	it("rejects invalid or non-Date snapshot times", () => {
		const order: Order = {
			id: "order-1" as OrderId,
			state: { status: "placed" },
			version: 1 as Version,
		};

		expect(() =>
			captureAggregateSnapshot(model, order, new Date(Number.NaN)),
		).toThrow(SnapshotTimeValidationError);
		expect(() =>
			captureAggregateSnapshot(model, order, 0 as unknown as Date),
		).toThrow(SnapshotTimeValidationError);
	});

	it("reconstitutes a fresh aggregate without aliasing stored state", () => {
		const storedState = { status: "placed" };
		const restored = reconstituteAggregateFromSnapshot(
			model,
			"order-1" as OrderId,
			{
				state: storedState,
				version: 7 as Version,
				snapshotAt: new Date("2026-07-29T10:00:00.000Z"),
				schemaVersion: 2,
			},
		);

		expect(restored).toEqual({
			id: "order-1",
			state: { status: "placed" },
			version: 7,
		});
		expect(restored.state).not.toBe(storedState);
	});

	it("rejects symbol values with a guided error instead of a DataCloneError", () => {
		const order: Order = {
			id: "order-1" as OrderId,
			state: { status: "placed" },
			version: 1 as Version,
		};
		const symbolModel = defineSnapshotModel({
			...model,
			capture: () =>
				({ status: Symbol("draft") }) as unknown as {
					readonly status: string;
				},
		});

		// structuredClone would throw a raw DOMException with no path; the
		// gate must reject with the module's guided TypeError instead.
		expect(() =>
			captureAggregateSnapshot(
				symbolModel,
				order,
				new Date("2026-07-29T10:00:00.000Z"),
			),
		).toThrow(/snapshot state\.status is a symbol/);
	});

	it("routes a foreign-copy domain rejection into the corruption channel", () => {
		// Structurally a DomainError from another loaded kit copy: not
		// instanceof this copy's class, but category "DOMAIN".
		class ForeignDomainError extends Error {
			readonly category = "DOMAIN";
			readonly code = "STATUS_NOT_ALLOWED";
		}
		const validatingModel = defineSnapshotModel({
			...model,
			reconstitute: (): Order => {
				throw new ForeignDomainError("status no longer allowed");
			},
		});

		let caught: unknown;
		try {
			reconstituteAggregateFromSnapshot(validatingModel, "order-1" as OrderId, {
				state: { status: "placed" },
				version: 7 as Version,
				snapshotAt: new Date("2026-07-29T10:00:00.000Z"),
				schemaVersion: 2,
			});
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(SnapshotCorruptedError);
		expect((caught as SnapshotCorruptedError).cause).toBeInstanceOf(
			ForeignDomainError,
		);
	});

	it("routes a corrupt stored version into the corruption channel", () => {
		let caught: unknown;
		try {
			reconstituteAggregateFromSnapshot(model, "order-1" as OrderId, {
				state: { status: "placed" },
				version: -1 as Version,
				snapshotAt: new Date("2026-07-29T10:00:00.000Z"),
				schemaVersion: 2,
			});
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(SnapshotCorruptedError);
		expect((caught as SnapshotCorruptedError).cause).toBeInstanceOf(
			InvalidVersionError,
		);
	});

	it("lets an InvalidVersionError thrown by the factory itself propagate raw", () => {
		// A factory that advances the version before markReconstituted is a wiring
		// bug; wrapping it as corruption would refold the stream on every
		// load, forever.
		const wiredWrongModel = defineSnapshotModel({
			...model,
			reconstitute: (): Order => {
				throw new InvalidVersionError(0, "is below the current version 1");
			},
		});

		expect(() =>
			reconstituteAggregateFromSnapshot(wiredWrongModel, "order-1" as OrderId, {
				state: { status: "placed" },
				version: 0 as Version,
				snapshotAt: new Date("2026-07-29T10:00:00.000Z"),
				schemaVersion: 2,
			}),
		).toThrow(InvalidVersionError);
	});

	it("rejects a reconstitution that does not restore the snapshot version", () => {
		// A factory that ignores the version parameter (a forgotten
		// markReconstituted) is a wiring bug, not corruption: it must throw raw
		// instead of feeding the discard-and-refold recovery forever.
		const forgetfulModel = defineSnapshotModel({
			...model,
			reconstitute: (
				id: OrderId,
				state: { readonly status: string },
			): Order => ({ id, state, version: 0 as Version }),
		});

		expect(() =>
			reconstituteAggregateFromSnapshot(forgetfulModel, "order-1" as OrderId, {
				state: { status: "placed" },
				version: 7 as Version,
				snapshotAt: new Date("2026-07-29T10:00:00.000Z"),
				schemaVersion: 2,
			}),
		).toThrow(/must restore the persisted version/);
	});

	it("surfaces a domain rejection during reconstitution as snapshot corruption", () => {
		class StatusNoLongerAllowedError extends DomainError<"STATUS_NOT_ALLOWED"> {
			constructor() {
				super({
					code: "STATUS_NOT_ALLOWED",
					message: "status 'placed' is no longer a valid order status",
				});
			}
		}
		// A factory running TODAY'S validateState rules against yesterday's
		// stored blob: the load recipe must be able to catch one corruption
		// channel and refold from the stream instead of failing getById.
		const validatingModel = defineSnapshotModel({
			...model,
			reconstitute: (): Order => {
				throw new StatusNoLongerAllowedError();
			},
		});

		let caught: unknown;
		try {
			reconstituteAggregateFromSnapshot(validatingModel, "order-1" as OrderId, {
				state: { status: "placed" },
				version: 7 as Version,
				snapshotAt: new Date("2026-07-29T10:00:00.000Z"),
				schemaVersion: 2,
			});
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(SnapshotCorruptedError);
		expect((caught as SnapshotCorruptedError).cause).toBeInstanceOf(
			StatusNoLongerAllowedError,
		);
	});

	it("detaches nested data on capture and reconstitution", () => {
		type NestedOrder = Omit<Order, "state"> & {
			readonly state: { readonly lines: ReadonlyArray<{ quantity: number }> };
		};
		const nestedModel = defineSnapshotModel({
			aggregateType: "NestedOrder",
			schemaVersion: 1,
			capture: (order: NestedOrder) => ({
				lines: order.state.lines.map((line) => ({ ...line })),
			}),
			reconstitute: (
				id: OrderId,
				state: { readonly lines: ReadonlyArray<{ quantity: number }> },
				version: Version,
			): NestedOrder => ({ id, state, version }),
		});
		const aggregate: NestedOrder = {
			id: "order-1" as OrderId,
			version: 1 as Version,
			state: { lines: [{ quantity: 2 }] },
		};

		const snapshot = captureAggregateSnapshot(
			nestedModel,
			aggregate,
			new Date(),
		);
		const restored = reconstituteAggregateFromSnapshot(
			nestedModel,
			aggregate.id,
			snapshot,
		);

		expect(snapshot.state.lines).not.toBe(aggregate.state.lines);
		expect(snapshot.state.lines[0]).not.toBe(aggregate.state.lines[0]);
		expect(restored.state.lines).not.toBe(snapshot.state.lines);
		expect(restored.state.lines[0]).not.toBe(snapshot.state.lines[0]);
	});

	it("treats a missing stored schema version as version 1", () => {
		const migrate = vi.fn(() => ({ status: "migrated" }));
		const migratingModel = defineSnapshotModel({ ...model, migrate });

		const restored = reconstituteAggregateFromSnapshot(
			migratingModel,
			"order-1" as OrderId,
			{
				state: { legacyStatus: "placed" },
				version: 3 as Version,
				snapshotAt: new Date("2026-07-29T10:00:00.000Z"),
			},
		);

		expect(migrate).toHaveBeenCalledWith({ legacyStatus: "placed" }, 1);
		expect(restored.state).toEqual({ status: "migrated" });
	});

	it("fails with an addressed schema mismatch when no migration exists", () => {
		expect(() =>
			reconstituteAggregateFromSnapshot(model, "order-1" as OrderId, {
				state: { status: "placed" },
				version: 3 as Version,
				snapshotAt: new Date("2026-07-29T10:00:00.000Z"),
				schemaVersion: 1,
			}),
		).toThrowError(
			expect.objectContaining({
				aggregateType: "Order",
				aggregateId: "order-1",
				expectedSchemaVersion: 2,
				actualSchemaVersion: 1,
			}) as SnapshotSchemaMismatchError,
		);
	});

	it("rejects snapshot projections that would lose class behavior", () => {
		class ChildEntity {
			constructor(readonly value: string) {}
		}
		const unsafeModel = defineSnapshotModel({
			aggregateType: "Order",
			schemaVersion: 1,
			capture: () => ({ child: new ChildEntity("value") }),
			reconstitute: (id: OrderId, _state, version: Version): Order => ({
				id,
				state: { status: "unused" },
				version,
			}),
		});
		const order: Order = {
			id: "order-1" as OrderId,
			state: { status: "placed" },
			version: 1 as Version,
		};

		expect(() =>
			captureAggregateSnapshot(unsafeModel, order, new Date()),
		).toThrow(/class instance \(ChildEntity\)/);
	});

	const unsafeCaptures: ReadonlyArray<readonly [string, () => unknown]> = [
		["function", () => ({ nested: { calculate: () => 1 } })],
		["Promise", () => ({ nested: Promise.resolve(1) })],
		["Error", () => ({ nested: new Error("broken") })],
	];
	it.each(unsafeCaptures)(
		"rejects %s-valued snapshot DTOs with their path",
		(_kind, capture) => {
			const unsafeModel = defineSnapshotModel({
				aggregateType: "Order",
				schemaVersion: 1,
				capture,
				reconstitute: (id: OrderId, _state, version: Version): Order => ({
					id,
					state: { status: "unused" },
					version,
				}),
			});
			const order: Order = {
				id: "order-1" as OrderId,
				state: { status: "placed" },
				version: 1 as Version,
			};

			expect(() =>
				captureAggregateSnapshot(unsafeModel, order, new Date()),
			).toThrow(/nested/);
		},
	);

	it("rejects enumerable symbol keys that structuredClone would discard", () => {
		const secret = Symbol("secret");
		const unsafeModel = defineSnapshotModel({
			aggregateType: "Order",
			schemaVersion: 1,
			capture: () => ({ [secret]: "lost" }),
			reconstitute: (id: OrderId, _state, version: Version): Order => ({
				id,
				state: { status: "unused" },
				version,
			}),
		});
		const order: Order = {
			id: "order-1" as OrderId,
			state: { status: "placed" },
			version: 1 as Version,
		};

		expect(() =>
			captureAggregateSnapshot(unsafeModel, order, new Date()),
		).toThrow(/symbol-keyed/);
	});

	it("composes snapshot reconstitution with additive event-tail replay", () => {
		type CounterId = Id<"Counter">;
		type Incremented = DomainEvent<"Incremented", { by: number }>;
		class Counter extends EventSourcedAggregate<
			{ readonly value: number },
			Incremented,
			CounterId
		> {
			protected readonly aggregateType = "Counter";

			static bare(id: CounterId): Counter {
				return new Counter(id, { value: 0 });
			}

			static reconstitute(
				id: CounterId,
				state: { readonly value: number },
				version: Version,
			): Counter {
				const counter = new Counter(id, state);
				counter.markReconstituted(version);
				return counter;
			}

			get value(): number {
				return this.state.value;
			}

			protected readonly handlers = {
				Incremented: (
					state: { readonly value: number },
					event: UncommittedDomainEventOf<Incremented>,
				) => ({ value: state.value + event.payload.by }),
			};
		}
		const counterModel = defineSnapshotModel({
			aggregateType: "Counter",
			schemaVersion: 1,
			capture: (counter: Counter) => ({ value: counter.value }),
			reconstitute: Counter.reconstitute,
		});
		const id = "counter-1" as CounterId;
		const history = [1, 2, 3, 4].map((by) =>
			createDomainEvent(
				"Incremented",
				{ by },
				{ aggregateId: id, aggregateType: "Counter" },
			),
		);
		const full = Counter.bare(id);
		expect(full.replayHistory(history).isOk()).toBe(true);
		const atVersionTwo = Counter.bare(id);
		expect(atVersionTwo.replayHistory(history.slice(0, 2)).isOk()).toBe(true);
		const snapshot = captureAggregateSnapshot(
			counterModel,
			atVersionTwo,
			new Date(),
		);

		const fromSnapshot = reconstituteAggregateFromSnapshot(
			counterModel,
			id,
			snapshot,
		);
		expect(fromSnapshot.replayHistory(history.slice(2)).isOk()).toBe(true);

		expect(fromSnapshot.value).toBe(full.value);
		expect(fromSnapshot.version).toBe(full.version);
	});
});
