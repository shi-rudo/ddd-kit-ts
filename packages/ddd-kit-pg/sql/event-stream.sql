-- The table of PgEventStore. Run it in the schema of your aggregates, so that an
-- append joins the transaction of the command.
CREATE TABLE ddd_kit_event_stream (
	aggregate_type text NOT NULL,
	aggregate_id text NOT NULL,
	position bigint NOT NULL CHECK (position >= 1),
	event_id text NOT NULL,
	event_type text NOT NULL,
	schema_version integer NOT NULL,
	occurred_at timestamptz NOT NULL,
	-- SQL NULL means undefined. JSON null means null.
	payload jsonb,
	metadata jsonb,
	PRIMARY KEY (aggregate_type, aggregate_id, position)
);
