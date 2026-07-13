import type { AnyDomainEvent } from "../aggregate/domain-event";
import { EventHarvestError } from "../core/errors";
import { assertPositiveInteger } from "../utils/validate";
import type {
	DeadLetterRecord,
	DispatchTrackingOutbox,
	EventCommitCandidate,
	OutboxRecord,
	OutboxWriter,
} from "./ports";

/**
 * An {@link OutboxWriter} that deliberately drops every event: the
 * no-op (noop) writer, named for its consequence rather than its
 * mechanism, so the call site reads as the decision it is.
 *
 * `withCommit` and `UnitOfWork` require an outbox on purpose: the
 * asymmetry against the optional `bus` is the design. The bus is the
 * best-effort in-process fast path (post-commit, no durability), so it
 * may be omitted; the outbox is the delivery GUARANTEE, so running
 * without one is a decision, not a default. This writer is that
 * decision, made readable at the call site.
 *
 * Legitimate uses: aggregates that emit no events (`TEvent = never`,
 * nothing will ever be written), and deliberate best-effort setups
 * where the in-process bus is the only delivery and event loss on a
 * crash between commit and publish is ACCEPTED. Do not reach for an
 * undrained `InMemoryOutbox` instead: its pending map grows unbounded
 * (see the class docs).
 *
 * The name is long on purpose, same discipline as
 * `setStateWithoutVersionBump`: the dangerous variant carries the loud
 * name.
 */
export function outboxWriterAcceptingEventLoss<
	Evt extends AnyDomainEvent,
>(): OutboxWriter<Evt> {
	return {
		add: async () => {},
	};
}

/** Construction options for {@link InMemoryOutbox}. */
export interface InMemoryOutboxOptions {
	/**
	 * Failed-delivery ceiling: once `markFailed` has been reported this
	 * many times for a record, it moves to {@link InMemoryOutbox.deadLetters}
	 * and stops coming back from `getPending`. Default `5`.
	 */
	maxDeliveryAttempts?: number;

	/**
	 * Maximum recently dispatched event ids retained for idempotent `add`
	 * retries. Older receipts are evicted in dispatch order; a later candidate
	 * behind its source head then rejects instead of rewinding the cursor.
	 * Default `10_000`.
	 */
	maxRetainedDispatchedEventIds?: number;
}

type TrackedRecord<Evt extends AnyDomainEvent> = {
	dispatchId: string;
	event: Evt;
	source: OutboxRecord<Evt>["source"];
	position: OutboxRecord<Evt>["position"];
	attempts: number;
	lastError?: string;
};

type EventSourceCursor = {
	aggregateVersion: number;
	previousEventfulAggregateVersion: number | null;
};

/**
 * In-memory reference implementation of `DispatchTrackingOutbox<Evt>`
 * (and therefore of the plain `Outbox<Evt>` port).
 *
 * Intended for tests, single-process workers, and quick-start demos.
 * Uses the event's own `eventId` as the dispatch id: the common, clean
 * choice. Active storage is a `Map` keyed by `eventId`, and a bounded
 * recent-dispatch receipt cache keeps retries idempotent after acknowledgement.
 * Re-adding a pending event refreshes the stored commit envelope while the
 * delivery attempt count survives. Insertion order is preserved:
 * `getPending` returns records in commit order, as the port contract
 * requires.
 *
 * Dispatch tracking: `markFailed` increments the record's attempt count
 * and, at `maxDeliveryAttempts`, moves it to the dead-letter set
 * exposed by `deadLetters()`. Re-`add`ing a dead-lettered event
 * requeues it with a fresh attempts budget (the operator-facing
 * inverse of `deadLetters()`); `markDispatched` acks pending AND
 * dead-lettered records (manual redelivery then ack).
 * To link future eventful commits, the implementation also retains one
 * source cursor per qualified aggregate after dispatch. Consequently a
 * long-lived instance is bounded by active records PLUS distinct aggregate
 * sources it has ever seen PLUS `maxRetainedDispatchedEventIds`; use a durable
 * adapter with an explicit source-head lifecycle and an event-id unique key for
 * unbounded production workloads.
 *
 * For production, back the outbox with a transactional store so the
 * outbox row participates in the same transaction as the aggregate
 * write (see `TransactionScope` + `withCommit`). This class lives in
 * memory only: events are lost on process restart. Do NOT use it as a
 * dummy for bus-only setups without a dispatcher draining it: records
 * that are never `markDispatched` accumulate in the pending map
 * unbounded. For a deliberate no-delivery setup use
 * {@link outboxWriterAcceptingEventLoss} instead. Sharper still:
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
 *   const order = await orderRepository.getById(id);
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
	/** Latest eventful commit and its predecessor per qualified source. */
	private readonly sourceCursors = new Map<string, EventSourceCursor>();
	/** Bounded insertion-ordered receipts for retries after acknowledgement. */
	private readonly dispatchedEventIds = new Map<string, true>();
	private readonly maxDeliveryAttempts: number;
	private readonly maxRetainedDispatchedEventIds: number;

	constructor(options?: InMemoryOutboxOptions) {
		const max = options?.maxDeliveryAttempts ?? 5;
		assertPositiveInteger("InMemoryOutbox", "maxDeliveryAttempts", max);
		this.maxDeliveryAttempts = max;
		const retained = options?.maxRetainedDispatchedEventIds ?? 10_000;
		assertPositiveInteger(
			"InMemoryOutbox",
			"maxRetainedDispatchedEventIds",
			retained,
		);
		this.maxRetainedDispatchedEventIds = retained;
	}

	async add(events: ReadonlyArray<EventCommitCandidate<Evt>>): Promise<void> {
		for (const message of events) {
			const { event, source, position } = message;
			if (this.dispatchedEventIds.has(event.eventId)) {
				// eventId is the outbox idempotency key. Refresh its LRU position
				// without recreating a pending record or touching the source head.
				this.rememberDispatched(event.eventId);
				continue;
			}
			const existing = this.pending.get(event.eventId);
			const deadLetter = this.dead.get(event.eventId);
			if (deadLetter) {
				// Requeue the durable record exactly as committed. A dead letter is a
				// delivery state, not a new aggregate commit to re-finalize.
				this.dead.delete(event.eventId);
				this.pending.set(event.eventId, {
					dispatchId: deadLetter.dispatchId,
					event: deadLetter.event,
					source: deadLetter.source,
					position: deadLetter.position,
					attempts: 0,
				});
				continue;
			}
			const ownedSource = Object.freeze({ ...source });
			const sourceKey = JSON.stringify([
				source.aggregateType,
				source.aggregateId,
			]);
			const sourceCursor = this.sourceCursors.get(sourceKey);
			const existingMatchesSource =
				existing !== undefined &&
				existing.source.aggregateType === source.aggregateType &&
				existing.source.aggregateId === source.aggregateId;
			const staleHeadVersion =
				existingMatchesSource &&
				position.aggregateVersion < existing.position.aggregateVersion
					? existing.position.aggregateVersion
					: existing === undefined &&
						sourceCursor !== undefined &&
						position.aggregateVersion < sourceCursor.aggregateVersion
						? sourceCursor.aggregateVersion
						: undefined;
			if (staleHeadVersion !== undefined) {
				throw new EventHarvestError(
					`InMemoryOutbox rejected stale event "${event.eventId}" for ` +
						`${source.aggregateType} ${source.aggregateId} at aggregate version ` +
						`${position.aggregateVersion}: the event-source head is already ` +
						`${staleHeadVersion}. The dispatched-id receipt may have ` +
						"expired; use a durable outbox with a transactional eventId unique key " +
						"for unbounded idempotency.",
					event.type,
				);
			}
			let previousEventfulAggregateVersion: number | null;
			const refreshesLeakedCommit =
				existingMatchesSource &&
				existing.position.aggregateVersion !== position.aggregateVersion;
			if (refreshesLeakedCommit) {
				// InMemoryOutbox cannot observe transaction rollback. A pending
				// record with the same eventId but a new commit version is therefore
				// a replacement for the leaked attempt, not its successor. Preserve
				// the event-source predecessor and move the in-memory source head.
				previousEventfulAggregateVersion =
					existing.position.previousEventfulAggregateVersion;
				if (
					sourceCursor?.aggregateVersion === existing.position.aggregateVersion
				) {
					this.sourceCursors.set(sourceKey, {
						aggregateVersion: position.aggregateVersion,
						previousEventfulAggregateVersion,
					});
				}
			} else if (
				existingMatchesSource
			) {
				previousEventfulAggregateVersion =
					existing.position.previousEventfulAggregateVersion;
			} else if (sourceCursor?.aggregateVersion === position.aggregateVersion) {
				previousEventfulAggregateVersion =
					sourceCursor.previousEventfulAggregateVersion;
			} else {
				previousEventfulAggregateVersion = sourceCursor?.aggregateVersion ?? null;
				this.sourceCursors.set(sourceKey, {
					aggregateVersion: position.aggregateVersion,
					previousEventfulAggregateVersion,
				});
			}
			const ownedPosition = Object.freeze({
				...position,
				previousEventfulAggregateVersion,
			});
			if (existing) {
				// Re-add refreshes the stored COPY but keeps the delivery
				// bookkeeping: a failed-commit-then-retry re-adds the same
				// eventId with a new commit position. Dispatching the stale
				// envelope would hand consumers a position from a commit that
				// never happened. Attempts belong to delivery, so they survive.
				existing.event = event;
				existing.source = ownedSource;
				existing.position = ownedPosition;
				continue;
			}
			this.pending.set(event.eventId, {
				dispatchId: event.eventId,
				event,
				source: ownedSource,
				position: ownedPosition,
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
				source: record.source,
				position: record.position,
				attempts: record.attempts,
			});
		}
		return batch;
	}

	async markDispatched(dispatchIds: ReadonlyArray<string>): Promise<void> {
		for (const id of dispatchIds) {
			if (this.pending.has(id) || this.dead.has(id)) {
				this.rememberDispatched(id);
			}
			this.pending.delete(id);
			// Manual redelivery then ack: dispatching a dead-lettered record
			// clears it too.
			this.dead.delete(id);
		}
	}

	private rememberDispatched(eventId: string): void {
		this.dispatchedEventIds.delete(eventId);
		this.dispatchedEventIds.set(eventId, true);
		while (
			this.dispatchedEventIds.size > this.maxRetainedDispatchedEventIds
		) {
			const oldest = this.dispatchedEventIds.keys().next();
			if (oldest.done) break;
			this.dispatchedEventIds.delete(oldest.value);
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
				source: record.source,
				position: record.position,
				attempts: record.attempts,
				lastError: record.lastError,
			});
		}
	}

	async deadLetters(): Promise<ReadonlyArray<DeadLetterRecord<Evt>>> {
		return [...this.dead.values()].map((record) => ({ ...record }));
	}
}
