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
 *  1. `fn(ctx)` runs inside `scope.transactional(...)`; domain mutations
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
 *     the order is *causal*: events are recorded in the order the
 *     domain methods ran, and subscribers (handlers, projections,
 *     replay) MUST process them in that order. Across aggregates the
 *     order in this batch is deterministic but *not* a domain
 *     guarantee. Greg Young / Vernon IDDD §10: aggregates are
 *     independent consistency boundaries; events across them are
 *     eventually consistent. Subscribers should NOT engineer
 *     dependencies on cross-aggregate ordering; use
 *     `EventMetadata.causationId` to express true causation, or a
 *     process manager to coordinate. The in-process EventBus delivers
 *     this batch in order, sequential outbox-dispatchers preserve it
 *     too, but parallel dispatchers or message brokers may reorder
 *     across aggregates at delivery time.
 *  3. The transaction commits.
 *  4. **After** the commit, `aggregate.markPersisted(aggregate.version)`
 *     fires on each returned aggregate; only now are pending events
 *     considered flushed. Aggregates listed in the optional `deleted`
 *     marker array are the exception: their pending events are cleared
 *     directly WITHOUT `markPersisted`, so the post-save `onPersisted`
 *     hook never fires for a row that was just deleted.
 *  5. `bus.publish(events)` fires for the in-process fast path (skipped
 *     when no events or no `bus` is wired).
 *
 * Publishing AFTER commit prevents the classic "publish before commit"
 * footgun: in-process subscribers can never react to events from a
 * transaction that later rolled back. If `bus.publish` itself throws, the
 * outbox still holds the events and an outbox-dispatcher will deliver
 * them (eventual consistency).
 *
 * **A `bus.publish` failure never rejects `withCommit`.** Once the
 * transaction has committed, the write succeeded; surfacing a subscriber
 * failure as a rejection would hand the caller a use-case failure for a
 * committed write (a typical caller retries, double-executing it). The
 * in-process fast path is best-effort by design; the error is reported to
 * the optional `onPublishError(error, events)` hook (wire it to your
 * logger/metrics) and otherwise dropped; delivery is still guaranteed via
 * the outbox. The hook is an observer: if it throws, its error is
 * swallowed so the post-commit invariant holds.
 *
 * If the transaction rolls back, `markPersisted` is **not** called: the
 * aggregate keeps its pending events, so the caller can retry or discard.
 *
 * **Do not mutate an aggregate after `repository.save(...)` inside `fn`.**
 * `withCommit` cannot see what `save` wrote; the post-commit
 * `markPersisted` syncs `persistedVersion` to the CURRENT in-memory
 * version and (on `AggregateRoot`) re-baselines dirty tracking against
 * the CURRENT state. A mutation between `save` and the callback's return
 * therefore desyncs OCC (next save throws a false
 * `ConcurrencyConflictError`) — and under a partial-write repository
 * using `changedKeys`, an un-bumped mutation is silently marked clean
 * and never written. Mutate first, save last.
 *
 * **Duplicate aggregates are deduped by reference.** If the returned
 * `aggregates` array contains the same instance twice (e.g. a use
 * case touches an order via two repository references that happen to
 * resolve to the same identity-map entry), `withCommit` dedupes by
 * JavaScript object identity before harvesting. Each event lands in
 * the outbox exactly once and `markPersisted` fires exactly once. Two
 * *different* instances with the same logical id cannot be detected
 * at this layer; that is a Repository contract violation (failure to
 * maintain Fowler's Identity Map per Unit of Work). See
 * `docs/guide/repository.md` → "Identity Map: one instance per
 * aggregate per Unit of Work" for the requirement on `IRepository`
 * implementations that makes this dedupe sound.
 *
 * @example Tx-bound repos (Drizzle, Prisma, Mongo, …)
 * ```typescript
 * const result = await withCommit({ outbox, bus, scope }, async (tx) => {
 *   const orderRepository = makeOrderRepository(tx); // your factory binds tx to the repo
 *   const order = await orderRepository.getByIdOrFail(orderId);
 *   order.confirm();
 *   await orderRepository.save(order);             // pure persistence; does NOT call markPersisted
 *   return { result: order.id, aggregates: [order] };
 * });
 * ```
 */
export async function withCommit<Evt extends AnyDomainEvent, R, TCtx>(
	deps: {
		outbox: Outbox<Evt>;
		bus?: EventBus<Evt>;
		scope: TransactionScope<TCtx>;
		/**
		 * Observer for post-commit `bus.publish` failures. Called with the
		 * error and the events that were published. Must not be relied on
		 * for delivery: the outbox dispatcher is the reliable path.
		 */
		onPublishError?: (
			error: unknown,
			events: ReadonlyArray<Evt>,
		) => void;
	},
	fn: (ctx: TCtx) => Promise<{
		result: R;
		aggregates: ReadonlyArray<IAggregateRoot<Id<string>, Evt>>;
		/**
		 * Optional marker: which of `aggregates` were DELETED in this unit
		 * of work. Their pending events are harvested like any other
		 * (deletion events must reach the outbox), but the post-commit
		 * lifecycle differs: `markPersisted` is NOT called on them — it
		 * would fire the user-overridable `onPersisted` hook, whose
		 * post-save semantics (cache fill, read-model warm-up) are a lie
		 * for a row that was just deleted. Their pending events are
		 * cleared directly instead, so a later commit cannot re-emit them.
		 */
		deleted?: ReadonlyArray<IAggregateRoot<Id<string>, Evt>>;
	}>,
): Promise<R> {
	const { result, aggregates, deleted, events } = await deps.scope.transactional(
		async (ctx) => {
			const fnResult = await fn(ctx);
			// Dedupe by object identity. A use case that touches the same
			// aggregate via two repository references (same identity-map
			// entry) would otherwise double-harvest its events and call
			// markPersisted twice. Distinct instances with the same logical
			// id are NOT detected here; that's a different misuse class.
			const uniqueAggregates = Array.from(new Set(fnResult.aggregates));
			const harvested = uniqueAggregates.flatMap(
				(agg) => agg.pendingEvents,
			);
			// Guard: every event harvested from an aggregate MUST carry
			// aggregateId + aggregateType. Downstream consumers (outbox
			// dispatchers, projection handlers, audit logs) route by these
			// fields; missing them silently breaks routing. The
			// `this.recordEvent(...)` helper on AggregateRoot /
			// EventSourcedAggregate injects them automatically; this guard
			// catches the case where someone called `createDomainEvent(...)`
			// directly inside an aggregate method and forgot the options.
			for (const event of harvested) {
				const missing: string[] = [];
				if (!event.aggregateId) missing.push("aggregateId");
				if (!event.aggregateType) missing.push("aggregateType");
				if (missing.length > 0) {
					throw new Error(
						`withCommit: event "${event.type}" is missing ${missing.join(
							" and ",
						)}. ` +
							`Use this.recordEvent(type, payload) inside aggregate methods ` +
							`instead of createDomainEvent(...); recordEvent auto-injects ` +
							`aggregateId and aggregateType. Outbox dispatchers and ` +
							`projection handlers rely on these fields for routing.`,
					);
				}
			}
			if (harvested.length > 0) {
				await deps.outbox.add(harvested);
			}
			return {
				...fnResult,
				aggregates: uniqueAggregates,
				deleted: new Set(fnResult.deleted ?? []),
				events: harvested,
			};
		},
	);

	// Post-commit: mark each aggregate as persisted (clears pendingEvents).
	// Done AFTER the tx commits so a rolled-back transaction never silently
	// "consumes" the in-memory pending events. DELETED aggregates get their
	// pending events cleared without markPersisted: the row is gone, and
	// firing the post-save onPersisted hook for a deletion would hand the
	// hook a semantic lie (see the `deleted` field JSDoc above).
	for (const agg of aggregates) {
		try {
			if (deleted.has(agg)) {
				agg.clearPendingEvents();
			} else {
				agg.markPersisted(agg.version);
			}
		} catch {
			// Only the user-overridable onPersisted hook can throw here, and
			// it runs AFTER the framework cleanup (events already flushed for
			// THIS aggregate). Aborting the loop would leave the remaining
			// aggregates un-marked (double-emitting their events on the next
			// commit) and reject a committed write. Hook failures are
			// observer failures: the post-commit invariant wins.
		}
	}

	if (deps.bus && events.length > 0) {
		try {
			await deps.bus.publish(events);
		} catch (error) {
			// The tx has committed and the outbox holds the events; an
			// outbox dispatcher will deliver them. Rejecting here would turn
			// a committed write into an apparent use-case failure (callers
			// would retry and double-execute).
			try {
				deps.onPublishError?.(error, events);
			} catch {
				// Observer-only hook: its own failure must not break the
				// post-commit invariant either.
			}
		}
	}

	return result;
}
