import type { InfrastructureError } from "../../core/errors";
import type { IAggregateRoot, Version } from "../../domain/aggregate/aggregate";
import type { AnyDomainEvent } from "../../domain/event/domain-event";
import type { Id } from "../../domain/identity/id";
import type {
	AggregateClass,
	IdentityMap,
} from "../../persistence/repository/identity-map";
import type {
	PersistenceChanges,
	PersistenceModel,
} from "../../persistence/repository/persistence-model";

/** The explicit persistence intent registered for one tracked aggregate. */
export type AggregateWriteIntent = "add" | "update" | "remove";

/**
 * @internal Shared with the repository facade in this package; not part
 * of the public API.
 */
export interface RuntimePersistenceDefinition<Evt extends AnyDomainEvent> {
	readonly aggregate: AggregateClass<IAggregateRoot<Id<string>, Evt>>;
	readonly persistence: PersistenceModel<
		IAggregateRoot<Id<string>, Evt>,
		unknown,
		unknown
	>;
	readonly flush: (
		transaction: unknown,
		write: AggregatePersistenceWrite<IAggregateRoot<Id<string>, Evt>, unknown>,
	) => void | Promise<void>;
	readonly mapError: (
		error: unknown,
		write: AggregatePersistenceWrite<IAggregateRoot<Id<string>, Evt>, unknown>,
	) => InfrastructureError;
	readonly physicalRemoval?: boolean;
}

/** Read-only Identity Map operations available to repository adapters. */
export type UnitOfWorkIdentityMap = Pick<
	IdentityMap,
	"get" | "has" | "isDeleted"
>;

/**
 * Repository-specific tracking capability handed only to its adapter.
 *
 * Read paths call {@link RepositoryTracking.trackLoaded} before returning a
 * restored aggregate.
 * Write methods exposed to application code are replaced by Unit-of-Work-owned
 * `add`, `update`, and `remove` registrations, so an adapter implementation of
 * those methods cannot perform durable I/O early or skip event harvesting.
 *
 * Contract for repository implementations:
 * - `findById(id)` checks `identityMap.get` BEFORE hydrating, treats
 *   `identityMap.isDeleted` as not-found (`undefined`), and returns
 *   `tracking.trackLoaded(aggregate)` after hydration. This captures the
 *   expected version before application code can mutate the instance.
 * - Adapter objects do not need lifecycle methods; the facade installs the
 *   Unit-of-Work-owned `add`, `update`, and optional `remove`. If a concrete
 *   adapter has same-named methods anyway, the facade masks them.
 * - Other repository methods are reads. A custom method that performs a write
 *   would bypass the Unit of Work and violates the adapter contract.
 */
export interface RepositoryTracking<
	TAggregate extends IAggregateRoot<Id<string>, AnyDomainEvent>,
> {
	/**
	 * Registers an aggregate restored by a repository before returning it to
	 * application code. The Unit of Work identity-maps the instance and captures
	 * its current version as the optimistic-concurrency expectation.
	 */
	trackLoaded(aggregate: TAggregate): TAggregate;

	/**
	 * Read-only view of the per-operation Identity Map (Fowler): one aggregate type+id,
	 * one in-memory instance. Created fresh per `run()`, cleared on
	 * close; accessing it after close throws
	 * {@link TransactionClosedError}.
	 */
	readonly identityMap: UnitOfWorkIdentityMap;
}

/**
 * Immutable adapter input for one registered aggregate write.
 *
 * `expectedVersion` is captured when a loaded aggregate joins the Unit of
 * Work and is absent for `add`. `version`, `changes`, and `events` describe
 * the exact moment at which the application registered its write intent.
 * Adapters must use the expected/current version pair for their OCC predicate
 * and must not read mutable write state back from an aggregate reference.
 */
export interface AggregatePersistenceWrite<
	TAggregate extends IAggregateRoot<Id<string>, AnyDomainEvent>,
	TChangeSet,
> {
	readonly intent: AggregateWriteIntent;
	readonly aggregateId: TAggregate["id"];
	readonly expectedVersion: Version | undefined;
	readonly version: Version;
	readonly changes: PersistenceChanges<TChangeSet>;
	readonly events: TAggregate["pendingEvents"];
}
