/**
 * Transaction-scope abstraction.
 *
 * Wraps a block of work so it runs inside the persistence layer's native
 * transaction (Postgres `BEGIN`/`COMMIT`, Mongo session, Drizzle / Prisma
 * `$transaction`, etc.). The block commits when the callback resolves
 * and rolls back if it throws.
 *
 * `TCtx` is the persistence layer's transaction handle — Drizzle's `tx`,
 * Prisma's `tx`, Mongo's session, or `unknown` for the no-context path.
 * The scope opens the transaction and passes the handle to `fn`; the use
 * case hands it down to its repositories so writes bind to that
 * transaction. Default `TCtx = unknown` keeps the no-context callers
 * compiling — they just ignore the parameter.
 *
 * This is **not** Fowler's full Unit of Work (no change tracking, no
 * `registerDirty` / `registerNew` / `registerDeleted`, no commit-time
 * flush). It is intentionally minimal — change tracking is the ORM's
 * job; the library stays out of it. The name `TransactionScope` is
 * therefore more honest than `UnitOfWork`.
 *
 * @example
 * ```typescript
 * // No-context fake (tests):
 * const scope: TransactionScope = {
 *   transactional: (fn) => fn(undefined),
 * };
 *
 * // Drizzle-flavoured:
 * class DrizzleScope implements TransactionScope<DrizzleTx> {
 *   constructor(private db: DrizzleDb) {}
 *   async transactional<T>(fn: (tx: DrizzleTx) => Promise<T>): Promise<T> {
 *     return this.db.transaction((tx) => fn(tx));
 *   }
 * }
 *
 * await scope.transactional(async (tx) => {
 *   const order = await orderRepo.getByIdOrFail(tx, orderId);
 *   order.confirm();
 *   await orderRepo.save(tx, order);
 * });
 * ```
 */
export interface TransactionScope<TCtx = unknown> {
	transactional<T>(fn: (ctx: TCtx) => Promise<T>): Promise<T>;
}
