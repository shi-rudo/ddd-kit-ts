import type { Aggregate, Version } from "../../domain/aggregate/aggregate";
import type { AnyDomainEvent } from "../../domain/event/domain-event";
import type { Id } from "../../domain/identity/id";

/**
 * The version that the Unit of Work captured when it loaded the aggregate.
 *
 * Use it as the `expectedVersion` of a write whose decision used only the
 * state that this run loaded. It is the wrong value when a person or another
 * system made the decision on an earlier read. Such a write expects the
 * version of that read.
 */
export const versionAtLoad: unique symbol = Symbol("versionAtLoad");

/** What an update or a removal expects of the stored aggregate. */
export interface WriteExpectation {
	/**
	 * The version that the store must hold when the write lands: the
	 * {@link Version} that the caller saw, or {@link versionAtLoad}.
	 *
	 * The Unit of Work compares a `Version` with the version that it loaded.
	 * If they differ, the registration throws `ExpectedVersionMismatchError`.
	 */
	readonly expectedVersion: Version | typeof versionAtLoad;
}

/**
 * The persistence operations shared by every aggregate repository.
 *
 * This is a reusable building block for consumer-owned driven ports. A
 * Bounded Context can extend it with intent-revealing lookups without making
 * adapter-native filters or reporting queries part of the write model.
 *
 * Writes are persistence-oriented and participate in the active Unit of Work.
 * `add` and `update` register explicit lifecycle intent; they do not commit or
 * perform durable I/O before the Unit of Work flushes. That distinction keeps
 * duplicate creation, optimistic concurrency, and adapter routing explicit.
 *
 * Physical removal is deliberately absent. Event-sourced and retained
 * aggregates often have no meaningful hard-delete operation. Use
 * {@link Repository} when the persistence boundary genuinely supports it.
 *
 * @template TAggregate - Aggregate root loaded and registered by the port.
 * @template TId - Branded aggregate identifier.
 */
export interface AggregatePersistence<
	TAggregate extends Aggregate<TId, AnyDomainEvent>,
	TId extends Id<string>,
> {
	/**
	 * Finds an aggregate by identity.
	 *
	 * Absence is an expected branch and is represented by `undefined`. A found
	 * aggregate joins the active Unit of Work and must be identity-mapped there.
	 */
	findById(id: TId): Promise<TAggregate | undefined>;

	/**
	 * Gets an aggregate by identity.
	 *
	 * Implementations throw `AggregateNotFoundError` when the aggregate does not
	 * exist. A returned aggregate joins the active Unit of Work exactly like a
	 * value returned from {@link AggregatePersistence.findById}.
	 */
	getById(id: TId): Promise<TAggregate>;

	/**
	 * Registers a newly created aggregate for insertion at commit.
	 *
	 * Use this exactly once for an aggregate that was created in the current Unit
	 * of Work. Passing an aggregate loaded from persistence is a lifecycle error.
	 * The method returns after registration; durable I/O happens during flush.
	 */
	add(aggregate: TAggregate): void;

	/**
	 * Registers a loaded aggregate for an optimistic-concurrency update.
	 *
	 * The caller states the expected version. The flush writes only if the
	 * store holds that version. Passing an aggregate that is not tracked as
	 * loaded is a lifecycle error. The method returns after registration;
	 * durable I/O happens during flush.
	 */
	update(aggregate: TAggregate, expectation: WriteExpectation): void;
}

/**
 * Full collection-style repository contract for aggregate roots whose
 * persistence boundary supports physical removal.
 *
 * `remove` is persistence cleanup, not a business decision. User-facing
 * deletion normally belongs in aggregate behavior with domain language such as
 * `cancel`, `archive`, `close`, or `revoke`, followed by
 * {@link AggregatePersistence.update}. Extend this contract only when the row
 * or document itself may genuinely disappear.
 *
 * Consumer applications still own their concrete driven ports. For example,
 * `OrderRepository extends Repository<Order, OrderId>` may add a lookup needed
 * by an order command, while read-heavy access remains on a projection or query
 * port.
 */
export interface Repository<
	TAggregate extends Aggregate<TId, AnyDomainEvent>,
	TId extends Id<string>,
> extends AggregatePersistence<TAggregate, TId> {
	/**
	 * Registers a tracked aggregate for physical removal at commit.
	 *
	 * The caller states the expected version, as for
	 * {@link AggregatePersistence.update}. The Unit of Work retains
	 * optimistic-concurrency and pending-event information until removal and
	 * its event/outbox batch commit atomically.
	 */
	remove(aggregate: TAggregate, expectation: WriteExpectation): void;
}
