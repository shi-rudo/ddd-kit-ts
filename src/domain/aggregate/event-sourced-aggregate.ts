import { err, ok, type Result } from "@shirudo/result";
import {
	DirectStateMutationError,
	type DomainError,
	ForeignEventError,
	HandlerReturnedNoStateError,
	isDomainErrorLike,
	MissingHandlerError,
} from "../../errors/kit-errors";
import {
	assertStateHasNoHostileOwnKey,
	assertStateInvariant,
} from "../entity/entity";
import type {
	AnyDomainEvent,
	PendingDomainEvent,
	UncommittedDomainEventOf,
} from "../event/domain-event";
import type { Id } from "../identity/id";
import type { IEventSourcedAggregate, Version } from "./aggregate";
import {
	assertReplayTargetHasNoPendingEvents,
	BaseAggregate,
} from "./base-aggregate";

// Re-export for backwards compatibility: `IEventSourcedAggregate` lives
// in `aggregate.ts` (the type hub).
export type { IEventSourcedAggregate } from "./aggregate";

type Handler<TState, TEvent> = (state: TState, event: TEvent) => TState;

/**
 * Base class for Event-Sourced Aggregate Roots (Vernon, IDDD Chapter 8).
 *
 * Like `AggregateRoot`, this is both the root entity and the aggregate
 * boundary. The difference is persistence: state is derived from events,
 * not stored directly. Events are the single source of truth: all state
 * changes go through `apply()` → handler.
 *
 * Extends `BaseAggregate` (the shared lifecycle machinery) but offers no
 * `commit()`, and the inherited `setState()` throws
 * `DirectStateMutationError`: the only way to change state is an event
 * folded by a handler through `apply()`, so the instance never runs ahead
 * of its stream.
 *
 * `apply()` and `validateEvent()` throw `DomainError`-derived exceptions
 * on invariant violations. Subclasses override `validateEvent()` to
 * throw their own concrete subclasses (e.g. `OrderAlreadyConfirmedError`).
 * Two gates guard a NEW fact: `validateEvent` checks the decision against
 * the current state before the fold, and the `validateState` function
 * from `AggregateConfig` checks the folded state after it, exactly as it
 * does for a state-stored `setState`. Replay through `replayHistory`
 * runs neither, because history is already accepted fact and rules change
 * over time; a stream that was valid when written must stay loadable under
 * tomorrow's rules. The infrastructure-boundary method `replayHistory`
 * returns `Result`: it catches `DomainError` during replay so callers can
 * react to corrupted event streams without try/catch.
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
 *     this.apply(
 *       this.createEvent("OrderConfirmed", { orderId: this.id }),
 *     );
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
	>
	extends BaseAggregate<TState, TId, TEvent>
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
	protected validateEvent(_event: UncommittedDomainEventOf<TEvent>): void {}

	/**
	 * Always throws {@link DirectStateMutationError}. An event-sourced
	 * aggregate changes state only through `apply()`, where the fact is
	 * recorded and the version advances with it.
	 */
	protected override setState(_newState: TState): void {
		throw new DirectStateMutationError(String(this.id));
	}

	/**
	 * Applies an event: validates the decision, locates the handler, folds
	 * the next state, validates that state, then commits state + pending
	 * event + version bump atomically.
	 *
	 * Throws `DomainError` (or a subclass) when `validateEvent` rejects the
	 * decision. Throws whatever the `validateState` function throws when it
	 * rejects the folded state.
	 * Throws `MissingHandlerError` if no handler is registered for `event.type`.
	 * Throws `HandlerReturnedNoStateError` (wiring) when the handler returns
	 * `undefined`, the signature of a fold without a `return`.
	 * Throws `MisaddressedEventError` (wiring) when the event carries an
	 * `aggregateId` or `aggregateType` naming a different aggregate;
	 * missing address fields are stamped from the aggregate instead.
	 *
	 * State is not mutated if any step throws: the handler is invoked into
	 * a local and only assigned to `_state` once all checks pass.
	 *
	 * The method is generic in the event tag `K`, so concrete callers
	 * (`this.apply(orderCreated)`) narrow to the literal tag and the
	 * handler is typed as `Handler<TState, Extract<TEvent, { type: K }>>`,
	 * with no `as` cast required at the call site.
	 *
	 * `apply()` is exclusively for NEW facts: it always records the event
	 * and bumps the version (the former `isNew` flag argument is gone).
	 * Replaying history is a different operation with its own entry
	 * point, `replayHistory`.
	 *
	 * @param event - The domain event to apply
	 */
	protected apply<K extends TEvent["type"]>(
		event: PendingDomainEvent<Extract<TEvent, { type: K }>>,
	): void {
		// New facts get their address here, by construction: missing
		// fields are stamped from the aggregate (the createEvent
		// guarantee), a present-but-foreign address throws
		// MisaddressedEventError before anything is recorded. Without
		// this, a mis-addressed event would mutate state, version, and
		// pendingEvents and only fail later at harvest or on the next
		// load, poisoning the own stream.
		const stamped = this.stampNewEventAddress(event);
		// Both gates live HERE, not in fold: only new facts are checked
		// against current rules; replay trusts history. Freeze, validate,
		// assign, in the order Entity.setState keeps: the object validated
		// IS the frozen object stored, and nothing below assigns until both
		// gates passed. Unlike setState there is no defensive copy: the fold
		// result is the aggregate's own next state, so a rejected result is
		// left frozen. The hostile own-key guard runs below on every new
		// fact; replay runs it once on the final state. The event was
		// stamped above, so it is appended as is.
		this.validateEvent(stamped as UncommittedDomainEventOf<TEvent>);
		const next = this.freezeState(this.fold(stamped));
		// A hostile row can reach the handler through the payload or its own
		// construction; the guard runs at the same depth and on the same
		// shapes as setState, on the state that is about to be stored.
		assertStateHasNoHostileOwnKey(next, "Aggregate state");
		assertStateInvariant(this, next);
		this._state = next;
		this.appendStampedEvent(stamped);
		this.bumpVersion();
	}

	/**
	 * Internal fold shared by `apply()` and `replayHistory`: locate the
	 * handler and compute the next state. It deliberately does NOT assign
	 * the state, record the event, bump the version, or run `validateEvent`
	 * and `validateState`; `apply()` layers all of that on for new facts,
	 * while replay assigns the fold result as is (the history is already
	 * persisted, and validating it against current rules would reject
	 * streams that were valid when written).
	 * The replay loop iterates over `TEvent[]` and therefore cannot
	 * supply a narrowed `K` generic, so this helper accepts `TEvent`
	 * and the discriminator is resolved via the (statically-sound)
	 * `handlers` map.
	 *
	 * Replay address check: a history event that names a DIFFERENT
	 * aggregate id or type is a persisted row that belongs to someone
	 * else (a miswired stream read, colliding ids across types, a
	 * corrupted store). Throws `ForeignEventError`, an
	 * `InfrastructureError`, which PROPAGATES through the replay
	 * methods (their `Result` channel is reserved for `DomainError`
	 * stream corruption) after the all-or-nothing rollback. History
	 * events without the optional address fields pass unchecked (the
	 * fields are optional on the event shape); NEW events are covered
	 * by the stricter `stampNewEventAddress` on the apply path.
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

	private fold(event: TEvent | UncommittedDomainEventOf<TEvent>): TState {
		// Own-key guard: the handlers map is an object literal, so a plain
		// property get for event.type === "toString" / "constructor" /
		// "__proto__" (a corrupt or adversarial stream row) would resolve
		// through Object.prototype and invoke a non-handler.
		const handler = Object.hasOwn(this.handlers, event.type)
			? (this.handlers[event.type as keyof typeof this.handlers] as Handler<
					TState,
					TEvent | UncommittedDomainEventOf<TEvent>
				>)
			: undefined;
		if (!handler) {
			throw new MissingHandlerError(event.type);
		}

		const nextState = handler(this._state, event);
		// Only `undefined` is rejected: a primitive or `null` state is a
		// legal TState, a missing `return` is not.
		if (nextState === undefined) {
			throw new HandlerReturnedNoStateError(event.type);
		}
		return nextState;
	}

	/**
	 * Reconstitutes the aggregate from an event history. Catches `DomainError`
	 * thrown during replay and returns it as an `Err`: this is the
	 * infrastructure boundary, where event-stream corruption is an expected
	 * recoverable failure. Unexpected (non-DomainError) throws propagate.
	 *
	 * All-or-nothing: if any event mid-stream throws, or the final restore
	 * marker is rejected, the aggregate's state, version, and pending list
	 * are rolled back to their pre-call values. Partial replay is never
	 * observable. A handler that records a decision during the fold is the
	 * one way to make the marker throw.
	 *
	 * Version advances additively: the aggregate's pre-existing version plus
	 * `history.length`. A fresh aggregate (v=0) loading 3 events ends at v=3;
	 * a reconstituted aggregate at v=P catching up on M newer events ends at
	 * v=P+M. Events carry no stream position, so an overlap with the current
	 * version is invisible here: the caller passes only the events after
	 * that version and checks the final version against the pinned stream
	 * head ({@link ReplayHeadMismatchError}).
	 *
	 * The replay target must not carry pending decisions. Factory-vs-load
	 * lifecycle is owned by the Unit of Work rather than inferred from an
	 * aggregate persistence flag.
	 */
	public replayHistory(
		history: ReadonlyArray<TEvent>,
	): Result<void, DomainError> {
		assertReplayTargetHasNoPendingEvents(this);
		// Empty stream: nothing was loaded, so preserve current state and version.
		if (history.length === 0) return ok();

		const previousState = this._state;
		const startVersion = this.version;
		try {
			for (const event of history) {
				this.assertReplayedEventBelongsHere(event);
				this._state = this.freezeState(this.fold(event));
			}
			// Only the final fold result is stored, so the hostile own-key
			// guard runs once here instead of once per replayed event; a
			// rejection rolls back below like any other replay failure.
			assertStateHasNoHostileOwnKey(this._state, "Aggregate state");
			// Inside the try on purpose: a handler that records a decision
			// during the fold makes this throw, and the rollback below must
			// cover that case too.
			this.markReconstituted((startVersion + history.length) as Version);
		} catch (e) {
			this._state = previousState;
			this.setVersion(startVersion);
			// The guard above proved the pending list empty before the loop,
			// so anything in it now came from a handler that recorded a
			// decision during the fold; the rollback drops it too.
			this.discardPendingDecisions();
			// Copy-safe: a handler may run in another loaded copy of the kit,
			// whose DomainError fails a plain instanceof; the Result channel
			// must carry it regardless.
			if (isDomainErrorLike(e)) return err(e);
			throw e;
		}
		return ok();
	}

	/**
	 * A map of event types to their corresponding handlers.
	 * Subclasses MUST implement this property.
	 *
	 * A handler returns the next state. `undefined` is rejected on both the
	 * apply and the replay path as a missing `return`, so model an absent
	 * state as `null` or as a status field, never as `undefined`.
	 *
	 * Handlers MUST fold state from `type` and `payload` only. The
	 * parameter is typed as the uncommitted shape because a live `apply()`
	 * folds the event BEFORE the shell records it: `eventId` and
	 * `occurredAt` do not exist yet. Replay folds recorded events
	 * through the same handlers, so those fields ARE present at runtime
	 * there. A handler that reads them through an escape hatch (`as any`,
	 * plain JavaScript) folds `undefined` live and a value on replay,
	 * producing silently divergent state. When a time or identity changes a
	 * business decision, pass it in the payload.
	 */
	protected abstract readonly handlers: {
		[K in TEvent["type"]]: Handler<
			TState,
			UncommittedDomainEventOf<Extract<TEvent, { type: K }>>
		>;
	};
}

/**
 * Reconstitutes an event-sourced aggregate from one page of history and
 * yields it only on success. `createReplayTarget` builds the instance: a
 * fresh one, or one restored from a snapshot. The instance exists only
 * inside this call. A rejected replay therefore leaves the caller with
 * nothing to return by mistake. Later catch-up pages go through
 * `replayHistory` on the value. A `DomainError` from a handler rides the
 * `Result`; wiring errors and a foreign row throw, as in `replayHistory`.
 * The creator runs outside the `Result`: what it throws propagates.
 */
export function reconstituteAggregateFromHistory<
	TAggregate extends IEventSourcedAggregate<Id<string>, AnyDomainEvent>,
>(
	createReplayTarget: () => TAggregate,
	history: Parameters<TAggregate["replayHistory"]>[0],
): Result<TAggregate, DomainError> {
	const aggregate = createReplayTarget();
	const replayed = aggregate.replayHistory(history);
	if (replayed.isErr()) return err(replayed.error);
	return ok(aggregate);
}
