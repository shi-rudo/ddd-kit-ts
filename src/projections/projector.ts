import {
	type AggregateAddress,
	encodeAggregateAddress,
} from "../aggregate/aggregate-address";
import type { AnyDomainEvent } from "../aggregate/domain-event";
import {
	ForeignEventError,
	ProjectionGapError,
	ProjectionIdentityViolationError,
	ProjectionOrderViolationError,
	UnprojectableEventError,
} from "../core/errors";
import type { OutboxSink } from "../events/outbox-dispatcher";
import type { CommittedDomainEvent } from "../events/ports";
import type { TransactionScope } from "../repo/scope";
import {
	isPositionAfter,
	type Projection,
	type ProjectionCheckpoint,
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
}

/** Outcome of one {@link Projector.project} batch. */
export interface ProjectionBatchResult {
	/** Events applied and checkpointed in this batch. */
	applied: number;
	/** Events skipped at positions already traversed under the source contract. */
	skipped: number;
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
 * - **Gaps reject instead of becoming silent skips.** `commitSize`
 *   proves every event in a commit was consumed, while
 *   `previousEventfulAggregateVersion` links the next eventful commit to the
 *   checkpoint. A missing sequence, incomplete commit, missing aggregate
 *   commit, or non-genesis first event throws before its event is applied.
 *   Because checkpoints advance only across a verified chain, a position
 *   at or behind the watermark is already traversed and can be skipped under
 *   the source's one-logical-event-per-position contract.
 * - **Feeds are complete per aggregate address.** Once a feed supplies one
 *   address, it must supply every committed envelope in that address's cursor
 *   chain. Do not event-type-filter a projector subscription. Irrelevant event
 *   types are explicit no-ops in `Projection.apply`; invoking the handler and
 *   checkpointing their positions preserves continuity.
 * - **The watermark carries event identity.** A different `eventId` at the
 *   exact stored watermark, or at one position inside the current batch,
 *   throws {@link ProjectionIdentityViolationError} before `apply`. The
 *   checkpoint deliberately keeps no full position history, so older skips
 *   continue to rely on the source contract rather than claiming an identity
 *   proof the receipt cannot provide.
 * - **Batch inversions reject as transport violations.** Before applying,
 *   the projector scans positions that were still unseen at batch start.
 *   A descending pair for one aggregate throws
 *   {@link ProjectionOrderViolationError}; positions the stored checkpoint
 *   had already covered remain valid late redeliveries.
 * - **Malformed envelopes reject loudly.** A missing/empty `eventId`, a
 *   missing/invalid `position`, missing `source.aggregateId` /
 *   `source.aggregateType`, or an optional event address contradicting its
 *   authoritative envelope source fails the batch BEFORE anything is applied.
 *   The domain event remains persistence-agnostic.
 * - **Competing instances serialize by checkpoint key.** The required
 *   {@link ProjectionCheckpointStore.withCheckpointLocks} callback covers the
 *   complete load / apply / save critical section for every addressed
 *   aggregate. The adapter must lock a key even when its checkpoint row does
 *   not exist yet; a plain row lock is insufficient at genesis. Without that
 *   adapter guarantee, only a hard single-projector deployment is safe.
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

	constructor(options: ProjectorOptions<Evt, TCtx>) {
		this.scope = options.scope;
		this.checkpoints = options.checkpoints;
		this.projection = options.projection;
	}

	/**
	 * Applies one batch: one transaction and one exclusive checkpoint-key
	 * section, per envelope a cursor check and `apply`, then one checkpoint save
	 * per advanced aggregate. Rejects
	 * (after rollback) when a handler throws or an envelope carries no
	 * valid cursor; the caller's at-least-once redelivery retries the batch.
	 * The input must be a complete, ordered feed per aggregate address; an
	 * event-type-filtered subscription cannot satisfy the cursor contract.
	 */
	async project(
		events: ReadonlyArray<CommittedDomainEvent<Evt>>,
	): Promise<ProjectionBatchResult> {
		// Validate cursors BEFORE opening the transaction: a malformed
		// batch must not burn a transaction or apply a prefix.
		const cursored = events.map(({ event, source, position }) => {
			if (typeof event.eventId !== "string" || event.eventId.length === 0) {
				throw new UnprojectableEventError(
					this.projection.name,
					typeof event.eventId === "string" ? event.eventId : "<missing>",
					"carries no non-empty eventId. Projection checkpoints retain the " +
						"event identity at their watermark, so every projectable event must " +
						"have a stable identifier.",
				);
			}
			if (position === undefined) {
				throw new UnprojectableEventError(
					this.projection.name,
					event.eventId,
					"carries no complete projection cursor envelope. Events written " +
						"by withCommit are wrapped automatically; other sources must " +
						"provide source and position explicitly.",
				);
			}
			if (!isValidPosition(position)) {
				throw new UnprojectableEventError(
					this.projection.name,
					event.eventId,
					"carries an invalid projection cursor: aggregateVersion and " +
						"commitSequence must be non-negative integers, commitSize must " +
						"be a positive integer greater than commitSequence, and " +
						"previousEventfulAggregateVersion must be an earlier non-negative " +
						"version or null at genesis.",
				);
			}
			if (source === undefined) {
				throw new UnprojectableEventError(
					this.projection.name,
					event.eventId,
					"carries no aggregateId/aggregateType in its commit envelope source.",
				);
			}
			const { aggregateId, aggregateType } = source;
			if (!aggregateId || !aggregateType) {
				throw new UnprojectableEventError(
					this.projection.name,
					event.eventId,
					"carries no aggregateId/aggregateType; the checkpoint watermark " +
						"is keyed per (aggregateType, aggregateId), because ids are " +
						"type-scoped. Events written by withCommit carry both stamps.",
				);
			}
			const idContradictsSource =
				event.aggregateId !== undefined && event.aggregateId !== aggregateId;
			const typeContradictsSource =
				event.aggregateType !== undefined &&
				event.aggregateType !== aggregateType;
			if (idContradictsSource || typeContradictsSource) {
				throw new ForeignEventError(
					aggregateId,
					aggregateType,
					event.type,
					event.aggregateId,
					event.aggregateType,
				);
			}
			const address: AggregateAddress = { aggregateType, aggregateId };
			return { event, position, address };
		});
		const lockAddresses = [
			...new Map(
				cursored.map(
					({ address }) => [encodeAggregateAddress(address), address] as const,
				),
			).entries(),
		]
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
			.map(([, address]) => address);

		// Everything mutable lives INSIDE the transactional callback: a
		// retrying scope re-runs it from zero, so a rolled-back attempt
		// can never leak counts or watermarks into the next one.
		const projectWithLocks = async (
			ctx: TCtx,
		): Promise<ProjectionBatchResult> => {
			let applied = 0;
			let skipped = 0;
			// Load and validate every addressed checkpoint before any handler
			// runs. Legacy/partial rows therefore cannot turn a batch prefix
			// into visible work even under the in-memory passthrough scope.
			const checkpointsAtBatchStart = new Map<
				string,
				ProjectionCheckpoint | undefined
			>();
			const watermarks = new Map<string, ProjectionPosition | undefined>();
			for (const { event, address } of cursored) {
				const key = encodeAggregateAddress(address);
				if (watermarks.has(key)) continue;
				const stored = await this.checkpoints.load(
					ctx,
					this.projection.name,
					address,
				);
				if (stored !== undefined && !isValidCheckpoint(stored)) {
					throw new UnprojectableEventError(
						this.projection.name,
						event.eventId,
						"found a stored checkpoint with an invalid or legacy cursor. " +
							"Migrate the commitSize/previousEventfulAggregateVersion/" +
							"lastAppliedEventId columns or " +
							"reset and rebuild this projection.",
					);
				}
				checkpointsAtBatchStart.set(key, stored);
				watermarks.set(key, stored?.position);
			}

			// A checkpoint remembers the identity at exactly its watermark. A
			// different eventId at that same position is therefore a provable source
			// collision. Older positions cannot be identity-checked without retaining
			// an unbounded per-position ledger and continue to rely on the source
			// contract that one position names one logical event.
			for (const { event, position, address } of cursored) {
				const stored = checkpointsAtBatchStart.get(
					encodeAggregateAddress(address),
				);
				if (
					stored !== undefined &&
					isSameOrderedPosition(position, stored.position) &&
					event.eventId !== stored.lastAppliedEventId
				) {
					throw new ProjectionIdentityViolationError(
						this.projection.name,
						event.eventId,
						stored.lastAppliedEventId,
						formatPosition(position),
					);
				}
			}

			const batchEventIdsByPosition = new Map<string, string>();
			for (const { event, position, address } of cursored) {
				const key = addressedPositionKey(address, position);
				const recordedEventId = batchEventIdsByPosition.get(key);
				if (
					recordedEventId !== undefined &&
					recordedEventId !== event.eventId
				) {
					throw new ProjectionIdentityViolationError(
						this.projection.name,
						event.eventId,
						recordedEventId,
						formatPosition(position),
					);
				}
				batchEventIdsByPosition.set(key, event.eventId);
			}

			// A descending pair among positions that were still unseen at batch
			// start is direct evidence of transport reordering. Ignore positions
			// the stored checkpoint had already covered: those are harmless late
			// redeliveries, not evidence about this batch's new-event ordering.
			const newestUnprocessed = new Map<string, ProjectionPosition>();
			for (const { event, position, address } of cursored) {
				const key = encodeAggregateAddress(address);
				const stored = watermarks.get(key);
				if (stored !== undefined && !isPositionAfter(position, stored))
					continue;
				const newest = newestUnprocessed.get(key);
				if (newest !== undefined && isPositionAfter(newest, position)) {
					throw new ProjectionOrderViolationError(
						this.projection.name,
						event.eventId,
						formatPosition(newest),
						formatPosition(position),
					);
				}
				if (newest === undefined || isPositionAfter(position, newest)) {
					newestUnprocessed.set(key, position);
				}
			}

			// Prove the whole batch's cursor chain before mutating the read
			// model. The simulated watermark also provides intra-batch dedupe
			// without relying on checkpoint-store read-your-writes behavior.
			const advanced = new Map<
				string,
				{ address: AggregateAddress; checkpoint: ProjectionCheckpoint }
			>();
			const toApply: Array<{ event: Evt }> = [];
			for (const { event, position, address } of cursored) {
				const key = encodeAggregateAddress(address);
				const watermark = watermarks.get(key);
				if (watermark !== undefined && !isPositionAfter(position, watermark)) {
					skipped += 1;
					continue;
				}
				if (!isContiguousPosition(position, watermark)) {
					throw new ProjectionGapError(
						this.projection.name,
						event.eventId,
						formatPosition(watermark),
						formatPosition(position),
					);
				}
				watermarks.set(key, position);
				advanced.set(key, {
					address,
					checkpoint: {
						position,
						lastAppliedEventId: event.eventId,
					},
				});
				toApply.push({ event });
				applied += 1;
			}
			for (const { event } of toApply) {
				await this.projection.apply(ctx, event);
			}
			for (const { address, checkpoint } of advanced.values()) {
				await this.checkpoints.save(
					ctx,
					this.projection.name,
					address,
					checkpoint,
				);
			}
			return { applied, skipped };
		};
		return this.scope.transactional((ctx) =>
			this.checkpoints.withCheckpointLocks(
				ctx,
				this.projection.name,
				lockAddresses,
				() => projectWithLocks(ctx),
			),
		);
	}

	/**
	 * The wait-for-version query: `true` when this projection has
	 * processed the addressed aggregate at least up to `position`. Pass the
	 * position of the last event the awaited commit emitted (see
	 * {@link ProjectionCheckpointStore.hasReached} for why the full
	 * cursor, not just the version).
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
	 * {@link Projector.project} afterwards. Stop all live consumers for this
	 * projection before reset and keep them stopped through catch-up replay;
	 * rebuild is not coordinated by the per-address delivery locks.
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
	 * **Dead-lettering a projection event stalls that aggregate chain.**
	 * A later event cannot advance past the missing commit/sequence: it
	 * fails with `ProjectionGapError` until the dead letter is repaired
	 * and replayed (or the projection is reset and rebuilt). No unseen
	 * event is silently classified as a duplicate.
	 */
	toOutboxSink(): OutboxSink<Evt> {
		return {
			publish: async (record) => {
				await this.project([record]);
			},
		};
	}
}

type GapAwareProjectionPosition = ProjectionPosition & {
	commitSize: number;
	previousEventfulAggregateVersion: number | null;
};

function isGapAwarePosition(
	position: ProjectionPosition,
): position is GapAwareProjectionPosition {
	return (
		Number.isInteger(position.commitSize) &&
		Object.hasOwn(position, "previousEventfulAggregateVersion")
	);
}

function isValidPosition(
	position: ProjectionPosition,
): position is GapAwareProjectionPosition {
	if (!isGapAwarePosition(position)) return false;
	const previous = position.previousEventfulAggregateVersion;
	return (
		Number.isInteger(position.aggregateVersion) &&
		position.aggregateVersion >= 0 &&
		Number.isInteger(position.commitSequence) &&
		position.commitSequence >= 0 &&
		position.commitSize > position.commitSequence &&
		(previous === null ||
			(Number.isInteger(previous) &&
				previous >= 0 &&
				previous < position.aggregateVersion))
	);
}

function isValidCheckpoint(
	checkpoint: unknown,
): checkpoint is ProjectionCheckpoint {
	if (typeof checkpoint !== "object" || checkpoint === null) return false;
	const candidate = checkpoint as Partial<ProjectionCheckpoint>;
	return (
		typeof candidate.lastAppliedEventId === "string" &&
		candidate.lastAppliedEventId.length > 0 &&
		candidate.position !== undefined &&
		isValidPosition(candidate.position)
	);
}

function isSameOrderedPosition(
	left: ProjectionPosition,
	right: ProjectionPosition,
): boolean {
	return (
		left.aggregateVersion === right.aggregateVersion &&
		left.commitSequence === right.commitSequence
	);
}

function addressedPositionKey(
	address: AggregateAddress,
	position: ProjectionPosition,
): string {
	return JSON.stringify([
		address.aggregateType,
		address.aggregateId,
		position.aggregateVersion,
		position.commitSequence,
	]);
}

function isContiguousPosition(
	candidate: GapAwareProjectionPosition,
	watermark: ProjectionPosition | undefined,
): boolean {
	if (
		candidate.commitSize < 1 ||
		candidate.commitSequence < 0 ||
		candidate.commitSequence >= candidate.commitSize
	) {
		return false;
	}
	if (watermark === undefined) {
		return (
			candidate.commitSequence === 0 &&
			candidate.previousEventfulAggregateVersion === null
		);
	}
	if (!isGapAwarePosition(watermark)) return false;
	if (candidate.aggregateVersion === watermark.aggregateVersion) {
		return (
			candidate.previousEventfulAggregateVersion ===
				watermark.previousEventfulAggregateVersion &&
			candidate.commitSize === watermark.commitSize &&
			candidate.commitSequence === watermark.commitSequence + 1
		);
	}
	return (
		watermark.commitSequence === watermark.commitSize - 1 &&
		candidate.commitSequence === 0 &&
		candidate.previousEventfulAggregateVersion === watermark.aggregateVersion
	);
}

function formatPosition(position: ProjectionPosition | undefined): string {
	if (position === undefined) return "genesis";
	return `(${position.aggregateVersion}, ${position.commitSequence})`;
}
