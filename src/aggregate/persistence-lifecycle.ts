import type { Version } from "./aggregate";

/**
 * Kit-internal authority for advancing an aggregate's persistence baseline.
 *
 * Kept out of every package entry point: repositories may inspect aggregate
 * state and pending events, but only application commit orchestration may
 * acknowledge or discard them after the surrounding transaction commits.
 */
export interface AggregatePersistenceCapability {
	acknowledge(version: Version): void;
	discardPendingEvents(): void;
}

const persistenceCapabilityRegistryKey = Symbol.for(
	"@shirudo/ddd-kit/aggregate-persistence-capability-registry/v3",
);

function createCapabilityRegistry(): WeakMap<
	object,
	AggregatePersistenceCapability
> {
	const existing = Object.getOwnPropertyDescriptor(
		globalThis,
		persistenceCapabilityRegistryKey,
	)?.value;
	if (existing instanceof WeakMap) {
		return existing as WeakMap<object, AggregatePersistenceCapability>;
	}

	const registry = new WeakMap<object, AggregatePersistenceCapability>();
	try {
		Object.defineProperty(globalThis, persistenceCapabilityRegistryKey, {
			value: registry,
			enumerable: false,
			writable: false,
			configurable: false,
		});
	} catch {
		// A hardened host may reject global registration. The local registry
		// still preserves the lifecycle boundary; only duplicate-package
		// cooperation is unavailable in that host.
	}
	return registry;
}

// A shared WeakMap lets aggregates constructed by a bundled plugin copy be
// acknowledged by the host package copy without attaching callable authority
// to the aggregate itself. The registry is not a security boundary against
// code already running in the same process; it is an architectural boundary
// kept out of package exports and public aggregate types.
const capabilities = createCapabilityRegistry();

export function registerAggregatePersistenceCapability(
	aggregate: object,
	capability: AggregatePersistenceCapability,
): void {
	const frozen = Object.freeze(capability);
	capabilities.set(aggregate, frozen);
}

export function aggregatePersistenceCapabilityFor(
	aggregate: object,
): AggregatePersistenceCapability | undefined {
	return capabilities.get(aggregate);
}
