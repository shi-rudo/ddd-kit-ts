import { err, ok, type Result } from "../core/result";
import type { Id } from "../core/id";
import { Entity } from "../entity/entity";
import type { IAggregateRoot } from "./aggregate-root";
import type { DomainEvent } from "./domain-event";
import type {
	AggregateSnapshot,
	Version,
} from "./aggregate";

/**
 * Interface for Event-Sourced Aggregate Roots.
 * Defines the contract for aggregates that manage state changes via event sourcing.
 *
 * @template TId - The type of the aggregate root identifier
 * @template TEvent - The union type of all domain events
 */
export interface IEventSourcedAggregate<
	TId extends Id<string>,
	TEvent extends DomainEvent<string, unknown>,
> extends IAggregateRoot<TId> {
	/**
	 * Returns a read-only list of new, not-yet-persisted events.
	 */
	readonly pendingEvents: ReadonlyArray<TEvent>;

	/**
	 * Reconstitutes the aggregate from an event history.
	 *
	 * @param history - An ordered list of past events
	 */
	loadFromHistory(history: TEvent[]): Result<void, string>;

	/**
	 * Clears the list of pending events.
	 */
	clearPendingEvents(): void;

	/**
	 * Checks if the aggregate has any pending events.
	 */
	hasPendingEvents(): boolean;

	/**
	 * Returns the number of pending events.
	 */
	getEventCount(): number;

	/**
	 * Returns the latest pending event, if any.
	 */
	getLatestEvent(): TEvent | undefined;
}

type Handler<TState, TEvent> = (state: TState, event: TEvent) => TState;

/**
 * Configuration options for EventSourcedAggregate behavior.
 */
export interface EventSourcedAggregateConfig {
	/**
	 * Whether to automatically bump the version when applying new events.
	 * Defaults to true. Set to false to manually control versioning.
	 */
	autoVersionBump?: boolean;
}

/**
 * Base class for Event-Sourced Aggregate Roots (Vernon, IDDD Chapter 8).
 *
 * Like `AggregateRoot`, this is both the root entity and the aggregate boundary.
 * The difference is persistence: state is derived from events, not stored directly.
 * Events are the single source of truth — all state changes go through `apply()` → handler.
 *
 * Extends `Entity` directly (not `AggregateRoot`) so that `setState()` and
 * `addDomainEvent()` are not available. This enforces the event sourcing pattern
 * at the type level — there is no way to mutate state without going through an event handler.
 *
 * @template TState - The type of the aggregate state (contains child entities and value objects)
 * @template TEvent - The union type of all domain events
 * @template TId - The type of the aggregate root identifier
 *
 * @example
 * ```typescript
 * class Order extends EventSourcedAggregate<OrderState, OrderEvent, OrderId> {
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
export abstract class EventSourcedAggregate<
	TState,
	TEvent extends DomainEvent<string, unknown>,
	TId extends Id<string>,
> extends Entity<TState, TId>
	implements IEventSourcedAggregate<TId, TEvent> {

	// --- Version management (own, not inherited from AggregateRoot) ---

	private _version: Version = 0 as Version;

	public get version(): Version {
		return this._version;
	}

	private setVersion(version: Version): void {
		this._version = version;
	}

	// --- Event tracking ---

	private _pendingEvents: TEvent[] = [];
	private readonly _autoVersionBump: boolean;

	public get pendingEvents(): ReadonlyArray<TEvent> {
		return this._pendingEvents;
	}

	public clearPendingEvents(): void {
		this._pendingEvents = [];
	}

	protected constructor(
		id: TId,
		initialState: TState,
		config?: EventSourcedAggregateConfig,
	) {
		super(id, initialState);
		this._autoVersionBump = config?.autoVersionBump ?? true;
	}

	// --- Event application ---

	/**
	 * Validates an event before it is applied.
	 * Override this method to add custom validation logic.
	 * Return `ok(true)` if the event is valid, `err(message)` otherwise.
	 */
	protected validateEvent(_event: TEvent): Result<true, string> {
		return ok(true);
	}

	/**
	 * Applies an event to change the state and adds it to pending events.
	 * Returns a Result type instead of throwing an error.
	 *
	 * @param event - The domain event to apply
	 * @param isNew - Whether the event is new (needs persisting) or from history replay
	 */
	protected apply(event: TEvent, isNew = true): Result<void, string> {
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

		this._state = handler(
			this._state,
			event as Extract<TEvent, { type: TEvent["type"] }>,
		);

		if (isNew) {
			this._pendingEvents.push(event);
			if (this._autoVersionBump) {
				this.setVersion((this._version + 1) as Version);
			}
		}

		return ok();
	}

	/**
	 * Applies an event to change the state and adds it to pending events.
	 * Throws an error if validation fails or handler is missing.
	 */
	protected applyUnsafe(event: TEvent, isNew = true): void {
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

		this._state = handler(
			this._state,
			event as Extract<TEvent, { type: TEvent["type"] }>,
		);

		if (isNew) {
			this._pendingEvents.push(event);
			if (this._autoVersionBump) {
				this.setVersion((this._version + 1) as Version);
			}
		}
	}

	/**
	 * Manually bumps the aggregate version.
	 * Only needed if `autoVersionBump` is disabled.
	 */
	protected bumpVersion(): void {
		this.setVersion((this._version + 1) as Version);
	}

	// --- History & Snapshots ---

	/**
	 * Reconstitutes the aggregate from an event history.
	 * Sets the version to the number of events in the history.
	 */
	public loadFromHistory(history: TEvent[]): Result<void, string> {
		for (const event of history) {
			const result = this.apply(event, false);
			if (!result.ok) {
				return result;
			}
		}
		this.setVersion(history.length as Version);
		return ok();
	}

	public hasPendingEvents(): boolean {
		return this._pendingEvents.length > 0;
	}

	public getEventCount(): number {
		return this._pendingEvents.length;
	}

	public getLatestEvent(): TEvent | undefined {
		return this._pendingEvents[this._pendingEvents.length - 1];
	}

	/**
	 * Creates a snapshot of the current aggregate state.
	 */
	public createSnapshot(): AggregateSnapshot<TState> {
		return {
			state: structuredClone(this._state),
			version: this._version,
			snapshotAt: new Date(),
		};
	}

	/**
	 * Restores the aggregate from a snapshot and applies events that occurred after.
	 */
	public restoreFromSnapshotWithEvents(
		snapshot: AggregateSnapshot<TState>,
		eventsAfterSnapshot: TEvent[],
	): Result<void, string> {
		this._state = snapshot.state;
		this.setVersion(snapshot.version);

		for (const event of eventsAfterSnapshot) {
			const result = this.apply(event, false);
			if (!result.ok) {
				return result;
			}
		}

		this.setVersion((snapshot.version + eventsAfterSnapshot.length) as Version);
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
