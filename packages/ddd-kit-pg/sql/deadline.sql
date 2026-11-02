-- The table of PgDeadlineStore. Run it in the schema of your aggregates, so that
-- schedule and cancel join the transaction of the command.
CREATE TABLE ddd_kit_deadline (
	delivery_id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
	-- The scheduling order, which breaks a tie of due_at.
	sequence bigserial NOT NULL,
	process_name text NOT NULL,
	key text NOT NULL,
	due_at timestamptz NOT NULL,
	-- SQL NULL means undefined. JSON null means null.
	payload jsonb,
	status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'dead')),
	attempts integer NOT NULL DEFAULT 0,
	last_error text
);

-- One pending deadline per address. A dead letter frees its address.
CREATE UNIQUE INDEX ddd_kit_deadline_address
	ON ddd_kit_deadline (process_name, key)
	WHERE status = 'pending';

CREATE INDEX ddd_kit_deadline_due
	ON ddd_kit_deadline (due_at, sequence)
	WHERE status = 'pending';
