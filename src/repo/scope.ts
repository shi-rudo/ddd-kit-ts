/**
 * Transaction-scope abstraction.
 *
 * Wraps a block of work so it runs inside the persistence layer's native
 * transaction (Postgres `BEGIN`/`COMMIT`, Mongo session, Drizzle / Prisma
 * `$transaction`, etc.). The block commits when the callback resolves
 * and rolls back if it throws.
 *
 * `TCtx` is the persistence layer's transaction handle: Drizzle's `tx`,
 * Prisma's `tx`, Mongo's session, etc. The scope opens the transaction
 * and passes the handle to `fn`; the use case binds its repositories to
 * that handle (typically by constructing a tx-scoped repo from the ctx).
 *
 * No default for `TCtx`: every implementor names their context type
 * explicitly. For genuinely context-free scopes (in-memory tests, naive
 * no-tx scopes) use `TransactionScope<undefined>`: that's a conscious
 * "there is nothing meaningful here" statement, not an accidental
 * `unknown` fallback.
 *
 * Intentionally minimal: the scope itself does no change tracking and
 * no commit-time flush. Those concerns live in the layers above - the
 * aggregate detects its own changes (`changedKeys` / `hasChanges`),
 * `withCommit` orchestrates the commit lifecycle, and the opt-in
 * `UnitOfWork` facade adds tx-bound repositories and enrollment. See
 * "TransactionScope stays minimal; the Unit of Work lives above it" in
 * docs/guide/design-decisions.md.
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
 * @example Use site: bind repos to the live transaction
 * ```typescript
 * await scope.transactional(async (tx) => {
 *   // Construct tx-bound repos from ctx (your factory / DI of choice)
 *   const orderRepository = makeOrderRepository(tx);
 *
 *   const order = await orderRepository.getByIdOrFail(orderId);
 *   order.confirm();
 *   await orderRepository.save(order);
 * });
 * ```
 *
 * `IRepository`'s contract takes the id / aggregate only: the tx handle
 * is wired into a concrete repository at construction time, not threaded
 * through every call. Different ORMs have different idioms for that
 * (constructor injection, factory functions, `withTx` chains); pick one
 * and keep it consistent.
 */
/** Options passed to {@link TransactionScope.transactional}. */
export interface TransactionalOptions {
	/**
	 * Cooperative-cancellation signal forwarded from `withCommit` /
	 * `UnitOfWork.run`. The kit does not interrupt an in-flight query
	 * itself: it pre-checks `aborted` before opening the transaction and
	 * exposes the signal for the work callback to poll. A scope whose
	 * driver supports cancellation (passing the signal to the query, an
	 * interactive-transaction timeout) SHOULD honor it to abort work
	 * already in progress; scopes that ignore it stay correct, just not
	 * eagerly cancellable.
	 */
	readonly signal?: AbortSignal;
}

export interface TransactionScope<TCtx> {
	transactional<T>(
		fn: (ctx: TCtx) => Promise<T>,
		options?: TransactionalOptions,
	): Promise<T>;
}
