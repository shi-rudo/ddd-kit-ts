import type { AnyDomainEvent, PendingDomainEvent } from "../event/domain-event";
import type { Id } from "../identity/id";
import { BaseAggregate } from "./base-aggregate";

export type { IAggregateRoot } from "./aggregate";
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
export abstract class AggregateRoot<
	TState,
	TId extends Id<string>,
	TEvent extends AnyDomainEvent = never,
> extends BaseAggregate<TState, TId, TEvent> {
	/**
	 * Changes state and records the resulting facts in record-after-mutation
	 * order. State validation, the event mint gate, and the event address
	 * check run before the transition becomes observable, so a rejected
	 * decision records nothing and moves nothing.
	 */
	protected commit(
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
		const stamped = eventBatch.map((event) => this.stampNewEventAddress(event));

		this.setState(newState);
		for (const event of stamped) this.addDomainEvent(event);
	}

	/** Every normal domain-state transition advances the OCC version. */
	protected override setState(newState: TState): void {
		super.setState(newState);
		this.bumpVersion();
	}

	/**
	 * Replaces loss-tolerant derived state without advancing the domain version.
	 *
	 * This is intentionally loud: concurrent writers may overwrite such a
	 * change. Keep business facts on the normal `setState`/`commit` path.
	 */
	protected setStateWithoutVersionBump(newState: TState): void {
		super.setState(newState);
	}
}
