import { err, ok, type Result } from "@shirudo/result";
import type { Id } from "../core/id";
import { DomainError, MissingHandlerError } from "../core/errors";
import { Entity, freezeShallow } from "../entity/entity";
import type { IAggregateRoot } from "./aggregate-root";
import type { AnyDomainEvent } from "./domain-event";
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
	TEvent extends AnyDomainEvent,
> extends IAggregateRoot<TId, TEvent> {
	/**
	 * Reconstitutes the aggregate from an event history. Returns `Result`
	 * because event-stream corruption is an expected recoverable failure
	 * at the infrastructure boundary.
	 *
	 * @param history - An ordered list of past events
	 */
	loadFromHistory(history: ReadonlyArray<TEvent>): Result<void, DomainError>;
}

type Handler<TState, TEvent extends AnyDomainEvent> = (
	state: TState,
	event: TEvent,
) => TState;

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
	TEvent extends AnyDomainEvent,
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

	public get pendingEvents(): ReadonlyArray<TEvent> {
		return Object.freeze(this._pendingEvents.slice());
	}

	public clearPendingEvents(): void {
		this._pendingEvents = [];
	}

	/**
	 * **Framework lifecycle method — `@sealed`.** Called by `withCommit`
	 * (or by your own orchestration code, after harvesting `pendingEvents`)
	 * to push the persisted version back into the in-memory aggregate and
	 * clear `pendingEvents`. TypeScript has no `final` keyword, but
	 * subclasses **should not** override this method directly.
	 *
	 * Overriding without calling `super.markPersisted(version)` silently
	 * leaks `pendingEvents` — the next `withCommit` will re-dispatch them
	 * through the outbox, double-emitting events. This bug has been hit
	 * in production by consumers; the {@link onPersisted} hook below is
	 * the safer extension point.
	 *
	 * If you must override (legitimate cases are very rare), call
	 * `super.markPersisted(version)` FIRST so the framework's cleanup
	 * runs, then add your logic afterwards.
	 *
	 * @param version - The version assigned by the persistence layer
	 * @see onPersisted — the safe extension point for subclasses
	 */
	public markPersisted(version: Version): void {
		this.setVersion(version);
		this._pendingEvents = [];
		this.onPersisted(version);
	}

	/**
	 * Subclass extension point — fires AFTER {@link markPersisted} has
	 * updated the version and cleared `pendingEvents`. Override this for
	 * post-persist logging, metrics, or cache-eviction without risk of
	 * breaking the framework's pendingEvents cleanup.
	 *
	 * The default implementation is a no-op. Subclasses do NOT need to
	 * call `super.onPersisted(version)` — there is nothing in the parent
	 * implementation to preserve.
	 *
	 * **`onPersisted` deliberately receives only the version, not the
	 * drained events.** Event-driven post-persist logic (aggregate-level
	 * audit logging, per-event-type side effects) belongs in `EventBus`
	 * subscribers or the outbox dispatcher — that is the proper
	 * Aggregate-Boundary separation. Building event-aware logic into
	 * `onPersisted` couples aggregate lifecycle to event processing and
	 * recreates the boundary problems Vernon's aggregate discipline is
	 * meant to prevent.
	 *
	 * @param version - The version that was just persisted
	 */
	protected onPersisted(_version: Version): void {
		// no-op by default
	}

	protected constructor(id: TId, initialState: TState) {
		super(id, initialState);
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
		this._state = freezeShallow(nextState);
		if (isNew) {
			this._pendingEvents.push(event);
			this.setVersion((this._version + 1) as Version);
		}
	}

	// --- History & Snapshots ---

	/**
	 * Reconstitutes the aggregate from an event history. Catches `DomainError`
	 * thrown during replay and returns it as an `Err` — this is the
	 * infrastructure boundary, where event-stream corruption is an expected
	 * recoverable failure. Unexpected (non-DomainError) throws propagate.
	 *
	 * Version advances additively: the aggregate's pre-existing version plus
	 * `history.length`. A fresh aggregate (v=0) loading 3 events ends at v=3;
	 * an aggregate already at v=1 (e.g. after a creation event) loading
	 * 2 events ends at v=3, not v=2.
	 */
	public loadFromHistory(history: ReadonlyArray<TEvent>): Result<void, DomainError> {
		const startVersion = this._version;
		for (const event of history) {
			try {
				this.dispatchAndCommit(event, false);
			} catch (e) {
				if (e instanceof DomainError) return err(e);
				throw e;
			}
		}
		this.setVersion((startVersion + history.length) as Version);
		return ok();
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
	 * Restores the aggregate from a snapshot and applies events that occurred
	 * after. Same infrastructure-boundary semantics as `loadFromHistory`:
	 * catches `DomainError` and returns it as an `Err`; non-domain throws
	 * propagate.
	 *
	 * All-or-nothing: if any event mid-stream throws a `DomainError`, the
	 * aggregate is rolled back to its pre-call state + version. Partial
	 * restoration is never observable to the caller.
	 */
	public restoreFromSnapshotWithEvents(
		snapshot: AggregateSnapshot<TState>,
		eventsAfterSnapshot: ReadonlyArray<TEvent>,
	): Result<void, DomainError> {
		const previousState = this._state;
		const previousVersion = this._version;

		this._state = freezeShallow(structuredClone(snapshot.state));
		this.setVersion(snapshot.version);

		for (const event of eventsAfterSnapshot) {
			try {
				this.dispatchAndCommit(event, false);
			} catch (e) {
				this._state = previousState;
				this.setVersion(previousVersion);
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
