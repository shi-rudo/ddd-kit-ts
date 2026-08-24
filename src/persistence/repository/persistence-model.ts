import { UnmanagedInstanceError } from "../../errors/kit-errors";
import { deepEqual } from "../../internal/structural/deep-equal";

/** Whether a baseline represents an existing row or a pending insert. */
export type PersistenceLifecycle = "loaded" | "new";

/**
 * Adapter-owned projection and change derivation for one aggregate type.
 *
 * The domain model does not implement this contract. A repository adapter
 * chooses what it persists, how that projection is captured at load, and
 * whether a change set is a partial diff or a full replacement.
 */
export interface PersistenceModel<TAggregate, TBaseline, TChangeSet> {
	/**
	 * Captures the adapter's persistence projection at the current moment.
	 * Return a detached value or an immutable value object: the Unit of Work
	 * retains it as a baseline and cannot make an arbitrary adapter type safe.
	 *
	 * Capture must be deterministic for an unchanged aggregate: the Unit of
	 * Work compares successive captures to detect mutation after write
	 * registration. A capture that embeds ambient values (clock reads,
	 * random ids) would make every commit look mutated. The default
	 * comparison is the package's structural deep equality, which matches
	 * `Set` members and `Map` keys by reference (JS `SameValueZero`
	 * semantics): a capture that re-materializes object Set members or Map
	 * keys on every call must supply {@link captureEquals}.
	 */
	capture(aggregate: TAggregate): TBaseline;

	/**
	 * Adapter-owned equality for two captures of the persistence projection.
	 * Optional: the default is the package's structural deep equality (Set
	 * members and Map keys by reference). Supply it when the capture shape
	 * needs domain-specific comparison, for example rebuilt value-object Set
	 * members compared by value.
	 */
	readonly captureEquals?: (a: TBaseline, b: TBaseline) => boolean;

	/**
	 * Derives the adapter's write payload from its own baseline.
	 *
	 * `baseline` is absent for a new aggregate. `lifecycle` disambiguates that
	 * case from an adapter whose loaded baseline type itself admits `undefined`.
	 * The returned payload must not share mutable references with the aggregate;
	 * it is the exact value later handed to `flush`.
	 */
	changes(
		baseline: TBaseline | undefined,
		aggregate: TAggregate,
		lifecycle: PersistenceLifecycle,
	): TChangeSet;

	/** Tells orchestration whether the derived state write is empty. */
	isEmpty(changes: TChangeSet): boolean;
}

declare const persistenceBaselineBrand: unique symbol;

/**
 * Opaque, typed receipt for an adapter-owned persistence baseline.
 *
 * It intentionally exposes no data. The Unit of Work may retain the token and
 * ask the owning adapter capability to derive changes, but cannot branch on or
 * couple itself to the baseline's shape.
 */
export interface PersistenceBaseline<TAggregate, TChangeSet> {
	readonly [persistenceBaselineBrand]: (aggregate: TAggregate) => TChangeSet;
}

/** A derived adapter change set plus its adapter-defined emptiness result. */
export interface PersistenceChanges<TChangeSet> {
	readonly value: TChangeSet;
	readonly empty: boolean;
}

interface BaselineCapability {
	readonly baseline: unknown;
	readonly lifecycle: PersistenceLifecycle;
	capture(aggregate: unknown): unknown;
	captureEquals(a: unknown, b: unknown): boolean;
	changes(
		baseline: unknown,
		aggregate: unknown,
		lifecycle: PersistenceLifecycle,
	): unknown;
	isEmpty(changes: unknown): boolean;
}

const capabilities = new WeakMap<object, BaselineCapability>();

/** Captures a baseline for an aggregate restored by a repository adapter. */
export function capturePersistenceBaseline<TAggregate, TBaseline, TChangeSet>(
	model: PersistenceModel<TAggregate, TBaseline, TChangeSet>,
	aggregate: TAggregate,
): PersistenceBaseline<TAggregate, TChangeSet> {
	return createBaselineToken(model, model.capture(aggregate), "loaded");
}

/** Creates the explicit no-row baseline for a newly added aggregate. */
export function insertPersistenceBaseline<TAggregate, TBaseline, TChangeSet>(
	model: PersistenceModel<TAggregate, TBaseline, TChangeSet>,
): PersistenceBaseline<TAggregate, TChangeSet> {
	return createBaselineToken(model, undefined, "new");
}

/**
 * Captures the aggregate's current adapter projection using the capability
 * carried by an existing baseline. Used to seal persistence-last registration.
 */
export function recapturePersistenceBaseline<TAggregate, TChangeSet>(
	baseline: PersistenceBaseline<TAggregate, TChangeSet>,
	aggregate: TAggregate,
): PersistenceBaseline<TAggregate, TChangeSet> {
	const capability = capabilityFor(baseline, "recapturePersistenceBaseline");
	return createErasedBaselineToken({
		...capability,
		baseline: capability.capture(aggregate),
		lifecycle: "loaded",
	});
}

/**
 * Recaptures the adapter projection and reports whether it drifted from the
 * baseline's stored capture, using the model's `captureEquals` when supplied
 * and structural deep equality otherwise.
 *
 * This, not `changes()`/`isEmpty()`, is the mutation detector: the
 * `PersistenceModel` contract explicitly permits a full-replacement change
 * set whose `isEmpty` is never true, so a non-empty change set proves
 * nothing about mutation. Comparing capture to capture asks the honest
 * question independent of the model's diffing strategy. A `"new"` lifecycle
 * baseline has no stored capture and never reports drift.
 */
export function persistenceProjectionDrifted<TAggregate, TChangeSet>(
	baseline: PersistenceBaseline<TAggregate, TChangeSet>,
	aggregate: TAggregate,
): boolean {
	const capability = capabilityFor(baseline, "persistenceProjectionDrifted");
	if (capability.lifecycle === "new") return false;
	return !capability.captureEquals(
		capability.baseline,
		capability.capture(aggregate),
	);
}

/** Derives a typed adapter change set without exposing the stored baseline. */
export function derivePersistenceChanges<TAggregate, TChangeSet>(
	baseline: PersistenceBaseline<TAggregate, TChangeSet>,
	aggregate: TAggregate,
): PersistenceChanges<TChangeSet> {
	const capability = capabilityFor(baseline, "derivePersistenceChanges");
	const value = capability.changes(
		capability.baseline,
		aggregate,
		capability.lifecycle,
	) as TChangeSet;
	return Object.freeze({ value, empty: capability.isEmpty(value) });
}

function createBaselineToken<TAggregate, TBaseline, TChangeSet>(
	model: PersistenceModel<TAggregate, TBaseline, TChangeSet>,
	baseline: TBaseline | undefined,
	lifecycle: PersistenceLifecycle,
): PersistenceBaseline<TAggregate, TChangeSet> {
	return createErasedBaselineToken({
		baseline,
		lifecycle,
		capture: (aggregate) => model.capture(aggregate as TAggregate),
		captureEquals: (a, b) =>
			model.captureEquals
				? model.captureEquals(a as TBaseline, b as TBaseline)
				: deepEqual(a, b),
		changes: (stored, aggregate, currentLifecycle) =>
			model.changes(
				stored as TBaseline | undefined,
				aggregate as TAggregate,
				currentLifecycle,
			),
		isEmpty: (changes) => model.isEmpty(changes as TChangeSet),
	});
}

function createErasedBaselineToken<TAggregate, TChangeSet>(
	capability: BaselineCapability,
): PersistenceBaseline<TAggregate, TChangeSet> {
	const token = Object.freeze(Object.create(null)) as PersistenceBaseline<
		TAggregate,
		TChangeSet
	>;
	capabilities.set(token as object, capability);
	return token;
}

function capabilityFor<TAggregate, TChangeSet>(
	baseline: PersistenceBaseline<TAggregate, TChangeSet>,
	operation: string,
): BaselineCapability {
	const capability = capabilities.get(baseline as object);
	if (!capability) {
		throw new UnmanagedInstanceError(operation, "the persistence baseline");
	}
	return capability;
}
