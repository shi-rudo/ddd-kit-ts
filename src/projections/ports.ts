import type { AnyDomainEvent } from "../aggregate/domain-event";

/**
 * A projection's cursor into one aggregate's event sequence: the
 * `(aggregateVersion, commitSequence)` pair `withCommit` stamps on
 * every harvested event. Lexicographically ordered, it is a total
 * order per aggregate and a compact per-event watermark; see
 * `DomainEvent.aggregateVersion` / `DomainEvent.commitSequence`.
 */
export interface ProjectionPosition {
	aggregateVersion: number;
	commitSequence: number;
}

/**
 * `true` when `candidate` comes strictly after `reference` in the
 * per-aggregate total order (higher version, or same version and
 * higher commit sequence).
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
 */
export interface AggregateAddress {
	readonly aggregateType: string;
	readonly aggregateId: string;
}

/**
 * Driven port for projection checkpoints: the per-`(projection,
 * aggregateType, aggregateId)` watermark that makes a projection
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
	 * The stored watermark for `(projection, address)`, or `undefined`
	 * when this projection has never applied an event of that
	 * aggregate. Called inside the projector's transaction.
	 */
	load(
		ctx: TCtx,
		projection: string,
		address: AggregateAddress,
	): Promise<ProjectionPosition | undefined>;

	/**
	 * Persists the watermark, overwriting a previous one (last write
	 * wins; the projector only calls this with advancing positions).
	 * Called inside the projector's transaction, after the read-model
	 * update it accounts for.
	 */
	save(
		ctx: TCtx,
		projection: string,
		address: AggregateAddress,
		position: ProjectionPosition,
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
	 * retains stale rows).
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
