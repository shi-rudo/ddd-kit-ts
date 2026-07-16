/**
 * One deadline due for delivery, as returned by
 * {@link DeadlineStore.due}. `deliveryId` identifies this scheduled
 * INCARNATION of the deadline, not the `(scope, key)` address: a
 * reschedule replaces the incarnation, and acknowledging a stale
 * incarnation must never consume the new one (see
 * {@link DeadlineStore.markDelivered}).
 */
export interface DueDeadline<TPayload = unknown> {
	/** Opaque per-incarnation id used for `markDelivered`/`markFailed`. */
	readonly deliveryId: string;
	/** The namespace half of the address, e.g. a process or policy name. */
	readonly scope: string;
	/** The instance half of the address, e.g. a saga or reservation id. */
	readonly key: string;
	/** When the deadline was due. */
	readonly dueAt: Date;
	/** The payload handed back as the input; plain data only. */
	readonly payload: TPayload;
	/** Failed delivery attempts so far (see `markFailed`). */
	readonly attempts: number;
}

/** A deadline that exhausted its delivery attempts; see {@link DeadlineStore.deadLetters}. */
export interface DeadLetterDeadline<TPayload = unknown>
	extends DueDeadline<TPayload> {
	/** Human-readable rendering of the last delivery error, if recorded. */
	readonly lastError?: string;
}

/**
 * Driven port for durable deadlines: timeout-as-input. A process that
 * waits ("if PaymentReceived has not arrived in 30 minutes,
 * compensate"; "release the reservation hold after 15 minutes";
 * "expire the offer at month's end") schedules a deadline, and a poll
 * loop later DELIVERS it as an input to whatever owns the decision, a
 * saga aggregate, a use case, a policy. The store never executes
 * consumer code; firing a deadline means handing back a record.
 *
 * Deliberately general-purpose and deliberately small. This is not a
 * scheduler framework and not a cron abstraction: there is no
 * recurrence, no execution engine, and the poll loop belongs to the
 * consumer (the outbox guide's `drainOnce` pattern fits; the deadlines
 * guide shows the wiring).
 *
 * Addressing is the `(scope, key)` pair, so one table serves every
 * waiting process in an application: `scope` names the policy
 * ("checkout-saga", "reservation-hold"), `key` the instance. There is
 * at most ONE pending deadline per address; `schedule` on an existing
 * address replaces it (that IS the reschedule operation), and each
 * scheduling gets a fresh `deliveryId`, so acknowledgements of a
 * replaced incarnation cannot consume its successor.
 *
 * Two sides, two transactional postures, the same split as the outbox:
 *
 * - **`schedule` and `cancel` are write-side calls** and must join the
 *   ambient write transaction (use a tx-bound store instance inside
 *   `withCommit`'s callback, exactly like an outbox adapter). This is
 *   a correctness rule, not a preference: state that says "waiting for
 *   payment" committed without its deadline is a process that never
 *   wakes up, and a deadline scheduled for a rolled-back state change
 *   is a ghost input.
 * - **`due`, `markDelivered`, `markFailed`, and `deadLetters` are the
 *   poll surface** and run out of band, in the consumer's loop.
 *
 * Delivery is at-least-once: a crash between processing and
 * `markDelivered` redelivers, so consumers make deadline handling
 * idempotent (the idempotency store with the `deliveryId` as key is
 * the ready-made answer). Deadlines have no cross-key ordering
 * obligations, so unlike the outbox a poison deadline blocks only
 * itself; bounded retries still matter, which is why failure tracking
 * is part of the port rather than an extension: report failed
 * deliveries via `markFailed`, and the store dead-letters a deadline
 * past its attempt ceiling.
 *
 * Run one logical poller per store unless your adapter's `due` claims
 * records for competing pollers; the same rule as the outbox
 * dispatcher.
 *
 * The bundled processor supplies an `EffectContext` to every poll-side
 * operation. Production adapters MUST pass its signal to native I/O or enforce
 * a native timeout no later than `deadlineAt`; the shell can bound its wait but
 * cannot terminate a promise that ignores cancellation. A timed-out write has
 * an unknown outcome. Acknowledgements must remain idempotent when they complete
 * late; a late failure update may count its original delivery attempt and must
 * still no-op after the incarnation was delivered or replaced.
 *
 * Verify an adapter with `createDeadlineStoreContractTests` from
 * `@shirudo/ddd-kit/testing`; `InMemoryDeadlineStore` is the
 * reference.
 *
 * @template TPayload - The payload shape carried from `schedule` to
 * delivery; plain, serializable data (the same discipline as event
 * payloads and snapshots)
 */
export interface DeadlineStore<TPayload = unknown> {
	/**
	 * Schedules (or reschedules) the deadline at `(scope, key)`: at most
	 * one pending deadline exists per address, and scheduling an
	 * occupied address replaces its due time, payload, attempt count,
	 * and incarnation. Called inside the write transaction.
	 */
	schedule(deadline: {
		scope: string;
		key: string;
		dueAt: Date;
		payload: TPayload;
	}): Promise<void>;

	/**
	 * Removes the pending deadline at `(scope, key)`; a no-op when none
	 * exists (the awaited input arrived in time and the wait is over).
	 * Called inside the write transaction.
	 */
	cancel(scope: string, key: string): Promise<void>;

	/**
	 * Up to `limit` deadlines with `dueAt <= now` that are neither
	 * delivered nor dead-lettered, ordered by `dueAt` (earliest first;
	 * ties in scheduling order). A `limit` of `0` is legal and yields an
	 * empty page (poll loops computing a remaining capacity may pass
	 * it). `now` is a parameter on purpose: the poll loop owns the
	 * clock, which keeps adapters deterministic and tests free of real
	 * time. The bundled processor always supplies `context`; it is optional only
	 * so existing adapters remain assignable.
	 */
	due(
		now: Date,
		limit: number,
		context?: EffectContext,
	): Promise<ReadonlyArray<DueDeadline<TPayload>>>;

	/**
	 * Acknowledges delivered incarnations so they stop coming back.
	 * Idempotent on already-acknowledged and unknown ids, and a no-op
	 * for ids of REPLACED incarnations (a late ack after a reschedule
	 * must not consume the successor). Also clears a dead-lettered
	 * incarnation (manual redelivery, then ack). It remains idempotent if the
	 * operation completes after the caller timed out. The bundled processor
	 * always supplies `context`.
	 */
	markDelivered(
		deliveryIds: ReadonlyArray<string>,
		context?: EffectContext,
	): Promise<void>;

	/**
	 * Records one failed delivery attempt for the incarnation:
	 * increments its `attempts` and, once the store's ceiling is
	 * reached, moves it to the dead-letter set that `due` no longer
	 * returns. A no-op for unknown, delivered, or replaced ids.
	 * Returns the exact dead-letter record only on the call that performs
	 * that transition; retries below the ceiling and no-ops return
	 * `undefined`. A late completion may count that original delivery attempt; it
	 * must still no-op if the incarnation was delivered or replaced in the
	 * meantime. The bundled processor never reissues the same store call and
	 * always supplies `context`.
	 */
	markFailed(
		deliveryId: string,
		error?: unknown,
		context?: EffectContext,
	): Promise<DeadLetterDeadline<TPayload> | undefined>;

	/**
	 * Deadlines that exhausted their delivery attempts. Wire this to durable
	 * alerting and reconciliation: a growing set means processes that stopped
	 * waking up, and the poller can stop between the store transition and its
	 * immediate observer callback.
	 */
	deadLetters(): Promise<ReadonlyArray<DeadLetterDeadline<TPayload>>>;
}

import type { EffectContext } from "../utils/effect";
