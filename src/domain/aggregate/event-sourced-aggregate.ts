import { err, ok, type Result } from "@shirudo/result";
import {
	DirectStateMutationError,
	type DomainError,
	FoldReturnedNoStateError,
	ForeignEventError,
	isDomainErrorLike,
	MissingFoldError,
} from "../../errors/kit-errors";
import {
	assertStateHasNoHostileOwnKey,
	assertStateInvariant,
	freezeEntityState,
	storeTrustedState,
} from "../entity/entity";
import type {
	AnyDomainEvent,
	PendingDomainEvent,
	UncommittedDomainEventOf,
} from "../event/domain-event";
import type { Id } from "../identity/id";
import type { ReplayableAggregate, Version } from "./aggregate";
import {
	assertReplayTargetHasNoPendingEvents,
	BaseAggregate,
} from "./base-aggregate";
import { requirePendingEventLifecycleReadView } from "./pending-event-lifecycle";

type Fold<TState, TEvent> = (state: TState, event: TEvent) => TState;

/**
 * Base class for Event-Sourced Aggregate Roots (Vernon, IDDD Chapter 8).
 *
 * Like `StateStoredAggregate`, this is both the root entity and the aggregate
 * boundary. The difference is persistence: state is derived from events,
 * not stored directly. Events are the single source of truth: all state
 * changes go through `apply()` and a fold.
 *
 * Extends `BaseAggregate` (the shared lifecycle machinery) but offers no
 * `setState()`, and the inherited `setState()` throws
 * `DirectStateMutationError`: the only way to change state is an event
 * folded through `apply()`, so the instance never runs ahead
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
 * @template TId    - The aggregate root identifier
 * @template TEvent - The union type of all domain events
 *
 * @example
 * ```typescript
 * class OrderAlreadyConfirmedError extends DomainError<"ORDER_ALREADY_CONFIRMED"> {
 *   constructor(id: OrderId) {
 *     super({ code: "ORDER_ALREADY_CONFIRMED", message: `Order ${id} is already confirmed` });
 *   }
 * }
 *
 * class Order extends EventSourcedAggregate<OrderState, OrderId, OrderEvent> {
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
 *   protected readonly folds = {
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
		TId extends Id<string>,
		TEvent extends AnyDomainEvent,
	>
	extends BaseAggregate<TState, TId, TEvent>
	implements ReplayableAggregate<TId, TEvent>
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
	 * the read boundary (see the event-upcasting guide) so the folds
	 * always receive the current event shape.
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
	 * Applies an event: validates the decision, locates the fold, computes
	 * the next state, validates that state, then commits state + pending
	 * event + version bump atomically.
	 *
	 * Throws `DomainError` (or a subclass) when `validateEvent` rejects the
	 * decision. Throws whatever the `validateState` function throws when it
	 * rejects the folded state.
	 * Throws `MissingFoldError` if no fold is declared for `event.type`.
	 * Throws `FoldReturnedNoStateError` (wiring) when the fold returns
	 * `undefined`, the signature of a fold without a `return`.
	 * Throws `MisaddressedEventError` (wiring) when the event carries an
	 * `aggregateId` or `aggregateType` naming a different aggregate;
	 * missing address fields are stamped from the aggregate instead.
	 *
	 * State is not mutated if any step throws: the fold is invoked into
	 * a local and only stored once all checks pass.
	 *
	 * The method is generic in the event tag `K`, so concrete callers
	 * (`this.apply(orderCreated)`) narrow to the literal tag and the
	 * fold is typed as `Fold<TState, Extract<TEvent, { type: K }>>`,
	 * with no `as` cast required at the call site.
	 *
	 * `apply()` is exclusively for NEW facts: it always records the event
	 * and bumps the version. Replaying history is a different operation
	 * with its own entry point, `replayHistory`.
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
		const stamped = this.addressNewEvent(event);
		this.assertEventIdsNotPending([stamped]);
		this.assertPendingEventLimit(1);
		// Both gates run here, not in fold: apply checks only new facts
		// against the current rules, and replay trusts history. The order
		// is the one Entity.setState keeps: freeze, validate, store. The
		// object that passed validation is the object stored, and no step
		// below stores until both gates passed. Unlike setState there is
		// no defensive copy: the fold result is the aggregate's own next
		// state, so a rejected result stays frozen. The hostile own-key
		// guard runs on every new fact; replay runs it once on the final
		// state. The event was stamped above, so it is appended as is.
		this.validateEvent(stamped as UncommittedDomainEventOf<TEvent>);
		const next = freezeEntityState(this, this.fold(stamped));
		// A hostile row can reach the fold through the payload or its own
		// construction; the guard runs at the same depth and on the same
		// shapes as setState, on the state that is about to be stored.
		assertStateHasNoHostileOwnKey(next, "Aggregate state");
		assertStateInvariant(this, next);
		// The version write is the last step that can throw (an override of
		// setVersion). The store and the append run after it and cannot
		// throw.
		this.bumpVersion();
		storeTrustedState(this, next);
		this.appendStampedEvent(stamped);
	}

	/**
	 * Internal fold shared by `apply()` and `replayHistory`: locate the
	 * fold and compute the next state. It deliberately does NOT assign
	 * the state, record the event, bump the version, or run `validateEvent`
	 * and `validateState`; `apply()` layers all of that on for new facts,
	 * while replay assigns the fold result as is (the history is already
	 * persisted, and validating it against current rules would reject
	 * streams that were valid when written).
	 * The replay loop iterates over `TEvent[]` and therefore cannot
	 * supply a narrowed `K` generic, so this helper accepts `TEvent`
	 * and the discriminator is resolved via the (statically-sound)
	 * `folds` map.
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
	 * by the stricter `addressNewEvent` on the apply path.
	 */
	private assertReplayedEventBelongsHere(event: TEvent): void {
		const idMismatch =
			event.aggregateId !== undefined && event.aggregateId !== this.id;
		const typeMismatch =
			event.aggregateType !== undefined &&
			event.aggregateType !== this.aggregateType;
		if (idMismatch || typeMismatch) {
			throw new ForeignEventError({
				expected: { aggregateType: this.aggregateType, aggregateId: this.id },
				actual: {
					aggregateType: event.aggregateType,
					aggregateId: event.aggregateId,
				},
				eventType: event.type,
			});
		}
	}

	private fold(event: TEvent | UncommittedDomainEventOf<TEvent>): TState {
		// Own-key guard: the folds map is an object literal, so a plain
		// property get for event.type === "toString" / "constructor" /
		// "__proto__" (a corrupt or adversarial stream row) would resolve
		// through Object.prototype and invoke a non-fold.
		const fold = Object.hasOwn(this.folds, event.type)
			? (this.folds[event.type as keyof typeof this.folds] as Fold<
					TState,
					TEvent | UncommittedDomainEventOf<TEvent>
				>)
			: undefined;
		if (!fold) {
			throw new MissingFoldError(event.type);
		}

		const nextState = fold(this.state, event);
		// Only `undefined` is rejected: a primitive or `null` state is a
		// legal TState, a missing `return` is not.
		if (nextState === undefined) {
			throw new FoldReturnedNoStateError(event.type);
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
	 * observable. A fold that records a decision is the one way to make
	 * the marker throw. The rollback restores the previous state object by
	 * reference. Under the default shallow freeze a fold that writes into a
	 * nested object of that state in place is not detected, and the write
	 * survives the rollback; see `AggregateConfig.deepFreezeState`.
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
		assertReplayTargetHasNoPendingEvents(
			this.id,
			requirePendingEventLifecycleReadView(
				this,
				"replayHistory",
			).pendingEventCount(),
		);
		// Empty stream: nothing was loaded, so preserve current state and version.
		if (history.length === 0) return ok();

		const previousState = this.state;
		const startVersion = this.version;
		try {
			for (const event of history) {
				this.assertReplayedEventBelongsHere(event);
				storeTrustedState(this, this.fold(event));
			}
			// Only the final fold result is stored, so the hostile own-key
			// guard runs once here instead of once per replayed event; a
			// rejection rolls back below like any other replay failure.
			assertStateHasNoHostileOwnKey(this.state, "Aggregate state");
			// Inside the try on purpose: a fold that records a decision
			// makes this throw, and the rollback below must cover that case
			// too.
			this.markReconstituted((startVersion + history.length) as Version);
		} catch (e) {
			storeTrustedState(this, previousState);
			// The fold itself never writes the version, but a fold that
			// records a decision bumps it through apply(); the rollback
			// writes the start version back through the same path.
			this.setVersion(startVersion);
			// The guard above proved the pending list empty before the loop,
			// so anything in it now came from a fold that recorded a
			// decision; the rollback drops it too.
			this.discardPendingDecisions();
			// Copy-safe: a fold may run in another loaded copy of the kit,
			// whose DomainError fails a plain instanceof; the Result channel
			// must carry it regardless.
			if (isDomainErrorLike(e)) return err(e);
			throw e;
		}
		return ok();
	}

	/**
	 * One fold per event type: a pure function from the current state and
	 * the event to the next state. Subclasses MUST implement this property.
	 *
	 * A fold returns the next state. `undefined` is rejected on both the
	 * apply and the replay path as a missing `return`, so model an absent
	 * state as `null` or as a status field, never as `undefined`.
	 *
	 * A fold MUST derive state from `type` and `payload` only. The
	 * parameter is typed as the uncommitted shape because a live `apply()`
	 * folds the event BEFORE the shell records it: `eventId` and
	 * `occurredAt` do not exist yet. Replay folds recorded events
	 * through the same map, so those fields ARE present at runtime
	 * there. A fold that reads them through an escape hatch (`as any`,
	 * plain JavaScript) sees `undefined` live and a value on replay,
	 * producing silently divergent state. When a time or identity changes a
	 * business decision, pass it in the payload.
	 */
	protected abstract readonly folds: {
		[K in TEvent["type"]]: Fold<
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
 * `replayHistory` on the value. A `DomainError` from a fold rides the
 * `Result`; wiring errors and a foreign row throw, as in `replayHistory`.
 * The creator runs outside the `Result`: what it throws propagates.
 */
export function reconstituteAggregateFromHistory<
	TAggregate extends ReplayableAggregate<Id<string>, AnyDomainEvent>,
>(
	createReplayTarget: () => TAggregate,
	history: Parameters<TAggregate["replayHistory"]>[0],
): Result<TAggregate, DomainError> {
	const aggregate = createReplayTarget();
	const replayed = aggregate.replayHistory(history);
	if (replayed.isErr()) return err(replayed.error);
	return ok(aggregate);
}
