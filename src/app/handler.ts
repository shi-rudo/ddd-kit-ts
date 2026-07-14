import type { IAggregateRoot } from "../aggregate/aggregate-root";
import type { AnyDomainEvent } from "../aggregate/domain-event";
import { EventHarvestError } from "../core/errors";
import type { Id } from "../core/id";
import type {
	EventBus,
	EventCommitCandidate,
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

declare const aggregateCommitTokenBrand: unique symbol;

/**
 * Opaque receipt that one aggregate was explicitly enrolled in the current
 * {@link withCommit} invocation. Tokens are minted only by the invocation's
 * {@link CommitEnrollment} capability and are bound to that invocation at
 * runtime; a forged token or one retained from an earlier call is rejected
 * inside the transaction.
 */
export interface AggregateCommitToken<
	Evt extends AnyDomainEvent = AnyDomainEvent,
> {
	readonly [aggregateCommitTokenBrand]: Evt;
}

/**
 * Invocation-scoped enrollment capability handed to a {@link withCommit}
 * callback. Call `enrollSaved` only for an aggregate participating in the
 * repository write, and return the resulting token in `commits`.
 */
export interface CommitEnrollment<Evt extends AnyDomainEvent> {
	enrollSaved(
		aggregate: IAggregateRoot<Id<string>, Evt>,
	): AggregateCommitToken<Evt>;
	/**
	 * Enroll an aggregate whose row is deleted by the current transaction.
	 * Its events are harvested, but post-commit cleanup clears them without
	 * calling `markPersisted` or the post-save `onPersisted` hook.
	 */
	enrollDeleted(
		aggregate: IAggregateRoot<Id<string>, Evt>,
	): AggregateCommitToken<Evt>;
}

/** The resolved value of a {@link withCommit} work callback. */
export interface WithCommitWorkResult<Evt extends AnyDomainEvent, R> {
	result: R;
	/**
	 * Commit tokens returned by the invocation's enrollment capability.
	 * Naked aggregates are intentionally not accepted: touching an aggregate
	 * does not prove that its repository write participated in the transaction.
	 */
	commits: ReadonlyArray<AggregateCommitToken<Evt>>;
}

type CommitDisposition = "saved" | "deleted";

interface AggregateCommitRecord<Evt extends AnyDomainEvent> {
	readonly aggregate: IAggregateRoot<Id<string>, Evt>;
	disposition: CommitDisposition;
}

interface CommitTokenScope<Evt extends AnyDomainEvent> {
	readonly enrollment: CommitEnrollment<Evt>;
	close(): void;
	resolve(tokens: unknown): ReadonlyArray<AggregateCommitRecord<Evt>>;
}

/** One token registry per transactional callback attempt. */
function createCommitTokenScope<
	Evt extends AnyDomainEvent,
>(): CommitTokenScope<Evt> {
	const recordsByToken = new WeakMap<object, AggregateCommitRecord<Evt>>();
	const tokensByAggregate = new WeakMap<
		IAggregateRoot<Id<string>, Evt>,
		AggregateCommitToken<Evt>
	>();
	let open = true;

	const enroll = (
		aggregate: IAggregateRoot<Id<string>, Evt>,
		disposition: CommitDisposition,
	): AggregateCommitToken<Evt> => {
		if (!open) {
			throw new EventHarvestError(
				"withCommit: commit enrollment was used after its work callback " +
					"settled. Await every repository write and return its token before " +
					"leaving the callback.",
			);
		}

		const existing = tokensByAggregate.get(aggregate);
		if (existing) {
			const record = recordsByToken.get(existing);
			if (!record) {
				throw new EventHarvestError(
					"withCommit: internal commit-token registry is inconsistent.",
				);
			}
			if (record.disposition === "deleted" && disposition === "saved") {
				throw new EventHarvestError(
					`withCommit: aggregate ${String(aggregate.id)} was enrolled as ` +
						"saved after it was enrolled as deleted in the same transaction.",
				);
			}
			if (disposition === "deleted") {
				record.disposition = "deleted";
			}
			return existing;
		}

		const token = Object.freeze(
			Object.create(null),
		) as AggregateCommitToken<Evt>;
		tokensByAggregate.set(aggregate, token);
		recordsByToken.set(token, { aggregate, disposition });
		return token;
	};

	return {
		enrollment: Object.freeze({
			enrollSaved: (aggregate: IAggregateRoot<Id<string>, Evt>) =>
				enroll(aggregate, "saved"),
			enrollDeleted: (aggregate: IAggregateRoot<Id<string>, Evt>) =>
				enroll(aggregate, "deleted"),
		}),
		close: () => {
			open = false;
		},
		resolve: (tokens) => {
			if (!Array.isArray(tokens)) {
				throw new EventHarvestError(
					"withCommit: the work callback must return `commits` containing " +
						"tokens from the current enrollment capability. Naked aggregate " +
						"arrays are not commit evidence.",
				);
			}

			const seen = new Set<object>();
			const records: AggregateCommitRecord<Evt>[] = [];
			for (const token of tokens) {
				if (
					token === null ||
					(typeof token !== "object" && typeof token !== "function")
				) {
					throw new EventHarvestError(
						"withCommit: a commit token was not minted by this callback's " +
							"enrollment capability. Forged and stale tokens are rejected.",
					);
				}
				const tokenObject = token as object;
				const record = recordsByToken.get(tokenObject);
				if (!record) {
					throw new EventHarvestError(
						"withCommit: a commit token was not minted by this callback's " +
							"enrollment capability. Forged and stale tokens are rejected.",
					);
				}
				if (seen.has(tokenObject)) continue;
				seen.add(tokenObject);
				records.push(record);
			}
			return records;
		},
	};
}

/**
 * Helper for executing a write Use Case inside a transaction scope.
 *
 * The use-case callback receives an invocation-scoped enrollment capability
 * and returns opaque commit tokens for the repository writes that completed
 * in the transaction. `withCommit` owns the post-save lifecycle (harvest,
 * outbox, mark-persisted, publish). A naked aggregate is not commit evidence:
 * merely touching or constructing one must never make it look persisted.
 *
 * **Trust boundary.** A token proves invocation-local enrollment, not that the
 * kit inspected a database write; a generic transaction helper cannot observe
 * adapter internals. Repository code must enroll only writes participating in
 * this transaction. `UnitOfWork` centralizes that rule in repository methods.
 * The opaque, scoped token prevents accidental aggregate smuggling and stale
 * reuse; it is not a security boundary against code that deliberately lies to
 * its own persistence capability.
 *
 * Order of operations:
 *  1. `fn(ctx, enrollment)` runs inside `scope.transactional(...)`; domain
 *     mutations + repo writes happen here. After a repository write has
 *     enrolled an aggregate, the callback includes that opaque token in its
 *     `commits` result. Tokens are invocation-bound: forged or stale tokens
 *     fail before harvest. `ctx` is whatever transaction handle the `scope`
 *     exposes (Drizzle `tx`, Prisma `tx`, Mongo session, or `undefined` for
 *     context-free scopes).
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
 *     tokens appear in the returned `commits` array, then in
 *     each aggregate's `pendingEvents` order (insertion order via
 *     `apply` / `commit` / `addDomainEvent`). So tokens for `[a, b]`
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
 *     fires on each saved enrollment; only now are pending events considered
 *     flushed. Deleted enrollments are the exception: their pending events
 *     are cleared directly WITHOUT `markPersisted`, so the post-save
 *     `onPersisted` hook never fires for a row that was just deleted.
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
 * **Duplicate enrollment is idempotent by reference.** Enrolling the same
 * instance repeatedly returns the same token, and a repeated token in
 * `commits` is harvested once. Each event lands in the outbox exactly once
 * and `markPersisted` fires exactly once. Two
 * *different* instances with the same logical id cannot be detected
 * at this layer; that is a Repository contract violation (failure to
 * maintain Fowler's Identity Map per Unit of Work). See
 * `docs/guide/repository.md` → "Identity Map: one instance per
 * aggregate per Unit of Work" for the requirement on `IRepository`
 * implementations that makes this dedupe sound.
 *
 * @example Tx-bound repos (Drizzle, Prisma, Mongo, …)
 * ```typescript
 * const result = await withCommit({ outbox, bus, scope }, async (tx, enrollment) => {
 *   const orderRepository = makeOrderRepository(tx); // your factory binds tx to the repo
 *   const order = await orderRepository.getById(orderId);
 *   order.confirm();
 *   await orderRepository.save(order);             // pure persistence; does NOT call markPersisted
 *   const commit = enrollment.enrollSaved(order);   // attest the repository write
 *   return { result: order.id, commits: [commit] };
 * });
 * ```
 */
export async function withCommit<Evt extends AnyDomainEvent, R, TCtx>(
	deps: WithCommitDeps<Evt, TCtx>,
	fn: (
		ctx: TCtx,
		enrollment: CommitEnrollment<Evt>,
	) => Promise<WithCommitWorkResult<Evt, R>>,
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
				const tokenScope = createCommitTokenScope<Evt>();
				let fnResult: WithCommitWorkResult<Evt, R>;
				try {
					fnResult = await fn(ctx, tokenScope.enrollment);
				} finally {
					// A callback can leak the capability into delayed work. Seal it as
					// soon as the callback settles so a late enrollment fails loudly
					// instead of being accepted after the harvest snapshot.
					tokenScope.close();
				}
				const commitRecords = tokenScope.resolve(fnResult.commits);
				const uniqueAggregates = commitRecords.map(
					({ aggregate }) => aggregate,
				);
				const deletedAggregates = new Set(
					commitRecords
						.filter(({ disposition }) => disposition === "deleted")
						.map(({ aggregate }) => aggregate),
				);
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
					result: fnResult.result,
					aggregates: uniqueAggregates,
					deleted: deletedAggregates,
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
