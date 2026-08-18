/**
 * Kit-internal authority for acknowledging one exact pending-event batch.
 *
 * Kept out of every package entry point: repositories may inspect aggregate
 * state and pending events, but only application commit orchestration may
 * acknowledge or discard them after the surrounding transaction commits.
 */
export interface PendingEventLifecycleCapability {
	/**
	 * Acknowledges the committed batch. `committedVersion` is the version the
	 * commit actually persisted (captured at enrollment); the aggregate syncs
	 * its persisted-version marker from it rather than from its live version,
	 * so un-awaited concurrent work mutating the instance in the post-commit
	 * window cannot desync the marker.
	 */
	acknowledge(events: ReadonlyArray<unknown>, committedVersion?: number): void;
	discardPendingEvents(events: ReadonlyArray<unknown>): void;
	/**
	 * Version the persistence layer last confirmed for the aggregate, or
	 * `undefined` for a never-persisted instance. Grounds the `withCommit`
	 * unique-cursor guard.
	 */
	persistedVersion(): number | undefined;
}

// The key version stamps the capability SHAPE. Bump it whenever the
// interface above changes: registrations made under another key stay
// invisible, so an aggregate constructed by an incompatible package copy
// fails the generic "no kit-managed persistence lifecycle" check instead of
// half-working through a shape it does not fully implement.
const persistenceCapabilityRegistryKey = Symbol.for(
	"@shirudo/ddd-kit/pending-event-lifecycle-registry/v4",
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
