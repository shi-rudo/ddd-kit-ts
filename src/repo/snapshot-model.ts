import type { AggregateSnapshot, Version } from "../aggregate/aggregate";
import { SnapshotTimeValidationError } from "../aggregate/domain-event-errors";
import { SnapshotSchemaMismatchError } from "../core/errors";
import type { Id } from "../core/id";
import { isBuiltInObject } from "../utils/array/is-built-in";

interface SnapshotAggregate {
	readonly id: Id<string>;
	readonly version: Version;
}

/**
 * Adapter-owned mapping between an OO aggregate and its stored snapshot DTO.
 *
 * Snapshot shape, schema migration, envelope construction, and reconstitution
 * are persistence concerns. The aggregate remains responsible for producing a
 * valid domain object; it does not know when or how snapshots are stored.
 */
export interface SnapshotModel<
	TAggregate extends SnapshotAggregate,
	TSnapshotState,
> {
	/** Stable type name used to address schema errors and snapshot storage. */
	readonly aggregateType: string;

	/** Current schema version of the stored snapshot DTO. */
	readonly schemaVersion: number;

	/** Projects the current aggregate into a persistence DTO. */
	capture(aggregate: TAggregate): TSnapshotState;

	/**
	 * Reconstitutes a fresh, valid aggregate without recording a new decision.
	 * This is normally a call to a static aggregate factory.
	 */
	reconstitute(
		id: TAggregate["id"],
		state: TSnapshotState,
		version: Version,
	): TAggregate;

	/** Upgrades an older stored DTO into the model's current DTO shape. */
	readonly migrate?: (
		stored: unknown,
		storedSchemaVersion: number,
	) => TSnapshotState;
}

/** Type-inference helper for declaring an adapter-owned snapshot model. */
export function defineSnapshotModel<
	TAggregate extends SnapshotAggregate,
	TSnapshotState,
>(
	model: SnapshotModel<TAggregate, TSnapshotState>,
): SnapshotModel<TAggregate, TSnapshotState> {
	assertSnapshotModel(model);
	return Object.freeze({ ...model });
}

/**
 * Captures a detached persistence envelope at an application-supplied time.
 * The application decides when snapshotting is worthwhile; this function does
 * not read a clock or perform I/O.
 */
export function captureAggregateSnapshot<
	TAggregate extends SnapshotAggregate,
	TSnapshotState,
>(
	model: SnapshotModel<TAggregate, TSnapshotState>,
	aggregate: TAggregate,
	snapshotAt: Date,
): AggregateSnapshot<TSnapshotState> {
	assertSnapshotModel(model);
	const recordedAt = copySnapshotAt(snapshotAt);
	const state = detachSnapshotState(model.capture(aggregate));
	return Object.freeze({
		state,
		version: aggregate.version,
		snapshotAt: recordedAt,
		schemaVersion: model.schemaVersion,
	});
}

/**
 * Reconstitutes a fresh aggregate from a stored snapshot through the owning
 * adapter model. A missing schema version denotes the original schema `1`.
 */
export function reconstituteAggregateFromSnapshot<
	TAggregate extends SnapshotAggregate,
	TSnapshotState,
>(
	model: SnapshotModel<TAggregate, TSnapshotState>,
	id: TAggregate["id"],
	snapshot: AggregateSnapshot<unknown>,
): TAggregate {
	assertSnapshotModel(model);
	const storedSchemaVersion = snapshot.schemaVersion ?? 1;
	let state: TSnapshotState;
	if (storedSchemaVersion === model.schemaVersion) {
		state = detachSnapshotState(snapshot.state) as TSnapshotState;
	} else if (model.migrate) {
		state = detachSnapshotState(
			model.migrate(detachSnapshotState(snapshot.state), storedSchemaVersion),
		);
	} else {
		throw new SnapshotSchemaMismatchError({
			aggregateType: model.aggregateType,
			aggregateId: String(id),
			expectedSchemaVersion: model.schemaVersion,
			actualSchemaVersion: storedSchemaVersion,
		});
	}

	return model.reconstitute(id, state, snapshot.version);
}

function assertSnapshotModel(model: {
	readonly aggregateType: string;
	readonly schemaVersion: number;
}): void {
	if (
		typeof model.aggregateType !== "string" ||
		model.aggregateType.trim().length === 0
	) {
		throw new TypeError(
			"SnapshotModel.aggregateType must be a non-empty string",
		);
	}
	if (!Number.isSafeInteger(model.schemaVersion) || model.schemaVersion < 1) {
		throw new TypeError(
			"SnapshotModel.schemaVersion must be a positive safe integer",
		);
	}
}

function copySnapshotAt(snapshotAt: Date): Date {
	if (!(snapshotAt instanceof Date) || !Number.isFinite(snapshotAt.getTime())) {
		throw new SnapshotTimeValidationError();
	}
	return new Date(snapshotAt.getTime());
}

function detachSnapshotState<T>(state: T): T {
	assertSnapshotSafe(state, "", new WeakSet());
	return structuredClone(state);
}

/**
 * Rejects graphs that structured cloning would lose or silently degrade.
 * Snapshot models map class-based domain state to plain persistence DTOs.
 */
function assertSnapshotSafe(
	value: unknown,
	path: string,
	seen: WeakSet<object>,
): void {
	if (typeof value === "function") {
		throw new TypeError(
			`snapshot state${path} is a function; map it to serialisable data in the snapshot model`,
		);
	}
	if (value === null || typeof value !== "object") return;
	const object = value as object;
	if (seen.has(object)) return;
	seen.add(object);

	if (Array.isArray(object)) {
		for (let index = 0; index < object.length; index++) {
			assertSnapshotSafe(object[index], `${path}[${index}]`, seen);
		}
		return;
	}

	const tag = Object.prototype.toString.call(object);
	if (isBuiltInObject(object, tag)) {
		if (tag === "[object Map]") {
			let index = 0;
			for (const [key, entry] of object as Map<unknown, unknown>) {
				assertSnapshotSafe(key, `${path}<map key #${index}>`, seen);
				assertSnapshotSafe(entry, `${path}<map value #${index}>`, seen);
				index++;
			}
			return;
		}
		if (tag === "[object Set]") {
			let index = 0;
			for (const member of object as Set<unknown>) {
				assertSnapshotSafe(member, `${path}<set member #${index}>`, seen);
				index++;
			}
			return;
		}
		if (
			tag === "[object Promise]" ||
			tag === "[object WeakMap]" ||
			tag === "[object WeakSet]"
		) {
			throw new TypeError(
				`snapshot state${path} is a ${tag.slice(8, -1)} and cannot be persisted`,
			);
		}
		if (tag === "[object Error]") {
			throw new TypeError(
				`snapshot state${path} is an Error; map it to plain data in the snapshot model`,
			);
		}
		return;
	}

	const prototype = Object.getPrototypeOf(object);
	if (prototype === Object.prototype || prototype === null) {
		for (const key of Reflect.ownKeys(object)) {
			const descriptor = Object.getOwnPropertyDescriptor(object, key);
			if (!descriptor?.enumerable) continue;
			if (typeof key === "symbol") {
				throw new TypeError(
					`snapshot state${path} has a symbol-keyed property; map it to plain data in the snapshot model`,
				);
			}
			assertSnapshotSafe(
				(object as Record<PropertyKey, unknown>)[key],
				`${path}.${key}`,
				seen,
			);
		}
		return;
	}

	const name: string = prototype.constructor?.name || "anonymous class";
	throw new TypeError(
		`snapshot state${path} is a class instance (${name}); map it to plain data in the snapshot model`,
	);
}
