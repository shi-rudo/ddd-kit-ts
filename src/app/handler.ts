import type { IAggregateRoot } from "../aggregate/aggregate-root";
import type { AnyDomainEvent } from "../aggregate/domain-event";
import { EventHarvestError } from "../core/errors";
import type { Id } from "../core/id";
import type {
	EventCommitCandidate,
	EventBus,
	OutboxWriter,
} from "../events/ports";
import type { TransactionScope } from "../repo/scope";
import { abortReason } from "../utils/abort";
import { reportToObserver } from "../utils/observer";

/** Dependencies for {@link withCommit}. */
export interface WithCommitDeps<Evt extends AnyDomainEvent, TCtx> {
	/**
	 * The write half of the outbox: `withCommit` only ever calls `add()`.
	 * Pass a full `Outbox` for the kit's poll-based dispatch, or a bare
	 * `OutboxWriter` backed by an external delivery solution.
	 *
	 * Required on purpose, while `bus` is optional: the bus is the
	 * best-effort in-process fast path, the outbox is the delivery
	 * guarantee. Running without delivery reliability is a decision, not
	 * a default; make it explicit with
	 * `outboxWriterAcceptingEventLoss()`.
	 */
	outbox: OutboxWriter<Evt>;
	bus?: EventBus<Evt>;
	scope: TransactionScope<TCtx>;
	/**
	 * Observer for post-commit `bus.publish` failures. Called with the
	 * error and the events that were published. Must not be relied on
	 * for delivery: the outbox dispatcher is the reliable path.
	 */
	onPublishError?: (error: unknown, events: ReadonlyArray<Evt>) => void;
	/**
	 * Observer for post-commit persistence-cleanup failures: a throw from
	 * `markPersisted`, the user-overridable `onPersisted` hook, or
	 * `clearPendingEvents`. Called once per failing aggregate with the
	 * error and that aggregate. Symmetric with {@link onPublishError}: the
	 * transaction has already committed, so the failure must NOT reject the
	 * write; without this observer it would otherwise vanish silently. The
	 * hook is an observer only: if it throws, its error is swallowed so the
	 * post-commit invariant holds, and the loop continues marking the
	 * remaining aggregates.
	 */
	onPersistError?: (
		error: unknown,
		aggregate: IAggregateRoot<Id<string>, Evt>,
	) => void;
	/**
	 * Cooperative-cancellation signal. If already aborted, `withCommit`
	 * rejects with the signal's `reason` BEFORE opening the transaction.
	 * Otherwise the signal is forwarded to `scope.transactional`, where a
	 * cancellation-aware scope can abort an in-flight query. The kit does
	 * not race the work promise: aborting does not kill a running query
	 * unless the scope honors the signal.
	 */
	signal?: AbortSignal;
}

/** The resolved value of a {@link withCommit} work callback. */
export interface WithCommitWorkResult<Evt extends AnyDomainEvent, R> {
	result: R;
	aggregates: ReadonlyArray<IAggregateRoot<Id<string>, Evt>>;
	/**
	 * Optional marker: which of `aggregates` were DELETED in this unit
	 * of work. Must be a SUBSET of `aggregates` (enforced inside the
	 * transaction with `EventHarvestError`: a deleted aggregate missing
	 * from `aggregates` would lose its deletion events silently).
	 * Their pending events are harvested like any other
	 * (deletion events must reach the outbox), but the post-commit
	 * lifecycle differs: `markPersisted` is NOT called on them. It
	 * would fire the user-overridable `onPersisted` hook, whose
	 * post-save semantics (cache fill, read-model warm-up) are a lie
	 * for a row that was just deleted. Their pending events are
	 * cleared directly instead, so a later commit cannot re-emit them.
	 */
	deleted?: ReadonlyArray<IAggregateRoot<Id<string>, Evt>>;
}

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
	 *     events were recorded. Each bare domain event is composed into an
	 *     `EventCommitCandidate` carrying its aggregate source and the commit
	 *     facts known by the application. The outbox source atomically links
	 *     that candidate to the preceding eventful commit and persists the
	 *     resulting `CommittedDomainEvent`. The domain event itself is never
	 *     stamped or copied.
 *
 *     **Harvest order.** Events are concatenated in the order
 *     aggregates appear in the returned `aggregates` array, then in
 *     each aggregate's `pendingEvents` order (insertion order via
 *     `apply` / `commit` / `addDomainEvent`). So `aggregates: [a, b]`
 *     with `a` emitting `[e1, e2]` and `b` emitting `[e3]` produces
 *     `outbox.add([envelope(e1), envelope(e2), envelope(e3)])` and
 *     `bus.publish([e1, e2, e3])` in that exact order.
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
 * `ConcurrencyConflictError`); and under a partial-write repository
 * using `changedKeys`, an un-bumped mutation is silently marked clean
 * and never written. The commit envelope widens the blast radius further:
 * it would claim a position the committed row does not carry, poisoning
 * every consumer's ordering and idempotency watermarks. Mutate first,
 * save last.
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
 *   const order = await orderRepository.getById(orderId);
 *   order.confirm();
 *   await orderRepository.save(order);             // pure persistence; does NOT call markPersisted
 *   return { result: order.id, aggregates: [order] };
 * });
 * ```
 */
export async function withCommit<Evt extends AnyDomainEvent, R, TCtx>(
	deps: WithCommitDeps<Evt, TCtx>,
	fn: (ctx: TCtx) => Promise<WithCommitWorkResult<Evt, R>>,
): Promise<R> {
	// Pre-flight: an already-aborted caller never opens a transaction.
	// Throwing the signal's reason matches the web AbortSignal convention;
	// the `??` fallback mirrors event-bus.ts and guards a non-spec polyfill
	// whose `reason` is undefined (a bare `throw undefined` is unusable).
	if (deps.signal?.aborted) {
		throw abortReason(
			deps.signal,
			"withCommit aborted before opening a transaction",
		);
	}

	const { result, aggregates, deleted, events } =
		await deps.scope.transactional(
			async (ctx) => {
				const fnResult = await fn(ctx);
				// Dedupe by object identity. A use case that touches the same
				// aggregate via two repository references (same identity-map
				// entry) would otherwise double-harvest its events and call
				// markPersisted twice. Distinct instances with the same logical
				// id are NOT detected here; that's a different misuse class.
				const uniqueAggregates = Array.from(new Set(fnResult.aggregates));
				// Subset guard: `deleted` is a MARKER over `aggregates`, not a
				// second harvest source. A deleted aggregate missing from
				// `aggregates` would have its deletion events silently lost
				// (never harvested into the outbox) and double-emitted by a
				// later commit; fail inside the transaction like the other
				// harvest guards so nothing commits.
				const aggregateSet = new Set(uniqueAggregates);
				for (const deletedAggregate of fnResult.deleted ?? []) {
					if (!aggregateSet.has(deletedAggregate)) {
						throw new EventHarvestError(
							"withCommit: an aggregate in `deleted` is not listed in " +
								"`aggregates`. The harvest only reads `aggregates`, so " +
								"its deletion events would be silently dropped. List " +
								"every deleted aggregate in BOTH arrays.",
						);
					}
				}
				// Prepare each bare domain event for source finalization in the outbox.
				// The aggregate's event remains untouched and is what the in-process
				// domain bus receives.
				const candidates = uniqueAggregates.flatMap((agg) => {
					if (
						agg.pendingEvents.length > 0 &&
						agg.persistedVersion !== undefined &&
						(agg.version as number) <= (agg.persistedVersion as number)
					) {
						throw new EventHarvestError(
							`withCommit: aggregate ${String(agg.id)} recorded events but ` +
								`did not advance its version beyond persistedVersion ` +
								`(${agg.persistedVersion}). An eventful commit needs a unique ` +
								`cursor; use AggregateRoot.commit(currentState, event) instead ` +
								`of addDomainEvent(event) alone.`,
						);
					}
					return agg.pendingEvents.map((event, index) => {
						const commitSize = agg.pendingEvents.length;
						const aggregateId = event.aggregateId;
						const aggregateType = event.aggregateType;
						const missing: string[] = [];
						if (!aggregateId) missing.push("aggregateId");
						if (!aggregateType) missing.push("aggregateType");
						if (!aggregateId || !aggregateType) {
							throw new EventHarvestError(
								`withCommit: event "${event.type}" is missing ${missing.join(
									" and ",
								)}. ` +
									`Use this.recordEvent(type, payload) inside aggregate methods ` +
									`instead of createDomainEvent(...); recordEvent auto-injects ` +
									`aggregateId and aggregateType. Outbox dispatchers and ` +
									`projection handlers rely on the envelope source.`,
								event.type,
							);
						}
						return Object.freeze({
							event,
							source: Object.freeze({ aggregateId, aggregateType }),
							position: Object.freeze({
								aggregateVersion: agg.version as number,
								commitSequence: index,
								commitSize,
							}),
						}) as EventCommitCandidate<Evt>;
					});
				});
				if (candidates.length > 0) {
					await deps.outbox.add(candidates);
				}
				return {
					...fnResult,
					aggregates: uniqueAggregates,
					deleted: new Set(fnResult.deleted ?? []),
					events: candidates.map(({ event }) => event),
				};
			},
			{ signal: deps.signal },
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
		} catch (error) {
			// Only the user-overridable onPersisted hook can throw here, and
			// it runs AFTER the framework cleanup (events already flushed for
			// THIS aggregate). Aborting the loop would leave the remaining
			// aggregates un-marked (double-emitting their events on the next
			// commit) and reject a committed write. Hook failures are
			// observer failures: the post-commit invariant wins. Report the
			// failure to onPersistError instead of dropping it silently
			// (symmetric with the onPublishError path below); a throwing OR
			// async-rejecting observer is neutralised so it cannot break the
			// invariant either.
			reportToObserver(() => deps.onPersistError?.(error, agg));
		}
	}

	if (deps.bus && events.length > 0) {
		try {
			await deps.bus.publish(events);
		} catch (error) {
			// The tx has committed and the outbox holds the events; an
			// outbox dispatcher will deliver them. Rejecting here would turn
			// a committed write into an apparent use-case failure (callers
			// would retry and double-execute). A throwing OR async-rejecting
			// observer is neutralised so it cannot break the invariant either.
			reportToObserver(() => deps.onPublishError?.(error, events));
		}
	}

	return result;
}
