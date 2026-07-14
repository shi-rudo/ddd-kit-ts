import {
	type AggregateAddress,
	encodeAggregateAddress,
} from "../aggregate/aggregate-address";
import type { AnyDomainEvent } from "../aggregate/domain-event";
import { EventHarvestError } from "../core/errors";
import { assertPositiveInteger } from "../utils/validate";
import type {
	DeadLetterRecord,
	DispatchTrackingOutbox,
	EventCommitCandidate,
	EventCommitCandidatePosition,
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
	 * Maximum recently dispatched event receipts (id, qualified source, and
	 * candidate commit position) retained for idempotent `add` retries and
	 * collision detection. Older receipts are evicted in dispatch order; a later
	 * candidate behind its source head then rejects instead of rewinding the
	 * cursor.
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
	commitSize: number;
	eventIdsBySequence: ReadonlyMap<number, string>;
};

type DispatchedEventReceipt = {
	readonly source: AggregateAddress;
	readonly position: EventCommitCandidatePosition;
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
 * delivery attempt count survives. Its commit sequence and size remain
 * immutable; only this transaction-unaware adapter may move a still-pending
 * event to another aggregate version after an outer rollback leaked the first
 * add. Dead-lettered and acknowledged retries must match the complete original
 * candidate receipt. Reusing an `eventId` for another source or commit position
 * throws {@link EventHarvestError} while the pending, dead-letter, or bounded
 * dispatched receipt still proves the collision. Insertion order is preserved:
 * `getPending` returns records in commit order, as the port contract requires.
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
	/** Bounded insertion-ordered receipts for exact retries after acknowledgement. */
	private readonly dispatchedEventIds = new Map<
		string,
		DispatchedEventReceipt
	>();
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
		// Prove identity/receipt and source-position consistency for the whole input
		// before mutating pending records or source heads. Otherwise a conflict later
		// in one add() call could reject only after its earlier prefix had leaked.
		this.assertBatchEventReceiptIntegrity(events);
		this.assertBatchPositionIntegrity(events);
		for (const message of events) {
			const { event, source, position } = message;
			const dispatchedReceipt = this.dispatchedEventIds.get(event.eventId);
			if (dispatchedReceipt !== undefined) {
				assertSameEventSource(event, source, dispatchedReceipt.source);
				assertSameCandidateReceipt(
					event,
					position,
					dispatchedReceipt.position,
					false,
				);
				// eventId is the outbox idempotency key. Refresh its LRU position
				// without recreating a pending record or touching the source head.
				this.rememberDispatched(
					event.eventId,
					dispatchedReceipt.source,
					dispatchedReceipt.position,
				);
				continue;
			}
			const existing = this.pending.get(event.eventId);
			const deadLetter = this.dead.get(event.eventId);
			if (existing !== undefined) {
				assertSameEventSource(event, source, existing.source);
				// A pending record may move to another aggregateVersion only because
				// this in-memory adapter cannot observe rollback and the same event is
				// re-harvested. Its index and commit cardinality remain immutable.
				assertSameCandidateReceipt(event, position, existing.position, true);
			}
			if (deadLetter) {
				assertSameEventSource(event, source, deadLetter.source);
				assertSameCandidateReceipt(event, position, deadLetter.position, false);
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
			const sourceKey = encodeAggregateAddress(source);
			const sourceCursor = this.sourceCursors.get(sourceKey);
			let staleHeadVersion: number | undefined;
			if (
				existing !== undefined &&
				position.aggregateVersion < existing.position.aggregateVersion
			) {
				staleHeadVersion = existing.position.aggregateVersion;
			} else if (
				existing === undefined &&
				sourceCursor !== undefined &&
				position.aggregateVersion < sourceCursor.aggregateVersion
			) {
				staleHeadVersion = sourceCursor.aggregateVersion;
			}
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
			if (sourceCursor?.aggregateVersion === position.aggregateVersion) {
				if (sourceCursor.commitSize !== position.commitSize) {
					throw new EventHarvestError(
						`InMemoryOutbox rejected event "${event.eventId}" for ` +
							`${source.aggregateType} ${source.aggregateId}: aggregate version ` +
							`${position.aggregateVersion} was already recorded with commitSize ` +
							`${sourceCursor.commitSize}, not ${position.commitSize}.`,
						event.type,
					);
				}
				const positionOwner = sourceCursor.eventIdsBySequence.get(
					position.commitSequence,
				);
				if (positionOwner !== undefined && positionOwner !== event.eventId) {
					throw new EventHarvestError(
						`InMemoryOutbox rejected event "${event.eventId}" for ` +
							`${source.aggregateType} ${source.aggregateId}: source position ` +
							`(${position.aggregateVersion}, ${position.commitSequence}) is ` +
							`already owned by event "${positionOwner}". One qualified source ` +
							"position must identify exactly one immutable event.",
						event.type,
					);
				}
			}
			let previousEventfulAggregateVersion: number | null;
			const refreshesLeakedCommit =
				existing !== undefined &&
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
						commitSize: position.commitSize,
						eventIdsBySequence: new Map([
							[position.commitSequence, event.eventId],
						]),
					});
				} else if (
					sourceCursor?.aggregateVersion === position.aggregateVersion &&
					!sourceCursor.eventIdsBySequence.has(position.commitSequence)
				) {
					this.sourceCursors.set(
						sourceKey,
						cursorWithEvent(
							sourceCursor,
							position.commitSequence,
							event.eventId,
						),
					);
				}
			} else if (existing !== undefined) {
				previousEventfulAggregateVersion =
					existing.position.previousEventfulAggregateVersion;
			} else if (sourceCursor?.aggregateVersion === position.aggregateVersion) {
				previousEventfulAggregateVersion =
					sourceCursor.previousEventfulAggregateVersion;
				if (!sourceCursor.eventIdsBySequence.has(position.commitSequence)) {
					this.sourceCursors.set(
						sourceKey,
						cursorWithEvent(
							sourceCursor,
							position.commitSequence,
							event.eventId,
						),
					);
				}
			} else {
				previousEventfulAggregateVersion =
					sourceCursor?.aggregateVersion ?? null;
				this.sourceCursors.set(sourceKey, {
					aggregateVersion: position.aggregateVersion,
					previousEventfulAggregateVersion,
					commitSize: position.commitSize,
					eventIdsBySequence: new Map([
						[position.commitSequence, event.eventId],
					]),
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

	private assertBatchEventReceiptIntegrity(
		events: ReadonlyArray<EventCommitCandidate<Evt>>,
	): void {
		const receiptsInBatch = new Map<
			string,
			{
				readonly source: AggregateAddress;
				readonly position: EventCommitCandidatePosition;
			}
		>();
		for (const { event, source, position } of events) {
			const batchReceipt = receiptsInBatch.get(event.eventId);
			if (batchReceipt !== undefined) {
				assertSameEventSource(event, source, batchReceipt.source);
				assertSameCandidateReceipt(
					event,
					position,
					batchReceipt.position,
					false,
				);
			} else {
				receiptsInBatch.set(event.eventId, { source, position });
			}
			const dispatchedReceipt = this.dispatchedEventIds.get(event.eventId);
			if (dispatchedReceipt !== undefined) {
				assertSameEventSource(event, source, dispatchedReceipt.source);
				assertSameCandidateReceipt(
					event,
					position,
					dispatchedReceipt.position,
					false,
				);
				continue;
			}
			const existing = this.pending.get(event.eventId);
			if (existing !== undefined) {
				assertSameEventSource(event, source, existing.source);
				assertSameCandidateReceipt(event, position, existing.position, true);
			}
			const deadLetter = this.dead.get(event.eventId);
			if (deadLetter !== undefined) {
				assertSameEventSource(event, source, deadLetter.source);
				assertSameCandidateReceipt(event, position, deadLetter.position, false);
			}
		}
	}

	private assertBatchPositionIntegrity(
		events: ReadonlyArray<EventCommitCandidate<Evt>>,
	): void {
		const simulatedCursors = new Map<string, EventSourceCursor>();
		for (const { event, source, position } of events) {
			const sourceKey = encodeAggregateAddress(source);
			const cursor =
				simulatedCursors.get(sourceKey) ?? this.sourceCursors.get(sourceKey);
			if (
				cursor === undefined ||
				position.aggregateVersion > cursor.aggregateVersion
			) {
				simulatedCursors.set(sourceKey, {
					aggregateVersion: position.aggregateVersion,
					previousEventfulAggregateVersion: cursor?.aggregateVersion ?? null,
					commitSize: position.commitSize,
					eventIdsBySequence: new Map([
						[position.commitSequence, event.eventId],
					]),
				});
				continue;
			}
			if (position.aggregateVersion < cursor.aggregateVersion) continue;
			if (cursor.commitSize !== position.commitSize) {
				throw new EventHarvestError(
					`InMemoryOutbox rejected event "${event.eventId}" for ` +
						`${source.aggregateType} ${source.aggregateId}: aggregate version ` +
						`${position.aggregateVersion} was already recorded with commitSize ` +
						`${cursor.commitSize}, not ${position.commitSize}.`,
					event.type,
				);
			}
			const positionOwner = cursor.eventIdsBySequence.get(
				position.commitSequence,
			);
			if (positionOwner !== undefined && positionOwner !== event.eventId) {
				throw new EventHarvestError(
					`InMemoryOutbox rejected event "${event.eventId}" for ` +
						`${source.aggregateType} ${source.aggregateId}: source position ` +
						`(${position.aggregateVersion}, ${position.commitSequence}) is ` +
						`already owned by event "${positionOwner}". One qualified source ` +
						"position must identify exactly one immutable event.",
					event.type,
				);
			}
			if (positionOwner === undefined) {
				simulatedCursors.set(
					sourceKey,
					cursorWithEvent(cursor, position.commitSequence, event.eventId),
				);
			}
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
			const record = this.pending.get(id) ?? this.dead.get(id);
			if (record !== undefined) {
				this.rememberDispatched(id, record.source, record.position);
			}
			this.pending.delete(id);
			// Manual redelivery then ack: dispatching a dead-lettered record
			// clears it too.
			this.dead.delete(id);
		}
	}

	private rememberDispatched(
		eventId: string,
		source: AggregateAddress,
		position: EventCommitCandidatePosition,
	): void {
		this.dispatchedEventIds.delete(eventId);
		this.dispatchedEventIds.set(eventId, {
			source: Object.freeze({ ...source }),
			position: Object.freeze({
				aggregateVersion: position.aggregateVersion,
				commitSequence: position.commitSequence,
				commitSize: position.commitSize,
			}),
		});
		while (this.dispatchedEventIds.size > this.maxRetainedDispatchedEventIds) {
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

function cursorWithEvent(
	cursor: EventSourceCursor,
	commitSequence: number,
	eventId: string,
): EventSourceCursor {
	return {
		...cursor,
		eventIdsBySequence: new Map(cursor.eventIdsBySequence).set(
			commitSequence,
			eventId,
		),
	};
}

function assertSameCandidateReceipt(
	event: AnyDomainEvent,
	received: EventCommitCandidatePosition,
	recorded: EventCommitCandidatePosition,
	allowAggregateVersionRefresh: boolean,
): void {
	const sameVersion =
		allowAggregateVersionRefresh ||
		received.aggregateVersion === recorded.aggregateVersion;
	if (
		sameVersion &&
		received.commitSequence === recorded.commitSequence &&
		received.commitSize === recorded.commitSize
	) {
		return;
	}
	throw new EventHarvestError(
		`InMemoryOutbox rejected event "${event.eventId}": its commit candidate ` +
			`changed from (${recorded.aggregateVersion}, ${recorded.commitSequence}; ` +
			`commitSize=${recorded.commitSize}) to (${received.aggregateVersion}, ` +
			`${received.commitSequence}; commitSize=${received.commitSize}). ` +
			"An exact redelivery must keep its source position immutable.",
		event.type,
	);
}

function assertSameEventSource(
	event: AnyDomainEvent,
	received: AggregateAddress,
	recorded: AggregateAddress,
): void {
	if (
		received.aggregateType === recorded.aggregateType &&
		received.aggregateId === recorded.aggregateId
	) {
		return;
	}
	throw new EventHarvestError(
		`InMemoryOutbox rejected eventId collision for "${event.eventId}": ` +
			`it already belongs to ${recorded.aggregateType} ${recorded.aggregateId}, ` +
			`but was received for ${received.aggregateType} ${received.aggregateId}. ` +
			"An eventId must identify one immutable event across all aggregate sources.",
		event.type,
	);
}
