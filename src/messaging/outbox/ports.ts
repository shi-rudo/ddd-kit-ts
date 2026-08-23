import type { AnyDomainEvent } from "../../domain/event/domain-event";
import type { ExecutionContext } from "../../utils/execution";
import type {
	CommittedDomainEvent,
	EventCommitCandidate,
} from "../committed-event";

/**
 * One pending event in the outbox plus the opaque id the implementation
 * needs to ack it via `markDispatched`. The library does not prescribe
 * what `dispatchId` looks like: an implementation can reuse the event's
 * own `eventId`, generate its own UUID, use the row's auto-increment
 * primary key, or whatever the storage layer prefers.
 */
export interface OutboxRecord<Evt extends AnyDomainEvent>
	extends CommittedDomainEvent<Evt> {
	dispatchId: string;

	/**
	 * Failed delivery attempts so far. Populated by implementations that
	 * track dispatch failures (see {@link DispatchTrackingOutbox});
	 * plain `Outbox` implementations may omit it.
	 */
	attempts?: number;
}

/** A record that exhausted its delivery attempts; see {@link DispatchTrackingOutbox.deadLetters}. */
export interface DeadLetterRecord<Evt extends AnyDomainEvent>
	extends CommittedDomainEvent<Evt> {
	dispatchId: string;
	/** Failed delivery attempts when the record was dead-lettered. */
	attempts: number;
	/** Human-readable rendering of the last delivery error, if recorded. */
	lastError?: string;
}

/**
 * Write half of the transactional outbox: the only outbox capability the
 * write side (`withCommit`, `UnitOfWork`) depends on. Persisting the
 * events atomically with the aggregate state is the kit's guarantee;
 * DELIVERY is a separate, replaceable concern.
 *
 * Implement ONLY this interface to plug in an external delivery
 * solution: `add()` writes into that solution's outbox storage inside
 * the ambient transaction, and its own listener (polling or
 * WAL/CDC-based, such as a Debezium-style connector, a delivery
 * library, or a broker-native outbox) owns delivery entirely. The
 * kit-side poll surface ({@link Outbox}) is then never involved. See
 * the outbox guide, "External dispatchers".
 */
export interface OutboxWriter<Evt extends AnyDomainEvent> {
	/**
	 * Finalizes and persists event commit candidates. Called from inside
	 * `withCommit`'s transactional callback, atomically with the aggregate
	 * write.
	 *
	 * For every qualified aggregate source, the adapter must serialize source
	 * advancement, read its last eventful aggregate version, write that value as
	 * `previousEventfulAggregateVersion` on every event in the candidate's
	 * commit, and advance the source head to `aggregateVersion` in the SAME
	 * transaction. A state-only aggregate commit does not call `add()` and must
	 * therefore not advance this event-source head.
	 *
	 * A qualified source position `(aggregateType, aggregateId,
	 * aggregateVersion, commitSequence)` MUST identify one immutable event. All
	 * candidates for the same aggregate commit MUST also agree on `commitSize`.
	 * Enforce both constraints before advancing the source head; a conflicting
	 * retry must reject without replacing the stored event or changing the head.
	 *
	 * **Idempotency:** implementations should dedupe on
	 * `candidate.event.eventId`. `withCommit` itself does not retry, but the
	 * surrounding use case (a queue consumer, an HTTP retry, a transactional
	 * outbox-dispatcher loop) may legitimately invoke the same write more than
	 * once. A unique-key constraint on `(eventId)` in the outbox table is the
	 * standard implementation; the source-head update and dedupe decision must
	 * share the transaction. Idempotency applies only to an exact candidate
	 * retry: the same event ID, qualified source, aggregate version, commit
	 * sequence, and commit size. Reusing an `eventId` for another source or
	 * position is a caller bug: adapters that retain the conflicting record
	 * should reject it rather than replace or silently reinterpret it as a retry.
	 */
	add: (events: ReadonlyArray<EventCommitCandidate<Evt>>) => Promise<void>;
}

/**
 * Transactional outbox port: the bridge between the write-side
 * transaction and the (out-of-band) event dispatcher.
 *
 * Lifecycle:
 *  1. `add()` inside the write transaction (`withCommit` calls this) so
 *     events persist atomically with the aggregate state
 *     ({@link OutboxWriter}, the only part the write side needs).
 *  2. An outbox dispatcher (the kit's `OutboxDispatcher` or your own)
 *     polls `getPending()` and forwards the events to subscribers /
 *     external brokers.
 *  3. After successful dispatch, the dispatcher calls `markDispatched()`
 *     with the records' `dispatchId`s so they don't come back next poll.
 *
 * `markDispatched` is required to be idempotent: calling it with an id
 * that's already marked is a no-op, not an error. This lets the
 * dispatcher safely retry on partial-failure.
 *
 * **Competing dispatcher instances** are an adapter contract, not a
 * dispatcher feature: a transactional implementation that should
 * support several concurrent pollers must make `getPending` claim the
 * returned records (`FOR UPDATE SKIP LOCKED` or equivalent). Without
 * claiming, run one logical dispatcher per outbox.
 *
 * The bundled dispatcher supplies an {@link ExecutionContext} to every poll-side
 * operation. Production adapters MUST pass its signal to native I/O or enforce
 * a native timeout no later than `deadlineAt`; the shell can bound its wait but
 * cannot terminate a promise that ignores cancellation. A timed-out write has
 * an unknown outcome. Acknowledgements must remain idempotent when they complete
 * late; a late failure update may count its original delivery attempt and must
 * still no-op after the record was dispatched.
 */
export interface Outbox<Evt extends AnyDomainEvent> extends OutboxWriter<Evt> {
	/**
	 * Returns up to `limit` outbox records that have not yet been
	 * dispatched, **in the order `add()` persisted them** (commit order).
	 * The ordering is part of the port contract: `withCommit` promises
	 * subscribers per-aggregate causal order, and a sequential dispatcher
	 * can only honor that promise when this read is ordered. SQL-backed
	 * implementations need a monotonic position column (an auto-increment
	 * primary key works) and an `ORDER BY` on it; a bare `SELECT` returns
	 * rows in storage order, not insertion order. The dispatcher polls
	 * this on a schedule. When `limit` is omitted, the implementation
	 * decides on a default page size. The bundled dispatcher always supplies
	 * `context`; it is optional only so existing adapters remain assignable.
	 */
	getPending: (
		limit?: number,
		context?: ExecutionContext,
	) => Promise<ReadonlyArray<OutboxRecord<Evt>>>;

	/**
	 * Marks the given dispatch records as delivered so subsequent
	 * `getPending` calls don't return them. Must be idempotent on
	 * already-marked ids, including a late completion after the caller's
	 * storage deadline. The bundled dispatcher always supplies `context`.
	 */
	markDispatched: (
		dispatchIds: ReadonlyArray<string>,
		context?: ExecutionContext,
	) => Promise<void>;
}

/**
 * Optional extension of {@link Outbox} for dispatchers that track
 * delivery failures. Without failure tracking, a poison message (an
 * event whose delivery always throws) is redelivered forever: it comes
 * back from every `getPending` poll, blocks per-aggregate ordering
 * behind it, and burns the dispatcher's cycles. This extension gives
 * the dispatcher a bounded-retry story: report each failed delivery via
 * {@link markFailed}; the implementation moves records past its
 * attempt ceiling to a dead-letter set that `getPending` no longer
 * returns, and {@link deadLetters} exposes them for alerting, manual
 * inspection, and redelivery (deliver by hand, then ack via
 * `markDispatched`, which also clears dead-lettered records).
 *
 * See the outbox guide's dispatcher recipe for the retry-then-dead-letter
 * loop this port shape supports.
 */
export interface DispatchTrackingOutbox<Evt extends AnyDomainEvent>
	extends Outbox<Evt> {
	/**
	 * Records one failed delivery attempt for the given record:
	 * increments its attempt count (surfaced as
	 * {@link OutboxRecord.attempts}) and, once the implementation's
	 * ceiling is reached, moves the record to the dead-letter set.
	 * A no-op for unknown or already-dispatched ids (a late failure
	 * report after a successful retry must not resurrect the record).
	 * Returns the exact dead-letter record only on the call that performs
	 * that transition; retries below the ceiling and no-ops return
	 * `undefined`. This lets productive pollers emit an immediate signal
	 * without scanning the durable dead-letter set after every failure. A late
	 * completion may count that original delivery attempt; it must still no-op if
	 * the record was dispatched in the meantime. The bundled dispatcher never
	 * reissues the same store call and always supplies `context`.
	 */
	markFailed: (
		dispatchId: string,
		error?: unknown,
		context?: ExecutionContext,
	) => Promise<DeadLetterRecord<Evt> | undefined>;

	/**
	 * Records that exhausted their delivery attempts. They no longer
	 * come back from `getPending`; wire this to durable alerting and
	 * reconciliation so poison messages surface even if the poller stops
	 * between this store transition and its immediate observer callback.
	 */
	deadLetters: () => Promise<ReadonlyArray<DeadLetterRecord<Evt>>>;
}

/**
 * Discriminates a {@link DispatchTrackingOutbox} from a plain
 * {@link Outbox} at runtime. The single source of truth for the check;
 * the dispatcher and the contract suite both use it, so what counts as
 * a tracking outbox cannot drift between them. Both tracking methods
 * must be present: a plain adapter that happens to expose an unrelated
 * `markFailed` helper must not be mistaken for one that implements the
 * tracking protocol and then be fed `(dispatchId, error)` arguments it
 * never asked for. Internal plumbing, not exported from the package
 * entries.
 */
export function isDispatchTrackingOutbox<Evt extends AnyDomainEvent>(
	outbox: Outbox<Evt> | DispatchTrackingOutbox<Evt>,
): outbox is DispatchTrackingOutbox<Evt> {
	const candidate = outbox as DispatchTrackingOutbox<Evt>;
	return (
		typeof candidate.markFailed === "function" &&
		typeof candidate.deadLetters === "function"
	);
}
