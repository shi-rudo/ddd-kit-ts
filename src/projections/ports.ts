import type { AnyDomainEvent } from "../aggregate/domain-event";
import type { AggregateEventSource, CommitPosition } from "../events/ports";

/**
 * A projection's gap-proof cursor into one aggregate's commit chain.
 * `aggregateVersion` plus `commitSequence` orders events; `commitSize`
 * proves the current commit is complete; `previousEventfulAggregateVersion`
 * links the next commit to the eventful predecessor. `withCommit` supplies
 * the current commit facts; the event source finalizes the predecessor on the
 * surrounding `CommittedDomainEvent`.
 *
 * A source MUST map exactly one logical event to each position. Custom
 * envelopes may translate another store's cursor into these fields, but
 * mapping two different eventIds to one position destroys the proof and
 * is a source-adapter bug.
 */
export type ProjectionPosition = CommitPosition;

/**
 * Durable receipt for the last event one projection applied from an aggregate
 * stream. The position answers "how far?"; `lastAppliedEventId` identifies the
 * event at exactly that watermark. Together they let the projector distinguish
 * a true watermark redelivery from a source mapping a different event to the
 * same position. Older positions still rely on the source's one-event-per-
 * position contract because a checkpoint deliberately retains no full history.
 */
export interface ProjectionCheckpoint {
	readonly position: ProjectionPosition;
	readonly lastAppliedEventId: string;
}

/**
 * `true` when `candidate` comes strictly after `reference` in the
 * per-aggregate tuple order (higher version, or same version and higher
 * commit sequence). This comparison alone does not prove continuity;
 * the projector checks the boundary fields before advancing.
 */
export function isPositionAfter(
	candidate: ProjectionPosition,
	reference: ProjectionPosition,
): boolean {
	if (candidate.aggregateVersion !== reference.aggregateVersion) {
		return candidate.aggregateVersion > reference.aggregateVersion;
	}
	return candidate.commitSequence > reference.commitSequence;
}

/**
 * The address of one aggregate instance as checkpoints key it: the
 * kit's identities are type-scoped (`Id<"OrderId">` brands say so),
 * so `Order 1` and `Payment 1` are different aggregates even when the
 * raw id strings collide. Both fields come from the stamps every
 * committed event carries. `aggregateType` is thereby part of the
 * checkpoint contract: renaming an aggregate type orphans its
 * checkpoints, so treat the string as a stable identifier and migrate
 * checkpoint rows deliberately when it must change.
 *
 * `aggregateType` is a TECHNICAL stream category and must be unique
 * across everything feeding one checkpoint store, not just within one
 * bounded context. Contexts may reuse the same ubiquitous-language
 * name (a Sales `Order` and a Fulfillment `Order` are different
 * models); when their events share projection infrastructure, qualify
 * the string at the source ("sales.order", "fulfillment.order"). The
 * kit deliberately adds no `boundedContext` field: the address stays
 * two fields, and the qualification is the consumer's naming decision
 * (same field-accretion line as on `DomainEvent`).
 */
export type AggregateAddress = AggregateEventSource;

/**
 * Canonical map-key encoding for an {@link AggregateAddress}: a JSON
 * tuple, so no separator-like character inside either half (both are
 * arbitrary JS strings) can make two different addresses collide.
 * Module-internal export shared by the projector's batch-local maps
 * and the in-memory checkpoint store; SQL adapters key on the columns
 * themselves and never need it.
 */
export function addressKey(address: AggregateAddress): string {
	return JSON.stringify([address.aggregateType, address.aggregateId]);
}

/**
 * Driven port for projection checkpoints: the per-`(projection,
 * aggregateType, aggregateId)` watermark receipt that makes a projection
 * idempotent and rebuild-safe. The {@link ProjectionCheckpointStore.load} /
 * {@link ProjectionCheckpointStore.save} half runs inside the SAME
 * transaction as the read-model update (the `Projector` guarantees
 * the pairing); the store itself is a dumb last-write-wins record,
 * monotonicity is the projector's job.
 *
 * Production adapters put the checkpoint table in the same database
 * as the read model, so update and checkpoint commit atomically: a
 * checkpoint without its update loses events, an update without its
 * checkpoint replays work. Verify an adapter with
 * `createProjectionCheckpointStoreContractTests` from
 * `@shirudo/ddd-kit/testing`.
 *
 * @template TCtx - The transaction context of the ambient
 * `TransactionScope` (a knex trx, a drizzle tx, a pg client)
 */
export interface ProjectionCheckpointStore<TCtx = unknown> {
	/**
	 * The stored watermark receipt for `(projection, address)`, or `undefined`
	 * when this projection has never applied an event of that
	 * aggregate. Called inside the projector's transaction.
	 */
	load(
		ctx: TCtx,
		projection: string,
		address: AggregateAddress,
	): Promise<ProjectionCheckpoint | undefined>;

	/**
	 * Persists the watermark receipt, overwriting a previous one (last write
	 * wins; the projector only calls this with advancing checkpoints).
	 * Called inside the projector's transaction, after the read-model
	 * update it accounts for.
	 */
	save(
		ctx: TCtx,
		projection: string,
		address: AggregateAddress,
		checkpoint: ProjectionCheckpoint,
	): Promise<void>;

	/**
	 * The wait-for-version building block: `true` when the stored
	 * watermark for `(projection, address)` is at or past
	 * `position`. Runs OUTSIDE any transaction (a query-side poll).
	 *
	 * Pass the position of the LAST event your commit emitted: all
	 * events of one commit share the `aggregateVersion`, so comparing
	 * on the version alone would report "reached" while later events
	 * of the same commit are still unapplied.
	 */
	hasReached(
		projection: string,
		address: AggregateAddress,
		position: ProjectionPosition,
	): Promise<boolean>;

	/**
	 * Deletes every checkpoint of `projection` (other projections'
	 * checkpoints are untouched): the rebuild entry point. Called
	 * inside the rebuild transaction, together with the projection's
	 * `truncate`, so a rebuild starts from a consistent zero.
	 */
	reset(ctx: TCtx, projection: string): Promise<void>;
}

/**
 * One projection: the consumer-owned mapping from events to ONE read
 * model (one table/view per projection; run several `Projector`s for
 * several read shapes). The kit owns the mechanics around it
 * (cursor skip, atomic checkpointing, rebuild); the handler owns the
 * read-model writes.
 *
 * The projector feed MUST contain every committed envelope for each aggregate
 * address it carries, including event types this read model does not use.
 * Handle those events as explicit no-ops in `apply`: the projector still
 * advances their cursor. Filtering a broker subscription by event type drops
 * positions from the source chain and turns the next commit into a real gap.
 */
export interface Projection<Evt extends AnyDomainEvent, TCtx = unknown> {
	/**
	 * Stable unique name; keys the checkpoints. Renaming it orphans the
	 * old checkpoints and replays everything under the new name.
	 */
	name: string;

	/**
	 * Applies ONE event's read-model change inside the ambient
	 * transaction. The projector's cursor already filtered duplicates
	 * and stale events, so plain writes are safe; route on
	 * `event.type` and handle creates, updates, deletes, corrections,
	 * and tombstones explicitly (an upsert-only handler silently
	 * retains stale rows). For a known event type this projection does not use,
	 * return without writing; that explicit no-op still consumes and checkpoints
	 * the envelope's source position.
	 *
	 * MUST be side-effect-free beyond the read model: no mails, no
	 * external calls, no commands. A rebuild replays every event; side
	 * effects would fire again.
	 */
	apply(ctx: TCtx, event: Evt): Promise<void>;

	/**
	 * Optional: clears the read model, called by `Projector.reset()`
	 * in the same transaction as the checkpoint reset, so a rebuild
	 * never observes a half-cleared state. Without it, truncating the
	 * read model before a rebuild is the caller's responsibility.
	 */
	truncate?(ctx: TCtx): Promise<void>;
}
