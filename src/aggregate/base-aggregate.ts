import type { Id } from "../core/id";
import { Entity } from "../entity/entity";
import type { AggregateSnapshot, IAggregateRoot, Version } from "./aggregate";
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
 * @template TSnapshotState - The plain-data shape stored in snapshots.
 *   Defaults to `TState` for plain-data states. Aggregates whose state
 *   carries class-based child entities declare a plain DTO shape here
 *   and override {@link toSnapshotState} / {@link fromSnapshotState}.
 */
export abstract class BaseAggregate<
		TState,
		TId extends Id<string>,
		TEvent extends AnyDomainEvent = never,
		TSnapshotState = TState,
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
	protected onPersisted(_version: Version): void {}

	/**
	 * Appends a domain event to the pending list. Prefer the higher-level
	 * `AggregateRoot.commit()` (state-stored) or `EventSourcedAggregate.apply()`
	 * (event-sourced) call sites — both wrap `addDomainEvent` in the
	 * canonical record-AFTER-mutation order (Vernon §8). Calling
	 * `addDomainEvent` directly is appropriate only when state and event
	 * recording have already been decoupled deliberately (e.g. a
	 * deletion event before a hard-delete; see `docs/guide/repository.md`).
	 */
	protected addDomainEvent(event: TEvent): void {
		this._pendingEvents.push(event);
	}

	/**
	 * Creates a snapshot of the current aggregate state — the state at
	 * this moment plus the version. Useful for ES snapshot policies and
	 * for state-stored backup / restore.
	 *
	 * The state is converted via {@link toSnapshotState}; the default
	 * requires plain, serialisable data and fails fast otherwise.
	 */
	public createSnapshot(): AggregateSnapshot<TSnapshotState> {
		return {
			state: this.toSnapshotState(this._state),
			version: this.version,
			snapshotAt: new Date(),
		};
	}

	/**
	 * Converts live aggregate state into the plain-data shape stored in a
	 * snapshot. The default validates that the state graph is plain,
	 * serialisable data (no class instances, functions, Promise/WeakMap/
	 * WeakSet) and then `structuredClone`s it — class instances would
	 * silently lose their prototype here AND on every snapshot-store
	 * round-trip, so the default fails fast with the offending path
	 * instead of producing a snapshot that breaks on first method call
	 * after restore.
	 *
	 * Override this together with {@link fromSnapshotState} (and the
	 * `TSnapshotState` generic) when the state carries class-based child
	 * entities. The override owns isolation: return fresh objects, not
	 * references into live state.
	 */
	protected toSnapshotState(state: TState): TSnapshotState {
		assertSnapshotSafe(state, "", new WeakSet());
		return structuredClone(state) as unknown as TSnapshotState;
	}

	/**
	 * Converts the plain-data snapshot shape back into live aggregate
	 * state. The default `structuredClone`s the stored state so the
	 * restored aggregate never aliases the snapshot object. Override
	 * together with {@link toSnapshotState} to reconstruct class-based
	 * child entities.
	 */
	protected fromSnapshotState(stored: TSnapshotState): TState {
		return structuredClone(stored) as unknown as TState;
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

/**
 * Built-in tags `structuredClone` handles AND that survive a typical
 * snapshot-store round-trip well enough to allow by default. Treated
 * atomically — never walked for own keys (a deep-frozen Date carries
 * non-enumerable shadow methods that must not trip the function check).
 */
const SNAPSHOT_SAFE_TAGS: ReadonlySet<string> = new Set([
	"[object Date]",
	"[object RegExp]",
	"[object Error]",
	"[object ArrayBuffer]",
	"[object SharedArrayBuffer]",
	"[object DataView]",
	"[object Boolean]",
	"[object Number]",
	"[object String]",
]);

/**
 * Walks a state graph and throws a descriptive error (with the offending
 * path) when it contains anything `structuredClone` would either reject
 * (functions, Promise/WeakMap/WeakSet) or silently degrade (class
 * instances lose their prototype and methods). Used by the default
 * `toSnapshotState` so snapshot corruption surfaces at snapshot time,
 * not on the first method call after a much later restore.
 */
function assertSnapshotSafe(
	value: unknown,
	path: string,
	seen: WeakSet<object>,
): void {
	if (typeof value === "function") {
		throw new Error(
			`createSnapshot: state${path} is a function — snapshot state must be ` +
				`plain, serialisable data. Override toSnapshotState()/` +
				`fromSnapshotState() to map it.`,
		);
	}
	if (value === null || typeof value !== "object") return;
	const obj = value as object;
	if (seen.has(obj)) return;
	seen.add(obj);

	if (Array.isArray(obj)) {
		for (let i = 0; i < obj.length; i++) {
			assertSnapshotSafe(obj[i], `${path}[${i}]`, seen);
		}
		return;
	}

	const tag = Object.prototype.toString.call(obj);
	if (tag === "[object Map]") {
		let i = 0;
		for (const [key, entryValue] of obj as Map<unknown, unknown>) {
			assertSnapshotSafe(key, `${path}<map key #${i}>`, seen);
			assertSnapshotSafe(entryValue, `${path}<map value #${i}>`, seen);
			i++;
		}
		return;
	}
	if (tag === "[object Set]") {
		let i = 0;
		for (const member of obj as Set<unknown>) {
			assertSnapshotSafe(member, `${path}<set member #${i}>`, seen);
			i++;
		}
		return;
	}
	if (
		tag === "[object Promise]" ||
		tag === "[object WeakMap]" ||
		tag === "[object WeakSet]"
	) {
		throw new Error(
			`createSnapshot: state${path} is a ${tag.slice(8, -1)} — it cannot ` +
				`be cloned or persisted. Override toSnapshotState()/` +
				`fromSnapshotState() to map it.`,
		);
	}
	if (ArrayBuffer.isView(obj) || SNAPSHOT_SAFE_TAGS.has(tag)) return;

	if (tag === "[object Object]") {
		const proto = Object.getPrototypeOf(obj);
		if (proto !== Object.prototype && proto !== null) {
			const name: string =
				(proto.constructor && proto.constructor.name) || "anonymous class";
			throw new Error(
				`createSnapshot: state${path} is a class instance (${name}) — ` +
					`structuredClone would strip its prototype and methods, producing ` +
					`a snapshot that breaks on the first method call after restore. ` +
					`Override toSnapshotState()/fromSnapshotState() to map child ` +
					`entities to plain data.`,
			);
		}
		for (const key of Reflect.ownKeys(obj)) {
			assertSnapshotSafe(
				(obj as Record<PropertyKey, unknown>)[key],
				`${path}.${String(key)}`,
				seen,
			);
		}
		return;
	}
	// Unknown exotic tag: let structuredClone decide — it throws clearly
	// for unsupported types.
}
