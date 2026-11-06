import type { AnyDomainEvent } from "@shirudo/ddd-kit";

/**
 * The mapping between a domain event and the event that a table keeps. The
 * table holds JSON, and JSON does not keep a `Date`, a `Map`, a `Set`, a
 * `bigint`, or `undefined` inside a payload. An application that uses such a
 * value maps it here, per event type. Upcasting runs in `decode`.
 *
 * Keep the mapping one-to-one: the stream counts one version per stored event.
 */
export interface PgEventCodec<Evt extends AnyDomainEvent> {
	/** Returns the event to store. Its payload and metadata must be JSON. */
	encode(event: Evt): AnyDomainEvent;
	/** Returns the current domain event for a stored event of any schema version. */
	decode(stored: AnyDomainEvent): Evt;
}
