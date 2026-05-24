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
 *
 *     **Harvest order.** Events are concatenated in the order
 *     aggregates appear in the returned `aggregates` array, then in
 *     each aggregate's `pendingEvents` order (insertion order via
 *     `apply` / `commit` / `addDomainEvent`). So `aggregates: [a, b]`
 *     with `a` emitting `[e1, e2]` and `b` emitting `[e3]` produces
 *     `outbox.add([e1, e2, e3])` and `bus.publish([e1, e2, e3])` in
 *     that exact order.
 *
 *     **Two ordering guarantees, not one.** Within a single aggregate
 *     the order is *causal* — events are recorded in the order the
 *     domain methods ran, and subscribers (handlers, projections,
 *     replay) MUST process them in that order. Across aggregates the
 *     order in this batch is deterministic but *not* a domain
 *     guarantee. Greg Young / Vernon IDDD §10: aggregates are
 *     independent consistency boundaries; events across them are
 *     eventually consistent. Subscribers should NOT engineer
 *     dependencies on cross-aggregate ordering — use
 *     `EventMetadata.causationId` to express true causation, or a
 *     process manager to coordinate. The in-process EventBus delivers
 *     this batch in order, sequential outbox-dispatchers preserve it
 *     too, but parallel dispatchers or message brokers may reorder
 *     across aggregates at delivery time.
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
