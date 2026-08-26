import type { Version } from "../../domain/aggregate/aggregate";
import type { IAggregateRoot } from "../../domain/aggregate/aggregate-root";
import {
	type PendingEventLifecycleCapability,
	requirePendingEventLifecycleCapability,
} from "../../domain/aggregate/pending-event-lifecycle";
import {
	type AnyDomainEvent,
	isMintedEvent,
	type PendingDomainEvent,
} from "../../domain/event/domain-event";
import type { Id } from "../../domain/identity/id";
import { EventHarvestError } from "../../errors/kit-errors";
import { abortReason } from "../../internal/async/abort";
import {
	DEFAULT_EXECUTION_TIMEOUT_MS,
	type ExecutionContext,
	runBoundedExecution,
} from "../../internal/async/execution";
import { reportToObserver } from "../../internal/observer";
import { assertNonNegativeFinite } from "../../internal/validate";
import type { EventCommitCandidate } from "../../messaging/committed-event";
import type { EventBus } from "../../messaging/event-bus/ports";
import type { OutboxWriter } from "../../messaging/outbox/ports";
import type { TransactionScope } from "../../persistence/repository/scope";

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
	 * Application-shell observer invoked for each successfully acknowledged
	 * saved aggregate, after every commit record has completed its internal
	 * acknowledgement attempt. Deleted aggregates do not trigger it. `version`
	 * is the commit-time value captured before any observer runs. Observer
	 * failures are reported through `onPersistError` and never turn an already
	 * committed write into an apparent failure. The execution context carries
	 * owner cancellation and the configured post-commit deadline.
	 */
	onPersisted?: (
		aggregate: IAggregateRoot<Id<string>, Evt>,
		version: Version,
		context: ExecutionContext,
	) => void | Promise<void>;
	/**
	 * Observer for post-commit persistence failures: either the internal
	 * acknowledgement/disposal step or the application-shell `onPersisted`
	 * observer. Called once per failure with the error and affected aggregate.
	 * Symmetric with {@link onPublishError}: the
	 * transaction has already committed, so the failure must NOT reject the
	 * write; without this observer it would otherwise vanish silently. The
	 * hook is an observer only: if it throws, its error is swallowed so the
	 * post-commit invariant holds, and the loop continues the remaining
	 * post-commit work.
	 */
	onPersistError?: (
		error: unknown,
		aggregate: IAggregateRoot<Id<string>, Evt>,
	) => void;
	/**
	 * Total time allotted to the complete post-commit application phase:
	 * every application observer followed by in-process bus publication shares
	 * one absolute deadline. Callbacks that have not started when the deadline is
	 * reached are skipped and reported as timeouts. Defaults to `30000`ms.
	 * Timing out or aborting these best-effort operations is reported through the
	 * matching error observer and never rejects an already committed write.
	 */
	postCommitTimeoutMs?: number;
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
 * repository write, and return every resulting token in `commits`. Omitting
 * any token rejects the transaction: an enrolled write may not commit without
 * its event harvest and post-commit acknowledgement. Enrollable instances
 * must extend `AggregateRoot` or `EventSourcedAggregate`; structural
 * `IAggregateRoot` lookalikes have no internal lifecycle capability and fail
 * before commit.
 */
export interface CommitEnrollment<Evt extends AnyDomainEvent> {
	enrollSaved(
		aggregate: IAggregateRoot<Id<string>, Evt>,
		options?: CommitEnrollmentOptions,
	): AggregateCommitToken<Evt>;
	/**
	 * Enroll an aggregate whose row is deleted by the current transaction.
	 * Its events are harvested and discarded after commit, but the saved-only
	 * application `onPersisted` observer is not called.
	 */
	enrollDeleted(
		aggregate: IAggregateRoot<Id<string>, Evt>,
		options?: CommitEnrollmentOptions,
	): AggregateCommitToken<Evt>;
}

/** OCC baseline associated with one exact commit enrollment. */
export interface CommitEnrollmentOptions {
	/** Absent for a new aggregate; captured at load for update or removal. */
	readonly expectedVersion?: Version;
}

/** The resolved value of a {@link withCommit} work callback. */
export interface WithCommitWorkResult<Evt extends AnyDomainEvent, R> {
	result: R;
	/**
	 * Commit tokens returned by the invocation's enrollment capability.
	 * Every token minted during the callback must appear at least once.
	 * Naked aggregates are intentionally not accepted: touching an aggregate
	 * does not prove that its repository write participated in the transaction.
	 */
	commits: ReadonlyArray<AggregateCommitToken<Evt>>;
}

type CommitDisposition = "saved" | "deleted";

interface AggregateCommitRecord<Evt extends AnyDomainEvent> {
	readonly aggregate: IAggregateRoot<Id<string>, Evt>;
	readonly eventLifecycle: PendingEventLifecycleCapability;
	readonly version: Version;
	readonly expectedVersion: Version | undefined;
	/**
	 * Version the persistence layer last confirmed for the aggregate at
	 * enrollment time (kit-maintained). `undefined` means the aggregate was
	 * never persisted, so any single eventful commit cursor is unique.
	 */
	readonly persistedVersion: Version | undefined;
	readonly events: ReadonlyArray<PendingDomainEvent<Evt>>;
	disposition: CommitDisposition;
}

/**
 * True when the aggregate's live version or pending-event batch no longer
 * matches its enrollment-time snapshot. Shared by the duplicate-enrollment
 * gate and the harvest-time recheck: both must reject the same divergence,
 * or events recorded after enrollment would be silently dropped.
 */
function enrollmentDiverged<Evt extends AnyDomainEvent>(
	record: AggregateCommitRecord<Evt>,
): boolean {
	const pending = record.aggregate.pendingEvents;
	return (
		record.aggregate.version !== record.version ||
		pending.length !== record.events.length ||
		record.events.some((event, index) => event !== pending[index])
	);
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
	let mintedTokenCount = 0;
	let open = true;

	const enroll = (
		aggregate: IAggregateRoot<Id<string>, Evt>,
		disposition: CommitDisposition,
		options?: CommitEnrollmentOptions,
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
			// Duplicate enrollment is idempotent by reference. An omitted
			// expectedVersion is no assertion, not an assertion of "absent":
			// only a supplied value is compared against the recorded baseline.
			if (
				options?.expectedVersion !== undefined &&
				options.expectedVersion !== record.expectedVersion
			) {
				throw new EventHarvestError(
					`withCommit: aggregate ${String(aggregate.id)} was re-enrolled ` +
						`with expectedVersion ${String(options.expectedVersion)}, but its ` +
						`enrollment recorded ${String(record.expectedVersion)}. Duplicate ` +
						"enrollment must assert the same OCC baseline or none.",
				);
			}
			if (enrollmentDiverged(record)) {
				throw new EventHarvestError(
					`withCommit: aggregate ${String(aggregate.id)} changed after its ` +
						"commit batch was enrolled. Register persistence intent last.",
				);
			}
			// The widened disposition is adopted only after every check passed:
			// a rejected enrollDeleted whose error the callback catches must
			// not leave a saved aggregate marked deleted, or the post-commit
			// loop would discard instead of acknowledge.
			if (disposition === "deleted") {
				record.disposition = "deleted";
			}
			return existing;
		}

		const eventLifecycle = requirePendingEventLifecycleCapability(
			aggregate,
			"withCommit enrollment",
		);

		const token = Object.freeze(
			Object.create(null),
		) as AggregateCommitToken<Evt>;
		// The pendingEvents getter already returns a frozen detached copy;
		// re-copying and re-freezing it here would only duplicate the work.
		const events = aggregate.pendingEvents;
		// Recorded-before-persistence is checked HERE, not only at harvest:
		// the UnitOfWork enrolls at write registration, so this rejection
		// lands before any adapter flush. The harvest guard alone fires after
		// flush, and a non-transactional event store would already have
		// appended the unstamped batch durably.
		for (const event of events) {
			if (!isMintedEvent(event)) {
				throw new EventHarvestError(
					`withCommit: event "${(event as { readonly type: string }).type}" ` +
						"has not been recorded. Call recordPendingEvents(aggregate, " +
						"createStamp) in the application shell before persistence or " +
						"outbox harvest.",
					(event as { readonly type: string }).type,
				);
			}
		}
		// The kit-maintained marker, not the enrollment-supplied
		// expectedVersion, grounds the unique-cursor guard: it survives
		// callers who omit enrollment options (the documented
		// direct-withCommit style), and grounding the guard in data supplied
		// by the very caller it checks would be circular.
		const persistedVersion = eventLifecycle.persistedVersion();
		tokensByAggregate.set(aggregate, token);
		recordsByToken.set(token, {
			aggregate,
			eventLifecycle,
			disposition,
			version: aggregate.version,
			expectedVersion: options?.expectedVersion,
			persistedVersion,
			events,
		});
		mintedTokenCount += 1;
		return token;
	};

	return {
		enrollment: Object.freeze({
			enrollSaved: (
				aggregate: IAggregateRoot<Id<string>, Evt>,
				options?: CommitEnrollmentOptions,
			) => enroll(aggregate, "saved", options),
			enrollDeleted: (
				aggregate: IAggregateRoot<Id<string>, Evt>,
				options?: CommitEnrollmentOptions,
			) => enroll(aggregate, "deleted", options),
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
				// Harvest-time recheck of the enrollment snapshot: an event
				// recorded after enrollSaved but before the callback returned
				// would be excluded from the harvest and silently lost by the
				// post-commit prefix acknowledgement. Divergence fails loudly
				// inside the transaction instead.
				if (enrollmentDiverged(record)) {
					throw new EventHarvestError(
						`withCommit: aggregate ${String(record.aggregate.id)} changed ` +
							"after its commit batch was enrolled; events recorded after " +
							"enrollment are not part of the attested write and would be " +
							"silently dropped. Make domain decisions first, write, and " +
							"enroll last.",
					);
				}
				records.push(record);
			}
			if (seen.size !== mintedTokenCount) {
				throw new EventHarvestError(
					"withCommit: every token minted by the current enrollment " +
						"capability must be returned in `commits`. If an enrolled write " +
						"must not commit, throw so the transaction rolls back.",
				);
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
 * in the transaction. `withCommit` owns the post-commit lifecycle (harvest,
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
 *  4. **After** the commit, a non-exported capability acknowledges every
 *     saved enrollment and discards pending events for deleted enrollments.
 *     Only after the complete commit set is clean does the optional
 *     application-shell `onPersisted(aggregate, version, context)` observer run for
 *     saved aggregates. Deleted rows never trigger that observer.
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
 * The complete application-observer and bus-publication phase shares one
 * absolute `postCommitTimeoutMs` budget (30 seconds by default); later callbacks
 * are not started once it expires. A timeout or owner abort is reported
 * through the same observer paths and never changes the committed result.
 *
 * If the transaction rolls back, no acknowledgement occurs: the aggregate
 * keeps its pending events, so the caller can retry or discard the instance.
 *
 * Enrollment captures an exact version and event batch. Re-enrolling the same
 * aggregate after it changes rejects. `UnitOfWork` additionally seals the
 * adapter persistence projection and rejects later mutation before flush. For
 * direct `withCommit` use, make domain decisions first, write, and enroll last.
 *
 * **Duplicate enrollment is idempotent by reference.** Enrolling the same
 * instance repeatedly returns the same token, and a repeated token in
 * `commits` is harvested once. A repeat call that omits `expectedVersion`
 * makes no OCC assertion; only a supplied value that contradicts the
 * enrollment-time baseline rejects. Each event lands in the outbox exactly once
 * and post-commit acknowledgement runs exactly once. Two
 * *different* instances with the same logical id cannot be detected
 * at this layer; that is a Repository contract violation (failure to
 * maintain Fowler's Identity Map per Unit of Work). See
 * `docs/guide/repository.md` → "Identity Map: one instance per
 * aggregate per Unit of Work" for the requirement on repository
 * implementations that makes this dedupe sound.
 *
 * @example Tx-bound repos (Drizzle, Prisma, Mongo, …)
 * ```typescript
 * const result = await withCommit({ outbox, bus, scope }, async (tx, enrollment) => {
 *   const orderRepository = makeOrderRepository(tx); // your factory binds tx to the repo
 *   const order = await orderRepository.getById(orderId);
 *   order.confirm();
 *   await persistOrder(tx, order);                 // low-level adapter write
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
	const postCommitTimeoutMs =
		deps.postCommitTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;
	assertNonNegativeFinite(
		"withCommit",
		"postCommitTimeoutMs",
		postCommitTimeoutMs,
	);

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

	const { result, commitRecords, events } = await deps.scope.transactional(
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
			// Prepare each bare domain event for source finalization in the outbox.
			// The aggregate's event remains untouched and is what the in-process
			// domain bus receives.
			const candidates = commitRecords.flatMap((record) => {
				const agg = record.aggregate;
				if (
					record.events.length > 0 &&
					record.persistedVersion !== undefined &&
					(record.version as number) <= (record.persistedVersion as number)
				) {
					throw new EventHarvestError(
						`withCommit: aggregate ${String(agg.id)} recorded events but ` +
							`did not advance its version beyond the persisted version ` +
							`(${String(record.persistedVersion)}). An eventful commit needs a unique ` +
							`cursor; use AggregateRoot.commit(currentState, event) instead ` +
							`of addDomainEvent(event) alone.`,
					);
				}
				return record.events.map((event, index) => {
					if (!isMintedEvent(event)) {
						throw new EventHarvestError(
							`withCommit: event "${event.type}" has not been recorded. ` +
								"Call recordPendingEvents(aggregate, createStamp) in the " +
								"application shell before persistence or outbox harvest.",
							event.type,
						);
					}
					const recordedEvent = event as Evt;
					const commitSize = record.events.length;
					const aggregateId = recordedEvent.aggregateId;
					const aggregateType = recordedEvent.aggregateType;
					const missing: string[] = [];
					if (!aggregateId) missing.push("aggregateId");
					if (!aggregateType) missing.push("aggregateType");
					if (!aggregateId || !aggregateType) {
						throw new EventHarvestError(
							`withCommit: event "${recordedEvent.type}" is missing ${missing.join(
								" and ",
							)}. ` +
								`Use this.createEvent(type, payload) inside aggregate methods ` +
								`instead of createDomainEvent(...); createEvent auto-injects ` +
								`aggregateId and aggregateType. Outbox dispatchers and ` +
								`projection handlers rely on the envelope source.`,
							recordedEvent.type,
						);
					}
					// Backstop behind the aggregate's own address check: the
					// envelope source is copied from the event, so an event that
					// names another aggregate must never become this commit.
					const enrolledType = record.eventLifecycle.aggregateType();
					if (
						aggregateId !== String(agg.id) ||
						aggregateType !== enrolledType
					) {
						throw new EventHarvestError(
							`withCommit: event "${recordedEvent.type}" is addressed to ` +
								`${aggregateType} ${aggregateId} but was enrolled under ` +
								`${enrolledType} ${String(agg.id)}. The aggregate base ` +
								"classes stamp the address on every recording path; an " +
								"instance from another package copy must stamp it the " +
								"same way.",
							recordedEvent.type,
						);
					}
					return Object.freeze({
						event: recordedEvent,
						source: Object.freeze({ aggregateId, aggregateType }),
						position: Object.freeze({
							aggregateVersion: record.version as number,
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
				commitRecords,
				events: candidates.map(({ event }) => event),
			};
		},
		{ signal: deps.signal },
	);

	// Post-commit: capture the persisted versions, acknowledge every saved
	// aggregate, and discard pending events for deleted aggregates through the
	// non-exported capability.
	// Done AFTER the tx commits so a rolled-back transaction never silently
	// "consumes" the in-memory pending events. A deleted row does not trigger
	// the saved-only application observer.
	const persistedObservations: Array<{
		readonly aggregate: IAggregateRoot<Id<string>, Evt>;
		readonly version: Version;
	}> = [];
	for (const {
		aggregate,
		eventLifecycle,
		disposition,
		version,
		events: committedEvents,
	} of commitRecords) {
		try {
			if (disposition === "deleted") {
				eventLifecycle.discardPendingEvents(committedEvents);
			} else {
				eventLifecycle.acknowledge(committedEvents, version);
				persistedObservations.push({ aggregate, version });
			}
		} catch (error) {
			// An aggregate can still be made hostile at runtime, for example by
			// freezing it after construction. The transaction has committed, so
			// continue cleaning peers and report the failed acknowledgement rather
			// than rejecting a successful write or double-emitting peer events.
			reportToObserver(() => deps.onPersistError?.(error, aggregate));
		}
	}

	// Application observers run only after every commit record has completed
	// its acknowledgement attempt, and only for successful acknowledgements.
	// A slow or failing observer can therefore never prevent peer cleanup. Each
	// observer receives the version captured before any observer ran, so an
	// earlier callback cannot rewrite a later callback's commit receipt.
	const postCommitDeadlineAt = Date.now() + postCommitTimeoutMs;
	const onPersisted = deps.onPersisted;
	if (onPersisted) {
		for (const { aggregate, version } of persistedObservations) {
			try {
				await runBoundedExecution(
					"withCommit.onPersisted",
					{ signal: deps.signal, deadlineAt: postCommitDeadlineAt },
					(context) => onPersisted(aggregate, version, context),
				);
			} catch (error) {
				reportToObserver(() => deps.onPersistError?.(error, aggregate));
			}
		}
	}

	const bus = deps.bus;
	if (bus && events.length > 0) {
		try {
			await runBoundedExecution(
				"withCommit.bus.publish",
				{ signal: deps.signal, deadlineAt: postCommitDeadlineAt },
				(context) =>
					bus.publish(events, {
						signal: context.signal,
						timeoutMs: Math.max(0, context.deadlineAt - Date.now()),
					}),
			);
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
