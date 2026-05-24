import type { IAggregateRoot } from "../aggregate/aggregate-root";
import type { AnyDomainEvent } from "../aggregate/domain-event";
import type { Id } from "../core/id";
import type { EventBus, Outbox } from "../events/ports";
import type { TransactionScope } from "../repo/scope";

/**
 * Helper for executing a write Use Case inside a transaction scope.
 *
 * The use-case callback returns the aggregates it touched; `withCommit`
 * owns the post-save lifecycle (harvest, outbox, mark-persisted, publish).
 * This matches the Vernon / Axon / EventFlow unit-of-work pattern:
 * `Repository.save` is pure persistence; "this aggregate has been
 * committed" is the orchestrator's call to make, not the repo's.
 *
 * Order of operations:
 *  1. `fn(ctx)` runs inside `scope.transactional(...)` — domain mutations
 *     + repo writes happen here. `ctx` is whatever transaction handle the
 *     `scope` exposes (Drizzle `tx`, Prisma `tx`, Mongo session, or
 *     `undefined` for context-free scopes).
 *  2. **Still inside the transaction**, `withCommit` harvests every
 *     aggregate's `pendingEvents` and writes them via `outbox.add` (so
 *     events persist atomically with the state change). Skipped when no
 *     events were recorded.
 *  3. The transaction commits.
 *  4. **After** the commit, `aggregate.markPersisted(aggregate.version)`
 *     fires on each returned aggregate — only now are pending events
 *     considered flushed.
 *  5. `bus.publish(events)` fires for the in-process fast path (skipped
 *     when no events or no `bus` is wired).
 *
 * Publishing AFTER commit prevents the classic "publish before commit"
 * footgun: in-process subscribers can never react to events from a
 * transaction that later rolled back. If `bus.publish` itself throws, the
 * outbox still holds the events and an outbox-dispatcher will deliver
 * them (eventual consistency).
 *
 * If the transaction rolls back, `markPersisted` is **not** called — the
 * aggregate keeps its pending events, so the caller can retry or discard.
 *
 * @example Tx-bound repos (Drizzle, Prisma, Mongo, …)
 * ```typescript
 * const result = await withCommit({ outbox, bus, scope }, async (tx) => {
 *   const orderRepository = makeOrderRepository(tx); // your factory binds tx to the repo
 *   const order = await orderRepository.getByIdOrFail(orderId);
 *   order.confirm();
 *   await orderRepository.save(order);             // pure persistence — does NOT call markPersisted
 *   return { result: order.id, aggregates: [order] };
 * });
 * ```
 */
export async function withCommit<Evt extends AnyDomainEvent, R, TCtx>(
	deps: {
		outbox: Outbox<Evt>;
		bus?: EventBus<Evt>;
		scope: TransactionScope<TCtx>;
	},
	fn: (ctx: TCtx) => Promise<{
		result: R;
		aggregates: ReadonlyArray<IAggregateRoot<Id<string>, Evt>>;
	}>,
): Promise<R> {
	const { result, aggregates, events } = await deps.scope.transactional(
		async (ctx) => {
			const fnResult = await fn(ctx);
			const harvested = fnResult.aggregates.flatMap(
				(agg) => agg.pendingEvents,
			);
			if (harvested.length > 0) {
				await deps.outbox.add(harvested);
			}
			return { ...fnResult, events: harvested };
		},
	);

	// Post-commit: mark each aggregate as persisted (clears pendingEvents).
	// Done AFTER the tx commits so a rolled-back transaction never silently
	// "consumes" the in-memory pending events.
	for (const agg of aggregates) {
		agg.markPersisted(agg.version);
	}

	if (deps.bus && events.length > 0) {
		await deps.bus.publish(events);
	}

	return result;
}
