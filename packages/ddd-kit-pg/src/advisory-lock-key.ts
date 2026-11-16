/** The tables of the package that name an advisory lock. */
type LockTable =
	| "ddd_kit_event_stream"
	| "ddd_kit_idempotency"
	| "ddd_kit_outbox"
	| "ddd_kit_outbox_source_head"
	| "ddd_kit_projection_checkpoint";

/**
 * The SQL expression of an advisory lock key. An advisory lock holds across a
 * database, so the key names its table by OID. Two schemas with the same table
 * then do not share a lock, and every search path that resolves the table
 * computes the same key.
 *
 * Without `key`, the lock covers the table as a whole. `key` is an SQL
 * expression of type text, for example `$1`.
 */
export function advisoryLockKey(table: LockTable, key?: string): string {
	const tableOid = `'${table}'::regclass::oid::text`;
	const text = key === undefined ? tableOid : `${tableOid} || '/' || ${key}`;
	return `hashtextextended(${text}, 0)`;
}
