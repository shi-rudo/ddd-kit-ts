/** @module @shirudo/ddd-kit-pg */

export {
	PgDeadlineStore,
	type PgDeadlineStoreOptions,
} from "./pg-deadline-store";
export {
	PgCommitRolledBackError,
	PgEventDecodeError,
	PgEventStreamCorruptError,
	PgRetryableTransactionFailureError,
	PgRollbackFailedError,
	PgUnsupportedIsolationLevelError,
} from "./pg-errors";
export type { PgEventCodec } from "./pg-event-codec";
export { PgEventStore, type PgEventStoreOptions } from "./pg-event-store";
export { PgIdempotencyStore } from "./pg-idempotency-store";
export { PgOutbox, type PgOutboxOptions } from "./pg-outbox";
export { fromPgPool, type PgPollPool } from "./pg-pool-executor";
export { PgProjectionCheckpointStore } from "./pg-projection-checkpoint-store";
export {
	fromPg,
	type PgQueryExecutor,
	type PgQueryResult,
} from "./pg-query-executor";
export { PgSnapshotStore } from "./pg-snapshot-store";
export {
	type PgClientPool,
	type PgIsolationLevel,
	PgTransactionScope,
	type PgTransactionScopeOptions,
} from "./pg-transaction-scope";
