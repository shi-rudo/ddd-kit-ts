import type { AnyDomainEvent } from "../aggregate/domain-event";
import { UnprojectableEventError } from "../core/errors";
import type { OutboxSink } from "../events/outbox-dispatcher";
import type { TransactionScope } from "../repo/scope";
import {
	type AggregateAddress,
	addressKey,
	isPositionAfter,
	type Projection,
	type ProjectionCheckpointStore,
	type ProjectionPosition,
} from "./ports";

/** Construction options for {@link Projector}. */
export interface ProjectorOptions<Evt extends AnyDomainEvent, TCtx> {
	/**
	 * The transaction boundary that makes read-model update and
	 * checkpoint atomic. Wire the SAME scope (same database) the
	 * read model and the checkpoint table live in.
	 */
	scope: TransactionScope<TCtx>;

	/** The checkpoint store; see {@link ProjectionCheckpointStore}. */
	checkpoints: ProjectionCheckpointStore<TCtx>;

	/** The consumer-owned event-to-read-model mapping. */
	projection: Projection<Evt, TCtx>;

	/**
	 * Cursor extractor for sources with their own ordering. The default
	 * reads the `(aggregateVersion, commitSequence)` stamps `withCommit`
	 * puts on every harvested event; an event-sourced stream replayed
	 * from a store supplies its own extractor (the store's position is
	 * the authority there, see the outbox guide). Returning `undefined`
	 * means "this event has no cursor" and makes `project` reject
	 * loudly: an uncursored event cannot be deduped or ordered, and
	 * silently applying it would break idempotency on redelivery.
	 */
	position?: (event: Evt) => ProjectionPosition | undefined;
}

/** Outcome of one {@link Projector.project} batch. */
export interface ProjectionBatchResult {
	/** Events applied and checkpointed in this batch. */
	applied: number;
	/** Events skipped as duplicates or stale (at or behind the watermark). */
	skipped: number;
}

function defaultPosition(
	event: AnyDomainEvent,
): ProjectionPosition | undefined {
	const { aggregateVersion, commitSequence } = event;
	if (aggregateVersion === undefined || commitSequence === undefined) {
		return undefined;
	}
	return { aggregateVersion, commitSequence };
}

/**
 * The projection runner: applies event batches to ONE projection with
 * the mechanics `read-model-design.md` demands, so the consumer's
 * {@link Projection.apply} can be a plain mapping.
 *
 * Contract:
 *
 * - **Update and checkpoint commit atomically.** One batch runs in one
 *   `TransactionScope` transaction; each advanced aggregate's watermark
 *   is saved once, inside that transaction, after its events applied. A
 *   failure anywhere rolls back the WHOLE batch (updates and
 *   checkpoints together), so redelivery replays it from the previous
 *   watermark. It is never possible to checkpoint an unapplied event or
 *   apply an uncheckpointed one, and a retrying scope re-runs the
 *   callback from zero (counts included).
 * - **In-order delivery per aggregate is a PRECONDITION, not something
 *   the watermark creates.** The watermark only recognizes positions at
 *   or behind itself; it cannot tell a redelivered duplicate from a
 *   straggler that was never applied, so under a feed that reorders
 *   events of ONE aggregate, a late-arriving earlier event is dropped
 *   and the read model stays permanently wrong. Compliant feeds: the
 *   kit's `OutboxDispatcher` (sequential, stop-on-failure), a broker
 *   partitioned or FIFO-keyed by the aggregate address, or an
 *   event-store replay in stream order via the `position` extractor.
 *   A transport without per-aggregate ordering needs a resequencer in
 *   front of the projector, or a rebuild as the remediation.
 * - **Duplicates and stale events are skipped via the cursor.** An
 *   event at or behind the stored `(aggregateVersion, commitSequence)`
 *   watermark of its aggregate is counted as skipped, not applied:
 *   under the ordering precondition above, everything below the
 *   watermark is at-least-once redelivery, absorbed here instead of in
 *   every handler.
 * - **Uncursored events reject loudly.** An event without stamps (and
 *   no custom `position` extractor covering it), or without an
 *   `aggregateId` / `aggregateType`, fails the batch BEFORE anything
 *   is applied; see {@link ProjectorOptions.position}.
 * - **One logical projector instance per projection.** The cursor
 *   check-then-apply is not concurrency-safe across competing
 *   instances unless the adapter serializes it (row lock on the
 *   checkpoint row); same rule as the outbox dispatcher.
 *
 * Feeding: hand batches to {@link Projector.project} from any source
 * (an outbox poll, a queue consumer, a replay), or wire the projector
 * straight into an `OutboxDispatcher` via {@link Projector.toOutboxSink}.
 *
 * Rebuild: {@link Projector.reset} clears checkpoints and (when the
 * projection provides `truncate`) the read model in one transaction;
 * then replay the source through `project` again. Rebuild-safety is
 * exactly why {@link Projection.apply} must be side-effect-free.
 */
export class Projector<Evt extends AnyDomainEvent, TCtx = unknown> {
	private readonly scope: TransactionScope<TCtx>;
	private readonly checkpoints: ProjectionCheckpointStore<TCtx>;
	private readonly projection: Projection<Evt, TCtx>;
	private readonly position: (event: Evt) => ProjectionPosition | undefined;

	constructor(options: ProjectorOptions<Evt, TCtx>) {
		this.scope = options.scope;
		this.checkpoints = options.checkpoints;
		this.projection = options.projection;
		this.position = options.position ?? defaultPosition;
	}

	/**
	 * Applies one batch: one transaction, per event a cursor check and
	 * `apply`, then one checkpoint save per advanced aggregate. Rejects
	 * (after rollback) when a handler throws or an event carries no
	 * cursor; the caller's at-least-once redelivery retries the batch.
	 */
	async project(events: ReadonlyArray<Evt>): Promise<ProjectionBatchResult> {
		// Validate cursors BEFORE opening the transaction: a malformed
		// batch must not burn a transaction or apply a prefix.
		const cursored = events.map((event) => {
			const position = this.position(event);
			if (position === undefined) {
				throw new UnprojectableEventError(
					this.projection.name,
					event.eventId,
					"carries no (aggregateVersion, commitSequence) cursor. Events written " +
						"by withCommit are stamped automatically; for other sources supply " +
						"the 'position' extractor. An uncursored event cannot be deduped " +
						"or ordered.",
				);
			}
			const { aggregateId, aggregateType } = event;
			if (aggregateId === undefined || aggregateType === undefined) {
				throw new UnprojectableEventError(
					this.projection.name,
					event.eventId,
					"carries no aggregateId/aggregateType; the checkpoint watermark " +
						"is keyed per (aggregateType, aggregateId), because ids are " +
						"type-scoped. Events written by withCommit carry both stamps.",
				);
			}
			const address: AggregateAddress = { aggregateType, aggregateId };
			return { event, position, address };
		});

		// Everything mutable lives INSIDE the transactional callback: a
		// retrying scope re-runs it from zero, so a rolled-back attempt
		// can never leak counts or watermarks into the next one.
		return this.scope.transactional(async (ctx) => {
			let applied = 0;
			let skipped = 0;
			// The batch watermark is tracked here, not re-read from the
			// store per event: one load per aggregate, one save per
			// advanced aggregate, and no dependence on the store's
			// read-your-writes behavior inside the open transaction (an
			// adapter that stages writes until commit is equally correct).
			const watermarks = new Map<string, ProjectionPosition | undefined>();
			const advanced = new Map<string, AggregateAddress>();
			for (const { event, position, address } of cursored) {
				const key = addressKey(address);
				let watermark: ProjectionPosition | undefined;
				if (watermarks.has(key)) {
					watermark = watermarks.get(key);
				} else {
					watermark = await this.checkpoints.load(
						ctx,
						this.projection.name,
						address,
					);
					watermarks.set(key, watermark);
				}
				if (watermark !== undefined && !isPositionAfter(position, watermark)) {
					skipped += 1;
					continue;
				}
				await this.projection.apply(ctx, event);
				watermarks.set(key, position);
				advanced.set(key, address);
				applied += 1;
			}
			for (const [key, address] of advanced) {
				const position = watermarks.get(key);
				if (position !== undefined) {
					await this.checkpoints.save(
						ctx,
						this.projection.name,
						address,
						position,
					);
				}
			}
			return { applied, skipped };
		});
	}

	/**
	 * The wait-for-version query: `true` when this projection has
	 * processed the addressed aggregate at least up to `position`. Pass the
	 * position of the last event the awaited commit emitted (see
	 * {@link ProjectionCheckpointStore.hasReached} for why the full
	 * pair, not just the version).
	 */
	hasProcessed(
		address: AggregateAddress,
		position: ProjectionPosition,
	): Promise<boolean> {
		return this.checkpoints.hasReached(this.projection.name, address, position);
	}

	/**
	 * Rebuild entry point: one transaction that clears this
	 * projection's checkpoints and, when the projection provides
	 * `truncate`, the read model with them. Replay the source through
	 * {@link Projector.project} afterwards.
	 */
	async reset(): Promise<void> {
		await this.scope.transactional(async (ctx) => {
			await this.projection.truncate?.(ctx);
			await this.checkpoints.reset(ctx, this.projection.name);
		});
	}

	/**
	 * Adapts this projector as an `OutboxSink`, so an `OutboxDispatcher`
	 * can feed it directly: each record becomes a single-event batch
	 * (apply + checkpoint in its own transaction), a throw leaves the
	 * record pending for the dispatcher's retry/dead-letter mechanics.
	 * Duplicates the dispatcher redelivers are absorbed by the cursor.
	 *
	 * **Dead-lettering a projection event leaves a permanent hole.**
	 * With a `DispatchTrackingOutbox`, a poison event dead-letters and
	 * LATER events of the same aggregate advance the watermark past it.
	 * The cursor cannot distinguish "already applied" from "never
	 * applied", so redelivering the dead letter afterwards is a silent
	 * skip, and applying it out of order would be wrong anyway. The
	 * remediation for a dead-lettered projection event is a rebuild
	 * (`reset()` + replay) or a manual read-model correction, which is
	 * why `deadLetters()` alerting matters doubly for projections. With
	 * a plain `Outbox`, the poison event instead blocks the queue: the
	 * read model stalls but stays consistent. Pick the trade-off
	 * deliberately.
	 */
	toOutboxSink(): OutboxSink<Evt> {
		return {
			publish: async (record) => {
				await this.project([record.event]);
			},
		};
	}
}
