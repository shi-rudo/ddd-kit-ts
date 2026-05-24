import type { Id } from "../core/id";
import type { IAggregateRoot } from "../aggregate/aggregate-root";

/**
 * Core repository contract for Aggregate Roots.
 *
 * In DDD a Repository is a "collection illusion" for aggregates: load by
 * identity, save the whole aggregate, delete by identity. Querying by
 * arbitrary criteria is a separate concern (CQRS read-side, ad-hoc bulk
 * operations) and lives on the `IQueryableRepository` extension below — so
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
	 * responsible for **persistence only** — they must NOT touch the
	 * aggregate's in-memory state:
	 *
	 *  1. Throw `ConcurrencyConflictError` from `@shirudo/ddd-kit` when the
	 *     aggregate's expected version does not match the version currently
	 *     stored (optimistic concurrency).
	 *  2. Write the aggregate to durable storage.
	 *
	 * **Insert vs update — library convention.** A fresh aggregate begins
	 * at `version === 0` (the `Version` brand defaults to `0` in both
	 * `AggregateRoot` and `EventSourcedAggregate`). After the first
	 * versioned mutation (`setState(_, true)`, `apply()`, `commit()`) the
	 * version is `> 0`. Implementations distinguish the two paths by the
	 * incoming `aggregate.version`:
	 *
	 *  - `aggregate.version === 0` → **INSERT** (no existing row to lock
	 *    against; the write succeeds unconditionally or fails the unique
	 *    constraint on `id`).
	 *  - `aggregate.version  >  0` → **UPDATE** with the OCC predicate
	 *    `WHERE id = ? AND version = expected`. If the row count is `0`,
	 *    another writer raced you — throw `ConcurrencyConflictError`.
	 *
	 * The library does not formalise this in the type system because
	 * version-bump semantics differ across the two aggregate flavours
	 * (state-stored aggregates bump on the user's call to `setState(_,
	 * true)`; event-sourced aggregates bump on every `apply()` by
	 * definition). The `version === 0` invariant for "never persisted" is
	 * the common contract.
	 *
	 * Do **not** call `aggregate.markPersisted(...)` here. The library's
	 * `withCommit` orchestrator handles the post-save lifecycle (harvest
	 * pending events into the outbox, then mark persisted after commit).
	 * Calling `markPersisted` inside `save` clears pending events too early
	 * and breaks the harvest path — and is also why the Vernon/Axon/
	 * EventFlow pattern separates persistence from commit-events.
	 *
	 * If you are not using `withCommit` (custom orchestration), call
	 * `aggregate.markPersisted(aggregate.version)` yourself **after** you
	 * have harvested `aggregate.pendingEvents` for downstream dispatch.
	 */
	save(aggregate: TAgg): Promise<void>;

	/**
	 * Removes the aggregate by id.
	 */
	delete(id: TId): Promise<void>;
}

/**
 * Repository extension that adds filter-based querying. `TFilter` is the
 * filter shape your persistence layer speaks: a Drizzle `SQL` expression, a
 * Prisma `WhereInput`, a MongoDB filter document, a plain
 * `(t: TAgg) => boolean` predicate for in-memory repos, or anything else.
 *
 * The library does not prescribe a Specification or query DSL — the
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
	 * Returns **every** aggregate matching the filter — no pagination,
	 * no cursor. For unbounded result sets, prefer a read-side projection
	 * (CQRS read model) over loading aggregates in bulk; aggregates are
	 * write-side objects and rehydrating thousands of them by id is rarely
	 * what you want. If you need pagination on the write side, declare a
	 * domain-specific paged method on your concrete repository (e.g.
	 * `findPage(filter, cursor)`) — the library does not prescribe a
	 * pagination contract because cursor/offset/keyset semantics vary too
	 * much across storage backends.
	 */
	find(filter: TFilter): Promise<TAgg[]>;
}
