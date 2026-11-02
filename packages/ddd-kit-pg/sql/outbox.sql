-- The tables of PgOutbox. Run them in the schema of your aggregates, so that a
-- write joins the transaction of the command.
CREATE TABLE ddd_kit_outbox (
	position bigserial PRIMARY KEY,
	event_id text NOT NULL UNIQUE,
	aggregate_type text NOT NULL,
	aggregate_id text NOT NULL,
	aggregate_version bigint NOT NULL,
	commit_sequence integer NOT NULL,
	commit_size integer NOT NULL,
	previous_eventful_aggregate_version bigint,
	event_type text NOT NULL,
	schema_version integer NOT NULL,
	occurred_at timestamptz NOT NULL,
	-- SQL NULL means undefined. JSON null means null.
	payload jsonb,
	metadata jsonb,
	status text NOT NULL DEFAULT 'pending'
		CHECK (status IN ('pending', 'dispatched', 'dead')),
	attempts integer NOT NULL DEFAULT 0,
	last_error text,
	claimed_until timestamptz,
	dispatched_at timestamptz,
	UNIQUE (aggregate_type, aggregate_id, aggregate_version, commit_sequence)
);

CREATE INDEX ddd_kit_outbox_pending
	ON ddd_kit_outbox (position)
	WHERE status = 'pending';

CREATE INDEX ddd_kit_outbox_dead
	ON ddd_kit_outbox (position)
	WHERE status = 'dead';

-- Keep an ended head for ever. Without it, a removed source opens again.
CREATE TABLE ddd_kit_outbox_source_head (
	aggregate_type text NOT NULL,
	aggregate_id text NOT NULL,
	-- NULL until the first event of the source.
	last_eventful_aggregate_version bigint,
	-- The events of that commit. A retry of one stays a retry after a purge.
	last_commit_event_ids text[] NOT NULL DEFAULT '{}',
	ended boolean NOT NULL DEFAULT false,
	PRIMARY KEY (aggregate_type, aggregate_id)
);
