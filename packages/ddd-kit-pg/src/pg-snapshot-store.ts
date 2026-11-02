import {
	type AggregateIdentity,
	type AggregateSnapshot,
	assertJsonSafe,
	type SnapshotStore,
	toVersion,
} from "@shirudo/ddd-kit";
import type { PgQueryExecutor } from "./pg-query-executor";

/**
 * The latest snapshot of each aggregate. A snapshot is derived data, so the store
 * needs no transaction: use `fromPgPool`. Run `sql/snapshot.sql` to create the
 * table.
 *
 * The table keeps JSON. `save` rejects a state that JSON does not keep exactly.
 * Map such a value in the `SnapshotModel`, which owns the snapshot DTO.
 */
export class PgSnapshotStore<TState = unknown>
	implements SnapshotStore<TState>
{
	constructor(private readonly executor: PgQueryExecutor) {}

	async load(
		identity: AggregateIdentity,
	): Promise<AggregateSnapshot<TState> | undefined> {
		const { rows } = await this.executor.query<{
			readonly state: string;
			readonly version: string;
			readonly snapshot_at: Date;
			readonly schema_version: number | null;
		}>(
			`SELECT state::text AS state, version::text AS version, snapshot_at, schema_version
			FROM ddd_kit_snapshot
			WHERE aggregate_type = $1 AND aggregate_id = $2`,
			[identity.aggregateType, identity.aggregateId],
		);
		const row = rows[0];
		if (row === undefined) return undefined;
		return {
			state: JSON.parse(row.state),
			version: toVersion(Number(row.version)),
			snapshotAt: row.snapshot_at,
			...(row.schema_version === null
				? {}
				: { schemaVersion: row.schema_version }),
		};
	}

	async save(
		identity: AggregateIdentity,
		snapshot: AggregateSnapshot<TState>,
	): Promise<void> {
		assertJsonSafe(
			snapshot.state,
			`PgSnapshotStore.save ${identity.aggregateType}/${identity.aggregateId} state`,
		);
		await this.executor.query(
			`INSERT INTO ddd_kit_snapshot
				(aggregate_type, aggregate_id, state, version, snapshot_at, schema_version)
			VALUES ($1, $2, $3::jsonb, $4, $5, $6)
			ON CONFLICT (aggregate_type, aggregate_id) DO UPDATE SET
				state = EXCLUDED.state,
				version = EXCLUDED.version,
				snapshot_at = EXCLUDED.snapshot_at,
				schema_version = EXCLUDED.schema_version`,
			[
				identity.aggregateType,
				identity.aggregateId,
				JSON.stringify(snapshot.state),
				snapshot.version,
				snapshot.snapshotAt.toISOString(),
				snapshot.schemaVersion ?? null,
			],
		);
	}

	async delete(identity: AggregateIdentity): Promise<void> {
		await this.executor.query(
			`DELETE FROM ddd_kit_snapshot
			WHERE aggregate_type = $1 AND aggregate_id = $2`,
			[identity.aggregateType, identity.aggregateId],
		);
	}
}
