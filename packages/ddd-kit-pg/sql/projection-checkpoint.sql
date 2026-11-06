-- The table of PgProjectionCheckpointStore. Run it in the database of your read
-- models, so that a read-model update and its checkpoint commit together.
CREATE TABLE ddd_kit_projection_checkpoint (
	projection text NOT NULL,
	aggregate_type text NOT NULL,
	aggregate_id text NOT NULL,
	aggregate_version bigint NOT NULL,
	commit_sequence integer NOT NULL,
	commit_size integer NOT NULL,
	previous_eventful_aggregate_version bigint,
	last_applied_event_id text NOT NULL,
	PRIMARY KEY (projection, aggregate_type, aggregate_id)
);
