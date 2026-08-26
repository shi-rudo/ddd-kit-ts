import type {
	AnyDomainEvent,
	AnyUncommittedDomainEvent,
	DomainEventStamp,
} from "../event/domain-event";
import { createGlobalCapabilityRegistry } from "./internal/global-capability-registry";

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
// pending-event-lifecycle.ts. Bump it whenever the interface above changes:
// registrations made under another key stay invisible, so an aggregate
// constructed by an incompatible package copy fails the caller's
// UnmanagedInstanceError check instead of half-working.
const recordingCapabilityRegistryKey = Symbol.for(
	"@shirudo/ddd-kit/pending-event-recording-registry/v1",
);

const { registry: capabilities, shared } =
	createGlobalCapabilityRegistry<PendingEventRecordingCapability>(
		recordingCapabilityRegistryKey,
	);

/**
 * Whether the recording registry is the process-wide one. `false` only on a
 * host that rejected the global registration; a lookup that fails then
 * names the private registry as the reason.
 */
export function isPendingEventRecordingRegistryShared(): boolean {
	return shared;
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
