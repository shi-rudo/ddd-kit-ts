import {
	assertJsonSafe,
	type DeadLetterDeadline,
	type DeadlineStore,
	type DueDeadline,
	type ExecutionContext,
} from "@shirudo/ddd-kit";
import type { PgQueryExecutor } from "./pg-query-executor";

const DEFAULT_MAX_DELIVERY_ATTEMPTS = 5;

export interface PgDeadlineStoreOptions {
	/** The failed deliveries that move a deadline to the dead letters. Default `5`. */
	readonly maxDeliveryAttempts?: number | undefined;
}

interface DeadlineRow {
	readonly delivery_id: string;
	readonly process_name: string;
	readonly key: string;
	readonly due_at: Date;
	/** `jsonb` as text, because `pg` parses SQL NULL and JSON null to the same value. */
	readonly payload: string | null;
	readonly attempts: number;
	readonly last_error: string | null;
}

const DEADLINE_COLUMNS = `
	delivery_id, process_name, key, due_at, payload::text AS payload, attempts,
	last_error`;

/**
 * Durable deadlines. The store runs every statement on its executor. So build one
 * on the transaction inside the callback of the scope for `schedule` and `cancel`,
 * and one with `fromPgPool` for the poll loop. Run `sql/deadline.sql` to create
 * the table.
 *
 * The table keeps JSON. `schedule` rejects a payload that JSON does not keep
 * exactly. Map such a value before the call.
 *
 * `due` does not claim its records, so run one poll loop per store. A second loop
 * delivers each deadline twice.
 */
export class PgDeadlineStore<TPayload = unknown>
	implements DeadlineStore<TPayload>
{
	private readonly maxDeliveryAttempts: number;

	constructor(
		private readonly executor: PgQueryExecutor,
		options: PgDeadlineStoreOptions = {},
	) {
		const attempts =
			options.maxDeliveryAttempts ?? DEFAULT_MAX_DELIVERY_ATTEMPTS;
		if (!Number.isSafeInteger(attempts) || attempts < 1) {
			throw new RangeError(
				`PgDeadlineStore: maxDeliveryAttempts must be a positive integer, got ${String(attempts)}`,
			);
		}
		this.maxDeliveryAttempts = attempts;
	}

	async schedule(deadline: {
		processName: string;
		key: string;
		dueAt: Date;
		payload: TPayload;
	}): Promise<void> {
		if (deadline.payload !== undefined) {
			assertJsonSafe(
				deadline.payload,
				`PgDeadlineStore.schedule ${deadline.processName}/${deadline.key} payload`,
			);
		}
		// A new delivery id makes a late acknowledgement of the replaced
		// incarnation a no-op.
		await this.executor.query(
			`INSERT INTO ddd_kit_deadline (process_name, key, due_at, payload)
			VALUES ($1, $2, $3, $4::jsonb)
			ON CONFLICT (process_name, key) WHERE status = 'pending' DO UPDATE SET
				delivery_id = gen_random_uuid()::text,
				sequence = nextval(pg_get_serial_sequence('ddd_kit_deadline', 'sequence')),
				due_at = EXCLUDED.due_at,
				payload = EXCLUDED.payload,
				attempts = 0,
				last_error = NULL`,
			[
				deadline.processName,
				deadline.key,
				deadline.dueAt.toISOString(),
				JSON.stringify(deadline.payload),
			],
		);
	}

	async cancel(processName: string, key: string): Promise<void> {
		await this.executor.query(
			`DELETE FROM ddd_kit_deadline
			WHERE process_name = $1 AND key = $2 AND status = 'pending'`,
			[processName, key],
		);
	}

	async due(
		now: Date,
		limit: number,
		context?: ExecutionContext,
	): Promise<ReadonlyArray<DueDeadline<TPayload>>> {
		if (!Number.isInteger(limit) || limit < 0) {
			throw new RangeError(
				`PgDeadlineStore: limit must be an integer >= 0, got ${limit}`,
			);
		}
		if (limit === 0) return [];
		context?.signal.throwIfAborted();
		const { rows } = await this.executor.query<DeadlineRow>(
			`SELECT ${DEADLINE_COLUMNS}
			FROM ddd_kit_deadline
			WHERE status = 'pending' AND due_at <= $1
			ORDER BY due_at, sequence
			LIMIT $2`,
			[now.toISOString(), limit],
			context,
		);
		return rows.map((row) => toDueDeadline<TPayload>(row));
	}

	async markDelivered(
		deliveryIds: ReadonlyArray<string>,
		context?: ExecutionContext,
	): Promise<void> {
		context?.signal.throwIfAborted();
		await this.executor.query(
			"DELETE FROM ddd_kit_deadline WHERE delivery_id = ANY($1::text[])",
			[deliveryIds],
			context,
		);
	}

	async markFailed(
		deliveryId: string,
		error?: unknown,
		context?: ExecutionContext,
	): Promise<DeadLetterDeadline<TPayload> | undefined> {
		context?.signal.throwIfAborted();
		const lastError =
			error instanceof Error ? error.message : String(error ?? "unknown");
		const { rows } = await this.executor.query<
			DeadlineRow & { readonly status: string }
		>(
			`UPDATE ddd_kit_deadline
			SET
				attempts = attempts + 1,
				last_error = $2,
				status = CASE WHEN attempts + 1 >= $3 THEN 'dead' ELSE 'pending' END
			WHERE delivery_id = $1 AND status = 'pending'
			RETURNING ${DEADLINE_COLUMNS}, status`,
			[deliveryId, lastError, this.maxDeliveryAttempts],
			context,
		);
		const row = rows[0];
		return row?.status === "dead" ? toDeadLetter<TPayload>(row) : undefined;
	}

	async deadLetters(): Promise<ReadonlyArray<DeadLetterDeadline<TPayload>>> {
		const { rows } = await this.executor.query<DeadlineRow>(
			`SELECT ${DEADLINE_COLUMNS}
			FROM ddd_kit_deadline
			WHERE status = 'dead'
			ORDER BY sequence`,
		);
		return rows.map((row) => toDeadLetter<TPayload>(row));
	}
}

function toDueDeadline<TPayload>(row: DeadlineRow): DueDeadline<TPayload> {
	return {
		deliveryId: row.delivery_id,
		processName: row.process_name,
		key: row.key,
		dueAt: row.due_at,
		payload: (row.payload === null
			? undefined
			: JSON.parse(row.payload)) as TPayload,
		attempts: row.attempts,
	};
}

function toDeadLetter<TPayload>(
	row: DeadlineRow,
): DeadLetterDeadline<TPayload> {
	return {
		...toDueDeadline<TPayload>(row),
		...(row.last_error === null ? {} : { lastError: row.last_error }),
	};
}
