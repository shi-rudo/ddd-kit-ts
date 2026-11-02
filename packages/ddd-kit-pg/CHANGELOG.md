# Changelog

This file follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- `PgQueryExecutor`, the seam that lets an adapter join the transaction of the
  caller, and the `fromPg` bridge for a `pg` client.
- `PgTransactionScope`, a `TransactionScope` over a `pg` pool. It reports a
  serialization failure or a deadlock as a retryable
  `PgRetryableTransactionFailureError`, and a `COMMIT` that rolled back as a
  `PgCommitRolledBackError`. It survives a lost connection, and it closes its
  executor when the transaction ends.
- `PgIdempotencyStore`, the transactional `IdempotencyStore`, with its table in
  `sql/idempotency.sql`. A claim of a key that another open transaction holds
  throws `IdempotencyInFlightError` at once and blocks no connection. `complete`
  rejects an outcome that JSON does not keep exactly.
- `PgEventStore`, with its table in `sql/event-stream.sql`, and `PgEventCodec`
  to map a `Date`, a `Map`, a `Set`, a `bigint`, or `undefined` inside a payload
  to JSON and back. Upcasting runs in the same codec. `append` rejects a value
  that JSON does not keep. A gap in a stream throws
  `PgEventStreamCorruptError`. `removeStream` deletes a whole stream, for example
  to erase personal data.
- `PgOutbox`, a `DispatchTrackingOutbox` with its tables in `sql/outbox.sql`. It
  writes on the transaction that `add` receives, links each commit to its
  predecessor, and rejects a new event of an ended source. With `claim`, several
  dispatchers can run at once, and they keep the order per aggregate. A record
  of a crashed dispatcher returns when its lease ends.
- `PgDeadlineStore`, `PgProjectionCheckpointStore`, and `PgSnapshotStore`, with
  their tables in `sql/`, and `fromPgPool` for the statements that need no
  transaction.
