import { err, ok, type Result } from "@shirudo/result";
import type { Id } from "../core/id";
import { DomainError, MissingHandlerError } from "../core/errors";
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
	 * Reconstitutes the aggregate from an event history. Returns `Result`
	 * because event-stream corruption is an expected recoverable failure
	 * at the infrastructure boundary.
	 *
	 * @param history - An ordered list of past events
	 */
	loadFromHistory(history: TEvent[]): Result<void, DomainError>;

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
 * `apply()` and `validateEvent()` throw `DomainError`-derived exceptions on
 * invariant violations. Subclasses override `validateEvent()` to throw their
 * own concrete subclasses (e.g. `OrderAlreadyConfirmedError`). Only the
 * infrastructure-boundary methods (`loadFromHistory`,
 * `restoreFromSnapshotWithEvents`) return `Result` — they catch `DomainError`
 * during replay so callers can react to corrupted event streams without
 * try/catch.
 *
 * @template TState - The type of the aggregate state (contains child entities and value objects)
 * @template TEvent - The union type of all domain events
 * @template TId - The type of the aggregate root identifier
 *
 * @example
 * ```typescript
 * class OrderAlreadyConfirmedError extends DomainError {
 *   constructor(id: OrderId) { super(`Order ${id} is already confirmed`); }
 * }
 *
 * class Order extends EventSourcedAggregate<OrderState, OrderEvent, OrderId> {
 *   confirm(): void {
 *     this.apply(createDomainEvent("OrderConfirmed", {}));
 *   }
 *
 *   protected validateEvent(event: OrderEvent): void {
 *     if (event.type === "OrderConfirmed" && this.state.status === "confirmed") {
 *       throw new OrderAlreadyConfirmedError(this.id);
 *     }
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
	 * Validates an event before it is applied. Default is no-op.
	 * Subclasses override to throw a concrete `DomainError` subclass when
	 * the event violates an invariant in the current state.
	 */
	protected validateEvent(_event: TEvent): void {
		// no-op by default
	}

	/**
	 * Applies an event: validates, locates the handler, computes the next
	 * state, then commits state + pending event + version bump atomically.
	 *
	 * Throws `DomainError` (or a subclass) on validation failure.
	 * Throws `MissingHandlerError` if no handler is registered for `event.type`.
	 *
	 * State is not mutated if any step throws — the handler is invoked into
	 * a local and only assigned to `_state` once all checks pass.
	 *
	 * The method is generic in the event tag `K`, so concrete callers
	 * (`this.apply(orderCreated)`) narrow to the literal tag and the
	 * dispatched handler is typed as `Handler<TState, Extract<TEvent, { type: K }>>`
	 * — no `as` cast required at the call site.
	 *
	 * @param event - The domain event to apply
	 * @param isNew - Whether the event is new (needs persisting) or replayed from history
	 */
	protected apply<K extends TEvent["type"]>(
		event: Extract<TEvent, { type: K }>,
		isNew = true,
	): void {
		this.dispatchAndCommit(event, isNew);
	}

	/**
	 * Internal dispatch path used by `apply()` and the replay methods
	 * (`loadFromHistory`, `restoreFromSnapshotWithEvents`). The replay loop
	 * iterates over `TEvent[]` and therefore cannot supply a narrowed `K`
	 * generic, so this helper accepts `TEvent` and the discriminator is
	 * resolved via the (statically-sound) `handlers` map.
	 */
	private dispatchAndCommit(event: TEvent, isNew: boolean): void {
		this.validateEvent(event);

		const handler = this.handlers[event.type as keyof typeof this.handlers] as
			| Handler<TState, TEvent>
			| undefined;
		if (!handler) {
			throw new MissingHandlerError(event.type);
		}

		const nextState = handler(this._state, event);

		// Atomic commit: nothing above this line mutated aggregate state.
		this._state = nextState;
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
	 * Reconstitutes the aggregate from an event history. Catches `DomainError`
	 * thrown by `apply()` during replay and returns it as an `Err` — this is
	 * the infrastructure boundary, where event-stream corruption is an
	 * expected recoverable failure. Unexpected (non-DomainError) throws
	 * propagate.
	 */
	public loadFromHistory(history: TEvent[]): Result<void, DomainError> {
		for (const event of history) {
			try {
				this.dispatchAndCommit(event, false);
			} catch (e) {
				if (e instanceof DomainError) return err(e);
				throw e;
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
	 * Same infrastructure-boundary semantics as `loadFromHistory`: catches
	 * `DomainError` and returns it as an `Err`; non-domain throws propagate.
	 */
	public restoreFromSnapshotWithEvents(
		snapshot: AggregateSnapshot<TState>,
		eventsAfterSnapshot: TEvent[],
	): Result<void, DomainError> {
		this._state = snapshot.state;
		this.setVersion(snapshot.version);

		for (const event of eventsAfterSnapshot) {
			try {
				this.dispatchAndCommit(event, false);
			} catch (e) {
				if (e instanceof DomainError) return err(e);
				throw e;
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
