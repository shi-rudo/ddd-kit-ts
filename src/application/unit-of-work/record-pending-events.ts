import type { IAggregateRoot } from "../../domain/aggregate/aggregate";
import { pendingEventRecordingCapabilityFor } from "../../domain/aggregate/pending-event-recording";
import type {
	AnyDomainEvent,
	DomainEventFactory,
	DomainEventStamp,
	UncommittedDomainEventOf,
} from "../../domain/event/domain-event";
import type { Id } from "../../domain/identity/id";

/** Minimal shell role accepted by {@link recordPendingEvents}. */
export type DomainEventStampFactory = Pick<DomainEventFactory, "createStamp">;

/** Per-decision stamp provider for metadata that depends on the event. */
export type DomainEventStampProvider<TEvent extends AnyDomainEvent> = (
	event: UncommittedDomainEventOf<TEvent>,
	index: number,
) => DomainEventStamp;

/**
 * Records every still-unstamped event accepted by an aggregate.
 *
 * Recording is atomic with respect to the aggregate's pending list: if stamp
 * creation or validation fails, every decision remains unrecorded. A
 * successful second call returns the same event objects and does not read the
 * factory again, which keeps event identity stable across transaction retries.
 *
 * Pass a `DomainEventFactory` (only its `createStamp` role is required) for one
 * uniform recording policy, or a callback when metadata depends on the
 * concrete decision.
 */
export function recordPendingEvents<
	TId extends Id<string>,
	TEvent extends AnyDomainEvent,
>(
	aggregate: IAggregateRoot<TId, TEvent>,
	factory: DomainEventStampFactory,
): ReadonlyArray<TEvent>;
export function recordPendingEvents<
	TId extends Id<string>,
	TEvent extends AnyDomainEvent,
>(
	aggregate: IAggregateRoot<TId, TEvent>,
	createStamp: DomainEventStampProvider<TEvent>,
): ReadonlyArray<TEvent>;
export function recordPendingEvents<
	TId extends Id<string>,
	TEvent extends AnyDomainEvent,
>(
	aggregate: IAggregateRoot<TId, TEvent>,
	source: DomainEventStampFactory | DomainEventStampProvider<TEvent>,
): ReadonlyArray<TEvent> {
	const capability = pendingEventRecordingCapabilityFor(aggregate);
	if (!capability) {
		throw new TypeError(
			"recordPendingEvents requires an aggregate created by this package",
		);
	}
	const createStamp: DomainEventStampProvider<TEvent> =
		typeof source === "function" ? source : () => source.createStamp();
	return capability.record((event, index) =>
		createStamp(event as UncommittedDomainEventOf<TEvent>, index),
	) as ReadonlyArray<TEvent>;
}
