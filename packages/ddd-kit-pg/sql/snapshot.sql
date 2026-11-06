-- The table of PgSnapshotStore. A snapshot is derived data, so this table can
-- live apart from the aggregates. One table serves every aggregate type.
CREATE TABLE ddd_kit_snapshot (
	aggregate_type text NOT NULL,
	aggregate_id text NOT NULL,
	state jsonb NOT NULL,
	version bigint NOT NULL,
	snapshot_at timestamptz NOT NULL,
	-- NULL means that the snapshot has no schema version.
	schema_version integer,
	PRIMARY KEY (aggregate_type, aggregate_id)
);
