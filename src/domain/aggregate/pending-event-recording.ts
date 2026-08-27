import { UnmanagedInstanceError } from "../../errors/kit-errors";
import type {
	AnyDomainEvent,
	AnyUncommittedDomainEvent,
	DomainEventStamp,
} from "../event/domain-event";
import {
	createGlobalCapabilityRegistry,
	LOCAL_REGISTRY_DETAIL,
} from "./internal/global-capability-registry";

export type PendingEventStampFactory = (
	event: AnyUncommittedDomainEvent,
	index: number,
) => DomainEventStamp;

export interface PendingEventRecordingCapability {
	readonly record: (
		createStamp: PendingEventStampFactory,
	) => ReadonlyArray<AnyDomainEvent>;
}

// The key version stamps the capability SHAPE, mirroring
// pending-event-lifecycle.ts, and the shape includes the event type that
// crosses record(). Bump it whenever the interface above or that event
// shape changes: registrations made under another key stay invisible, so
// an aggregate constructed by an incompatible package copy fails the
// caller's UnmanagedInstanceError check instead of half-working.
const recordingCapabilityRegistryKey = Symbol.for(
	"@shirudo/ddd-kit/pending-event-recording-registry/v2",
);

const { registry: capabilities, shared } =
	createGlobalCapabilityRegistry<PendingEventRecordingCapability>(
		recordingCapabilityRegistryKey,
	);

/**
 * Resolves the recording capability or throws {@link UnmanagedInstanceError}
 * naming the operation and the instance. When the registry is private to
 * this package copy (a host that rejected the global registration), the
 * error says so, because that is the one reason an instance from another
 * copy cannot be recognized.
 */
export function requirePendingEventRecordingCapability(
	aggregate: object,
	operation: string,
): PendingEventRecordingCapability {
	const capability = capabilities.get(aggregate);
	if (capability !== undefined) return capability;
	throw new UnmanagedInstanceError(
		operation,
		"aggregate",
		(aggregate as { id?: unknown }).id,
		shared ? undefined : LOCAL_REGISTRY_DETAIL,
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
