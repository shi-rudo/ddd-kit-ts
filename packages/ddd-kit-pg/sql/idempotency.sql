-- The table of PgIdempotencyStore. Run it in the schema of your aggregates, so
-- that the store writes in the transaction of the command.
CREATE TABLE ddd_kit_idempotency (
	key text PRIMARY KEY,
	fingerprint text NOT NULL,
	token text NOT NULL DEFAULT gen_random_uuid()::text,
	status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed')),
	-- SQL NULL means an outcome of undefined. JSON null means an outcome of null.
	outcome jsonb,
	created_at timestamptz NOT NULL DEFAULT now(),
	completed_at timestamptz
);
