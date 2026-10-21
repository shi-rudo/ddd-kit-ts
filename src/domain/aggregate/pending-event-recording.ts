import { UnmanagedInstanceError } from "../../errors/kit-errors";
import { assertNotFromAnotherKitCopy } from "../../internal/kit-copy";
import type {
	AnyDomainEvent,
	AnyUnstampedDomainEvent,
	DomainEventStamp,
} from "../event/domain-event";

export type PendingEventStampFactory = (
	event: AnyUnstampedDomainEvent,
	index: number,
) => DomainEventStamp;

export interface PendingEventRecordingCapability {
	readonly record: (
		createStamp: PendingEventStampFactory,
	) => ReadonlyArray<AnyDomainEvent>;
}

const capabilities = new WeakMap<object, PendingEventRecordingCapability>();

/**
 * Resolves the recording capability. Throws `DuplicateKitCopyError` for an
 * aggregate of another loaded kit copy and `UnmanagedInstanceError` for any
 * other object.
 */
export function requirePendingEventRecordingCapability(
	aggregate: object,
	operation: string,
): PendingEventRecordingCapability {
	const capability = capabilities.get(aggregate);
	if (capability !== undefined) return capability;
	assertNotFromAnotherKitCopy(aggregate, "The aggregate");
	throw new UnmanagedInstanceError(
		operation,
		"aggregate",
		(aggregate as { id?: unknown } | null | undefined)?.id,
	);
}

export function registerPendingEventRecordingCapability(
	aggregate: object,
	capability: PendingEventRecordingCapability,
): void {
	capabilities.set(aggregate, Object.freeze(capability));
}

export function pendingEventRecordingCapabilityFor(
	aggregate: object,
): PendingEventRecordingCapability | undefined {
	return capabilities.get(aggregate);
}
