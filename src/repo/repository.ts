import type { IAggregateRoot } from "../aggregate/aggregate-root";
import type { Id } from "../core/id";

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
	TAggregate extends IAggregateRoot<TId>,
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
	 * The Unit of Work uses the version captured when the aggregate was loaded as
	 * the expected version. Passing an aggregate that is not tracked as loaded is
	 * a lifecycle error. The method returns after registration; durable I/O
	 * happens during flush.
	 */
	update(aggregate: TAggregate): void;
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
	TAggregate extends IAggregateRoot<TId>,
	TId extends Id<string>,
> extends AggregatePersistence<TAggregate, TId> {
	/**
	 * Registers a tracked aggregate for physical removal at commit.
	 *
	 * The Unit of Work retains optimistic-concurrency and pending-event
	 * information until removal and its event/outbox batch commit atomically.
	 */
	remove(aggregate: TAggregate): void;
}
