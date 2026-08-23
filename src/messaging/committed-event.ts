// The envelope that persistence puts around a domain event: where it was
// stored and at which position. Deliberately separate from `DomainEvent`,
// which carries the business fact alone. Outboxes, projectors and the
// integration-message mapper consume this shape; in-process domain
// handlers keep consuming the bare event.
import type { AggregateAddress } from "../domain/aggregate/aggregate-address";
import type { AnyDomainEvent } from "../domain/event/domain-event";

/**
 * Gap-proof position finalized by the event source at the persistence
 * boundary. It is deliberately separate from `DomainEvent`: these values
 * describe a stored commit, not the business fact itself.
 */
export interface CommitPosition {
	/** Aggregate OCC version reached by this eventful commit. */
	readonly aggregateVersion: number;
	/** Zero-based event index inside this aggregate commit. */
	readonly commitSequence: number;
	/** Total number of events emitted by this aggregate commit. */
	readonly commitSize: number;
	/**
	 * Aggregate version of the immediately preceding EVENTFUL commit for this
	 * qualified aggregate source, or `null` when this is its first eventful
	 * commit. State-only persistence is intentionally absent from this chain.
	 *
	 * The outbox/event-store adapter owns this value. It must read and advance
	 * the source head atomically with inserting the committed event envelope;
	 * application orchestration cannot derive it from the Unit of Work's OCC
	 * receipt because state-only commits are intentionally absent here.
	 */
	readonly previousEventfulAggregateVersion: number | null;
}

/**
 * Commit information known by the application transaction before the outbox
 * source has linked this eventful commit to its predecessor.
 */
export type EventCommitCandidatePosition = Omit<
	CommitPosition,
	"previousEventfulAggregateVersion"
>;

/**
 * A bare domain event prepared for the transactional outbox. The outbox source
 * owns the predecessor link and turns this candidate into a
 * {@link CommittedDomainEvent} when it persists the record.
 */
export interface EventCommitCandidate<Evt extends AnyDomainEvent> {
	readonly event: Evt;
	readonly source: AggregateAddress;
	readonly position: EventCommitCandidatePosition;
}

/**
 * A domain event enriched after persistence has established its source and
 * commit position. Outboxes and projectors consume this envelope; in-process
 * domain handlers continue to consume the bare {@link DomainEvent} value.
 */
export interface CommittedDomainEvent<Evt extends AnyDomainEvent> {
	readonly event: Evt;
	readonly source: AggregateAddress;
	readonly position: CommitPosition;
}
