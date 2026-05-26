import type { Id } from "../core/id";
import { Entity } from "../entity/entity";
import type { IAggregateRoot } from "./aggregate-root";
import type { Version } from "./aggregate";
import {
	type AnyDomainEvent,
	type CreateDomainEventOptions,
	createDomainEvent,
	type DomainEvent,
} from "./domain-event";

/**
 * Shared base for both `AggregateRoot` (state-stored) and
 * `EventSourcedAggregate`. Carries the lifecycle machinery that's
 * identical across the two flavours: version + persistedVersion
 * tracking, pending events buffer, the `markRestored` (Post-Load) /
 * `markPersisted` (Post-Save) lifecycle markers, and the
 * `recordEvent` helper that auto-injects `aggregateId` +
 * `aggregateType` on every event the aggregate emits.
 *
 * Consumers do NOT extend this class directly — extend
 * `AggregateRoot` for state-stored aggregates or
 * `EventSourcedAggregate` for event-sourced ones. The split between
 * those two reflects the canonical Vernon §8 (state-stored) /
 * Vernon §11 + Greg Young (event-sourced) distinction in how state
 * is represented; the lifecycle machinery is the same for both.
 *
 * @template TState - The type of the aggregate state
 * @template TId    - The aggregate root identifier
 * @template TEvent - The domain-event union. Defaults to `never` so
 *   aggregates without a declared event type cannot emit events
 *   (emitting any event becomes a compile error).
 */
export abstract class BaseAggregate<
		TState,
		TId extends Id<string>,
		TEvent extends AnyDomainEvent = never,
	>
	extends Entity<TState, TId>
	implements IAggregateRoot<TId, TEvent>
{
	/**
	 * The aggregate's domain type as a string, used to populate
	 * `aggregateType` on events recorded via {@link recordEvent}.
	 *
	 * Subclasses MUST declare this as a string literal:
	 *
	 * ```ts
	 * class Order extends AggregateRoot<OrderState, OrderId, OrderEvent> {
	 *   protected readonly aggregateType = "Order";
	 * }
	 * ```
	 *
	 * The string is *the* identifier downstream consumers (outbox
	 * dispatchers, projection handlers, audit logs) use to route by
	 * aggregate kind. Use the same canonical name across your system —
	 * matching the class name is the obvious choice, but the value
	 * comes from this explicit declaration, not `constructor.name`
	 * (which is fragile under minification, bundler transforms, and
	 * subclass renaming).
	 */
	protected abstract readonly aggregateType: string;

	private _version: Version = 0 as Version;

	/**
	 * DB-baseline version. `undefined` until the aggregate has been
	 * persisted or restored at least once. Repository implementations
	 * route INSERT vs UPDATE on this field and use it as the OCC
	 * baseline. See `IRepository.save` JSDoc.
	 *
	 * Distinct from {@link version}, which is the in-memory
	 * post-mutation value. Mutations bump `_version` but never touch
	 * `_persistedVersion` — that field only moves on {@link markRestored}
	 * (Post-Load) and {@link markPersisted} (Post-Save).
	 */
	private _persistedVersion: Version | undefined = undefined;

	private _pendingEvents: TEvent[] = [];

	public get version(): Version {
		return this._version;
	}

	public get persistedVersion(): Version | undefined {
		return this._persistedVersion;
	}

	/**
	 * Read-only list of domain events recorded on this aggregate that
	 * have not yet been flushed to the outbox / persistence layer.
	 */
	public get pendingEvents(): ReadonlyArray<TEvent> {
		return Object.freeze(this._pendingEvents.slice());
	}

	/**
	 * Clears the pending-event list. Called by `markPersisted` after a
	 * successful write — the events have been handed off to the outbox
	 * / event store and are no longer the aggregate's responsibility.
	 */
	public clearPendingEvents(): void {
		this._pendingEvents = [];
	}

	protected setVersion(version: Version): void {
		this._version = version;
	}

	/**
	 * Manually bumps the aggregate version. Used by state-stored
	 * aggregates' `setState(_, true)` / `commit()` paths and by the
	 * event-sourced replay path after each applied event.
	 */
	protected bumpVersion(): void {
		this.setVersion((this._version + 1) as Version);
	}

	/**
	 * **Lifecycle marker — Post-Load.** Syncs both `_version` and
	 * `_persistedVersion` to the DB-stored version. Used by
	 * `reconstitute(...)` factories to assemble an in-memory aggregate
	 * from a persisted row.
	 *
	 * Does NOT fire {@link onPersisted} — that hook has post-save
	 * semantics (metrics, audit, cache eviction), not post-load. The
	 * Factory-vs-Reconstitution distinction (Vernon §11) is honoured
	 * structurally: two separate markers, one for each transition.
	 *
	 * @param version - The version the row currently holds in the DB
	 *
	 * @example
	 * ```ts
	 * static reconstitute(id: OrderId, state: OrderState, version: Version): Order {
	 *   const order = new Order(id, state);
	 *   order.markRestored(version);
	 *   return order;
	 * }
	 * ```
	 */
	protected markRestored(version: Version): void {
		this.setVersion(version);
		this._persistedVersion = version;
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
		this.markRestored(version);
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
	 * **The hook must return synchronously.** `markPersisted` is `void`-
	 * typed and calls `onPersisted` without `await`. TypeScript's
	 * permissive `void` will accept an `async`-override returning
	 * `Promise<void>`, but the returned promise is fire-and-forget —
	 * any rejection becomes an unhandled rejection and `withCommit`
	 * proceeds without waiting. For asynchronous work, subscribe to the
	 * relevant domain event on the `EventBus` instead; that is the
	 * properly awaited extension point.
	 *
	 * @param version - The version that was just persisted
	 */
	protected onPersisted(_version: Version): void {
		// no-op by default
	}

	/**
	 * Records a domain event on the aggregate's pending list.
	 *
	 * **Ordering: record AFTER state mutation.** Vernon (IDDD §8) is
	 * explicit: a domain event describes something that has just
	 * happened — its existence implies the state change already
	 * occurred. Recording before mutation is a footgun: if a subsequent
	 * invariant check throws, the event has already been queued but
	 * the state never actually changed — consumers see an event for a
	 * fact that did not happen.
	 *
	 * `EventSourcedAggregate.apply()` enforces this ordering
	 * structurally; `AggregateRoot.commit()` is the opt-in equivalent
	 * for state-stored aggregates, where `setState` and event recording
	 * are otherwise decoupled.
	 */
	protected addDomainEvent(event: TEvent): void {
		this._pendingEvents.push(event);
	}

	/**
	 * Sugar for `createDomainEvent` that auto-injects `aggregateId`
	 * (from `this.id`) and `aggregateType` (from {@link aggregateType})
	 * into the event's metadata fields. This is the canonical path for
	 * recording events from inside aggregate domain methods.
	 *
	 * Downstream consumers — outbox dispatchers, projection handlers,
	 * audit logs — route by these two fields. Calling
	 * `createDomainEvent(...)` directly inside an aggregate method
	 * leaves them unset and is caught at the `withCommit` harvest
	 * boundary, but `this.recordEvent(...)` makes the right thing
	 * impossible to forget.
	 *
	 * @example
	 * ```ts
	 * class Order extends AggregateRoot<OrderState, OrderId, OrderEvent> {
	 *   protected readonly aggregateType = "Order";
	 *
	 *   confirm(): void {
	 *     this.commit(
	 *       { ...this.state, status: "confirmed" },
	 *       this.recordEvent("OrderConfirmed", { orderId: this.id }),
	 *     );
	 *   }
	 * }
	 * ```
	 *
	 * @param type    - event type discriminator (must be one of `TEvent`'s tags)
	 * @param payload - payload for that event subtype
	 * @param options - any remaining `createDomainEvent` options
	 *   (`eventId`, `occurredAt`, `metadata`, `version`); `aggregateId`
	 *   and `aggregateType` are deliberately omitted — the helper sets
	 *   them.
	 */
	protected recordEvent<E extends TEvent>(
		type: E["type"],
		payload: E["payload"],
		options?: Omit<CreateDomainEventOptions, "aggregateId" | "aggregateType">,
	): E {
		return createDomainEvent(type, payload, {
			...options,
			aggregateId: this.id,
			aggregateType: this.aggregateType,
		}) as DomainEvent<E["type"], E["payload"]> as E;
	}
}
