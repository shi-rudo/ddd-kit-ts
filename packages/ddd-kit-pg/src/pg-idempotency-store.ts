import {
	type IdempotencyClaim,
	type IdempotencyClaimHandle,
	IdempotencyInFlightError,
	IdempotencyKeyReuseError,
	type IdempotencyStore,
	KitWiringError,
} from "@shirudo/ddd-kit";
import type { PgQueryExecutor } from "./pg-query-executor";

interface IdempotencyRow {
	readonly fingerprint: string;
	readonly status: "pending" | "completed";
	/** `jsonb` as text, because `pg` parses SQL NULL and JSON null to the same value. */
	readonly outcome: string | null;
}

/**
 * The idempotency record of a command in the database of its aggregates. The
 * record joins the transaction of the executor, so a rollback releases the
 * claim, and the commit makes the outcome replayable. Run `sql/idempotency.sql`
 * to create the table.
 *
 * A claim of a key that another open transaction holds throws
 * `IdempotencyInFlightError` at once. A plain `INSERT` would wait at the unique
 * index and block a connection for as long as the other transaction runs. The
 * advisory lock in `claim` gives the answer without that wait, and the
 * transaction end releases it.
 *
 * The outcome is stored as JSON, so it must be plain data.
 */
export class PgIdempotencyStore implements IdempotencyStore<PgQueryExecutor> {
	readonly family = "transactional";

	async claim(
		executor: PgQueryExecutor,
		key: string,
		fingerprint: string,
	): Promise<IdempotencyClaim> {
		const { rows: locks } = await executor.query<{ locked: boolean }>(
			`SELECT pg_try_advisory_xact_lock(
				hashtext('ddd_kit_idempotency'),
				hashtext($1)
			) AS locked`,
			[key],
		);
		if (locks[0]?.locked !== true) throw new IdempotencyInFlightError({ key });

		const { rows: inserted } = await executor.query<{ token: string }>(
			`INSERT INTO ddd_kit_idempotency (key, fingerprint)
			VALUES ($1, $2)
			ON CONFLICT (key) DO NOTHING
			RETURNING token`,
			[key, fingerprint],
		);
		const token = inserted[0]?.token;
		if (token !== undefined) {
			return { status: "claimed", claim: { key, token } };
		}

		const { rows } = await executor.query<IdempotencyRow>(
			`SELECT fingerprint, status, outcome::text AS outcome
			FROM ddd_kit_idempotency
			WHERE key = $1`,
			[key],
		);
		const existing = rows[0];
		if (existing === undefined) throw new IdempotencyInFlightError({ key });
		if (existing.fingerprint !== fingerprint) {
			throw new IdempotencyKeyReuseError({
				key,
				storedFingerprint: existing.fingerprint,
				receivedFingerprint: fingerprint,
			});
		}
		if (existing.status === "pending") {
			throw new IdempotencyInFlightError({ key });
		}
		return {
			status: "completed",
			outcome:
				existing.outcome === null ? undefined : JSON.parse(existing.outcome),
		};
	}

	async complete(
		executor: PgQueryExecutor,
		{ key, token }: IdempotencyClaimHandle,
		outcome: unknown,
	): Promise<void> {
		const { rows } = await executor.query(
			`UPDATE ddd_kit_idempotency
			SET status = 'completed', outcome = $3::jsonb, completed_at = now()
			WHERE key = $1 AND token = $2 AND status = 'pending'
			RETURNING key`,
			[key, token, JSON.stringify(outcome)],
		);
		if (rows.length === 0) {
			throw new KitWiringError({
				code: "IDEMPOTENCY_COMPLETED_WITHOUT_CLAIM",
				message:
					`PgIdempotencyStore.complete() ran for key "${key}" without a ` +
					"pending claim of this token. Call claim() first, or use " +
					"withIdempotentCommit.",
				details: { key },
			});
		}
	}
}
