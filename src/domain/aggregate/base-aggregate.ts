import {
	DuplicateEventIdError,
	InvalidVersionError,
	MisaddressedEventError,
	PendingEventBatchMismatchError,
	PendingEventLimitExceededError,
	ReentrantEventRecordingError,
	UnmintedEventError,
	UnreplayableAggregateError,
} from "../../errors/kit-errors";
import { assertPositiveSafeInteger } from "../../internal/validate";
import { Entity, type EntityConfig } from "../entity/entity";
import {
	type AnyDomainEvent,
	type AnyUncommittedDomainEvent,
	adoptRecordedDomainEvent,
	adoptUncommittedDomainEvent,
	type CreateUncommittedDomainEventOptions,
	createUncommittedDomainEvent,
	isRecordedDomainEvent,
	isUncommittedDomainEvent,
	type PendingDomainEvent,
	recordDomainEvent,
	type UncommittedDomainEventOf,
} from "../event/domain-event";
import type { Id } from "../identity/id";
import { type Aggregate, toVersion, type Version } from "./aggregate";
import { registerPendingEventLifecycleCapability } from "./pending-event-lifecycle";
import {
	type PendingEventStampFactory,
	registerPendingEventRecordingCapability,
} from "./pending-event-recording";

/** Construction options shared by state-stored and event-sourced aggregates. */
export interface AggregateConfig<TState = unknown>
	extends EntityConfig<TState> {
	/**
	 * Upper bound on the pending list. A recording that would grow the list
	 * past it throws {@link PendingEventLimitExceededError} before the
	 * state moves, so the rejected decision records nothing and moves
	 * nothing. Defaults to unlimited. The limit is a modelling signal: a
	 * decision that emits hundreds of facts points at a missing aggregate
	 * boundary, not at a limit that is too low. Must be a positive safe
	 * integer when given.
	 */
	readonly maxPendingEvents?: number;
}

/**
 * Shared base for both `StateStoredAggregate` (state-stored) and
 * `EventSourcedAggregate`. Carries the lifecycle machinery that's
 * identical across the two flavours: current version, pending-event
 * tracking, the kit-internal post-commit acknowledgement capability,
 * the `markReconstituted` post-load marker, and the `createEvent` helper
 * that auto-injects `aggregateId` + `aggregateType` on every event the
 * aggregate emits. The application shell records the pending decisions
 * with `recordPendingEvents` before persistence.
 *
 * Consumers do NOT extend this class directly; extend
 * `StateStoredAggregate` for state-stored aggregates or
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
	implements Aggregate<TId, TEvent>
{
	/**
	 * The aggregate's domain type as a string, used to populate
	 * `aggregateType` on events created via {@link createEvent}.
	 *
	 * Subclasses MUST declare this as a string literal:
	 *
	 * ```ts
	 * class Order extends StateStoredAggregate<OrderState, OrderId, OrderEvent> {
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
	 * Version the persistence layer last confirmed for this instance:
	 * `undefined` until the aggregate is reconstituted (`markReconstituted`) or a
	 * commit is acknowledged. Kit-internal via the lifecycle capability; it
	 * grounds the application shell's unique-cursor guard, so an eventful
	 * commit that did not advance beyond the persisted row is rejected
	 * deterministically.
	 */
	private _persistedVersion: Version | undefined;

	private _pendingEvents: PendingDomainEvent<TEvent>[] = [];

	private readonly _maxPendingEvents: number | undefined;

	protected constructor(
		id: TId,
		initialState: TState,
		config?: AggregateConfig<TState>,
	) {
		super(id, initialState, config);
		if (config?.maxPendingEvents !== undefined) {
			assertPositiveSafeInteger(
				"Aggregate",
				"maxPendingEvents",
				config.maxPendingEvents,
			);
		}
		this._maxPendingEvents = config?.maxPendingEvents;
		registerPendingEventLifecycleCapability(this, {
			acknowledge: (events, committedVersion) => {
				this.acknowledgePendingEvents(events, committedVersion);
			},
			discardPendingEvents: (events) => {
				this.discardPendingEventsAfterDeletion(events);
			},
			persistedVersion: () => this._persistedVersion,
			pendingEventCount: () => this._pendingEvents.length,
			aggregateType: () => this.aggregateType,
		});
		registerPendingEventRecordingCapability(this, {
			record: (createStamp) => this.recordPendingDecisions(createStamp),
		});
	}

	/**
	 * Stamps every uncommitted decision in the pending list with identity
	 * and time from `createStamp`, passes an already recorded event through,
	 * and replaces the list atomically. Three guards run before the
	 * assignment: an event that no kit constructor minted is rejected
	 * ({@link UnmintedEventError}); a stamp provider that recorded a new
	 * decision on this aggregate mid-map is rejected
	 * ({@link ReentrantEventRecordingError}); and two decisions that
	 * received one eventId are rejected ({@link DuplicateEventIdError}).
	 * When a guard fires, every decision stays unrecorded.
	 */
	private recordPendingDecisions(
		createStamp: PendingEventStampFactory,
	): ReadonlyArray<AnyDomainEvent> {
		const stamped = this._pendingEvents;
		const stampedCount = stamped.length;
		const recorded: TEvent[] = stamped.map((event, index) => {
			const candidate = event as AnyDomainEvent | AnyUncommittedDomainEvent;
			if (isRecordedDomainEvent(candidate)) return candidate as TEvent;
			if (!isUncommittedDomainEvent(candidate)) {
				throw new UnmintedEventError((event as { readonly type: string }).type);
			}
			return recordDomainEvent(
				candidate,
				createStamp(candidate, index),
			) as TEvent;
		});
		// A stamp provider that triggers a new decision on this aggregate
		// grows or replaces the pending list mid-map; assigning `recorded`
		// would silently discard that decision.
		if (
			this._pendingEvents !== stamped ||
			this._pendingEvents.length !== stampedCount
		) {
			throw new ReentrantEventRecordingError(String(this.id));
		}
		// One identity per decision: a reused stamp would mint two facts
		// sharing one eventId, and idempotent consumers keyed on it would
		// silently drop one.
		const seenEventIds = new Set<string>();
		for (const event of recorded) {
			const eventId = (event as AnyDomainEvent).eventId;
			if (seenEventIds.has(eventId)) {
				throw new DuplicateEventIdError(String(this.id), eventId);
			}
			seenEventIds.add(eventId);
		}
		this._pendingEvents = recorded;
		return Object.freeze(recorded.slice()) as ReadonlyArray<AnyDomainEvent>;
	}

	private acknowledgePendingEvents(
		events: ReadonlyArray<unknown>,
		committedVersion: Version,
	): void {
		// Validate before anything moves: a rejected version leaves the
		// pending list and the marker untouched.
		const persisted = toVersion(committedVersion);
		this.stripAcknowledgedPrefix(events);
		// The next eventful commit needs a cursor beyond the version this
		// commit persisted. The caller passes the enrollment-time version:
		// syncing from the live version instead would let un-awaited
		// concurrent work that mutates the instance in the post-commit window
		// desync the marker.
		this._persistedVersion = persisted;
	}

	/**
	 * Post-commit cleanup for the deleted disposition. The row is gone, so
	 * there is no persisted version to advance: stamping the marker from the
	 * live instance would make a later legitimate re-enrollment of this
	 * instance trip the unique-cursor guard for a row that does not exist.
	 */
	private discardPendingEventsAfterDeletion(
		events: ReadonlyArray<unknown>,
	): void {
		this.stripAcknowledgedPrefix(events);
	}

	private stripAcknowledgedPrefix(events: ReadonlyArray<unknown>): void {
		if (
			events.length > this._pendingEvents.length ||
			events.some((event, index) => event !== this._pendingEvents[index])
		) {
			throw new PendingEventBatchMismatchError(
				String(this.id),
				events.length,
				this._pendingEvents.length,
			);
		}
		this._pendingEvents = this._pendingEvents.slice(events.length);
	}

	public get version(): Version {
		return this._version;
	}

	/**
	 * Read-only list of domain events recorded on this aggregate that
	 * have not yet been flushed to the outbox / persistence layer.
	 */
	public get pendingEvents(): ReadonlyArray<PendingDomainEvent<TEvent>> {
		return Object.freeze(this._pendingEvents.slice());
	}

	/**
	 * The one write path of the version: every bump and every
	 * reconstitution goes through here, so a subclass that overrides it
	 * observes every write. Rejects anything but a safe integer of at least
	 * zero. An override must not throw: the callers write the version after
	 * they validated the change, and a throw then leaves a state-stored
	 * state already moved. The event-sourced `apply()` writes the version
	 * before it moves state, so a throw there leaves nothing changed.
	 */
	protected setVersion(version: Version): void {
		this._version = toVersion(version);
	}

	/**
	 * Advances the version by one. Used by the state-stored `setState()`
	 * path and by the event-sourced `apply()` path.
	 */
	protected bumpVersion(): void {
		this.setVersion(this.nextVersion());
	}

	/** The version the next change writes; throws before anything moves. */
	protected nextVersion(): Version {
		return toVersion(this._version + 1);
	}

	/**
	 * **Lifecycle marker, Post-Load.** Sets the current version and the
	 * persisted-version marker to the stored version. Used by
	 * `reconstitute(...)` factories to assemble an in-memory aggregate
	 * from a persisted row.
	 *
	 * Three guards keep the marker honest. The instance must carry no
	 * pending decisions, because a restore on a dirty instance would later
	 * commit facts against a baseline they were never part of
	 * ({@link UnreplayableAggregateError}). The version must be a safe
	 * integer of at least zero, and it must not lie below the current
	 * version ({@link InvalidVersionError}); a catch-up replay only moves
	 * forward.
	 *
	 * The Factory-vs-Reconstitution distinction (Vernon §11) is honoured
	 * structurally: reconstitution stays inside the aggregate factory while
	 * post-commit acknowledgement belongs to application commit orchestration.
	 *
	 * If you override this, call `super.markReconstituted(version)` so the current
	 * domain version remains aligned with the reconstituted facts.
	 *
	 * @param version - The version the row currently holds in the DB
	 *
	 * @example
	 * ```ts
	 * static reconstitute(id: OrderId, state: OrderState, version: Version): Order {
	 *   const order = new Order(id, state);
	 *   order.markReconstituted(version);
	 *   return order;
	 * }
	 * ```
	 */
	protected markReconstituted(version: Version): void {
		assertReplayTargetHasNoPendingEvents(this.id, this._pendingEvents.length);
		const restored = toVersion(version);
		if (restored < this._version) {
			throw new InvalidVersionError(
				version,
				`is below the current version ${this._version}`,
			);
		}
		this.setVersion(restored);
		this._persistedVersion = restored;
	}

	/**
	 * Appends a domain event to the pending list. The event must be minted
	 * by a kit constructor; a missing `aggregateId` or `aggregateType` is
	 * stamped from this aggregate, and an address that names another
	 * aggregate throws {@link MisaddressedEventError} before anything is
	 * recorded. Each append is one fact. A decision appended twice becomes
	 * two facts with distinct ids. A recorded event that is already pending
	 * throws {@link DuplicateEventIdError}, and a list at `maxPendingEvents`
	 * throws {@link PendingEventLimitExceededError}, before anything is
	 * recorded. Prefer the higher-level `StateStoredAggregate.setState()`
	 * (state-stored) or `EventSourcedAggregate.apply()` (event-sourced) call
	 * sites, both of which wrap `addDomainEvent` in the canonical
	 * record-AFTER-mutation order (Vernon §8). Calling `addDomainEvent`
	 * directly is appropriate only after a version-advancing state mutation,
	 * or while constructing a never-persisted aggregate. An event-only commit
	 * on an already-persisted aggregate has no unique cursor and the
	 * application shell rejects it; use `setState(currentState, event)`.
	 */
	protected addDomainEvent(event: PendingDomainEvent<TEvent>): void {
		const stamped = this.addressNewEvent(event);
		this.assertEventIdsNotPending([stamped]);
		this.assertPendingCapacity(1);
		this.appendStampedEvent(stamped);
	}

	/**
	 * One identity per fact, checked before the change becomes observable:
	 * a recorded event whose `eventId` is already pending, or appears twice
	 * in one batch, throws {@link DuplicateEventIdError}. A decision has no
	 * `eventId` yet, so a stamp provider that reuses one is caught at
	 * recording instead.
	 */
	protected assertEventIdsNotPending(
		batch: readonly PendingDomainEvent<TEvent>[],
	): void {
		const pendingIds = new Set<string>();
		for (const pending of this._pendingEvents) {
			if (isRecordedDomainEvent(pending)) pendingIds.add(pending.eventId);
		}
		for (const event of batch) {
			if (!isRecordedDomainEvent(event)) continue;
			if (pendingIds.has(event.eventId)) {
				throw new DuplicateEventIdError(String(this.id), event.eventId);
			}
			pendingIds.add(event.eventId);
		}
	}

	/**
	 * The pending list stays within `maxPendingEvents`, checked before the
	 * change becomes observable: a batch that would grow the list past the
	 * limit throws {@link PendingEventLimitExceededError}. Without a limit
	 * the check is a no-op.
	 */
	protected assertPendingCapacity(added: number): void {
		const limit = this._maxPendingEvents;
		if (limit === undefined) return;
		const pending = this._pendingEvents.length;
		if (pending + added <= limit) return;
		throw new PendingEventLimitExceededError({
			aggregateType: this.aggregateType,
			aggregateId: String(this.id),
			limit,
			pending,
			added,
		});
	}

	/**
	 * Appends an event that the caller already passed through
	 * {@link addressNewEvent}. `setState()` and `apply()` stamp before the
	 * state moves and append afterwards, so the guard runs once per event.
	 */
	protected appendStampedEvent(event: PendingDomainEvent<TEvent>): void {
		this._pendingEvents.push(event);
	}

	/**
	 * Drops every pending decision. Only the event-sourced replay rollback
	 * uses it, after its guard proved the list empty before the replay
	 * began; anything present at rollback time came from the failed replay.
	 */
	protected discardPendingDecisions(): void {
		this._pendingEvents = [];
	}

	/**
	 * Address discipline for NEW facts, shared by both flavours: a
	 * present-but-foreign `aggregateId` / `aggregateType` is a wiring bug and
	 * throws {@link MisaddressedEventError}; missing fields are filled in
	 * from the aggregate, so a recorded event is always fully addressed and
	 * can never fail the harvest or the replay guard later. The mint gate
	 * runs first, so an unminted event fails before anything else. The
	 * stamped copy is frozen like the original (payload and metadata are
	 * shared, already deep-frozen by the constructors); a fully addressed
	 * event is returned as is.
	 */
	protected addressNewEvent<E extends PendingDomainEvent<TEvent>>(event: E): E {
		this.assertMintedEvent(event);
		const { aggregateId, aggregateType } = event;
		const idForeign = aggregateId !== undefined && aggregateId !== this.id;
		const typeForeign =
			aggregateType !== undefined && aggregateType !== this.aggregateType;
		if (idForeign || typeForeign) {
			throw new MisaddressedEventError({
				expected: { aggregateType: this.aggregateType, aggregateId: this.id },
				actual: { aggregateType, aggregateId },
				eventType: event.type,
			});
		}
		if (aggregateId !== undefined && aggregateType !== undefined) {
			return event;
		}
		// The spread preserves the event's structural shape; TS cannot
		// prove it against the generic, so the copy goes through the
		// event's own wider type. `aggregateId`/`aggregateType` are
		// `string | undefined` on DomainEvent; filling them in cannot
		// leave the declared shape.
		const copy = {
			...event,
			aggregateId: this.id,
			aggregateType: this.aggregateType,
		};
		const stamped: AnyDomainEvent | AnyUncommittedDomainEvent =
			isRecordedDomainEvent(event)
				? adoptRecordedDomainEvent(copy)
				: adoptUncommittedDomainEvent(copy);
		return stamped as E;
	}

	/**
	 * Mint gate for every recording path: only an event that a kit
	 * constructor produced passes. The kit marks two shapes: a recorded
	 * event carries the recorded brand (`createDomainEvent`,
	 * `createDomainEventFromFacts`) and a decision carries the uncommitted
	 * brand (`createUncommittedDomainEvent`, the aggregate `createEvent`
	 * helper). Either brand implies deeply frozen with defensively copied
	 * payload and metadata, a guarantee no frozen-ness probe can establish
	 * (a shallow-frozen literal with mutable nested data would fool it).
	 * O(1): one brand check per shape.
	 */
	protected assertMintedEvent(event: PendingDomainEvent<TEvent>): void {
		if (!isRecordedDomainEvent(event) && !isUncommittedDomainEvent(event)) {
			throw new UnmintedEventError(
				(event as AnyDomainEvent | AnyUncommittedDomainEvent).type,
			);
		}
	}

	/**
	 * Creates the immutable business fact accepted by this aggregate without
	 * reading a clock, generating an id, or attaching tracing metadata.
	 *
	 * The application shell records pending events after the domain operation
	 * and before persistence. Payload schema version stays here, next to the
	 * concrete event producer, rather than in shell-owned recording data.
	 */
	protected createEvent<E extends TEvent>(
		type: E["type"],
		payload: E["payload"],
		options?: Omit<
			CreateUncommittedDomainEventOptions,
			"aggregateId" | "aggregateType"
		>,
	): UncommittedDomainEventOf<E> {
		return createUncommittedDomainEvent(type, payload, {
			...options,
			aggregateId: this.id,
			aggregateType: this.aggregateType,
		}) as UncommittedDomainEventOf<E>;
	}
}

/**
 * Restore-target guard used by `markReconstituted` and by
 * `EventSourcedAggregate.replayHistory`: a target carrying unflushed
 * `pendingEvents` throws {@link UnreplayableAggregateError} BEFORE anything
 * moves. A restore advances the aggregate's current version, so unflushed
 * events recorded against the old version would later be harvested claiming
 * a version baseline they were never part of. When the discard is
 * deliberate, discard this dirty instance and reconstitute a fresh aggregate
 * instead of mutating persistence lifecycle state publicly.
 *
 * Deliberately a module-level function, not a class method: it MUST not be
 * overridable by consumer subclasses (a no-op override would silently
 * disable the guard at every call site). The callers pass the count of
 * the private list; the commit harvest reads the public `pendingEvents`
 * getter, so a subclass that overrides the getter changes the harvest,
 * not this guard.
 *
 * @internal Shared by the aggregate flavours in this package; not part of
 * the public API.
 */
export function assertReplayTargetHasNoPendingEvents(
	id: unknown,
	pending: number,
): void {
	if (pending > 0) {
		throw new UnreplayableAggregateError(
			String(id),
			`it carries ${pending} unflushed pending event(s) that are not ` +
				"part of the persisted stream; discard this dirty instance and " +
				"reconstitute a fresh aggregate before restoring persisted history",
		);
	}
}
