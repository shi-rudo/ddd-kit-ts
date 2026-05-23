/**
 * Transaction-scope abstraction.
 *
 * Wraps a block of work so it runs inside the persistence layer's native
 * transaction (Postgres `BEGIN`/`COMMIT`, Mongo session, etc.). The block
 * commits when the callback resolves and rolls back if it throws.
 *
 * This is **not** Fowler's full Unit of Work (no change tracking, no
 * registerDirty/registerNew/registerDeleted, no commit-time flush). It is
 * intentionally minimal — change tracking is the ORM's job; the library
 * stays out of it. The name `TransactionScope` is therefore more honest
 * than `UnitOfWork`.
 *
 * @example
 * ```typescript
 * await scope.transactional(async () => {
 *   const order = await repo.getByIdOrFail(orderId);
 *   order.confirm();
 *   await repo.save(order);
 * });
 * ```
 */
export interface TransactionScope {
	transactional<T>(fn: () => Promise<T>): Promise<T>;
}
