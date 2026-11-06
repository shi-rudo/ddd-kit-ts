import {
	type AggregateIdentity,
	type AnyDomainEvent,
	assertJsonSafe,
} from "@shirudo/ddd-kit";
import { PgEventDecodeError } from "./pg-errors";
import type { PgEventCodec } from "./pg-event-codec";

/** The columns of an event that both the stream table and the outbox table keep. */
export interface StoredEventRow {
	readonly event_id: string;
	readonly event_type: string;
	readonly schema_version: number;
	readonly occurred_at: Date;
	/** `jsonb` as text, because `pg` parses SQL NULL and JSON null to the same value. */
	readonly payload: string | null;
	readonly metadata: string | null;
}

/** The select list of {@link StoredEventRow} for a table alias. */
export const storedEventColumns = (alias: string): string =>
	`${alias}.event_id, ${alias}.event_type, ${alias}.schema_version, ` +
	`${alias}.occurred_at, ${alias}.payload::text AS payload, ` +
	`${alias}.metadata::text AS metadata`;

/**
 * Maps an event to the event that a table keeps, and rejects a value that JSON
 * does not keep exactly. A table keeps JSON, so it would otherwise change the
 * value without an error.
 */
export function encodeStoredEvent<Evt extends AnyDomainEvent>(
	event: Evt,
	codec: PgEventCodec<Evt> | undefined,
	subject: string,
): AnyDomainEvent {
	if (typeof event.eventId !== "string" || event.eventId === "") {
		throw new TypeError(
			`${subject} has no eventId. Stamp the event before the write: the ` +
				"commit stamps it when a write registers its aggregate, and " +
				"stampPendingEvents stamps it before that.",
		);
	}
	const stored = codec?.encode(event) ?? event;
	if (stored.eventId !== event.eventId) {
		throw new TypeError(
			`${subject}: the codec changed the eventId from "${event.eventId}" to ` +
				`"${String(stored.eventId)}". Keep the eventId in encode: a retry ` +
				"finds its stored event by that id.",
		);
	}
	if (stored.payload !== undefined) {
		assertJsonSafe(stored.payload, `${subject} payload`);
	}
	if (stored.metadata !== undefined) {
		assertJsonSafe(stored.metadata, `${subject} metadata`);
	}
	return stored;
}

/** Builds the domain event of a row. The source is the identity of the row. */
export function decodeStoredEvent<Evt extends AnyDomainEvent>(
	row: StoredEventRow,
	source: AggregateIdentity,
	codec: PgEventCodec<Evt> | undefined,
): Evt {
	const stored: AnyDomainEvent = {
		eventId: row.event_id,
		type: row.event_type,
		aggregateType: source.aggregateType,
		aggregateId: source.aggregateId,
		payload: row.payload === null ? undefined : JSON.parse(row.payload),
		occurredAt: row.occurred_at,
		schemaVersion: row.schema_version,
		...(row.metadata === null ? {} : { metadata: JSON.parse(row.metadata) }),
	};
	if (codec === undefined) return stored as Evt;
	try {
		return codec.decode(stored);
	} catch (cause) {
		throw new PgEventDecodeError({
			eventId: row.event_id,
			eventType: row.event_type,
			schemaVersion: row.schema_version,
			identity: source,
			cause,
		});
	}
}
