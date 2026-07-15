import type { IAggregateRoot } from "../aggregate/aggregate-root";
import type { AnyDomainEvent } from "../aggregate/domain-event";
import type { Id } from "../core/id";

/**
 * The canonical shape of a unit-of-work-facing repository: the minimal
 * subset of `IRepository` below (which adds `exists`). Since v3 both
 * interfaces share ONE delete contract: `delete` takes the AGGREGATE,
 * because deletion-event harvest, the identity-map tombstone, the
 * deleted-cannot-be-resaved gate, and an OCC predicate all need the
 * instance, which a bare id cannot provide. Ids stay branded
 * (`TId extends Id<string>`) end-to-end.
 *
 * Implementing this interface is optional (the `UnitOfWork` registry
 * is structurally typed), but it is the single source of truth the
 * guide's examples and the repository contract test suite
 * (`@shirudo/ddd-kit/testing`, whose `ContractRepository` is the
 * minimal structural subset of this shape) are written against.
 */
export interface IUnitOfWorkRepository<
	TAgg extends IAggregateRoot<TId, Evt>,
	TId extends Id<string>,
	Evt extends AnyDomainEvent = AnyDomainEvent,
> {
	findById(id: TId): Promise<TAgg | null>;
	getById(id: TId): Promise<TAgg>;
	save(aggregate: TAgg): Promise<void>;
	delete(aggregate: TAgg): Promise<void>;
}

/**
 * Core repository contract for Aggregate Roots.
 *
 * In DDD a Repository is a "collection illusion" for aggregates: load by
 * identity, save the whole aggregate, delete the whole aggregate.
 * Querying by arbitrary criteria is a separate concern. Consumer applications
 * declare domain-specific repository ports for command-side lookups, while UI,
 * search, reporting, and other read-heavy access belongs on query/read-model
 * ports. The kit deliberately does not ship a generic query repository: a
 * persistence-native filter would reverse dependency ownership, while bounds,
 * ordering, uniqueness, and continuation semantics belong to each consumer's
 * use case.
 *
 * Repositories work exclusively with Aggregate Root Entities. The Aggregate
 * Root represents the aggregate externally and is the only object that can
 * be loaded or saved through repositories. When loading, all child entities
 * and value objects inside the aggregate are loaded too; when saving, the
 * whole aggregate is persisted as a unit.
 *
 * @template TAgg - The aggregate root type (must implement IAggregateRoot)
 * @template TId  - The type of the aggregate root identifier
 */
export interface IRepository<
	TAgg extends IAggregateRoot<TId>,
	TId extends Id<string>,
> {
	/**
	 * Loads an aggregate by id. Returns `null` when not found.
	 */
	findById(id: TId): Promise<TAgg | null>;

	/**
	 * Loads an aggregate by id and throws `AggregateNotFoundError` when not
	 * found. Use this when "not found" is a programming/contract error in
	 * the calling Use Case; use `findById` when null is a valid outcome.
	 */
	getById(id: TId): Promise<TAgg>;

	/**
	 * Returns whether an aggregate with the given id exists. Cheaper than
	 * `findById !== null` if your storage supports `EXISTS`-style queries.
	 */
	exists(id: TId): Promise<boolean>;

	/**
	 * Persists the aggregate (insert or update). Implementations are
	 * responsible for **persistence only**; they must NOT touch the
	 * aggregate's in-memory state:
	 *
	 *  1. Throw `ConcurrencyConflictError` from `@shirudo/ddd-kit` when the
	 *     aggregate's expected version does not match the version currently
	 *     stored (optimistic concurrency).
	 *  2. Write the aggregate to durable storage.
	 *
	 * **Insert vs update: the `persistedVersion` convention.** Every aggregate
	 * exposes two version fields with distinct roles:
	 *
	 *  - `aggregate.version`: in-memory post-mutation value, bumped by
	 *    `setState()` / `commit()` / `apply()`. NOT the right
	 *    routing key, because mutations can advance it past zero while
	 *    the DB row still does not exist.
	 *  - `aggregate.persistedVersion`: what the persistence layer holds.
	 *    `undefined` until the aggregate has been persisted or restored
	 *    at least once. This is the routing key.
	 *
	 *  - `aggregate.persistedVersion === undefined` → **INSERT** (never
	 *    persisted; write succeeds unconditionally or fails the unique
	 *    constraint on `id`).
	 *  - otherwise → **UPDATE** with the OCC predicate
	 *    `WHERE id = ? AND version = aggregate.persistedVersion` (the
	 *    load-time / last-save baseline, not the post-mutation in-memory
	 *    value). If the row count is `0`, another writer raced you:
	 *    throw `ConcurrencyConflictError`.
	 *
	 * The aggregate exposes no lifecycle mutation methods. `withCommit` or
	 * `UnitOfWork` holds the internal capability that acknowledges a saved
	 * aggregate only after pending events were harvested and the surrounding
	 * transaction committed. Custom orchestration must wrap one of those
	 * application boundaries rather than trying to clear events in `save`.
	 */
	save(aggregate: TAgg): Promise<void>;

	/**
	 * Removes the aggregate's row. Since v3 the delete contract is
	 * unified with `IUnitOfWorkRepository`: the parameter is the
	 * AGGREGATE, because deletion-event harvest, the identity-map
	 * tombstone, and an OCC predicate on `persistedVersion` all need the
	 * instance, which a bare id cannot provide.
	 *
	 * Pure persistence: remove the row (predicated on
	 * `aggregate.persistedVersion` when the domain cares about
	 * delete-vs-update races); in unit-of-work repositories also call
	 * `session.enrollDeleted(aggregate)`. Event harvest stays the
	 * orchestrator's job: with plain `withCommit`, return the opaque token
	 * from `enrollment.enrollDeleted(aggregate)` in `commits`.
	 *
	 * Before reaching for `delete`, ask whether the user-facing "delete"
	 * is the right domain verb. Most are actually state transitions
	 * (*cancel*, *archive*, *close*, *deactivate*, *terminate*) with
	 * proper domain names that should be modelled as state changes plus
	 * a recorded event, not as row removal.
	 *
	 * `delete(aggregate)` belongs in the toolkit for three distinct
	 * cases, in decreasing order of common occurrence (see
	 * `docs/guide/repository.md` → "Deletion and Domain Events" for
	 * worked examples):
	 *
	 * 1. **State transition that records an event.** The user-facing
	 *    "delete" maps to a real domain operation (e.g. `order.cancel()`,
	 *    `order.archive()`). Call `save(aggregate)`; the row stays with
	 *    a status column. `delete` is never called by the use case.
	 *
	 * 2. **Hard-delete with event harvest.** The row genuinely must
	 *    vanish (regulatory purge, retention-window expiry, true
	 *    termination) *and* the disappearance is a domain fact
	 *    subscribers care about. Commit the deletion event on the
	 *    aggregate, then call `delete(aggregate)` inside the same
	 *    transactional callback. The commit must advance the version so
	 *    the event has a unique projection cursor.
	 *
	 * 3. **Hard-delete without event.** Deletion is invisible to the
	 *    domain (a single abandoned cart, an expired session row). No
	 *    subscriber cares. If the entity has identity in the ubiquitous
	 *    language, you probably want path 1 or 2 instead.
	 *
	 * **Id-only BULK cleanup deliberately has no port method:** loading
	 * aggregates one by one just to delete them at scale is waste. Keep
	 * infrastructure maintenance in an adapter-owned maintenance component.
	 * If an application use case invokes that capability, declare a separate,
	 * consumer-owned driven port such as
	 * `ExpiredAggregatePurger.purgeExpired(before)`; do not make the use case
	 * depend on a concrete repository class. This port stays an
	 * aggregate-lifecycle contract.
	 *
	 * In pure event-sourced systems `delete` is rarely meaningful:
	 * end-of-lifecycle there is a `Closed` / `Terminated` event in the
	 * stream, and identity persists in the event log. `delete` applies
	 * primarily to state-stored aggregates and snapshot / projection
	 * tables.
	 */
	delete(aggregate: TAgg): Promise<void>;
}
