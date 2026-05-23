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
	 * Persists the aggregate (insert or update).
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
	 * Returns all aggregates matching the filter.
	 */
	find(filter: TFilter): Promise<TAgg[]>;
}
