/**
 * Transaction-scope abstraction.
 *
 * Wraps a block of work so it runs inside the persistence layer's native
 * transaction (Postgres `BEGIN`/`COMMIT`, Mongo session, Drizzle / Prisma
 * `$transaction`, etc.). The block commits when the callback resolves
 * and rolls back if it throws.
 *
 * `TCtx` is the persistence layer's transaction handle — Drizzle's `tx`,
 * Prisma's `tx`, Mongo's session, etc. The scope opens the transaction
 * and passes the handle to `fn`; the use case binds its repositories to
 * that handle (typically by constructing a tx-scoped repo from the ctx).
 *
 * No default for `TCtx`: every implementor names their context type
 * explicitly. For genuinely context-free scopes (in-memory tests, naive
 * no-tx scopes) use `TransactionScope<undefined>` — that's a conscious
 * "there is nothing meaningful here" statement, not an accidental
 * `unknown` fallback.
 *
 * Intentionally **not** Fowler's full Unit of Work (no change tracking,
 * no `registerDirty` / `registerNew` / `registerDeleted`, no commit-time
 * flush). Change tracking is the ORM's job.
 *
 * @example Drizzle implementation
 * ```typescript
 * class DrizzleScope implements TransactionScope<DrizzleTx> {
 *   constructor(private db: DrizzleDb) {}
 *   async transactional<T>(fn: (tx: DrizzleTx) => Promise<T>): Promise<T> {
 *     return this.db.transaction((tx) => fn(tx));
 *   }
 * }
 * ```
 *
 * @example Use site — bind repos to the live transaction
 * ```typescript
 * await scope.transactional(async (tx) => {
 *   // Construct tx-bound repos from ctx (your factory / DI of choice)
 *   const orders = makeOrderRepo(tx);
 *
 *   const order = await orders.getByIdOrFail(orderId);
 *   order.confirm();
 *   await orders.save(order);
 * });
 * ```
 *
 * `IRepository`'s contract takes the id / aggregate only — the tx handle
 * is wired into a concrete repository at construction time, not threaded
 * through every call. Different ORMs have different idioms for that
 * (constructor injection, factory functions, `withTx` chains); pick one
 * and keep it consistent.
 */
export interface TransactionScope<TCtx> {
	transactional<T>(fn: (ctx: TCtx) => Promise<T>): Promise<T>;
}
