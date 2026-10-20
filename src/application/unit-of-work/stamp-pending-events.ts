import type { Aggregate } from "../../domain/aggregate/aggregate";
import {
	type PendingEventRecordingCapability,
	requirePendingEventRecordingCapability,
} from "../../domain/aggregate/pending-event-recording";
import {
	type AnyDomainEvent,
	type CreateDomainEventStampOptions,
	createDomainEventFactory,
	type DomainEventFactory,
	type DomainEventStamp,
	isStampedDomainEvent,
	type UnstampedDomainEventOf,
} from "../../domain/event/domain-event";
import type { Id } from "../../domain/identity/id";

/** Minimal shell role accepted by {@link stampPendingEvents}. */
export type DomainEventStampFactory = Pick<DomainEventFactory, "createStamp">;

/** Per-decision stamp provider for metadata that depends on the event. */
export type DomainEventStampProvider<TEvent extends AnyDomainEvent> = (
	event: UnstampedDomainEventOf<TEvent>,
	index: number,
) => DomainEventStamp;

/**
 * Stamp options that every decision of one stamping shares: a stamp time
 * and metadata such as the correlation id of the request. An `eventId` is per
 * fact, so the factory creates it for each decision.
 */
export type SharedDomainEventStampOptions = Omit<
	CreateDomainEventStampOptions,
	"eventId"
>;

/**
 * Stamps every still-unstamped event accepted by an aggregate.
 *
 * The commit stamps every still-unstamped event when it registers the
 * aggregate, so a use case does not need this function. Call it first when
 * the metadata depends on the concrete decision, for an import, or for a test
 * that needs fixed ids. The commit keeps the stamps that this function set.
 *
 * The function is a command that also returns the stamped batch, a
 * deliberate exception to command-query separation: the caller hands the
 * batch on to persistence and needs no second read of `pendingEvents`.
 *
 * Stamping is atomic with respect to the aggregate's pending list: if stamp
 * creation or validation fails, every decision remains unstamped. A
 * successful second call returns the same event objects and does not read the
 * factory again, so an instance that a retried attempt registers again keeps
 * its event identities.
 *
 * Pass a `DomainEventFactory` (only its `createStamp` role is required) for one
 * uniform stamping policy. Add `stampOptions` for metadata that every
 * decision of the batch shares, such as the correlation id of the request.
 * Pass a callback instead when metadata depends on the concrete decision.
 */
export function stampPendingEvents<
	TId extends Id<string>,
	TEvent extends AnyDomainEvent,
>(
	aggregate: Aggregate<TId, TEvent>,
	factory: DomainEventStampFactory,
	stampOptions?: SharedDomainEventStampOptions,
): ReadonlyArray<TEvent>;
export function stampPendingEvents<
	TId extends Id<string>,
	TEvent extends AnyDomainEvent,
>(
	aggregate: Aggregate<TId, TEvent>,
	createStamp: DomainEventStampProvider<TEvent>,
): ReadonlyArray<TEvent>;
export function stampPendingEvents<
	TId extends Id<string>,
	TEvent extends AnyDomainEvent,
>(
	aggregate: Aggregate<TId, TEvent>,
	source: DomainEventStampFactory | DomainEventStampProvider<TEvent>,
	stampOptions?: SharedDomainEventStampOptions,
): ReadonlyArray<TEvent> {
	const capability = requirePendingEventRecordingCapability(
		aggregate,
		"stampPendingEvents",
	);
	return recordWith(capability, source, stampOptions);
}

/**
 * The factory that the commit stamps with when its dependencies name none:
 * a random UUID from Web Crypto and the system clock.
 */
export const defaultEventStampFactory: DomainEventStampFactory =
	createDomainEventFactory();

/**
 * Stamps the pending events that are still unstamped when the commit
 * registers an aggregate. An aggregate whose pending events all carry a
 * stamp stays untouched: an explicit {@link stampPendingEvents} call keeps
 * its stamps, and an instance without the recording capability passes when
 * it has nothing to stamp.
 */
export function stampAtRegistration(
	aggregate: Aggregate<Id<string>, AnyDomainEvent>,
	factory: DomainEventStampFactory,
	stampOptions: SharedDomainEventStampOptions | undefined,
	operation: string,
): void {
	if (aggregate.pendingEvents.every(isStampedDomainEvent)) return;
	recordWith(
		requirePendingEventRecordingCapability(aggregate, operation),
		factory,
		stampOptions,
	);
}

function recordWith<TEvent extends AnyDomainEvent>(
	capability: PendingEventRecordingCapability,
	source: DomainEventStampFactory | DomainEventStampProvider<TEvent>,
	stampOptions: SharedDomainEventStampOptions | undefined,
): ReadonlyArray<TEvent> {
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
		createStamp(event as UnstampedDomainEventOf<TEvent>, index),
	) as ReadonlyArray<TEvent>;
}
