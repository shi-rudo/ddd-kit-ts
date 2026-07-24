import type {
	AnyDomainEvent,
	AnyUncommittedDomainEvent,
	DomainEventStamp,
} from "./domain-event";

export type PendingEventStampFactory = (
	event: AnyUncommittedDomainEvent,
	index: number,
) => DomainEventStamp;

export interface PendingEventRecordingCapability {
	readonly record: (
		createStamp: PendingEventStampFactory,
	) => ReadonlyArray<AnyDomainEvent>;
}

const CAPABILITIES = new WeakMap<object, PendingEventRecordingCapability>();

export function registerPendingEventRecordingCapability(
	aggregate: object,
	capability: PendingEventRecordingCapability,
): void {
	CAPABILITIES.set(aggregate, capability);
}

export function pendingEventRecordingCapabilityFor(
	aggregate: object,
): PendingEventRecordingCapability | undefined {
	return CAPABILITIES.get(aggregate);
}
