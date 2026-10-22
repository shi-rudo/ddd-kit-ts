import type { Aggregate, Version } from "../../domain/aggregate/aggregate";
import {
	type PendingEventLifecycleCapability,
	requirePendingEventLifecycleCapability,
} from "../../domain/aggregate/pending-event-lifecycle";
import {
	type AnyDomainEvent,
	defaultDomainEventFactory,
} from "../../domain/event/domain-event";
import type { Id } from "../../domain/identity/id";
import {
	copyAggregateIdentity,
	describeAggregateIdentity,
	eventCollectionError,
} from "../../errors/kit-errors";
import { abortReason } from "../../internal/async/abort";
import {
	DEFAULT_EXECUTION_TIMEOUT_MS,
	type ExecutionContext,
	runBoundedExecution,
} from "../../internal/async/execution";
import { reportToObserver } from "../../internal/observer";
import { assertTimerDelay } from "../../internal/validate";
import type { EventCommitCandidate } from "../../messaging/committed-event";
import type { EventBus, PublishChain } from "../../messaging/event-bus/ports";
import type { OutboxWriter } from "../../messaging/outbox/ports";
import type { TransactionScope } from "../../persistence/repository/scope";
import {
	type DomainEventStampFactory,
	type SharedDomainEventStampOptions,
	stampAtRegistration,
} from "../unit-of-work/stamp-pending-events";

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
	/**
	 * The chain of the event handler that runs this commit, from
	 * `context.publishChain`. The post-commit `bus.publish` continues it, so
	 * the bus can bound a publish cycle through the commit.
	 */
	publishChain?: PublishChain;
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
		aggregate: Aggregate<Id<string>, Evt>,
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
		aggregate: Aggregate<Id<string>, Evt>,
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
	/**
	 * Stamps every pending event that is still unstamped when its aggregate is
	 * registered: the event id, the stamp time, and the metadata. Defaults to
	 * `createDomainEventFactory()`, a UUID v7 from Web Crypto random bits and
	 * the system clock. An event that is already stamped, for example by an
	 * explicit `stampPendingEvents` call, keeps its stamp.
	 */
	eventStampFactory?: DomainEventStampFactory;
	/**
	 * Stamp options that every event stamped in this commit shares, for
	 * example the correlation id of the request.
	 */
	stampOptions?: SharedDomainEventStampOptions;
}

/**
 * Invocation-scoped registration capability handed to a {@link withCommit}
 * callback. Call `registerSaved` only for an aggregate participating in the
 * repository write. `withCommit` collects every registered aggregate: a
 * registered write commits with its event collection and post-commit
 * acknowledgement. If a registered write must not commit, throw, so the
 * transaction rolls back. Registrable instances must extend
 * `StateStoredAggregate` or `EventSourcedAggregate`; structural `Aggregate`
 * lookalikes have no internal lifecycle capability and fail before commit.
 */
export interface CommitRegistration<Evt extends AnyDomainEvent> {
	registerSaved(
		aggregate: Aggregate<Id<string>, Evt>,
		options?: CommitRegistrationOptions,
	): void;
	/**
	 * Register an aggregate whose row the current transaction removes.
	 * Its events are collected and discarded after commit, but the saved-only
	 * application `onPersisted` observer is not called.
	 */
	registerRemoved(
		aggregate: Aggregate<Id<string>, Evt>,
		options?: CommitRegistrationOptions,
	): void;
}

/** OCC baseline associated with one exact commit registration. */
export interface CommitRegistrationOptions {
	/** Absent for a new aggregate; captured at load for update or removal. */
	readonly expectedVersion?: Version;
}

type CommitDisposition = "saved" | "deleted";

interface AggregateCommitRecord<Evt extends AnyDomainEvent> {
	readonly aggregate: Aggregate<Id<string>, Evt>;
	readonly eventLifecycle: PendingEventLifecycleCapability;
	readonly version: Version;
	readonly expectedVersion: Version | undefined;
	/**
	 * Version the persistence layer last confirmed for the aggregate at
	 * registration time (kit-maintained). `undefined` means the aggregate was
	 * never persisted, so any single eventful commit cursor is unique.
	 */
	readonly persistedVersion: Version | undefined;
	readonly events: ReadonlyArray<Evt>;
	disposition: CommitDisposition;
}

/**
 * True when the aggregate's live version or pending-event batch no longer
 * matches its registration-time snapshot. Shared by the duplicate-registration
 * gate and the collection-time recheck: both must reject the same divergence,
 * or events recorded after registration would be silently dropped.
 */
function registrationDiverged<Evt extends AnyDomainEvent>(
	record: AggregateCommitRecord<Evt>,
): boolean {
	const pending = record.aggregate.pendingEvents;
	return (
		record.aggregate.version !== record.version ||
		pending.length !== record.events.length ||
		record.events.some((event, index) => event !== pending[index])
	);
}

interface CommitRegistry<Evt extends AnyDomainEvent> {
	readonly registration: CommitRegistration<Evt>;
	close(): void;
	/**
	 * The records in registration order. Throws when an aggregate changed
	 * after its registration.
	 */
	records(): ReadonlyArray<AggregateCommitRecord<Evt>>;
}

/**
 * Stamps the still-unstamped pending events of one registered aggregate.
 * `operation` names the registering call in an error.
 */
export type StampAtRegistration = (
	aggregate: Aggregate<Id<string>, AnyDomainEvent>,
	operation: string,
) => void;

/** One registry per transactional callback attempt. */
function createCommitRegistry<Evt extends AnyDomainEvent>(
	stamp: StampAtRegistration,
): CommitRegistry<Evt> {
	const recordsByAggregate = new Map<
		Aggregate<Id<string>, Evt>,
		AggregateCommitRecord<Evt>
	>();
	let open = true;

	const register = (
		aggregate: Aggregate<Id<string>, Evt>,
		disposition: CommitDisposition,
		options?: CommitRegistrationOptions,
	): void => {
		if (!open) {
			throw eventCollectionError(
				"withCommit: commit registration was used after its work callback " +
					"settled. Await every repository write before leaving the callback.",
			);
		}

		const existing = recordsByAggregate.get(aggregate);
		if (existing) {
			if (existing.disposition === "deleted" && disposition === "saved") {
				throw eventCollectionError(
					`withCommit: aggregate ${describeAggregateIdentity(aggregate.aggregateIdentity)} was registered as ` +
						"saved after it was registered as deleted in the same transaction.",
				);
			}
			// Duplicate registration is idempotent by reference. An omitted
			// expectedVersion is no assertion, not an assertion of "absent":
			// only a supplied value is compared against the recorded baseline.
			if (
				options?.expectedVersion !== undefined &&
				options.expectedVersion !== existing.expectedVersion
			) {
				throw eventCollectionError(
					`withCommit: aggregate ${describeAggregateIdentity(aggregate.aggregateIdentity)} was re-registered ` +
						`with expectedVersion ${String(options.expectedVersion)}, but its ` +
						`registration recorded ${String(existing.expectedVersion)}. Duplicate ` +
						"registration must assert the same OCC baseline or none.",
				);
			}
			if (registrationDiverged(existing)) {
				throw eventCollectionError(
					`withCommit: aggregate ${describeAggregateIdentity(aggregate.aggregateIdentity)} changed after its ` +
						"commit batch was registered. Register persistence intent last.",
				);
			}
			// The widened disposition is adopted only after every check passed:
			// a rejected registerRemoved whose error the callback catches must
			// not leave a saved aggregate marked deleted, or the post-commit
			// loop would discard instead of acknowledge.
			if (disposition === "deleted") {
				existing.disposition = "deleted";
			}
			return;
		}

		const eventLifecycle = requirePendingEventLifecycleCapability(
			aggregate,
			"withCommit registration",
		);
		// Stamped before the batch is recorded: the registration records the
		// exact event objects, and the collection-time recheck compares them by
		// reference.
		stamp(aggregate, "withCommit registration");
		// The pendingEvents getter already returns a frozen copy;
		// re-copying and re-freezing it here would only duplicate the work.
		// The stamp above left no unstamped event in it.
		const events = aggregate.pendingEvents as ReadonlyArray<Evt>;
		// The kit-maintained marker, not the registration-supplied
		// expectedVersion, grounds the unique-cursor guard: it survives
		// callers who omit registration options (the documented
		// direct-withCommit style), and grounding the guard in data supplied
		// by the very caller it checks would be circular.
		const persistedVersion = eventLifecycle.persistedVersion();
		recordsByAggregate.set(aggregate, {
			aggregate,
			eventLifecycle,
			disposition,
			version: aggregate.version,
			expectedVersion: options?.expectedVersion,
			persistedVersion,
			events,
		});
	};

	return {
		registration: Object.freeze({
			registerSaved: (
				aggregate: Aggregate<Id<string>, Evt>,
				options?: CommitRegistrationOptions,
			) => register(aggregate, "saved", options),
			registerRemoved: (
				aggregate: Aggregate<Id<string>, Evt>,
				options?: CommitRegistrationOptions,
			) => register(aggregate, "deleted", options),
		}),
		close: () => {
			open = false;
		},
		records: () => {
			const records = [...recordsByAggregate.values()];
			for (const record of records) {
				// Collection-time recheck of the registration snapshot: an event
				// recorded after registerSaved but before the callback returned
				// would be excluded from the collection and silently lost by the
				// post-commit prefix acknowledgement. Divergence fails loudly
				// inside the transaction instead.
				if (registrationDiverged(record)) {
					throw eventCollectionError(
						`withCommit: aggregate ${describeAggregateIdentity(record.aggregate.aggregateIdentity)} changed ` +
							"after its commit batch was registered; events recorded after " +
							"registration are not part of the attested write and would be " +
							"silently dropped. Make domain decisions first, write, and " +
							"register last.",
					);
				}
			}
			return records;
		},
	};
}

/**
 * Helper for executing a write Use Case inside a transaction scope.
 *
 * The use-case callback receives an invocation-scoped registration capability
 * and registers the aggregates of the repository writes that completed in the
 * transaction. `withCommit` collects every registered aggregate and owns the
 * post-commit lifecycle (collection, outbox, mark-persisted, publish). An
 * aggregate that the callback only touched or constructed is not collected.
 *
 * **Trust boundary.** A registration states invocation-local intent; the kit
 * does not inspect a database write, because a generic transaction helper
 * cannot observe adapter internals. Repository code must register only writes
 * participating in this transaction. `UnitOfWork` centralizes that rule in
 * repository methods. The capability is sealed when the callback settles, so a
 * late registration fails loudly.
 *
 * Order of operations:
 *  1. `fn(ctx, registration)` runs inside `scope.transactional(...)`; domain
 *     mutations + repo writes happen here. After a repository write, the
 *     callback registers its aggregate and finally returns its result. `ctx`
 *     is whatever transaction handle the `scope` exposes (Drizzle `tx`,
 *     Prisma `tx`, Mongo session, or `undefined` for context-free scopes).
 *  2. **Still inside the transaction**, `withCommit` collects every
 *     aggregate's `pendingEvents` and writes them via `outbox.add` (so
 *     events persist atomically with the state change). Skipped when no
 *     events were recorded. Each bare domain event is composed into an
 *     `EventCommitCandidate` carrying its aggregate source and the commit
 *     facts known by the application. The outbox source atomically links
 *     that candidate to the preceding eventful commit and persists the
 *     resulting `CommittedDomainEvent`. The domain event itself is never
 *     stamped or copied.
 *
 *     **Collection order.** Events are concatenated in registration
 *     order, then in each aggregate's `pendingEvents` order (insertion
 *     order via `apply` / `commit` / `addDomainEvent`). So registering
 *     `a`, then `b`, with `a` emitting `[e1, e2]` and `b` emitting `[e3]` produces
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
 *     saved registration and discards pending events for deleted registrations.
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
 * Registration captures an exact version and event batch. Re-registering the same
 * aggregate after it changes rejects. `UnitOfWork` additionally seals the
 * adapter persistence capture and rejects later mutation before flush. For
 * direct `withCommit` use, make domain decisions first, write, and register last.
 *
 * **Duplicate registration is idempotent by reference.** Registering the same
 * instance repeatedly collects it once. A repeat call that omits `expectedVersion`
 * makes no OCC assertion; only a supplied value that contradicts the
 * registration-time baseline rejects. Each event lands in the outbox exactly once
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
 * const result = await withCommit({ outbox, bus, scope }, async (tx, registration) => {
 *   const orderRepository = makeOrderRepository(tx); // your factory binds tx to the repo
 *   const order = await orderRepository.getById(orderId);
 *   order.confirm();
 *   await persistOrder(tx, order);                 // low-level adapter write
 *   registration.registerSaved(order);             // attest the repository write
 *   return order.id;
 * });
 * ```
 */
export async function withCommit<Evt extends AnyDomainEvent, R, TCtx>(
	deps: WithCommitDeps<Evt, TCtx>,
	fn: (ctx: TCtx, registration: CommitRegistration<Evt>) => Promise<R>,
): Promise<R> {
	return withCheckedCommit<Evt, R, TCtx>(
		deps,
		async (ctx, registration) => ({ result: await fn(ctx, registration) }),
		undefined,
	);
}

/** A work result that also carries the check of its own attempt. */
export interface CheckedWorkResult<R> {
	readonly result: R;
	/**
	 * Runs inside the transaction after the outbox write, just before the
	 * commit. A check that throws rolls the transaction back.
	 */
	readonly checkBeforeCommit?: () => void;
	/**
	 * Receives the error of a step that ran after the work callback and failed
	 * inside the transaction, before the scope rolls back.
	 */
	readonly onFailureBeforeCommit?: (error: unknown) => void;
}

/**
 * {@link withCommit} with a check per attempt before the commit. The scope
 * receives `onAttemptStart` in its transactional options. The callback also
 * receives the stamping step of the registration, so that a caller that
 * records the batch before it registers can stamp first.
 */
export async function withCheckedCommit<Evt extends AnyDomainEvent, R, TCtx>(
	deps: WithCommitDeps<Evt, TCtx>,
	fn: (
		ctx: TCtx,
		registration: CommitRegistration<Evt>,
		stamp: StampAtRegistration,
	) => Promise<CheckedWorkResult<R>>,
	onAttemptStart: (() => void) | undefined,
): Promise<R> {
	const postCommitTimeoutMs =
		deps.postCommitTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;
	assertTimerDelay("withCommit", "postCommitTimeoutMs", postCommitTimeoutMs);

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

	const eventStampFactory = deps.eventStampFactory ?? defaultDomainEventFactory;
	const stamp: StampAtRegistration = (aggregate, operation) =>
		stampAtRegistration(
			aggregate,
			eventStampFactory,
			deps.stampOptions,
			operation,
		);

	const { result, commitRecords, events } = await deps.scope.transactional(
		async (ctx) => {
			const registry = createCommitRegistry<Evt>(stamp);
			let fnResult: CheckedWorkResult<R>;
			try {
				fnResult = await fn(ctx, registry.registration, stamp);
			} finally {
				// A callback can leak the capability into delayed work. Seal it as
				// soon as the callback settles so a late registration fails loudly
				// instead of being accepted after the collection snapshot.
				registry.close();
			}
			try {
				const commitRecords = registry.records();
				// Prepare each bare domain event for source finalization in the outbox.
				// The aggregate's event remains untouched and is what the in-process
				// domain bus receives.
				const candidates = commitRecords.flatMap((record) => {
					const registered = record.aggregate.aggregateIdentity;
					if (
						record.events.length > 0 &&
						record.persistedVersion !== undefined &&
						(record.version as number) <= (record.persistedVersion as number)
					) {
						throw eventCollectionError(
							`withCommit: aggregate ${describeAggregateIdentity(registered)} recorded events but ` +
								`did not advance its version beyond the persisted version ` +
								`(${String(record.persistedVersion)}). An eventful commit needs a unique ` +
								`cursor; use StateStoredAggregate.setState(currentState, event) instead ` +
								`of addDomainEvent(event) alone.`,
						);
					}
					const registeredId = registered.aggregateId;
					const registeredType = registered.aggregateType;
					return record.events.map((event, index) => {
						const commitSize = record.events.length;
						const aggregateId = event.aggregateId;
						const aggregateType = event.aggregateType;
						const missing: string[] = [];
						if (!aggregateId) missing.push("aggregateId");
						if (!aggregateType) missing.push("aggregateType");
						if (!aggregateId || !aggregateType) {
							throw eventCollectionError(
								`withCommit: event "${event.type}" is missing ${missing.join(
									" and ",
								)}. ` +
									`Use this.createEvent(type, payload) inside aggregate methods ` +
									`instead of createDomainEvent(...); createEvent auto-injects ` +
									`aggregateId and aggregateType. Outbox dispatchers and ` +
									`projection handlers rely on the envelope source.`,
								event.type,
							);
						}
						// Backstop behind the aggregate identity check of the aggregate
						// itself: the envelope source is copied from the event, so an
						// event that names another aggregate must never become this commit.
						if (
							aggregateId !== registeredId ||
							aggregateType !== registeredType
						) {
							throw eventCollectionError(
								`withCommit: event "${event.type}" belongs to ` +
									`${describeAggregateIdentity({ aggregateType, aggregateId })} but ` +
									"was registered under " +
									`${describeAggregateIdentity({ aggregateType: registeredType, aggregateId: registeredId })}. ` +
									"The aggregate base " +
									"classes attribute every event to the aggregate on every recording path; an " +
									"aggregate that does not extend them must attribute it the " +
									"same way.",
								event.type,
							);
						}
						return Object.freeze({
							event,
							source: Object.freeze({ aggregateId, aggregateType }),
							position: Object.freeze({
								aggregateVersion: record.version as number,
								commitSequence: index,
								commitSize,
							}),
						}) as EventCommitCandidate<Evt>;
					});
				});
				const endedSources = commitRecords
					.filter((record) => record.disposition === "deleted")
					.map((record) =>
						copyAggregateIdentity(record.aggregate.aggregateIdentity),
					);
				if (candidates.length > 0) {
					// The bus publishes the events of these same candidates, so the
					// outbox must not change them. A mutation of the frozen array
					// throws in strict-mode code and has no effect otherwise.
					await deps.outbox.add(Object.freeze(candidates));
				}
				if (endedSources.length > 0) {
					await deps.outbox.endEventSources(Object.freeze(endedSources));
				}
				// The caller's own check runs first, so that it names a change in
				// its own terms, with one code for every kind of change.
				fnResult.checkBeforeCommit?.();
				if (candidates.length > 0 || endedSources.length > 0) {
					// The outbox write can yield. Work that the callback did not
					// await could change a registered aggregate meanwhile, and the
					// acknowledgement would then cover state or events that were
					// never written.
					for (const record of commitRecords) {
						if (registrationDiverged(record)) {
							throw eventCollectionError(
								`withCommit: aggregate ${describeAggregateIdentity(record.aggregate.aggregateIdentity)} ` +
									"changed while its outbox write ran. Await every change " +
									"inside the work callback.",
							);
						}
					}
				}
				return {
					result: fnResult.result,
					commitRecords,
					events: candidates.map(({ event }) => event),
				};
			} catch (error) {
				fnResult.onFailureBeforeCommit?.(error);
				throw error;
			}
		},
		{ signal: deps.signal, onAttemptStart },
	);

	// Post-commit: capture the persisted versions, acknowledge every saved
	// aggregate, and discard pending events for deleted aggregates through the
	// non-exported capability.
	// Done AFTER the tx commits so a rolled-back transaction never silently
	// "consumes" the in-memory pending events. A deleted row does not trigger
	// the saved-only application observer.
	const persistedObservations: Array<{
		readonly aggregate: Aggregate<Id<string>, Evt>;
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
						publishChain: deps.publishChain,
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
