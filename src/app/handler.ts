import type { EventBus, Outbox } from "../events/ports";
import type { TransactionScope } from "../repo/scope";

/**
 * Helper for executing a write Use Case inside a transaction scope.
 *
 * Order of operations:
 *  1. `fn(ctx)` runs inside `scope.transactional(...)` — domain mutations
 *     + repo writes happen here, with `ctx` being the persistence layer's
 *     transaction handle (Drizzle `tx`, Prisma `tx`, Mongo session,
 *     `unknown` for the no-context path).
 *  2. `outbox.add(events)` is also inside the transaction, so events
 *     persist atomically with the state change (outbox pattern).
 *  3. The transaction commits.
 *  4. **After** the commit, `bus.publish(events)` fires for the in-process
 *     fast path.
 *
 * Publishing AFTER commit prevents the classic "publish before commit"
 * footgun: in-process subscribers can never react to events from a
 * transaction that later rolled back. If `bus.publish` itself fails, the
 * outbox still holds the events and an outbox-dispatcher will deliver them
 * (eventual consistency).
 *
 * The `TCtx` generic flows from the supplied `scope` into `fn`'s
 * parameter, so Use Cases that need to bind to the live transaction handle
 * type-safely receive it without an `as` cast.
 *
 * @example
 * ```typescript
 * // No-context (e.g. tests): just ignore the ctx parameter.
 * const result = await withCommit({ outbox, bus, scope }, async () => {
 *   order.confirm();
 *   await repository.save(order);
 *   return { result: order.id, events: order.domainEvents };
 * });
 *
 * // Drizzle-flavoured: ctx is the live tx; thread it through to the repos.
 * const result = await withCommit({ outbox, bus, scope }, async (tx) => {
 *   const order = await orderRepo.getByIdOrFail(tx, orderId);
 *   order.confirm();
 *   await orderRepo.save(tx, order);
 *   return { result: order.id, events: order.domainEvents };
 * });
 * ```
 */
export async function withCommit<
	Evt extends { type: string },
	R,
	TCtx = unknown,
>(
	deps: {
		outbox: Outbox<Evt>;
		bus?: EventBus<Evt>;
		scope: TransactionScope<TCtx>;
	},
	fn: (ctx: TCtx) => Promise<{ result: R; events: ReadonlyArray<Evt> }>,
): Promise<R> {
	const { result, events } = await deps.scope.transactional(async (ctx) => {
		const fnResult = await fn(ctx);
		await deps.outbox.add(fnResult.events);
		return fnResult;
	});

	if (deps.bus) {
		await deps.bus.publish(events);
	}

	return result;
}
