import { err, ok, type Result } from "@shirudo/result";
import {
	DomainError,
	ForeignEventError,
	MisaddressedEventError,
	MissingHandlerError,
	UnreplayableAggregateError,
} from "../core/errors";
import type { Id } from "../core/id";
import type {
	AggregateSnapshot,
	IEventSourcedAggregate,
	Version,
} from "./aggregate";
import {
	assertRestoreTargetHasNoPendingEvents,
	BaseAggregate,
} from "./base-aggregate";
import type { AnyDomainEvent } from "./domain-event";

// Re-export for backwards compatibility: `IEventSourcedAggregate` lives
// in `aggregate.ts` (the type hub).
export type { IEventSourcedAggregate } from "./aggregate";

type Handler<TState, TEvent extends AnyDomainEvent> = (
	state: TState,
	event: TEvent,
) => TState;

/**
 * Base class for Event-Sourced Aggregate Roots (Vernon, IDDD Chapter 8).
 *
 * Like `AggregateRoot`, this is both the root entity and the aggregate
 * boundary. The difference is persistence: state is derived from events,
 * not stored directly. Events are the single source of truth: all state
 * changes go through `apply()` → handler.
 *
 * Extends `BaseAggregate` (the shared lifecycle machinery) but does NOT
 * expose `setState()` or `commit()` from `AggregateRoot`. This enforces
 * the event sourcing pattern at the type level: there is no way to
 * mutate state without going through an event handler.
 *
 * `apply()` and `validateEvent()` throw `DomainError`-derived exceptions
 * on invariant violations. Subclasses override `validateEvent()` to
 * throw their own concrete subclasses (e.g. `OrderAlreadyConfirmedError`).
 * Validation guards NEW facts only: replay (`loadFromHistory`,
 * `restoreFromSnapshotWithEvents`) never runs `validateEvent`, because
 * history is already accepted fact and decision rules change over time;
 * a stream that was valid when written must stay loadable under
 * tomorrow's rules. Only the infrastructure-boundary methods
 * (`loadFromHistory`, `restoreFromSnapshotWithEvents`) return `Result`:
 * they catch `DomainError` during replay so callers can react to
 * corrupted event streams without try/catch.
 *
 * @template TState - The aggregate state (contains child entities and value objects)
 * @template TEvent - The union type of all domain events
 * @template TId    - The aggregate root identifier
 *
 * @example
 * ```typescript
 * class OrderAlreadyConfirmedError extends DomainError<"ORDER_ALREADY_CONFIRMED"> {
 *   constructor(id: OrderId) {
 *     super({ code: "ORDER_ALREADY_CONFIRMED", message: `Order ${id} is already confirmed` });
 *   }
 * }
 *
 * class Order extends EventSourcedAggregate<OrderState, OrderEvent, OrderId> {
 *   protected readonly aggregateType = "Order";
 *
 *   confirm(): void {
 *     this.apply(this.recordEvent("OrderConfirmed", { orderId: this.id }));
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
		TSnapshotState = TState,
	>
	extends BaseAggregate<TState, TId, TEvent, TSnapshotState>
	implements IEventSourcedAggregate<TId, TEvent>
{
	/**
	 * Validates a NEW event before `apply()` records it. Default is
	 * no-op. Subclasses override to throw a concrete `DomainError`
	 * subclass when the event violates an invariant in the current
	 * state: the second net behind the command method's own guards.
	 *
	 * Replay never invokes this method. History is already accepted
	 * fact, and decision rules evolve; re-checking yesterday's events
	 * against today's rules would make legitimately persisted streams
	 * unloadable after a rule change. Old storage shapes are not a
	 * validation concern either: decode and upcast persisted events at
	 * the read boundary (see the event-upcasting guide) so handlers
	 * and replay always receive the current event shape.
	 */
	protected validateEvent(_event: TEvent): void {}

	/**
	 * Structural integrity check for a state restored from a SNAPSHOT.
	 * Default is no-op. Override to reject states that no version of
	 * the model could have produced (missing fields, impossible types,
	 * truncated data): a snapshot is DERIVED data read back from
	 * storage, so unlike replay (where every state is built by the
	 * handlers from accepted facts) the restored blob deserves a
	 * structural gate. Throw a `DomainError` and
	 * `restoreFromSnapshotWithEvents` returns it as `Err`, which the
	 * documented load recipe answers by discarding the snapshot and
	 * refolding from the stream.
	 *
	 * Deliberately NOT today's decision rules: a snapshot persisted
	 * under yesterday's rules must keep loading after a rule change
	 * ("replay from zero equals snapshot plus tail"). Rules stay in
	 * `validateState` / `validateEvent` on the live paths; schema
	 * DRIFT belongs in `snapshotSchemaVersion`; decode belongs in
	 * `fromSnapshotState` / `migrateSnapshotState`.
	 */
	protected validateRestoredState(_state: TState): void {}

	/**
	 * Applies an event: validates, locates the handler, computes the next
	 * state, then commits state + pending event + version bump atomically.
	 *
	 * Throws `DomainError` (or a subclass) on validation failure.
	 * Throws `MissingHandlerError` if no handler is registered for `event.type`.
	 *
	 * State is not mutated if any step throws: the handler is invoked into
	 * a local and only assigned to `_state` once all checks pass.
	 *
	 * The method is generic in the event tag `K`, so concrete callers
	 * (`this.apply(orderCreated)`) narrow to the literal tag and the
	 * dispatched handler is typed as `Handler<TState, Extract<TEvent, { type: K }>>`,
	 * with no `as` cast required at the call site.
	 *
	 * `apply()` is exclusively for NEW facts: it always records the event
	 * and bumps the version (the former `isNew` flag argument is gone).
	 * Replaying history is a different operation with its own entry
	 * points, `loadFromHistory` and `restoreFromSnapshotWithEvents`.
	 *
	 * @param event - The domain event to apply
	 */
	protected apply<K extends TEvent["type"]>(
		event: Extract<TEvent, { type: K }>,
	): void {
		// New facts get their address here, by construction: missing
		// fields are stamped from the aggregate (the recordEvent
		// guarantee), a present-but-foreign address throws
		// MisaddressedEventError before anything is recorded. Without
		// this, a mis-addressed event would mutate state, version, and
		// pendingEvents and only fail later at harvest or on the next
		// load, poisoning the own stream.
		const stamped = this.stampNewEventAddress(event);
		// Validation lives HERE, not in dispatch: only new facts are
		// checked against current rules; replay trusts history.
		this.validateEvent(stamped);
		this.dispatch(stamped);
		this.addDomainEvent(stamped);
		this.bumpVersion();
	}

	/**
	 * Address discipline for NEW facts: a present-but-foreign
	 * `aggregateId` / `aggregateType` is a wiring bug and throws
	 * {@link MisaddressedEventError}; missing fields are filled in from
	 * the aggregate, so an applied event is always fully addressed and
	 * can never fail the harvest or the replay guard later. The
	 * stamped copy is frozen like the original (payload and metadata
	 * are shared, already deep-frozen by `createDomainEvent`).
	 */
	private stampNewEventAddress<K extends TEvent["type"]>(
		event: Extract<TEvent, { type: K }>,
	): Extract<TEvent, { type: K }> {
		const { aggregateId, aggregateType } = event;
		const idForeign = aggregateId !== undefined && aggregateId !== this.id;
		const typeForeign =
			aggregateType !== undefined && aggregateType !== this.aggregateType;
		if (idForeign || typeForeign) {
			throw new MisaddressedEventError(
				this.id,
				this.aggregateType,
				event.type,
				aggregateId,
				aggregateType,
			);
		}
		if (aggregateId !== undefined && aggregateType !== undefined) {
			return event;
		}
		// The spread preserves the event's structural shape; TS cannot
		// prove it against the generic Extract, so the copy goes through
		// the event's own wider type. `aggregateId`/`aggregateType` are
		// `string | undefined` on DomainEvent; filling them in cannot
		// leave the declared shape.
		const stamped: AnyDomainEvent = Object.freeze({
			...event,
			aggregateId: this.id,
			aggregateType: this.aggregateType,
		});
		return stamped as Extract<TEvent, { type: K }>;
	}

	/**
	 * Internal state-transition path shared by `apply()` and the replay
	 * methods (`loadFromHistory`, `restoreFromSnapshotWithEvents`):
	 * locate the handler, commit the next state. It deliberately does
	 * NOT record the event, bump the version, or run `validateEvent`;
	 * `apply()` layers all three on for new facts, while replay must not
	 * (the history is already persisted, and validating it against
	 * current rules would reject streams that were valid when written).
	 * The replay loop iterates over `TEvent[]` and therefore cannot
	 * supply a narrowed `K` generic, so this helper accepts `TEvent`
	 * and the discriminator is resolved via the (statically-sound)
	 * `handlers` map.
	 */
	/**
	 * Replay address check: a history event that names a DIFFERENT
	 * aggregate id or type is a persisted row that belongs to someone
	 * else (a miswired stream read, colliding ids across types, a
	 * corrupted store). Throws `ForeignEventError`, an
	 * `InfrastructureError`, which PROPAGATES through the replay
	 * methods (their `Result` channel is reserved for `DomainError`
	 * stream corruption) after the all-or-nothing rollback. History
	 * events without the optional address fields pass unchecked
	 * (legacy streams predate the stamps); NEW events are covered by
	 * the stricter `stampNewEventAddress` on the apply path.
	 */
	private assertReplayedEventBelongsHere(event: TEvent): void {
		const idMismatch =
			event.aggregateId !== undefined && event.aggregateId !== this.id;
		const typeMismatch =
			event.aggregateType !== undefined &&
			event.aggregateType !== this.aggregateType;
		if (idMismatch || typeMismatch) {
			throw new ForeignEventError(
				this.id,
				this.aggregateType,
				event.type,
				event.aggregateId,
				event.aggregateType,
			);
		}
	}

	private dispatch(event: TEvent): void {
		// Own-key guard: the handlers map is an object literal, so a plain
		// property get for event.type === "toString" / "constructor" /
		// "__proto__" (a corrupt or adversarial stream row) would resolve
		// through Object.prototype and invoke a non-handler.
		const handler = Object.hasOwn(this.handlers, event.type)
			? (this.handlers[event.type as keyof typeof this.handlers] as Handler<
					TState,
					TEvent
				>)
			: undefined;
		if (!handler) {
			throw new MissingHandlerError(event.type);
		}

		const nextState = handler(this._state, event);

		// Atomic commit: nothing above this line mutated aggregate state.
		this._state = this.freezeState(nextState);
	}

	/**
	 * Reconstitutes the aggregate from an event history. Catches `DomainError`
	 * thrown during replay and returns it as an `Err`: this is the
	 * infrastructure boundary, where event-stream corruption is an expected
	 * recoverable failure. Unexpected (non-DomainError) throws propagate.
	 *
	 * All-or-nothing: if any event mid-stream throws, the aggregate's state
	 * is rolled back to its pre-call value, the same contract as
	 * `restoreFromSnapshotWithEvents`. Partial replay is never observable.
	 * (Version needs no rollback: replay goes through `dispatch`, which
	 * never bumps it; only the final `markRestored` advances it.)
	 *
	 * Version advances additively: the aggregate's pre-existing version plus
	 * `history.length`. A fresh aggregate (v=0) loading 3 events ends at
	 * v=3; a PERSISTED aggregate at v=P (`persistedVersion === P`) catching
	 * up on M newer events ends at v=P+M.
	 *
	 * **The replay target must be fresh or persisted.** An aggregate with
	 * unflushed `pendingEvents`, or with an in-memory version that was
	 * never persisted (a factory-created instance), throws
	 * {@link UnreplayableAggregateError} BEFORE anything moves: replaying
	 * onto it would `markRestored` a `persistedVersion` that counts
	 * unpersisted history, flipping repository routing from INSERT to
	 * UPDATE (or appending with a wrong expected version). The throw is
	 * deliberate (crash-loud programming bug), never a `Result` `Err`, and
	 * runs before the empty-history fast path so the misuse is caught
	 * deterministically rather than only when the stream happens to be
	 * non-empty.
	 */
	public loadFromHistory(
		history: ReadonlyArray<TEvent>,
	): Result<void, DomainError> {
		assertRestoreTargetHasNoPendingEvents(this);
		this.assertReplayTargetHasNoUnpersistedVersion();
		// Empty stream: nothing was loaded, so leave the lifecycle markers
		// alone. markRestored(version) here would replace the
		// never-persisted sentinel (persistedVersion === undefined) on a
		// fresh aggregate, flipping repository routing from INSERT to
		// UPDATE against a row that does not exist.
		if (history.length === 0) return ok();

		const previousState = this._state;
		const startVersion = this.version;
		for (const event of history) {
			try {
				this.assertReplayedEventBelongsHere(event);
				this.dispatch(event);
			} catch (e) {
				this._state = previousState;
				if (e instanceof DomainError) return err(e);
				throw e;
			}
		}
		this.markRestored((startVersion + history.length) as Version);
		return ok();
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
	 *
	 * **The restore target must not carry pending events**: such a target
	 * throws {@link UnreplayableAggregateError} before anything moves
	 * (crash-loud programming bug, never a `Result` `Err`; see that
	 * error's docs for the rationale and remedies). Unlike
	 * `loadFromHistory`, a never-persisted in-memory version is fine
	 * here: the snapshot overwrites state and version entirely instead
	 * of adding to them.
	 */
	public restoreFromSnapshotWithEvents(
		snapshot: AggregateSnapshot<TSnapshotState>,
		eventsAfterSnapshot: ReadonlyArray<TEvent>,
	): Result<void, DomainError> {
		assertRestoreTargetHasNoPendingEvents(this);
		const previousState = this._state;
		const previousVersion = this.version;
		// `persistedVersion` is invariant during the loop; no rollback needed.

		// Resolve, convert, and structurally check BEFORE anything is
		// assigned, under the method's documented Result contract: a
		// DomainError from migrateSnapshotState, fromSnapshotState, or
		// validateRestoredState maps to Err (the repository's
		// discard-and-refold branch must see it), while
		// SnapshotSchemaMismatchError (an InfrastructureError) and other
		// non-domain throws propagate. Deliberately NOT validated with
		// `validateState`: those are today's decision rules, and a
		// snapshot persisted under yesterday's rules must keep loading
		// ("replay from zero equals snapshot plus tail").
		// `validateRestoredState` is the separate STRUCTURAL gate for the
		// stored blob.
		let restored: TState;
		try {
			restored = this.fromSnapshotState(this.resolveSnapshotState(snapshot));
			this.validateRestoredState(restored);
		} catch (e) {
			if (e instanceof DomainError) return err(e);
			throw e;
		}

		this._state = this.freezeState(restored);
		this.setVersion(snapshot.version);

		for (const event of eventsAfterSnapshot) {
			try {
				this.assertReplayedEventBelongsHere(event);
				this.dispatch(event);
			} catch (e) {
				this._state = previousState;
				this.setVersion(previousVersion);
				if (e instanceof DomainError) return err(e);
				throw e;
			}
		}

		this.markRestored(
			(snapshot.version + eventsAfterSnapshot.length) as Version,
		);
		return ok();
	}

	/**
	 * Additive-replay guard for `loadFromHistory` only: the snapshot
	 * restore overwrites version wholesale, so a never-persisted in-memory
	 * version is harmless there and `restoreFromSnapshotWithEvents`
	 * deliberately does not call this.
	 */
	private assertReplayTargetHasNoUnpersistedVersion(): void {
		if (this.version > 0 && this.persistedVersion === undefined) {
			throw new UnreplayableAggregateError(
				String(this.id),
				`its in-memory version (${this.version}) was never persisted ` +
					"(persistedVersion is undefined), so additive replay would " +
					"mark unpersisted history as persisted; call " +
					"markPersisted(version) only after that state was actually " +
					"saved, then catch-up replay",
			);
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
