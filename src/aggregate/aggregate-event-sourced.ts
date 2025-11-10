import { err, ok, type Result } from "../core/result";
import type { Id } from "../core/id";
import { AggregateBase, type AggregateConfig } from "./aggregate-base";
import type {
	AggregateSnapshot,
	DomainEvent,
	Version,
} from "./aggregate";

type Handler<TState, TEvent> = (state: TState, event: TEvent) => TState;

/**
 * Extended configuration options for AggregateEventSourced behavior.
 */
export interface AggregateEventSourcedConfig extends AggregateConfig {
	/**
	 * Whether to automatically bump the version when applying new events.
	 * Defaults to true. Set to false to manually control versioning.
	 */
	autoVersionBump?: boolean;
}

/**
 * Base class for Event-Sourced Aggregates.
 * Extends `AggregateBase` with Event Sourcing capabilities:
 * - Event tracking (pendingEvents)
 * - Event handlers for state transitions
 * - Event validation
 * - History replay
 *
 * Use this class when you want Event Sourcing with full event tracking
 * and replay capabilities.
 *
 * @template TState - The type of the aggregate state
 * @template TEvent - The union type of all domain events
 * @template TId - The type of the aggregate identifier
 *
 * @example
 * ```typescript
 * class Order extends AggregateEventSourced<OrderState, OrderEvent, OrderId> {
 *   confirm(): void {
 *     this.apply(createDomainEvent("OrderConfirmed", {}));
 *   }
 *
 *   protected readonly handlers = {
 *     OrderConfirmed: (state: OrderState): OrderState => ({
 *       ...state,
 *       status: "confirmed",
 *     }),
 *   };
 * }
 * ```
 */
export abstract class AggregateEventSourced<
	TState,
	TEvent extends DomainEvent<string, unknown>,
	TId extends Id<string>,
> extends AggregateBase<TState, TId> {
	private readonly _eventConfig: AggregateEventSourcedConfig;
	private readonly _eventAutoVersionBump: boolean;

	private readonly _pendingEvents: TEvent[] = [];

	protected constructor(
		id: TId,
		initialState: TState,
		config?: AggregateEventSourcedConfig,
	) {
		super(id, initialState, config);
		this._eventConfig = config ?? {};
		this._eventAutoVersionBump = this._eventConfig.autoVersionBump ?? true;
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
	 * Validates an event before it is applied.
	 * Override this method to add custom validation logic.
	 * Return `ok(true)` if the event is valid, `err(message)` otherwise.
	 *
	 * @param event - The event to validate
	 * @returns Result indicating if the event is valid
	 *
	 * @example
	 * ```typescript
	 * protected validateEvent(event: OrderEvent): Result<true, string> {
	 *   if (event.type === "OrderShipped" && this.state.status !== "confirmed") {
	 *     return err("Order must be confirmed before shipping");
	 *   }
	 *   return ok(true);
	 * }
	 * ```
	 */
	protected validateEvent(_event: TEvent): Result<true, string> {
		return ok(true);
	}

	/**
	 * Applies an event to change the state and adds it
	 * to the list of pending events.
	 * Returns a Result type instead of throwing an error.
	 *
	 * @param event - The domain event to apply
	 * @param isNew - Indicates whether the event is new (and needs to be persisted)
	 *                or if it is being loaded from history
	 * @returns Result<void, string> - ok if successful, err with error message if validation fails or handler is missing
	 */
	protected apply(event: TEvent, isNew = true): Result<void, string> {
		// Validate event before applying
		const validation = this.validateEvent(event);
		if (!validation.ok) {
			return err(
				`Event validation failed for ${event.type}: ${validation.error}`,
			);
		}

		const handler = this.handlers[event.type as keyof typeof this.handlers];
		if (!handler) {
			return err(`Missing handler for event type: ${event.type}`);
		}

		// First, change the state
		this._state = handler(
			this._state,
			event as Extract<TEvent, { type: TEvent["type"] }>,
		);

		// Then (if new) add the event to the list and bump version
		if (isNew) {
			this._pendingEvents.push(event);
			if (this._eventAutoVersionBump) {
				this.version = (this.version + 1) as Version;
			}
		}

		return ok();
	}

	/**
	 * Applies an event to change the state and adds it
	 * to the list of pending events.
	 * Throws an error if validation fails or handler is missing.
	 *
	 * @param event - The domain event to apply
	 * @param isNew - Indicates whether the event is new (and needs to be persisted)
	 *                or if it is being loaded from history
	 * @throws Error if event validation fails or handler is missing
	 */
	protected applyUnsafe(event: TEvent, isNew = true): void {
		// Validate event before applying
		const validation = this.validateEvent(event);
		if (!validation.ok) {
			throw new Error(
				`Event validation failed for ${event.type}: ${validation.error}`,
			);
		}

		const handler = this.handlers[event.type as keyof typeof this.handlers];
		if (!handler) {
			throw new Error(`Missing handler for event type: ${event.type}`);
		}

		// First, change the state
		this._state = handler(
			this._state,
			event as Extract<TEvent, { type: TEvent["type"] }>,
		);

		// Then (if new) add the event to the list and bump version
		if (isNew) {
			this._pendingEvents.push(event);
			if (this._eventAutoVersionBump) {
				this.version = (this.version + 1) as Version;
			}
		}
	}

	/**
	 * Manually bumps the aggregate version.
	 * Only needed if `autoVersionBump` is disabled.
	 */
	protected bumpVersion(): void {
		this.version = (this.version + 1) as Version;
	}

	/**
	 * Reconstitutes the aggregate from an event history.
	 * Sets the version to the number of events in the history.
	 *
	 * @param history - An ordered list of past events
	 */
	public loadFromHistory(history: TEvent[]): Result<void, string> {
		for (const event of history) {
			const result = this.apply(event, false); // 'false' as it's not a new event
			if (!result.ok) {
				return result;
			}
		}
		// Set version to the number of events in history
		this.version = history.length as Version;
		return ok();
	}

	/**
	 * Checks if the aggregate has any pending events.
	 *
	 * @returns true if there are pending events, false otherwise
	 */
	public hasPendingEvents(): boolean {
		return this._pendingEvents.length > 0;
	}

	/**
	 * Returns the number of pending events.
	 *
	 * @returns The count of pending events
	 */
	public getEventCount(): number {
		return this._pendingEvents.length;
	}

	/**
	 * Returns the latest pending event, if any.
	 *
	 * @returns The most recent event or undefined if no events exist
	 */
	public getLatestEvent(): TEvent | undefined {
		return this._pendingEvents[this._pendingEvents.length - 1];
	}

	/**
	 * Restores the aggregate from a snapshot and applies events that occurred after the snapshot.
	 * This is more efficient than replaying all events from the beginning.
	 *
	 * @param snapshot - The snapshot to restore from
	 * @param eventsAfterSnapshot - Events that occurred after the snapshot was taken
	 *
	 * @example
	 * ```typescript
	 * const snapshot = await snapshotRepository.getLatest(aggregateId);
	 * const eventsAfter = await eventStore.getEventsAfter(aggregateId, snapshot.version);
	 * aggregate.restoreFromSnapshotWithEvents(snapshot, eventsAfter);
	 * ```
	 */
	public restoreFromSnapshotWithEvents(
		snapshot: AggregateSnapshot<TState>,
		eventsAfterSnapshot: TEvent[],
	): Result<void, string> {
		this._state = snapshot.state;
		this.version = snapshot.version;

		// Apply events that occurred after the snapshot
		for (const event of eventsAfterSnapshot) {
			const result = this.apply(event, false);
			if (!result.ok) {
				return result;
			}
		}

		// Set version to snapshot version + events after snapshot
		this.version = (snapshot.version + eventsAfterSnapshot.length) as Version;
		return ok();
	}

	/**
	 * A map of event types to their corresponding handlers.
	 * Subclasses MUST implement this property.
	 */
	protected abstract readonly handlers: {
		[K in TEvent["type"]]: Handler<TState, Extract<TEvent, { type: K }>>;
	};
}

