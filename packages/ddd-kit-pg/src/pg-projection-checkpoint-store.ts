import type {
	AggregateIdentity,
	ProjectionCheckpoint,
	ProjectionCheckpointStore,
	ProjectionPosition,
} from "@shirudo/ddd-kit";
import type { PgQueryExecutor } from "./pg-query-executor";

/**
 * The watermark of each projection per aggregate. The checkpoint and the
 * read-model update commit together, because both run on the transaction of the
 * `Projector`. Run `sql/projection-checkpoint.sql` in the database of your read
 * models.
 *
 * Run the projector at READ COMMITTED, the default of PostgreSQL. Each statement
 * then gets a new snapshot, so a load after a lock wait sees the checkpoint of
 * the previous lock holder. A transaction-wide snapshot would keep the state from
 * before the wait.
 */
export class PgProjectionCheckpointStore
	implements ProjectionCheckpointStore<PgQueryExecutor>
{
	/** @param poll Runs `hasReached`, which needs no transaction. Use `fromPgPool`. */
	constructor(private readonly poll: PgQueryExecutor) {}

	/**
	 * Holds an advisory lock per key until the transaction ends. A row lock would
	 * not work, because the first event of an aggregate has no row to lock. The
	 * sorted order prevents a deadlock. An advisory lock holds across a database,
	 * so the key names the table by its OID: every search path that resolves the
	 * table computes the same key. A hash collision only serializes more.
	 */
	async withCheckpointLocks<R>(
		tx: PgQueryExecutor,
		projection: string,
		identities: ReadonlyArray<AggregateIdentity>,
		work: () => Promise<R>,
	): Promise<R> {
		const keys = [
			...new Set(
				identities.map(({ aggregateType, aggregateId }) =>
					JSON.stringify([projection, aggregateType, aggregateId]),
				),
			),
		].sort();
		for (const key of keys) {
			await tx.query(
				`SELECT pg_advisory_xact_lock(
					hashtextextended('ddd_kit_projection_checkpoint'::regclass::oid::text || '/' || $1, 0)
				)`,
				[key],
			);
		}
		return work();
	}

	async load(
		tx: PgQueryExecutor,
		projection: string,
		identity: AggregateIdentity,
	): Promise<ProjectionCheckpoint | undefined> {
		const { rows } = await tx.query<{
			readonly aggregate_version: string;
			readonly commit_sequence: number;
			readonly commit_size: number;
			readonly previous: string | null;
			readonly last_applied_event_id: string;
		}>(
			`SELECT
				aggregate_version::text AS aggregate_version,
				commit_sequence,
				commit_size,
				previous_eventful_aggregate_version::text AS previous,
				last_applied_event_id
			FROM ddd_kit_projection_checkpoint
			WHERE projection = $1 AND aggregate_type = $2 AND aggregate_id = $3`,
			[projection, identity.aggregateType, identity.aggregateId],
		);
		const row = rows[0];
		if (row === undefined) return undefined;
		return {
			position: {
				aggregateVersion: Number(row.aggregate_version),
				commitSequence: row.commit_sequence,
				commitSize: row.commit_size,
				previousEventfulAggregateVersion:
					row.previous === null ? null : Number(row.previous),
			},
			lastAppliedEventId: row.last_applied_event_id,
		};
	}

	async save(
		tx: PgQueryExecutor,
		projection: string,
		identity: AggregateIdentity,
		{ position, lastAppliedEventId }: ProjectionCheckpoint,
	): Promise<void> {
		await tx.query(
			`INSERT INTO ddd_kit_projection_checkpoint (
				projection, aggregate_type, aggregate_id, aggregate_version,
				commit_sequence, commit_size, previous_eventful_aggregate_version,
				last_applied_event_id
			)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			ON CONFLICT (projection, aggregate_type, aggregate_id) DO UPDATE SET
				aggregate_version = EXCLUDED.aggregate_version,
				commit_sequence = EXCLUDED.commit_sequence,
				commit_size = EXCLUDED.commit_size,
				previous_eventful_aggregate_version =
					EXCLUDED.previous_eventful_aggregate_version,
				last_applied_event_id = EXCLUDED.last_applied_event_id`,
			[
				projection,
				identity.aggregateType,
				identity.aggregateId,
				position.aggregateVersion,
				position.commitSequence,
				position.commitSize,
				position.previousEventfulAggregateVersion,
				lastAppliedEventId,
			],
		);
	}

	async hasReached(
		projection: string,
		identity: AggregateIdentity,
		position: ProjectionPosition,
	): Promise<boolean> {
		const { rows } = await this.poll.query(
			`SELECT 1
			FROM ddd_kit_projection_checkpoint
			WHERE projection = $1
				AND aggregate_type = $2
				AND aggregate_id = $3
				AND (aggregate_version, commit_sequence) >= ($4::bigint, $5::integer)`,
			[
				projection,
				identity.aggregateType,
				identity.aggregateId,
				position.aggregateVersion,
				position.commitSequence,
			],
		);
		return rows.length > 0;
	}

	async reset(tx: PgQueryExecutor, projection: string): Promise<void> {
		await tx.query(
			"DELETE FROM ddd_kit_projection_checkpoint WHERE projection = $1",
			[projection],
		);
	}
}
