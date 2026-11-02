import {
	type AggregateIdentity,
	type AnyDomainEvent,
	ConcurrencyConflictError,
	DuplicateAggregateError,
	type EventStore,
	type EventStoreAppendOptions,
	KitWiringError,
	type ReadStreamOptions,
	type StreamReadResult,
} from "@shirudo/ddd-kit";
import { PgEventStreamCorruptError } from "./pg-errors";
import type { PgEventCodec } from "./pg-event-codec";
import type { PgQueryExecutor } from "./pg-query-executor";
import { rejectOnAbort } from "./reject-on-abort";
import {
	decodeStoredEvent,
	encodeStoredEvent,
	type StoredEventRow,
	storedEventColumns,
} from "./stored-event";

/** SQLSTATE `unique_violation`: another writer took a stream position first. */
const UNIQUE_VIOLATION = "23505";

export interface PgEventStoreOptions<Evt extends AnyDomainEvent> {
	/** Maps events to JSON and back. Without it, payloads must already be JSON. */
	readonly codec?: PgEventCodec<Evt> | undefined;
}

interface EventStreamRow extends StoredEventRow {
	/** `NULL` for an absent stream. */
	readonly last_version: string | null;
	/** `NULL` when the requested window of the stream is empty. */
	readonly position: string | null;
}

/**
 * An event store on the executor of one transaction, so an append joins that
 * transaction. Build it inside the callback of the scope. Run
 * `sql/event-stream.sql` to create the table.
 *
 * The table keeps JSON. `append` rejects a payload or metadata that JSON does
 * not keep exactly. Use a {@link PgEventCodec} to map such a value.
 *
 * A read returns the stream identity on each event, because the table keeps the
 * identity once per row. So `append` rejects an event of another aggregate.
 *
 * An abort signal stops the wait of a read, not the statement on the
 * connection. Set `statement_timeout` to bound a statement that hangs.
 */
export class PgEventStore<Evt extends AnyDomainEvent>
	implements EventStore<Evt>
{
	constructor(
		private readonly executor: PgQueryExecutor,
		private readonly options: PgEventStoreOptions<Evt> = {},
	) {}

	async append(
		stream: AggregateIdentity,
		events: ReadonlyArray<Evt>,
		{ expectedVersion }: EventStoreAppendOptions,
	): Promise<void> {
		if (events.length === 0) return;
		const stored = events.map((event, index) =>
			this.encodeForAppend(stream, event, index),
		);

		const { rows } = await this.executor.query<{ head: string | null }>(
			`SELECT max(position)::text AS head
			FROM ddd_kit_event_stream
			WHERE aggregate_type = $1 AND aggregate_id = $2`,
			[stream.aggregateType, stream.aggregateId],
		);
		const head = Number(rows[0]?.head ?? 0);
		if (head !== expectedVersion) {
			if (expectedVersion === 0) {
				throw new DuplicateAggregateError({ identity: stream });
			}
			throw new ConcurrencyConflictError({
				identity: stream,
				expectedVersion,
				reason: "stale_version",
				actualVersion: head,
			});
		}

		try {
			await this.executor.query(
				`INSERT INTO ddd_kit_event_stream (
					aggregate_type, aggregate_id, position, event_id, event_type,
					schema_version, occurred_at, payload, metadata
				)
				SELECT
					$1, $2, $3::bigint + row.ordinality, row.event_id, row.event_type,
					row.schema_version, row.occurred_at, row.payload::jsonb,
					row.metadata::jsonb
				FROM unnest(
					$4::text[], $5::text[], $6::int[], $7::timestamptz[], $8::text[],
					$9::text[]
				) WITH ORDINALITY AS row(
					event_id, event_type, schema_version, occurred_at, payload, metadata,
					ordinality
				)`,
				[
					stream.aggregateType,
					stream.aggregateId,
					expectedVersion,
					stored.map((event) => event.eventId),
					stored.map((event) => event.type),
					stored.map((event) => event.schemaVersion),
					stored.map((event) => event.occurredAt.toISOString()),
					stored.map((event) => JSON.stringify(event.payload)),
					stored.map((event) => JSON.stringify(event.metadata)),
				],
			);
		} catch (error) {
			if ((error as { code?: unknown }).code !== UNIQUE_VIOLATION) throw error;
			// The failed statement aborted the transaction, so the head cannot be
			// read any more.
			if (expectedVersion === 0) {
				throw new DuplicateAggregateError({ identity: stream, cause: error });
			}
			throw new ConcurrencyConflictError({
				identity: stream,
				expectedVersion,
				reason: "version_unknown",
				cause: error,
			});
		}
	}

	/**
	 * Deletes the whole stream in the transaction of the executor, for example
	 * to erase personal data. The version guard rejects a stream that changed
	 * after the load. Delete a snapshot of the aggregate first. A removed identity
	 * stays removed: give a new aggregate a new id.
	 */
	async removeStream(
		stream: AggregateIdentity,
		{ expectedVersion }: EventStoreAppendOptions,
	): Promise<void> {
		const { rows } = await this.executor.query<{ head: string | null }>(
			`SELECT max(position)::text AS head
			FROM ddd_kit_event_stream
			WHERE aggregate_type = $1 AND aggregate_id = $2`,
			[stream.aggregateType, stream.aggregateId],
		);
		const head = Number(rows[0]?.head ?? 0);
		if (head !== expectedVersion) {
			throw new ConcurrencyConflictError({
				identity: stream,
				expectedVersion,
				reason: "stale_version",
				actualVersion: head,
			});
		}
		await this.executor.query(
			`DELETE FROM ddd_kit_event_stream
			WHERE aggregate_type = $1 AND aggregate_id = $2`,
			[stream.aggregateType, stream.aggregateId],
		);
	}

	private encodeForAppend(
		stream: AggregateIdentity,
		event: Evt,
		index: number,
	): AnyDomainEvent {
		const subject = `PgEventStore.append events[${index}]`;
		const isForeign =
			(event.aggregateType !== undefined &&
				event.aggregateType !== stream.aggregateType) ||
			(event.aggregateId !== undefined &&
				event.aggregateId !== stream.aggregateId);
		if (isForeign) {
			throw new KitWiringError({
				code: "MISATTRIBUTED_EVENT",
				message:
					`${subject} belongs to ${event.aggregateType}/${event.aggregateId}, ` +
					`not to the stream ${stream.aggregateType}/${stream.aggregateId}. ` +
					"Append an event to the stream of its aggregate.",
				details: { eventId: event.eventId, eventType: event.type },
			});
		}
		return encodeStoredEvent(event, this.options.codec, subject);
	}

	async readStream(
		stream: AggregateIdentity,
		options: ReadStreamOptions,
	): Promise<StreamReadResult<Evt>> {
		assertPositiveLimit(options?.limit);
		assertStreamPosition("fromVersion", options.fromVersion);
		assertStreamPosition("toVersion", options.toVersion);
		const fromVersion = options.fromVersion ?? 0;
		options.signal?.throwIfAborted();

		// One statement is one view of the stream, so the head and the page agree.
		const { rows } = await rejectOnAbort(
			this.executor.query<EventStreamRow>(
				`WITH head AS (
					SELECT max(position) AS last_version
					FROM ddd_kit_event_stream
					WHERE aggregate_type = $1 AND aggregate_id = $2
				)
				SELECT
					head.last_version::text AS last_version,
					event.position::text AS position,
					${storedEventColumns("event")}
				FROM head
				LEFT JOIN ddd_kit_event_stream AS event
					ON event.aggregate_type = $1
					AND event.aggregate_id = $2
					AND event.position > $3::bigint
					AND ($4::bigint IS NULL OR event.position <= $4::bigint)
				ORDER BY event.position
				LIMIT $5::bigint`,
				[
					stream.aggregateType,
					stream.aggregateId,
					fromVersion,
					options.toVersion ?? null,
					options.limit,
				],
			),
			options.signal,
		);

		const lastVersion = rows[0]?.last_version ?? null;
		if (lastVersion === null) {
			return { exists: false, lastVersion: 0, events: [] };
		}
		const pageRows = rows.filter((row) => row.position !== null);
		pageRows.forEach((row, index) => {
			const expected = fromVersion + index + 1;
			if (Number(row.position) !== expected) {
				throw new PgEventStreamCorruptError({
					identity: stream,
					expectedPosition: expected,
					actualPosition: Number(row.position),
				});
			}
		});
		return {
			exists: true,
			lastVersion: Number(lastVersion),
			events: pageRows.map((row) =>
				decodeStoredEvent(row, stream, this.options.codec),
			),
		};
	}
}

function assertPositiveLimit(limit: unknown): void {
	if (!Number.isSafeInteger(limit) || (limit as number) < 1) {
		throw new RangeError(
			`PgEventStore: limit must be a positive safe integer, got ${String(limit)}`,
		);
	}
}

function assertStreamPosition(
	name: "fromVersion" | "toVersion",
	value: number | undefined,
): void {
	if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
		throw new RangeError(
			`PgEventStore: ${name} must be a non-negative safe integer, got ${String(value)}`,
		);
	}
}
