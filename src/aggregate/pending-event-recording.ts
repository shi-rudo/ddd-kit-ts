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

// The key version stamps the capability SHAPE, mirroring
// pending-event-lifecycle.ts. Bump it whenever the interface above changes:
// registrations made under another key stay invisible, so an aggregate
// constructed by an incompatible package copy fails the caller's generic
// "created by this package" check instead of half-working.
const recordingCapabilityRegistryKey = Symbol.for(
	"@shirudo/ddd-kit/pending-event-recording-registry/v1",
);

function createCapabilityRegistry(): WeakMap<
	object,
	PendingEventRecordingCapability
> {
	const existing = Object.getOwnPropertyDescriptor(
		globalThis,
		recordingCapabilityRegistryKey,
	)?.value;
	if (existing instanceof WeakMap) {
		return existing as WeakMap<object, PendingEventRecordingCapability>;
	}

	const registry = new WeakMap<object, PendingEventRecordingCapability>();
	try {
		Object.defineProperty(globalThis, recordingCapabilityRegistryKey, {
			value: registry,
			enumerable: false,
			writable: false,
			configurable: false,
		});
	} catch {
		// A hardened host may reject global registration. The local registry
		// still preserves the recording boundary; only duplicate-package
		// cooperation is unavailable in that host.
	}
	return registry;
}

// A shared WeakMap lets aggregates constructed by a bundled plugin copy be
// recorded by the host package copy, exactly like the lifecycle registry in
// pending-event-lifecycle.ts. The registry is not a security boundary
// against code already running in the same process; it is an architectural
// boundary kept out of package exports and public aggregate types.
const capabilities = createCapabilityRegistry();

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
