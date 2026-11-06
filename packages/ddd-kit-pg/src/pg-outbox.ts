import {
	type AggregateIdentity,
	type AnyDomainEvent,
	type DeadLetterRecord,
	type DispatchTrackingOutbox,
	type EventCommitCandidate,
	type ExecutionContext,
	KitWiringError,
	type OutboxRecord,
} from "@shirudo/ddd-kit";
import type { PgEventCodec } from "./pg-event-codec";
import {
	fromPgPool,
	inBoundedTransaction,
	type PgPollPool,
	setStatementDeadline,
} from "./pg-pool-executor";
import type { PgQueryExecutor } from "./pg-query-executor";
import { PgTransactionScope } from "./pg-transaction-scope";
import {
	decodeStoredEvent,
	encodeStoredEvent,
	type StoredEventRow,
	storedEventColumns,
} from "./stored-event";

const DEFAULT_MAX_DELIVERY_ATTEMPTS = 5;
const DEFAULT_PAGE_SIZE = 100;

export interface PgOutboxOptions<Evt extends AnyDomainEvent> {
	/**
	 * Runs the poll statements. The write statements run on the transaction that
	 * `add` receives.
	 */
	readonly pool: PgPollPool;
	/** The failed deliveries that move a record to the dead letters. Default `5`. */
	readonly maxDeliveryAttempts?: number | undefined;
	/**
	 * Lets several dispatchers run at once: `getPending` claims its records for
	 * `leaseMs`. A record returns to the polls when its lease ends: the record of
	 * a crashed dispatcher, and also a record whose delivery failed. Choose a
	 * lease longer than a delivery. Without this option, run one dispatcher per
	 * outbox.
	 */
	readonly claim?: { readonly leaseMs: number } | undefined;
	/** Maps events to JSON and back. Without it, payloads must already be JSON. */
	readonly codec?: PgEventCodec<Evt> | undefined;
}

interface OutboxRow extends StoredEventRow {
	readonly aggregate_type: string;
	readonly aggregate_id: string;
	readonly aggregate_version: string;
	readonly commit_sequence: number;
	readonly commit_size: number;
	readonly previous_eventful_aggregate_version: string | null;
	readonly attempts: number;
	readonly last_error: string | null;
}

const OUTBOX_COLUMNS = `
	${storedEventColumns("outbox")},
	outbox.aggregate_type,
	outbox.aggregate_id,
	outbox.aggregate_version::text AS aggregate_version,
	outbox.commit_sequence,
	outbox.commit_size,
	outbox.previous_eventful_aggregate_version::text
		AS previous_eventful_aggregate_version,
	outbox.attempts,
	outbox.last_error`;

/**
 * A durable outbox. `add` and `endEventSources` write on the transaction that
 * they receive, so the records commit or roll back with the aggregate. One
 * instance can serve every request. Run `sql/outbox.sql` to create the tables.
 *
 * The table keeps JSON. `add` rejects a payload or metadata that JSON does not
 * keep exactly. Use a {@link PgEventCodec} to map such a value.
 *
 * With `claim`, a poll holds back a later event of a source while an earlier
 * one is claimed, so that competing dispatchers keep the order per aggregate.
 * The claims of all dispatchers run one after another, each in a short
 * transaction.
 *
 * The table keeps a delivered record, so that a retry of its commit stays a
 * retry. Delete old records with your own job. Never delete a row of
 * `ddd_kit_outbox_source_head` whose `ended` is true.
 */
export class PgOutbox<Evt extends AnyDomainEvent>
	implements DispatchTrackingOutbox<Evt, PgQueryExecutor>
{
	private readonly poll: PgQueryExecutor;
	private readonly claimScope: PgTransactionScope;
	private readonly maxDeliveryAttempts: number;
	private readonly leaseMs: number | undefined;
	private readonly codec: PgEventCodec<Evt> | undefined;

	constructor(options: PgOutboxOptions<Evt>) {
		this.poll = fromPgPool(options.pool);
		// The claim needs a new snapshot after the wait for its lock.
		this.claimScope = new PgTransactionScope(options.pool, {
			isolationLevel: "read committed",
		});
		this.maxDeliveryAttempts = positiveInteger(
			"maxDeliveryAttempts",
			options.maxDeliveryAttempts ?? DEFAULT_MAX_DELIVERY_ATTEMPTS,
		);
		this.leaseMs =
			options.claim && positiveInteger("leaseMs", options.claim.leaseMs);
		this.codec = options.codec;
	}

	async add(
		candidates: ReadonlyArray<EventCommitCandidate<Evt>>,
		tx: PgQueryExecutor,
	): Promise<void> {
		const stored = candidates.map((candidate, index) => ({
			candidate,
			event: encodeStoredEvent(
				candidate.event,
				this.codec,
				`PgOutbox.add candidates[${index}]`,
			),
		}));
		for (const { candidate, event } of stored) {
			await addOne(candidate, event, tx);
		}
	}

	async endEventSources(
		sources: ReadonlyArray<AggregateIdentity>,
		tx: PgQueryExecutor,
	): Promise<void> {
		for (const source of sources) {
			// A source without a head has no events, so it stays open.
			await tx.query(
				`UPDATE ddd_kit_outbox_source_head
				SET ended = true
				WHERE aggregate_type = $1
					AND aggregate_id = $2
					AND last_eventful_aggregate_version IS NOT NULL`,
				[source.aggregateType, source.aggregateId],
			);
		}
	}

	async getPending(
		limit: number = DEFAULT_PAGE_SIZE,
		context?: ExecutionContext,
	): Promise<ReadonlyArray<OutboxRecord<Evt>>> {
		if (!(limit > 0)) return [];
		context?.signal.throwIfAborted();
		const { rows } =
			this.leaseMs === undefined
				? await this.poll.query<OutboxRow>(
						`SELECT ${OUTBOX_COLUMNS}
						FROM ddd_kit_outbox AS outbox
						WHERE outbox.status = 'pending'
						ORDER BY outbox.position
						LIMIT $1`,
						[limit],
						context,
					)
				: await this.claimPending(limit, this.leaseMs, context);
		return rows.map((row) => this.toRecord(row));
	}

	/**
	 * The lock and the claim are two statements, because READ COMMITTED gives each
	 * statement a new snapshot. In one statement, the snapshot would come before
	 * the lock. The poll would then miss the claim of the poll before it, and hand
	 * a later event of a source to another dispatcher.
	 */
	private claimPending(
		limit: number,
		leaseMs: number,
		context: ExecutionContext | undefined,
	) {
		const claim = async (tx: PgQueryExecutor) => {
			await tx.query(
				`SELECT pg_advisory_xact_lock(
					hashtextextended('ddd_kit_outbox'::regclass::oid::text, 0)
				)`,
			);
			if (context !== undefined) await setStatementDeadline(tx, context);
			// clock_timestamp and not now: now is the start of the transaction, before
			// the wait for the lock, and that wait would shorten the lease.
			// SKIP LOCKED passes over a row that another statement holds, for example
			// a late markFailed after its lease. A later event of that source must
			// then wait too, so chosen keeps an event only after every earlier
			// pending event of its source in the same claim.
			return tx.query<OutboxRow>(
				`WITH locked AS (
					SELECT candidate.position, candidate.aggregate_type, candidate.aggregate_id
					FROM ddd_kit_outbox AS candidate
					WHERE candidate.status = 'pending'
						AND (
							candidate.claimed_until IS NULL
							OR candidate.claimed_until <= clock_timestamp()
						)
						AND NOT EXISTS (
							SELECT 1
							FROM ddd_kit_outbox AS earlier
							WHERE earlier.aggregate_type = candidate.aggregate_type
								AND earlier.aggregate_id = candidate.aggregate_id
								AND earlier.position < candidate.position
								AND earlier.status = 'pending'
								AND earlier.claimed_until > clock_timestamp()
						)
					ORDER BY candidate.position
					LIMIT $1
					FOR UPDATE OF candidate SKIP LOCKED
				),
				chosen AS (
					SELECT locked.position
					FROM locked
					WHERE NOT EXISTS (
						SELECT 1
						FROM ddd_kit_outbox AS earlier
						WHERE earlier.aggregate_type = locked.aggregate_type
							AND earlier.aggregate_id = locked.aggregate_id
							AND earlier.position < locked.position
							AND earlier.status = 'pending'
							AND earlier.position NOT IN (SELECT position FROM locked)
					)
				),
				claimed AS (
					UPDATE ddd_kit_outbox AS target
					SET claimed_until = clock_timestamp() + $2 * interval '1 millisecond'
					FROM chosen
					WHERE target.position = chosen.position
					RETURNING target.*
				)
				SELECT ${OUTBOX_COLUMNS}
				FROM claimed AS outbox
				ORDER BY outbox.position`,
				[limit, leaseMs],
			);
		};
		return context === undefined
			? this.claimScope.transactional(claim)
			: inBoundedTransaction(this.claimScope, context, claim);
	}

	async markDispatched(
		dispatchIds: ReadonlyArray<string>,
		context?: ExecutionContext,
	): Promise<void> {
		context?.signal.throwIfAborted();
		await this.poll.query(
			`UPDATE ddd_kit_outbox
			SET status = 'dispatched', dispatched_at = now(), claimed_until = NULL
			WHERE event_id = ANY($1::text[]) AND status IN ('pending', 'dead')`,
			[dispatchIds],
			context,
		);
	}

	async markFailed(
		dispatchId: string,
		error?: unknown,
		context?: ExecutionContext,
	): Promise<DeadLetterRecord<Evt> | undefined> {
		context?.signal.throwIfAborted();
		const lastError =
			error instanceof Error ? error.message : String(error ?? "unknown");
		const { rows } = await this.poll.query<
			OutboxRow & { readonly status: string }
		>(
			`WITH failed AS (
				UPDATE ddd_kit_outbox
				SET
					attempts = attempts + 1,
					last_error = $2,
					status = CASE WHEN attempts + 1 >= $3 THEN 'dead' ELSE 'pending' END
				WHERE event_id = $1 AND status = 'pending'
				RETURNING *
			)
			SELECT ${OUTBOX_COLUMNS}, outbox.status
			FROM failed AS outbox`,
			[dispatchId, lastError, this.maxDeliveryAttempts],
			context,
		);
		const row = rows[0];
		return row?.status === "dead" ? this.toDeadLetter(row) : undefined;
	}

	async deadLetters(): Promise<ReadonlyArray<DeadLetterRecord<Evt>>> {
		const { rows } = await this.poll.query<OutboxRow>(
			`SELECT ${OUTBOX_COLUMNS}
			FROM ddd_kit_outbox AS outbox
			WHERE outbox.status = 'dead'
			ORDER BY outbox.position`,
		);
		return rows.map((row) => this.toDeadLetter(row));
	}

	async requeueDeadLetters(
		dispatchIds: ReadonlyArray<string>,
		context?: ExecutionContext,
	): Promise<void> {
		await this.poll.query(
			`UPDATE ddd_kit_outbox
			SET status = 'pending', attempts = 0, last_error = NULL, claimed_until = NULL
			WHERE event_id = ANY($1::text[]) AND status = 'dead'`,
			[dispatchIds],
			context,
		);
	}

	private toRecord(row: OutboxRow): OutboxRecord<Evt> {
		return {
			dispatchId: row.event_id,
			...this.toCommittedEvent(row),
			attempts: row.attempts,
		};
	}

	private toDeadLetter(row: OutboxRow): DeadLetterRecord<Evt> {
		return {
			dispatchId: row.event_id,
			...this.toCommittedEvent(row),
			attempts: row.attempts,
			...(row.last_error === null ? {} : { lastError: row.last_error }),
		};
	}

	private toCommittedEvent(row: OutboxRow) {
		const source = {
			aggregateType: row.aggregate_type,
			aggregateId: row.aggregate_id,
		};
		return {
			event: decodeStoredEvent(row, source, this.codec),
			source,
			position: {
				aggregateVersion: Number(row.aggregate_version),
				commitSequence: row.commit_sequence,
				commitSize: row.commit_size,
				previousEventfulAggregateVersion:
					row.previous_eventful_aggregate_version === null
						? null
						: Number(row.previous_eventful_aggregate_version),
			},
		};
	}
}

/** Writes one candidate. The lock on the source head serializes its writers. */
async function addOne<Evt extends AnyDomainEvent>(
	candidate: EventCommitCandidate<Evt>,
	event: AnyDomainEvent,
	tx: PgQueryExecutor,
): Promise<void> {
	const { source, position } = candidate;
	await tx.query(
		`INSERT INTO ddd_kit_outbox_source_head (aggregate_type, aggregate_id)
		VALUES ($1, $2)
		ON CONFLICT DO NOTHING`,
		[source.aggregateType, source.aggregateId],
	);
	const { rows: heads } = await tx.query<{
		readonly head: string | null;
		readonly last_commit_event_ids: ReadonlyArray<string>;
		readonly ended: boolean;
	}>(
		`SELECT
			last_eventful_aggregate_version::text AS head,
			last_commit_event_ids,
			ended
		FROM ddd_kit_outbox_source_head
		WHERE aggregate_type = $1 AND aggregate_id = $2
		FOR UPDATE`,
		[source.aggregateType, source.aggregateId],
	);
	const headRow = heads[0];
	const head = headRow?.head == null ? null : Number(headRow.head);

	const { rows: existing } = await tx.query<{
		readonly aggregate_type: string;
		readonly aggregate_id: string;
		readonly aggregate_version: string;
		readonly commit_sequence: number;
		readonly commit_size: number;
	}>(
		`SELECT
			aggregate_type,
			aggregate_id,
			aggregate_version::text AS aggregate_version,
			commit_sequence,
			commit_size
		FROM ddd_kit_outbox
		WHERE event_id = $1`,
		[event.eventId],
	);
	const stored = existing[0];
	if (stored !== undefined) {
		const isExactRetry =
			stored.aggregate_type === source.aggregateType &&
			stored.aggregate_id === source.aggregateId &&
			Number(stored.aggregate_version) === position.aggregateVersion &&
			stored.commit_sequence === position.commitSequence &&
			stored.commit_size === position.commitSize;
		if (isExactRetry) return;
		throw rejected(
			event,
			"its id already identifies another event, at another source or position",
		);
	}

	// The record of the head commit can be gone after a purge. The head still
	// names its events, so a retry of one stays a retry.
	if (
		position.aggregateVersion === head &&
		headRow?.last_commit_event_ids.includes(event.eventId)
	) {
		return;
	}

	if (headRow?.ended === true) {
		throw rejected(
			event,
			"the aggregate was removed, so its event source ended. Give a new " +
				"aggregate a new id",
		);
	}
	if (head !== null && position.aggregateVersion < head) {
		throw rejected(
			event,
			`its aggregate version ${position.aggregateVersion} is below the head ` +
				`${head} of the event source`,
		);
	}

	let predecessor = head;
	if (position.aggregateVersion === head) {
		const { rows: commit } = await tx.query<{
			readonly event_id: string;
			readonly commit_sequence: number;
			readonly commit_size: number;
			readonly previous: string | null;
		}>(
			`SELECT
				event_id,
				commit_sequence,
				commit_size,
				previous_eventful_aggregate_version::text AS previous
			FROM ddd_kit_outbox
			WHERE aggregate_type = $1 AND aggregate_id = $2 AND aggregate_version = $3`,
			[source.aggregateType, source.aggregateId, position.aggregateVersion],
		);
		const sibling = commit[0];
		if (sibling !== undefined) {
			if (sibling.commit_size !== position.commitSize) {
				throw rejected(
					event,
					`aggregate version ${position.aggregateVersion} has commit size ` +
						`${sibling.commit_size}, not ${position.commitSize}`,
				);
			}
			const owner = commit.find(
				(row) => row.commit_sequence === position.commitSequence,
			);
			if (owner !== undefined) {
				throw rejected(
					event,
					`event "${owner.event_id}" already owns its source position`,
				);
			}
			predecessor = sibling.previous === null ? null : Number(sibling.previous);
		} else {
			throw rejected(
				event,
				`aggregate version ${position.aggregateVersion} is the head of its ` +
					"event source, and the head names other events",
			);
		}
	}

	await tx.query(
		`INSERT INTO ddd_kit_outbox (
			event_id, aggregate_type, aggregate_id, aggregate_version, commit_sequence,
			commit_size, previous_eventful_aggregate_version, event_type,
			schema_version, occurred_at, payload, metadata
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb)`,
		[
			event.eventId,
			source.aggregateType,
			source.aggregateId,
			position.aggregateVersion,
			position.commitSequence,
			position.commitSize,
			predecessor,
			event.type,
			event.schemaVersion,
			event.occurredAt.toISOString(),
			JSON.stringify(event.payload),
			JSON.stringify(event.metadata),
		],
	);
	await tx.query(
		`UPDATE ddd_kit_outbox_source_head
		SET
			last_commit_event_ids = CASE
				WHEN last_eventful_aggregate_version = $3
					THEN array_append(last_commit_event_ids, $4::text)
				ELSE ARRAY[$4::text]
			END,
			last_eventful_aggregate_version = $3
		WHERE aggregate_type = $1 AND aggregate_id = $2`,
		[
			source.aggregateType,
			source.aggregateId,
			position.aggregateVersion,
			event.eventId,
		],
	);
}

function positiveInteger(name: string, value: number): number {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new RangeError(
			`PgOutbox: ${name} must be a positive integer, got ${String(value)}`,
		);
	}
	return value;
}

function rejected(
	event: AnyDomainEvent,
	reason: string,
): KitWiringError<"EVENT_COLLECTION_FAILED"> {
	return new KitWiringError({
		code: "EVENT_COLLECTION_FAILED",
		message: `PgOutbox rejected event "${event.eventId}": ${reason}.`,
		details: { eventId: event.eventId, eventType: event.type },
	});
}
