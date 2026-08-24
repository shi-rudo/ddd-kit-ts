import { err, ok, type Result } from "@shirudo/result";
import {
	DirectStateMutationError,
	DomainError,
	ForeignEventError,
	HandlerReturnedNoStateError,
	MisaddressedEventError,
	MissingHandlerError,
} from "../../errors/kit-errors";
import { assertStateInvariant } from "../entity/entity";
import {
	type AnyDomainEvent,
	type AnyUncommittedDomainEvent,
	adoptMintedEvent,
	adoptUncommittedDomainEvent,
	isMintedEvent,
	type PendingDomainEvent,
	type UncommittedDomainEventOf,
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
 * does for a state-stored `setState`. Replay through `loadFromHistory`
 * runs neither, because history is already accepted fact and rules change
 * over time; a stream that was valid when written must stay loadable under
 * tomorrow's rules. The infrastructure-boundary method `loadFromHistory`
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
	 * point, `loadFromHistory`.
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
		// against current rules; replay trusts history. Validate, then
		// freeze, then assign, in the order Entity.setState keeps: the object
		// validated IS the object stored, a rejected fold result leaves
		// nothing frozen behind, and nothing below assigns until both gates
		// passed. Unlike setState there is no defensive copy: the fold result
		// is the aggregate's own next state.
		// TODO: run the hostile own-key guard on the fold result as well
		// (ddd-kit-ts-rhxi.7).
		this.validateEvent(stamped as UncommittedDomainEventOf<TEvent>);
		const next = this.fold(stamped);
		assertStateInvariant(this, next);
		this._state = this.freezeState(next);
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
		event: PendingDomainEvent<Extract<TEvent, { type: K }>>,
	): PendingDomainEvent<Extract<TEvent, { type: K }>> {
		// Immutability first: runs before validate/fold so a rejected
		// event cannot leave mutated state behind (addDomainEvent would
		// catch it too, but only after the handler already committed).
		this.assertMintedEvent(event);
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
		const copy = {
			...event,
			aggregateId: this.id,
			aggregateType: this.aggregateType,
		};
		const stamped: AnyDomainEvent | AnyUncommittedDomainEvent = isMintedEvent(
			event,
		)
			? adoptMintedEvent(copy)
			: adoptUncommittedDomainEvent(copy);
		return stamped as PendingDomainEvent<Extract<TEvent, { type: K }>>;
	}

	/**
	 * Internal fold shared by `apply()` and `loadFromHistory`: locate the
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
	 * All-or-nothing: if any event mid-stream throws, the aggregate's state
	 * is rolled back to its pre-call value, the same contract as
	 * every replay path. Partial replay is never observable.
	 * (Version needs no rollback: replay goes through `fold`, which
	 * never bumps it; only the final `markRestored` advances it.)
	 *
	 * Version advances additively: the aggregate's pre-existing version plus
	 * `history.length`. A fresh aggregate (v=0) loading 3 events ends at v=3;
	 * a reconstituted aggregate at v=P catching up on M newer events ends at
	 * v=P+M.
	 *
	 * The replay target must not carry pending decisions. Factory-vs-load
	 * lifecycle is owned by the Unit of Work rather than inferred from an
	 * aggregate persistence flag.
	 */
	public loadFromHistory(
		history: ReadonlyArray<TEvent>,
	): Result<void, DomainError> {
		assertReplayTargetHasNoPendingEvents(this);
		// Empty stream: nothing was loaded, so preserve current state and version.
		if (history.length === 0) return ok();

		const previousState = this._state;
		const startVersion = this.version;
		for (const event of history) {
			try {
				this.assertReplayedEventBelongsHere(event);
				this._state = this.freezeState(this.fold(event));
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
