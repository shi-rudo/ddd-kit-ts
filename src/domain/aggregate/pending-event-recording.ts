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
// pending-event-lifecycle.ts, and the shape includes the event type that
// crosses record(). Bump it whenever the interface above or that event
// shape changes: registrations made under another key stay invisible, so
// an aggregate constructed by an incompatible package copy fails the
// caller's UnmanagedInstanceError check instead of half-working.
const recordingCapabilityRegistryKey = Symbol.for(
	"@shirudo/ddd-kit/pending-event-recording-registry/v2",
);

const { registry: capabilities, require } =
	createGlobalCapabilityRegistry<PendingEventRecordingCapability>(
		recordingCapabilityRegistryKey,
	);

/** Resolves the recording capability or throws `UnmanagedInstanceError`. */
export function requirePendingEventRecordingCapability(
	aggregate: object,
	operation: string,
): PendingEventRecordingCapability {
	return require(aggregate, operation, "aggregate");
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
