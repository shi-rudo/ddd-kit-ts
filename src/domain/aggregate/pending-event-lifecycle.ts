import type { AnyDomainEvent, PendingDomainEvent } from "../event/domain-event";
import type { Version } from "./aggregate";
import { createGlobalCapabilityRegistry } from "./internal/global-capability-registry";

/**
 * Kit-internal read view of the pending-event lifecycle. Kept out of every
 * package entry point. A repository identity map and a replay path read the
 * pending count through it; neither can acknowledge or discard through it.
 */
export interface PendingEventLifecycleReadView {
	/**
	 * Version the persistence layer last confirmed for the aggregate, or
	 * `undefined` for a never-persisted instance. Grounds the application
	 * shell's unique-cursor guard.
	 */
	persistedVersion(): Version | undefined;
	/**
	 * Count of unflushed pending events. The public `pendingEvents` getter
	 * allocates and freezes a defensive copy per read, which a count-only
	 * consumer does not need.
	 */
	pendingEventCount(): number;
	/**
	 * The aggregate's declared type; it is protected on the aggregate and
	 * absent from `Aggregate`.
	 */
	aggregateType(): string;
}

/**
 * Kit-internal authority for acknowledging one exact pending-event batch.
 *
 * Only application commit orchestration holds it: it acknowledges or
 * discards the batch after the surrounding transaction commits. Every other
 * reader takes the {@link PendingEventLifecycleReadView}.
 */
export interface PendingEventLifecycleCapability
	extends PendingEventLifecycleReadView {
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
}

// The key version stamps the capability SHAPE. Bump it whenever the
// interface above changes: registrations made under another key stay
// invisible, so an aggregate constructed by an incompatible package copy
// fails the UnmanagedInstanceError check at enrollment instead of
// half-working through a shape it does not fully implement.
const persistenceCapabilityRegistryKey = Symbol.for(
	"@shirudo/ddd-kit/pending-event-lifecycle-registry/v6",
);

const { registry: capabilities, require } =
	createGlobalCapabilityRegistry<PendingEventLifecycleCapability>(
		persistenceCapabilityRegistryKey,
	);

/** Resolves the lifecycle authority or throws `UnmanagedInstanceError`. */
export function requirePendingEventLifecycleCapability(
	aggregate: object,
	operation: string,
): PendingEventLifecycleCapability {
	return require(aggregate, operation, "aggregate");
}

/** Resolves the lifecycle read view or throws `UnmanagedInstanceError`. */
export function requirePendingEventLifecycleReadView(
	aggregate: object,
	operation: string,
): PendingEventLifecycleReadView {
	return require(aggregate, operation, "aggregate");
}

export function pendingEventLifecycleReadViewFor(
	aggregate: object,
): PendingEventLifecycleReadView | undefined {
	return capabilities.get(aggregate);
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
