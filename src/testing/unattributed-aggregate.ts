/**
 * An aggregate double for the collection guards. Internal to the testing
 * entry: not re-exported from `@shirudo/ddd-kit/testing`.
 */
import type { Aggregate, Version } from "../domain/aggregate/aggregate";
import { registerPendingEventLifecycleCapability } from "../domain/aggregate/pending-event-lifecycle";
import type { AnyDomainEvent } from "../domain/event/domain-event";
import type { Id } from "../domain/identity/id";

/**
 * An instance with the kit's lifecycle capability but without the aggregate
 * identity attribution of the aggregate base classes: the shape of an aggregate
 * from another package copy. Only such an instance can carry an unattributed event,
 * or an event of another aggregate, into the collection.
 */
export function unattributedAggregate<
	TId extends Id<string>,
	TEvent extends AnyDomainEvent,
>(
	id: TId,
	aggregateType: string,
	events: ReadonlyArray<TEvent>,
): Aggregate<TId, TEvent> {
	const instance = {
		id,
		aggregateIdentity: Object.freeze({ aggregateType, aggregateId: id }),
		version: 1 as Version,
		pendingEvents: events,
	};
	registerPendingEventLifecycleCapability(instance, {
		acknowledge: () => {},
		discardPendingEvents: () => {},
		persistedVersion: () => undefined,
		pendingEventCount: () => events.length,
	});
	return instance;
}
