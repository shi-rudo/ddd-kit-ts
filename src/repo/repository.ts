import type { Id } from "../core/id";
import type { IAggregateRoot } from "../aggregate/aggregate-root";
import type { AnyDomainEvent } from "../aggregate/domain-event";

/**
 * The canonical shape of a unit-of-work-facing repository. Unlike
 * `IRepository` below (id-canonical CRUD for `withCommit`-style
 * setups), `delete` takes the AGGREGATE: the unit of work needs the
 * instance for deletion-event harvest, the identity-map tombstone, and
 * the deleted-cannot-be-resaved gate. Ids stay branded (`TId extends
 * Id<string>`) end-to-end.
 *
 * Implementing this interface is optional — the `UnitOfWork` registry
 * is structurally typed — but it is the single source of truth the
 * guide's examples and the repository contract test suite
 * (`@shirudo/ddd-kit/testing`, whose `ContractRepository` is the
 * minimal structural subset of this shape) are written against.
 */
export interface IUnitOfWorkRepository<
	TAgg extends IAggregateRoot<TId, Evt>,
	TId extends Id<string>,
	Evt extends AnyDomainEvent = AnyDomainEvent,
> {
	getById(id: TId): Promise<TAgg | null>;
	getByIdOrFail(id: TId): Promise<TAgg>;
	save(aggregate: TAgg): Promise<void>;
	delete(aggregate: TAgg): Promise<void>;
}

/**
 * Core repository contract for Aggregate Roots.
 *
 * In DDD a Repository is a "collection illusion" for aggregates: load by
 * identity, save the whole aggregate, delete by identity. Querying by
 * arbitrary criteria is a separate concern (CQRS read-side, ad-hoc bulk
 * operations) and lives on the `IQueryableRepository` extension below, so
 * write-side repositories don't have to implement query plumbing they
 * don't need.
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
	getById(id: TId): Promise<TAgg | null>;

	/**
	 * Loads an aggregate by id and throws `AggregateNotFoundError` when not
	 * found. Use this when "not found" is a programming/contract error in
	 * the calling Use Case; use `getById` when null is a valid outcome.
	 */
	getByIdOrFail(id: TId): Promise<TAgg>;

	/**
	 * Returns whether an aggregate with the given id exists. Cheaper than
	 * `getById !== null` if your storage supports `EXISTS`-style queries.
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
	 *    `setState(_, true)` / `commit()` / `apply()`. NOT the right
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
	 * Do **not** call `aggregate.markPersisted(...)` here. The library's
	 * `withCommit` orchestrator handles the post-save lifecycle (harvest
	 * pending events into the outbox, then mark persisted after commit).
	 * Calling `markPersisted` inside `save` clears pending events too early
	 * and breaks the harvest path, and is also why the Vernon/Axon/
	 * EventFlow pattern separates persistence from commit-events.
	 *
	 * If you are not using `withCommit` (custom orchestration), call
	 * `aggregate.markPersisted(aggregate.version)` yourself **after** you
	 * have harvested `aggregate.pendingEvents` for downstream dispatch.
	 */
	save(aggregate: TAgg): Promise<void>;

	/**
	 * Removes the aggregate's row by id. Pure persistence: does NOT
	 * harvest pending events from the aggregate (the contract takes
	 * only the id, so there is no aggregate to harvest from).
	 *
	 * Before reaching for `delete`, ask whether the user-facing "delete"
	 * is the right domain verb. Most are actually state transitions
	 * (*cancel*, *archive*, *close*, *deactivate*, *terminate*) with
	 * proper domain names that should be modelled as state changes plus
	 * a recorded event, not as row removal.
	 *
	 * `delete(id)` belongs in the toolkit for three distinct cases, in
	 * decreasing order of common occurrence (see
	 * `docs/guide/repository.md` → "Deletion and Domain Events" for
	 * worked examples):
	 *
	 * 1. **State transition that records an event.** The user-facing
	 *    "delete" maps to a real domain operation (e.g. `order.cancel()`,
	 *    `order.archive()`). Call `save(aggregate)`; the row stays with
	 *    a status column. `delete(id)` is never called by the use case.
	 *
	 * 2. **Hard-delete with event harvest.** The row genuinely must
	 *    vanish (regulatory purge, retention-window expiry, true
	 *    termination) *and* the disappearance is a domain fact
	 *    subscribers care about. Inside `withCommit`'s transactional
	 *    callback, record the deletion event on the aggregate, then
	 *    call `delete(id)`. Return the aggregate in the `aggregates`
	 *    array so `withCommit` harvests its pending events into the
	 *    outbox before the row is gone.
	 *
	 * 3. **Hard-delete without event.** Deletion is invisible to the
	 *    domain (abandoned-cart cleanup, expired session rows). No
	 *    subscriber cares. If the entity has identity in the ubiquitous
	 *    language, you probably want path 1 or 2 instead.
	 *
	 * In pure event-sourced systems `delete` is rarely meaningful:
	 * end-of-lifecycle there is a `Closed` / `Terminated` event in the
	 * stream, and identity persists in the event log. `delete` applies
	 * primarily to state-stored aggregates and snapshot / projection
	 * tables.
	 */
	delete(id: TId): Promise<void>;
}

/**
 * Repository extension that adds filter-based querying. `TFilter` is the
 * filter shape your persistence layer speaks: a Drizzle `SQL` expression, a
 * Prisma `WhereInput`, a MongoDB filter document, a plain
 * `(t: TAgg) => boolean` predicate for in-memory repos, or anything else.
 *
 * The library does not prescribe a Specification or query DSL: the
 * Repository implementation owns its query language. This avoids the
 * phantom-interface trap of a library-level `ISpecification<T>` with no
 * methods and lets each Repository expose the strongest possible types for
 * its storage backend.
 *
 * Aggregates that are only ever accessed by id should implement
 * `IRepository` directly and skip this extension.
 *
 * @template TAgg    - The aggregate root type
 * @template TId     - The aggregate root identifier type
 * @template TFilter - The filter shape understood by this repository
 *
 * @example
 * ```typescript
 * // In-memory repo with a predicate filter
 * type Predicate<T> = (t: T) => boolean;
 * class InMemoryOrders implements IQueryableRepository<Order, OrderId, Predicate<Order>> {
 *   // ...
 *   async find(filter: Predicate<Order>): Promise<Order[]> { ... }
 *   async findOne(filter: Predicate<Order>): Promise<Order | null> { ... }
 * }
 *
 * // Drizzle repo with a SQL expression filter
 * import type { SQL } from "drizzle-orm";
 * class DrizzleOrders implements IQueryableRepository<Order, OrderId, SQL> {
 *   // ...
 * }
 * ```
 */
export interface IQueryableRepository<
	TAgg extends IAggregateRoot<TId>,
	TId extends Id<string>,
	TFilter,
> extends IRepository<TAgg, TId> {
	/**
	 * Returns the first aggregate matching the filter, or `null` if none.
	 */
	findOne(filter: TFilter): Promise<TAgg | null>;

	/**
	 * Returns **every** aggregate matching the filter: no pagination,
	 * no cursor. For unbounded result sets, prefer a read-side projection
	 * (CQRS read model) over loading aggregates in bulk; aggregates are
	 * write-side objects and rehydrating thousands of them by id is rarely
	 * what you want. If you need pagination on the write side, declare a
	 * domain-specific paged method on your concrete repository (e.g.
	 * `findPage(filter, cursor)`): the library does not prescribe a
	 * pagination contract because cursor/offset/keyset semantics vary too
	 * much across storage backends.
	 */
	find(filter: TFilter): Promise<TAgg[]>;
}
