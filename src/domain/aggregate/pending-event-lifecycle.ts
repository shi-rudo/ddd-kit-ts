import type { AnyDomainEvent, PendingDomainEvent } from "../event/domain-event";
import type { Version } from "./aggregate";
import { createGlobalCapabilityRegistry } from "./internal/global-capability-registry";

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
	acknowledge(
		events: ReadonlyArray<PendingDomainEvent<AnyDomainEvent>>,
		committedVersion: Version,
	): void;
	discardPendingEvents(
		events: ReadonlyArray<PendingDomainEvent<AnyDomainEvent>>,
	): void;
	/**
	 * Version the persistence layer last confirmed for the aggregate, or
	 * `undefined` for a never-persisted instance. Grounds the `withCommit`
	 * unique-cursor guard.
	 */
	persistedVersion(): Version | undefined;
	/**
	 * Count of unflushed pending events. The public `pendingEvents` getter
	 * allocates and freezes a defensive copy per read, which count-only
	 * consumers (the identity map's end-of-run scan) do not need.
	 */
	pendingEventCount(): number;
	/**
	 * The aggregate's declared type, for the harvest to check a recorded
	 * event's address against the enrolled aggregate; the type is protected
	 * on the aggregate and absent from `IAggregateRoot`.
	 */
	aggregateType(): string;
}

// The key version stamps the capability SHAPE. Bump it whenever the
// interface above changes: registrations made under another key stay
// invisible, so an aggregate constructed by an incompatible package copy
// fails the UnmanagedInstanceError check at enrollment instead of
// half-working through a shape it does not fully implement.
const persistenceCapabilityRegistryKey = Symbol.for(
	"@shirudo/ddd-kit/pending-event-lifecycle-registry/v6",
);

const { registry: capabilities, shared } =
	createGlobalCapabilityRegistry<PendingEventLifecycleCapability>(
		persistenceCapabilityRegistryKey,
	);

/**
 * Whether the lifecycle registry is the process-wide one. `false` only on a
 * host that rejected the global registration; a lookup that fails then
 * names the private registry as the reason.
 */
export function isPendingEventLifecycleRegistryShared(): boolean {
	return shared;
}

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
