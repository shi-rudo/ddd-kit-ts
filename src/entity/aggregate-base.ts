import type { Id } from "../core/id";
import type { DomainEvent, Version } from "./aggregate";

type Handler<TState, TEvent> = (state: TState, event: TEvent) => TState;

/**
 * An optional, but recommended, base class for Aggregates.
 * It encapsulates the logic for:
 * - Versioning for Optimistic Concurrency Control.
 * - Tracking domain events (pendingEvents).
 * - Enforcing state changes exclusively through events.
 */
export abstract class AggregateBase<
	TState,
	TEvent extends DomainEvent<string, unknown>,
	TId extends Id<string>,
> {
	public readonly id: TId;
	public version: Version = 0 as Version;

	public get state(): TState {
		return this._state;
	}
	// The state is 'protected' so that only the subclass can change it.
	protected _state: TState;

	private readonly _pendingEvents: TEvent[] = [];

	protected constructor(id: TId, initialState: TState) {
		this.id = id;
		this._state = initialState;
	}

	/**
	 * Returns a read-only list of new, not-yet-persisted events.
	 */
	public get pendingEvents(): ReadonlyArray<TEvent> {
		return this._pendingEvents;
	}

	/**
	 * Clears the list of pending events.
	 * Typically called after the events have been persisted.
	 */
	public clearPendingEvents(): void {
		this._pendingEvents.length = 0;
	}

	/**
	 * Applies an event to change the state and adds it
	 * to the list of pending events.
	 * @param event The domain event.
	 * @param isNew Indicates whether the event is new (and needs to be persisted)
	 *              or if it is being loaded from history.
	 */
	protected apply(event: TEvent, isNew = true): void {
		const handler = this.handlers[event.type as keyof typeof this.handlers];
		if (!handler) {
			throw new Error(`Missing handler for event type: ${event.type}`);
		}

		// First, change the state
		this._state = handler(
			this._state,
			event as Extract<TEvent, { type: TEvent["type"] }>,
		);

		// Then (if new) add the event to the list
		if (isNew) {
			this._pendingEvents.push(event);
		}
	}

	/**
	 * Reconstitutes the aggregate from an event history.
	 * @param history An ordered list of past events.
	 */
	public loadFromHistory(history: TEvent[]): void {
		for (const event of history) {
			this.apply(event, false); // 'false' as it's not a new event
		}
	}

	/**
	 * A map of event types to their corresponding handlers.
	 * Subclasses MUST implement this property.
	 */
	protected abstract readonly handlers: {
		[K in TEvent["type"]]: Handler<TState, Extract<TEvent, { type: K }>>;
	};
}
