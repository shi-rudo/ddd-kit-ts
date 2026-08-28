import type { AnyDomainEvent, PendingDomainEvent } from "../event/domain-event";
import type { Id } from "../identity/id";
import { BaseAggregate } from "./base-aggregate";

export type { Aggregate } from "./aggregate";
export type { AggregateConfig } from "./base-aggregate";

/**
 * OO-first Aggregate Root for state-stored domain models.
 *
 * The aggregate owns identity, valid domain state, behavior, its current
 * domain version, and pending domain events. It deliberately does not own a
 * database baseline or dirty-key bookkeeping. A repository adapter defines
 * its persistence projection through `PersistenceModel`; the Unit of Work
 * retains that opaque baseline and derives the adapter's change set at flush.
 */
export abstract class StateStoredAggregate<
	TState,
	TId extends Id<string>,
	TEvent extends AnyDomainEvent = never,
> extends BaseAggregate<TState, TId, TEvent> {
	/**
	 * Replaces the state, advances the OCC version, and records the events
	 * of the change, in that order. State validation, the event mint gate,
	 * and the event address check run before the change becomes observable,
	 * so a rejected decision records nothing and moves nothing. Without
	 * events the call is a plain versioned state change.
	 */
	protected override setState(
		newState: TState,
		events:
			| PendingDomainEvent<TEvent>
			| readonly PendingDomainEvent<TEvent>[] = [],
	): void {
		const eventBatch: readonly PendingDomainEvent<TEvent>[] = Array.isArray(
			events,
		)
			? events
			: [events as PendingDomainEvent<TEvent>];
		const stamped = eventBatch.map((event) => this.addressNewEvent(event));
		// The version number is validated before the state moves; the write
		// itself comes after the state gates, so a rejected state leaves the
		// version untouched.
		const next = this.nextVersion();

		super.setState(newState);
		this.setVersion(next);
		for (const event of stamped) this.appendStampedEvent(event);
	}

	/**
	 * Replaces loss-tolerant derived state without advancing the domain version.
	 *
	 * This is intentionally loud: concurrent writers may overwrite such a
	 * change. Keep business facts on the normal `setState` path.
	 */
	protected setStateWithoutVersionBump(newState: TState): void {
		super.setState(newState);
	}
}
