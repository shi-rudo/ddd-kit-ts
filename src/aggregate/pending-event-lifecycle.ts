/**
 * Kit-internal authority for acknowledging one exact pending-event batch.
 *
 * Kept out of every package entry point: repositories may inspect aggregate
 * state and pending events, but only application commit orchestration may
 * acknowledge or discard them after the surrounding transaction commits.
 */
export interface PendingEventLifecycleCapability {
	acknowledge(events: ReadonlyArray<unknown>): void;
	discardPendingEvents(events: ReadonlyArray<unknown>): void;
}

const persistenceCapabilityRegistryKey = Symbol.for(
	"@shirudo/ddd-kit/pending-event-lifecycle-registry/v3",
);

function createCapabilityRegistry(): WeakMap<
	object,
	PendingEventLifecycleCapability
> {
	const existing = Object.getOwnPropertyDescriptor(
		globalThis,
		persistenceCapabilityRegistryKey,
	)?.value;
	if (existing instanceof WeakMap) {
		return existing as WeakMap<object, PendingEventLifecycleCapability>;
	}

	const registry = new WeakMap<object, PendingEventLifecycleCapability>();
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

export function registerPendingEventLifecycleCapability(
	aggregate: object,
	capability: PendingEventLifecycleCapability,
): void {
	const frozen = Object.freeze(capability);
	capabilities.set(aggregate, frozen);
}

export function pendingEventLifecycleCapabilityFor(
	aggregate: object,
): PendingEventLifecycleCapability | undefined {
	return capabilities.get(aggregate);
}
