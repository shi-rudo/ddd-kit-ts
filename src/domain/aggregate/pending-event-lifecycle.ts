import { unmanagedInstanceError } from "../../errors/kit-errors";
import { assertNotFromAnotherKitCopy } from "../../internal/kit-copy";
import type { AnyDomainEvent, PendingDomainEvent } from "../event/domain-event";
import type { Version } from "./aggregate";

/**
 * Kit-internal read view of the pending-event lifecycle. Kept out of every
 * package entry point. The type exposes no acknowledge or discard, so a
 * reader such as the repository identity map or the replay path cannot
 * change the batch.
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
	 * commit actually persisted (captured at registration); the aggregate syncs
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

const capabilities = new WeakMap<object, PendingEventLifecycleCapability>();

/**
 * Resolves the lifecycle authority. Throws `DUPLICATE_KIT_COPY` for an
 * aggregate of another loaded kit copy and `UNMANAGED_INSTANCE` for any
 * other object.
 */
export function requirePendingEventLifecycleCapability(
	aggregate: object,
	operation: string,
): PendingEventLifecycleCapability {
	const capability = capabilities.get(aggregate);
	if (capability !== undefined) return capability;
	assertNotFromAnotherKitCopy(aggregate, "The aggregate");
	throw unmanagedInstanceError(
		operation,
		"aggregate",
		(aggregate as { id?: unknown } | null | undefined)?.id,
	);
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

// The read-view accessors narrow the same registration to the read type.
// A reader that resolves through them cannot reach acknowledge or discard.

/** Resolves the lifecycle read view or throws `UNMANAGED_INSTANCE`. */
export function requirePendingEventLifecycleReadView(
	aggregate: object,
	operation: string,
): PendingEventLifecycleReadView {
	return requirePendingEventLifecycleCapability(aggregate, operation);
}

export function pendingEventLifecycleReadViewFor(
	aggregate: object,
): PendingEventLifecycleReadView | undefined {
	return pendingEventLifecycleCapabilityFor(aggregate);
}
