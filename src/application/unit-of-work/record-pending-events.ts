import type { Aggregate } from "../../domain/aggregate/aggregate";
import { requirePendingEventRecordingCapability } from "../../domain/aggregate/pending-event-recording";
import type {
	AnyDomainEvent,
	CreateDomainEventStampOptions,
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
 * Stamp options that every decision of one recording shares: a recording time
 * and metadata such as the correlation id of the request. An `eventId` is per
 * fact, so the factory mints it for each decision.
 */
export type SharedDomainEventStampOptions = Omit<
	CreateDomainEventStampOptions,
	"eventId"
>;

/**
 * Records every still-unstamped event accepted by an aggregate.
 *
 * The function is a command that also returns the recorded batch, a
 * deliberate exception to command-query separation: the caller hands the
 * batch on to persistence and needs no second read of `pendingEvents`.
 *
 * Recording is atomic with respect to the aggregate's pending list: if stamp
 * creation or validation fails, every decision remains unrecorded. A
 * successful second call returns the same event objects and does not read the
 * factory again, which keeps event identity stable across transaction retries.
 *
 * Pass a `DomainEventFactory` (only its `createStamp` role is required) for one
 * uniform recording policy. Add `stampOptions` for metadata that every
 * decision of the batch shares, such as the correlation id of the request.
 * Pass a callback instead when metadata depends on the concrete decision.
 */
export function recordPendingEvents<
	TId extends Id<string>,
	TEvent extends AnyDomainEvent,
>(
	aggregate: Aggregate<TId, TEvent>,
	factory: DomainEventStampFactory,
	stampOptions?: SharedDomainEventStampOptions,
): ReadonlyArray<TEvent>;
export function recordPendingEvents<
	TId extends Id<string>,
	TEvent extends AnyDomainEvent,
>(
	aggregate: Aggregate<TId, TEvent>,
	createStamp: DomainEventStampProvider<TEvent>,
): ReadonlyArray<TEvent>;
export function recordPendingEvents<
	TId extends Id<string>,
	TEvent extends AnyDomainEvent,
>(
	aggregate: Aggregate<TId, TEvent>,
	source: DomainEventStampFactory | DomainEventStampProvider<TEvent>,
	stampOptions?: SharedDomainEventStampOptions,
): ReadonlyArray<TEvent> {
	const capability = requirePendingEventRecordingCapability(
		aggregate,
		"recordPendingEvents",
	);
	// Only the two shared fields reach the factory. The type omits eventId,
	// but a wider options object passes the structural check with one at
	// runtime, and one fixed id on every decision would collide.
	const shared = {
		occurredAt: stampOptions?.occurredAt,
		metadata: stampOptions?.metadata,
	};
	const createStamp: DomainEventStampProvider<TEvent> =
		typeof source === "function" ? source : () => source.createStamp(shared);
	return capability.record((event, index) =>
		createStamp(event as UncommittedDomainEventOf<TEvent>, index),
	) as ReadonlyArray<TEvent>;
}
