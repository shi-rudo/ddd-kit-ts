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
