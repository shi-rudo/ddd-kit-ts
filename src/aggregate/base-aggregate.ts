import {
	SnapshotSchemaMismatchError,
	UnmintedEventError,
	UnreplayableAggregateError,
} from "../core/errors";
import type { Id } from "../core/id";
import { Entity, type EntityConfig } from "../entity/entity";
import { isBuiltInObject } from "../utils/array/is-built-in";
import type { AggregateSnapshot, IAggregateRoot, Version } from "./aggregate";
import {
	type AnyDomainEvent,
	type CreateDomainEventOptions,
	defaultDomainEventFactory,
	type DomainEventFactory,
	type DomainEvent,
	isMintedEvent,
} from "./domain-event";
import { registerAggregatePersistenceCapability } from "./persistence-lifecycle";

/** Construction options shared by state-stored and event-sourced aggregates. */
export interface AggregateConfig<TState = unknown>
	extends EntityConfig<TState> {
	/**
	 * Immutable event factory captured by this aggregate instance. Its clock
	 * also stamps snapshots, keeping request-local event and snapshot time
	 * consistent without module-level mutation.
	 */
	readonly domainEventFactory?: DomainEventFactory;
}

/**
 * Shared base for both `AggregateRoot` (state-stored) and
 * `EventSourcedAggregate`. Carries the lifecycle machinery that's
 * identical across the two flavours: version + persistedVersion
 * tracking, the kit-internal post-commit acknowledgement capability,
 * the `markRestored` post-load marker, and the
 * `recordEvent` helper that auto-injects `aggregateId` +
 * `aggregateType` on every event the aggregate emits.
 *
 * Consumers do NOT extend this class directly; extend
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
	 * aggregate kind. Use the same canonical name across your system;
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
	 * `_persistedVersion`; that field moves on {@link markRestored}
	 * (Post-Load) and kit-internal post-commit acknowledgement.
	 */
	private _persistedVersion: Version | undefined = undefined;

	private _pendingEvents: TEvent[] = [];

	private readonly domainEventFactory: DomainEventFactory;

	protected constructor(
		id: TId,
		initialState: TState,
		config?: AggregateConfig<TState>,
	) {
		super(id, initialState, config);
		this.domainEventFactory =
			config?.domainEventFactory ?? defaultDomainEventFactory;
		registerAggregatePersistenceCapability(this, {
			acknowledge: (version) => {
				this._version = version;
				this._persistedVersion = version;
				this._pendingEvents = [];
			},
			discardPendingEvents: () => {
				this._pendingEvents = [];
			},
		});
	}

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
	 * Count-only accessor for internal hot paths (`hasChanges` runs per
	 * save): the public {@link pendingEvents} getter allocates and freezes
	 * a defensive copy per read, which a length check does not need.
	 */
	protected get pendingEventCount(): number {
		return this._pendingEvents.length;
	}

	protected setVersion(version: Version): void {
		this._version = version;
	}

	/**
	 * Manually bumps the aggregate version. Used by state-stored
	 * aggregates' `setState()` / `commit()` paths and by the
	 * event-sourced replay path after each applied event.
	 */
	protected bumpVersion(): void {
		this.setVersion((this._version + 1) as Version);
	}

	/**
	 * **Lifecycle marker, Post-Load.** Syncs both `_version` and
	 * `_persistedVersion` to the DB-stored version. Used by
	 * `reconstitute(...)` factories to assemble an in-memory aggregate
	 * from a persisted row.
	 *
	 * The Factory-vs-Reconstitution distinction (Vernon §11) is honoured
	 * structurally: reconstitution stays inside the aggregate factory while
	 * post-save acknowledgement belongs to application commit orchestration.
	 *
	 * **If you override this, call `super.markRestored(version)` FIRST**.
	 * The marker is load-bearing
	 * twice over: it syncs `version`/`persistedVersion`, and on
	 * `AggregateRoot` it also captures the dirty-tracking baseline for
	 * `changedKeys`/`hasChanges`. An override that skips `super` leaves
	 * that baseline uncaptured: `changedKeys` permanently reports ALL
	 * keys and `hasChanges` never returns `false`, so a partial-write
	 * repository silently degrades to full writes on every save, on top
	 * of the broken version sync.
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
	 * Appends a domain event to the pending list. Prefer the higher-level
	 * `AggregateRoot.commit()` (state-stored) or `EventSourcedAggregate.apply()`
	 * (event-sourced) call sites, both of which wrap `addDomainEvent` in the
	 * canonical record-AFTER-mutation order (Vernon §8). Calling
	 * `addDomainEvent` directly is appropriate only after a version-advancing
	 * state mutation, or while constructing a never-persisted aggregate.
	 * An event-only commit on an already-persisted aggregate has no unique
	 * cursor and `withCommit` rejects it; use `commit(currentState, event)`.
	 */
	protected addDomainEvent(event: TEvent): void {
		this.assertMintedEvent(event);
		this._pendingEvents.push(event);
	}

	/**
	 * Immutability gate for every recording path: only events minted by
	 * the kit's constructors (`createDomainEvent`, `recordEvent`) pass,
	 * checked against the constructor's internal, unforgeable mint
	 * marker. Minted implies deeply frozen with defensively copied
	 * payload and metadata, a guarantee no frozen-ness probe can
	 * establish (a shallow-frozen literal with mutable nested data
	 * would fool it). O(1): one WeakSet lookup.
	 */
	protected assertMintedEvent(event: TEvent): void {
		if (!isMintedEvent(event)) {
			throw new UnmintedEventError((event as AnyDomainEvent).type);
		}
	}

	/**
	 * Creates a snapshot of the current aggregate state: the state at
	 * this moment plus the version. Useful for ES snapshot policies and
	 * for state-stored backup / restore.
	 *
	 * The state is converted via {@link toSnapshotState}; the default
	 * requires plain, serialisable data and fails fast otherwise.
	 *
	 * `snapshotAt` is read from this aggregate instance's immutable
	 * `DomainEventFactory`, the same clock `recordEvent` stamps
	 * `occurredAt` from. Injecting a factory through `AggregateConfig`
	 * therefore pins both timestamps in deterministic tests.
	 * `schemaVersion` is stamped from
	 * {@link snapshotSchemaVersion} so a later restore can detect
	 * snapshots written against an older `TSnapshotState` shape.
	 */
	public createSnapshot(): AggregateSnapshot<TSnapshotState> {
		return {
			state: this.toSnapshotState(this._state),
			version: this.version,
			snapshotAt: this.domainEventFactory.now(),
			schemaVersion: this.snapshotSchemaVersion,
		};
	}

	/**
	 * Schema version of the shape {@link toSnapshotState} produces.
	 * Defaults to `1`. Bump it whenever `TSnapshotState` changes
	 * incompatibly (renamed or removed fields, changed representations):
	 * `createSnapshot` stamps it onto every snapshot, and the restore
	 * paths compare it, so an outdated stored snapshot surfaces as a
	 * `SnapshotSchemaMismatchError` at restore time (or is upgraded via
	 * {@link migrateSnapshotState}) instead of crashing on the first
	 * method call much later.
	 */
	protected readonly snapshotSchemaVersion: number = 1;

	/**
	 * Resolves a stored snapshot's state against the aggregate's current
	 * snapshot schema: pass-through when the versions match (a missing
	 * `schemaVersion` counts as `1`, the pre-versioning era), otherwise
	 * routed through {@link migrateSnapshotState}. Called by both restore
	 * paths BEFORE anything is assigned, so a rejected snapshot leaves
	 * the aggregate untouched.
	 */
	protected resolveSnapshotState(
		snapshot: AggregateSnapshot<TSnapshotState>,
	): TSnapshotState {
		const storedSchemaVersion = snapshot.schemaVersion ?? 1;
		if (storedSchemaVersion === this.snapshotSchemaVersion) {
			return snapshot.state;
		}
		return this.migrateSnapshotState(snapshot.state, storedSchemaVersion);
	}

	/**
	 * Upgrade hook for snapshots written against an older
	 * `TSnapshotState` shape. Receives the stored state as `unknown`
	 * (its shape is, by definition, not the current `TSnapshotState`)
	 * plus the schema version it was written with, and returns the
	 * current shape. The default rejects with
	 * `SnapshotSchemaMismatchError`: discard-and-refold from the full
	 * event stream is the safe default strategy; override this only when
	 * upgrading in place is cheaper than refolding.
	 */
	protected migrateSnapshotState(
		_stored: unknown,
		storedSchemaVersion: number,
	): TSnapshotState {
		throw new SnapshotSchemaMismatchError({
			aggregateType: this.aggregateType,
			aggregateId: String(this.id),
			expectedSchemaVersion: this.snapshotSchemaVersion,
			actualSchemaVersion: storedSchemaVersion,
		});
	}

	/**
	 * Converts live aggregate state into the plain-data shape stored in a
	 * snapshot. The default validates that the state graph is plain,
	 * serialisable data (no class instances, functions, Promise/WeakMap/
	 * WeakSet) and then `structuredClone`s it: class instances would
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
	 * Sugar for this aggregate's `DomainEventFactory` that auto-injects `aggregateId`
	 * (from `this.id`) and `aggregateType` (from {@link aggregateType})
	 * into the event's metadata fields. This is the canonical path for
	 * recording events from inside aggregate domain methods.
	 *
	 * Downstream consumers (outbox dispatchers, projection handlers,
	 * audit logs) route by these two fields. Calling
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
	 *   and `aggregateType` are deliberately omitted, because the helper
	 *   sets them.
	 */
	protected recordEvent<E extends TEvent>(
		type: E["type"],
		payload: E["payload"],
		options?: Omit<CreateDomainEventOptions, "aggregateId" | "aggregateType">,
	): E {
		return this.domainEventFactory.create(type, payload, {
			...options,
			aggregateId: this.id,
			aggregateType: this.aggregateType,
		}) as DomainEvent<E["type"], E["payload"]> as E;
	}
}

/**
 * Walks a state graph and throws a descriptive error (with the offending
 * path) when it contains anything `structuredClone` would either reject
 * (functions, Promise/WeakMap/WeakSet) or silently degrade (class
 * instances lose their prototype and methods; Errors lose subclass
 * prototypes and custom fields; symbol-keyed properties are dropped).
 * Used by the default `toSnapshotState` so snapshot corruption surfaces
 * at snapshot time, not on the first method call after a much later
 * restore.
 *
 * Built-in detection is brand-verified via {@link isBuiltInObject}: a
 * plain object spoofing a built-in tag through `Symbol.toStringTag` is
 * walked like any other plain object, so nothing can smuggle unsafe
 * members past the guard. The plain-object walk mirrors what
 * `structuredClone` serialises: own ENUMERABLE string-keyed values
 * (non-enumerable members are deliberately excluded from serialisation
 * and are ignored here too).
 */
function assertSnapshotSafe(
	value: unknown,
	path: string,
	seen: WeakSet<object>,
): void {
	if (typeof value === "function") {
		throw new Error(
			`createSnapshot: state${path} is a function: snapshot state must be ` +
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
	if (isBuiltInObject(obj, tag)) {
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
				`createSnapshot: state${path} is a ${tag.slice(8, -1)}: it cannot ` +
					`be cloned or persisted. Override toSnapshotState()/` +
					`fromSnapshotState() to map it.`,
			);
		}
		if (tag === "[object Error]") {
			throw new Error(
				`createSnapshot: state${path} is an Error: structuredClone ` +
					`downgrades Error subclasses to plain Error and silently drops ` +
					`custom fields, so the restored value would not round-trip. ` +
					`Override toSnapshotState()/fromSnapshotState() to map it to ` +
					`plain data.`,
			);
		}
		// Remaining brand-verified built-ins are snapshot-safe atomics:
		// Date, RegExp, TypedArrays/DataView, ArrayBuffer(+Shared), and
		// Boolean/Number/String wrappers. Never walked for own keys (a
		// deep-frozen Date carries non-enumerable shadow methods that must
		// not trip the function check).
		return;
	}

	const proto = Object.getPrototypeOf(obj);
	if (proto === Object.prototype || proto === null) {
		for (const key of Reflect.ownKeys(obj)) {
			const descriptor = Object.getOwnPropertyDescriptor(obj, key);
			if (!descriptor?.enumerable) continue;
			if (typeof key === "symbol") {
				throw new Error(
					`createSnapshot: state${path} has a symbol-keyed property ` +
						`(${String(key)}): structuredClone silently drops symbol ` +
						`keys, so the snapshot would lose state. Override ` +
						`toSnapshotState()/fromSnapshotState() to map it.`,
				);
			}
			assertSnapshotSafe(
				(obj as Record<PropertyKey, unknown>)[key],
				`${path}.${key}`,
				seen,
			);
		}
		return;
	}

	// Class instances and unknown exotic objects (including anything whose
	// built-in-looking tag failed brand verification): structuredClone
	// would strip or reject them: fail fast with the path.
	const name: string = proto.constructor?.name || "anonymous class";
	throw new Error(
		`createSnapshot: state${path} is a class instance (${name}): ` +
			`structuredClone would strip its prototype and methods, producing ` +
			`a snapshot that breaks on the first method call after restore. ` +
			`Override toSnapshotState()/fromSnapshotState() to map child ` +
			`entities to plain data.`,
	);
}

/**
 * Restore/replay-target guard shared by `AggregateRoot.restoreFromSnapshot`
 * and the event-sourced replay methods (`loadFromHistory`,
 * `restoreFromSnapshotWithEvents`): a target carrying unflushed
 * `pendingEvents` throws {@link UnreplayableAggregateError} BEFORE anything
 * moves. Every restore path re-baselines the version via `markRestored`, so
 * unflushed events recorded against the old baseline would later be
 * harvested claiming a version baseline they were never part of. When the
 * discard is deliberate, discard this dirty instance and reconstitute a
 * fresh aggregate instead of mutating persistence lifecycle state publicly.
 *
 * Deliberately a module-level function, not a class method: it MUST not be
 * overridable by consumer subclasses (a no-op override would silently
 * disable the guard for all three call sites), and it checks the PUBLIC
 * `pendingEvents` getter, the same surface `withCommit` harvests.
 *
 * @internal Shared by the aggregate flavours in this package; not part of
 * the public API.
 */
export function assertRestoreTargetHasNoPendingEvents(aggregate: {
	readonly id: unknown;
	readonly pendingEvents: ReadonlyArray<unknown>;
}): void {
	const pending = aggregate.pendingEvents.length;
	if (pending > 0) {
		throw new UnreplayableAggregateError(
			String(aggregate.id),
			`it carries ${pending} unflushed pending event(s) that are not ` +
				"part of the persisted stream; discard this dirty instance and " +
				"reconstitute a fresh aggregate before restoring persisted history",
		);
	}
}
