import type { AnyDomainEvent } from "../aggregate/domain-event";
import type { EventBus, Outbox } from "../events/ports";
import type { TransactionScope } from "../repo/scope";

/**
 * Helper for executing a write Use Case inside a transaction scope.
 *
 * Order of operations:
 *  1. `fn(ctx)` runs inside `scope.transactional(...)` — domain mutations
 *     + repo writes happen here. `ctx` is whatever transaction handle the
 *     `scope` exposes (Drizzle `tx`, Prisma `tx`, Mongo session, or
 *     `undefined` for context-free scopes).
 *  2. `outbox.add(events)` is also inside the transaction (skipped when
 *     the use case emits no events), so events persist atomically with
 *     the state change.
 *  3. The transaction commits.
 *  4. **After** the commit, `bus.publish(events)` fires for the
 *     in-process fast path (also skipped when the event list is empty).
 *
 * Publishing AFTER commit prevents the classic "publish before commit"
 * footgun: in-process subscribers can never react to events from a
 * transaction that later rolled back. If `bus.publish` itself fails, the
 * outbox still holds the events and an outbox-dispatcher will deliver
 * them (eventual consistency).
 *
 * @example No-context (tests / single-store flows)
 * ```typescript
 * const result = await withCommit({ outbox, bus, scope }, async () => {
 *   order.confirm();
 *   await orderRepo.save(order);
 *   return { result: order.id, events: order.domainEvents };
 * });
 * ```
 *
 * @example Tx-bound repos (Drizzle, Prisma, Mongo, …)
 * ```typescript
 * const result = await withCommit({ outbox, bus, scope }, async (tx) => {
 *   const orders = makeOrderRepo(tx); // your factory binds tx to the repo
 *   const order = await orders.getByIdOrFail(orderId);
 *   order.confirm();
 *   await orders.save(order);
 *   return { result: order.id, events: order.domainEvents };
 * });
 * ```
 */
export async function withCommit<Evt extends AnyDomainEvent, R, TCtx>(
	deps: {
		outbox: Outbox<Evt>;
		bus?: EventBus<Evt>;
		scope: TransactionScope<TCtx>;
	},
	fn: (ctx: TCtx) => Promise<{ result: R; events: ReadonlyArray<Evt> }>,
): Promise<R> {
	const { result, events } = await deps.scope.transactional(async (ctx) => {
		const fnResult = await fn(ctx);
		if (fnResult.events.length > 0) {
			await deps.outbox.add(fnResult.events);
		}
		return fnResult;
	});

	if (deps.bus && events.length > 0) {
		await deps.bus.publish(events);
	}

	return result;
}
