# Changelog

This file follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- `PgQueryExecutor`, the seam that lets an adapter join the transaction of the
  caller, and the `fromPg` bridge for a `pg` client.
- `PgTransactionScope`, a `TransactionScope` over a `pg` pool. It reports a
  serialization failure or a deadlock as a retryable
  `PgRetryableTransactionFailureError`, a `COMMIT` that rolled back as a
  `PgCommitRolledBackError`, and a failed `ROLLBACK` as a
  `PgRollbackFailedError` that keeps both failures. It survives a lost connection, and it closes its
  executor when the transaction ends. The option `isolationLevel` begins each
  transaction at that level. After a `COMMIT` that PostgreSQL answered with an
  error, the connection returns to the pool.
- `PgIdempotencyStore`, the transactional `IdempotencyStore`, with its table in
  `sql/idempotency.sql`. A claim of a key that another open transaction holds
  throws `IdempotencyInFlightError` at once and blocks no connection, also for
  roles whose search paths resolve the table through different schemas.
  `complete` rejects an outcome that JSON does not keep exactly.
- `PgEventStore`, with its table in `sql/event-stream.sql`, and `PgEventCodec`
  to map a `Date`, a `Map`, a `Set`, a `bigint`, or `undefined` inside a payload
  to JSON and back. Upcasting runs in the same codec. `append` rejects a value
  that JSON does not keep, and an event whose `eventId` the codec changed. A
  stored event that the codec cannot decode throws `PgEventDecodeError`, which
  names it. At REPEATABLE READ or SERIALIZABLE, an append after a removal that
  committed during its transaction fails with the retryable SQLSTATE 40001. A
  gap in a stream throws `PgEventStreamCorruptError`. `removeStream` deletes a whole stream, for example
  to erase personal data. It runs only at READ COMMITTED and rejects another
  isolation level with `PgUnsupportedIsolationLevelError`.
- `PgOutbox`, a `DispatchTrackingOutbox` with its tables in `sql/outbox.sql`. It
  writes on the transaction that `add` receives, links each commit to its
  predecessor, and rejects a new event of an ended source. With `claim`, several
  dispatchers can run at once, and they keep the order per aggregate. A record
  of a crashed dispatcher and a failed record return when their lease ends. The
  claim and every poll statement with a deadline run at READ COMMITTED, whatever
  the default of the database. A failure message with a NUL byte still counts as
  an attempt. A partial index supports the order check of the claim. A
  dispatcher deadline cancels a poll in the database, and a claim that its
  caller aborted before the `COMMIT` rolls back.
- `PgDeadlineStore`, `PgProjectionCheckpointStore`, and `PgSnapshotStore`, with
  their tables in `sql/`, and `fromPgPool` for the statements that need no
  transaction. The checkpoint locks name their table, like the other locks, and
  a deadline failure whose message holds a NUL byte still counts as an attempt.
