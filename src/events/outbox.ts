import type { AnyDomainEvent } from "../aggregate/domain-event";
import type {
	DeadLetterRecord,
	DispatchTrackingOutbox,
	OutboxRecord,
} from "./ports";

/** Construction options for {@link InMemoryOutbox}. */
export interface InMemoryOutboxOptions {
	/**
	 * Failed-delivery ceiling: once `markFailed` has been reported this
	 * many times for a record, it moves to {@link InMemoryOutbox.deadLetters}
	 * and stops coming back from `getPending`. Default `5`.
	 */
	maxDeliveryAttempts?: number;
}

type TrackedRecord<Evt extends AnyDomainEvent> = {
	dispatchId: string;
	event: Evt;
	attempts: number;
	lastError?: string;
};

/**
 * In-memory reference implementation of `DispatchTrackingOutbox<Evt>`
 * (and therefore of the plain `Outbox<Evt>` port).
 *
 * Intended for tests, single-process workers, and quick-start demos.
 * Uses the event's own `eventId` as the dispatch id: the common, clean
 * choice. Storage is a `Map` keyed by `eventId`, so re-adding the same
 * event is naturally idempotent (`getPending` returns each event at
 * most once; a re-add refreshes the stored copy, e.g. a retried
 * commit's freshly stamped `aggregateVersion`, while the delivery
 * attempt count survives), and insertion order is preserved:
 * `getPending` returns records in commit order, as the port contract
 * requires.
 *
 * Dispatch tracking: `markFailed` increments the record's attempt count
 * and, at `maxDeliveryAttempts`, moves it to the dead-letter set
 * exposed by `deadLetters()`. Re-`add`ing a dead-lettered event
 * requeues it with a fresh attempts budget (the operator-facing
 * inverse of `deadLetters()`); `markDispatched` acks pending AND
 * dead-lettered records (manual redelivery then ack).
 *
 * For production, back the outbox with a transactional store so the
 * outbox row participates in the same transaction as the aggregate
 * write (see `TransactionScope` + `withCommit`). This class lives in
 * memory only: events are lost on process restart. Sharper still:
 * events `add()`ed inside a transaction that later rolls back are NOT
 * removed (the Map knows nothing about your scope's rollback). Tests
 * that assert rollback purity need an outbox that participates in the
 * test store's transactional semantics; see the reference adapter at
 * https://github.com/shi-rudo/ddd-kit-ts/blob/main/src/testing/repository-contract.test.ts
 * (repo-only, not shipped to npm).
 *
 * @example
 * ```ts
 * import { InMemoryOutbox, EventBusImpl, withCommit } from "@shirudo/ddd-kit";
 *
 * const outbox = new InMemoryOutbox<OrderEvent>();
 * const bus = new EventBusImpl<OrderEvent>();
 *
 * await withCommit({ scope, outbox, bus }, async (tx) => {
 *   const orderRepository = makeOrderRepository(tx);
 *   const order = await orderRepository.getByIdOrFail(id);
 *   order.confirm();
 *   await orderRepository.save(order);
 *   return { result: order.id, aggregates: [order] };
 * });
 * ```
 */
export class InMemoryOutbox<Evt extends AnyDomainEvent>
	implements DispatchTrackingOutbox<Evt>
{
	private readonly pending = new Map<string, TrackedRecord<Evt>>();
	private readonly dead = new Map<string, DeadLetterRecord<Evt>>();
	private readonly maxDeliveryAttempts: number;

	constructor(options?: InMemoryOutboxOptions) {
		const max = options?.maxDeliveryAttempts ?? 5;
		if (!Number.isInteger(max) || max < 1) {
			throw new Error(
				`InMemoryOutbox: maxDeliveryAttempts must be an integer >= 1, got ${max}`,
			);
		}
		this.maxDeliveryAttempts = max;
	}

	async add(events: ReadonlyArray<Evt>): Promise<void> {
		for (const event of events) {
			// Requeue path: re-adding a dead-lettered event is the natural
			// inverse of deadLetters() (an operator fixed the poison cause).
			// It moves back into automatic dispatch with a fresh attempts
			// budget, at the tail of the pending order; silently succeeding
			// while the event stays dead would be a lie.
			if (this.dead.has(event.eventId)) {
				this.dead.delete(event.eventId);
				this.pending.set(event.eventId, {
					dispatchId: event.eventId,
					event,
					attempts: 0,
				});
				continue;
			}
			const existing = this.pending.get(event.eventId);
			if (existing) {
				// Re-add refreshes the stored COPY but keeps the delivery
				// bookkeeping: a failed-commit-then-retry re-adds the same
				// eventId with a newly stamped aggregateVersion (withCommit
				// stamps at harvest), and dispatching the stale copy would
				// hand consumers a version from a commit that never
				// happened. The attempts count belongs to delivery, not to
				// the payload, so it survives the refresh.
				existing.event = event;
				continue;
			}
			this.pending.set(event.eventId, {
				dispatchId: event.eventId,
				event,
				attempts: 0,
			});
		}
	}

	async getPending(limit?: number): Promise<ReadonlyArray<OutboxRecord<Evt>>> {
		// Copies, not the tracked internals: a caller mutating a returned
		// record must not corrupt the attempt bookkeeping. Map iteration
		// preserves insertion order, satisfying the port's ordering
		// contract. Stop at the limit instead of materializing the whole
		// backlog: a dispatcher polling a large backlog with a small batch
		// pays O(limit), not O(total pending). The clamp keeps a negative
		// limit (batchSize - inFlight going negative) at "nothing", not
		// "everything but the last records".
		// NaN (e.g. batchSize - inFlight with an undefined operand) clamps
		// to zero like the old slice(0, NaN) did, never to "everything".
		const max =
			typeof limit === "number"
				? Math.max(0, Number.isNaN(limit) ? 0 : limit)
				: Number.POSITIVE_INFINITY;
		const batch: Array<OutboxRecord<Evt>> = [];
		for (const record of this.pending.values()) {
			if (batch.length >= max) break;
			batch.push({
				dispatchId: record.dispatchId,
				event: record.event,
				attempts: record.attempts,
			});
		}
		return batch;
	}

	async markDispatched(dispatchIds: ReadonlyArray<string>): Promise<void> {
		for (const id of dispatchIds) {
			this.pending.delete(id);
			// Manual redelivery then ack: dispatching a dead-lettered record
			// clears it too.
			this.dead.delete(id);
		}
	}

	async markFailed(dispatchId: string, error?: unknown): Promise<void> {
		const record = this.pending.get(dispatchId);
		// Unknown or already-dispatched (or already dead-lettered) id: a
		// late failure report must not resurrect anything.
		if (!record) return;
		record.attempts += 1;
		record.lastError =
			error instanceof Error ? error.message : String(error ?? "unknown");
		if (record.attempts >= this.maxDeliveryAttempts) {
			this.pending.delete(dispatchId);
			this.dead.set(dispatchId, {
				dispatchId: record.dispatchId,
				event: record.event,
				attempts: record.attempts,
				lastError: record.lastError,
			});
		}
	}

	async deadLetters(): Promise<ReadonlyArray<DeadLetterRecord<Evt>>> {
		return [...this.dead.values()].map((record) => ({ ...record }));
	}
}
