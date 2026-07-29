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
	 */
	capture(aggregate: TAggregate): TBaseline;

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
	const capability = capabilityFor(baseline);
	return createErasedBaselineToken({
		...capability,
		baseline: capability.capture(aggregate),
		lifecycle: "loaded",
	});
}

/** Derives a typed adapter change set without exposing the stored baseline. */
export function derivePersistenceChanges<TAggregate, TChangeSet>(
	baseline: PersistenceBaseline<TAggregate, TChangeSet>,
	aggregate: TAggregate,
): PersistenceChanges<TChangeSet> {
	const capability = capabilityFor(baseline);
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
): BaselineCapability {
	const capability = capabilities.get(baseline as object);
	if (!capability) {
		throw new TypeError(
			"Persistence baseline was not created by this package instance.",
		);
	}
	return capability;
}
