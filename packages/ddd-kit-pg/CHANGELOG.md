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
  throws `IdempotencyInFlightError` at once and blocks no connection.
