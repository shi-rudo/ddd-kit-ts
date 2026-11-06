# @shirudo/ddd-kit-pg

PostgreSQL adapters for `@shirudo/ddd-kit`. The adapters run the contract suites
of the kit against a real database in CI.

This package is not published yet.

## The executor

An adapter owns no connection. It runs its statements on a `PgQueryExecutor`, so
the statements join your transaction.

```ts
import { fromPg } from "@shirudo/ddd-kit-pg";

const client = await pool.connect();
const executor = fromPg(client);
```

## The transaction scope

`PgTransactionScope` is a `TransactionScope` for a project that uses `pg`
directly. Wrap it in `RetryingTransactionScope` to retry a serialization failure
or a deadlock.

```ts
import { RetryingTransactionScope } from "@shirudo/ddd-kit";
import { PgTransactionScope } from "@shirudo/ddd-kit-pg";

const scope = new RetryingTransactionScope(new PgTransactionScope(pool));
```

Each transaction runs at the default isolation level of the database. To set a
level, pass `isolationLevel`, for example
`new PgTransactionScope(pool, { isolationLevel: "read committed" })`.

A failed statement aborts a PostgreSQL transaction, and `COMMIT` then rolls back
without an error. If your callback catches that failure and resolves, the scope
rejects with `PgCommitRolledBackError`. Rethrow the failure, or run the statement
in a savepoint.

## The tables

The package ships each table as a SQL file in `sql/`. Run the files that you need
with your migration tool, in the schema of your aggregates. A store then writes
in the transaction of your command.

| Store | File |
| --- | --- |
| `PgIdempotencyStore` | `sql/idempotency.sql` |
| `PgEventStore` | `sql/event-stream.sql` |
| `PgOutbox` | `sql/outbox.sql` |

## Idempotency

`PgIdempotencyStore` keeps each record until you delete it. Delete old records
with your own job, for example by `completed_at`. A retry of a deleted key runs
the command again.

A store rejects an outcome that JSON does not keep exactly, for example one with
a `Date`. Return plain JSON from the use case.

## Events

`PgEventStore` runs on the executor of one transaction. Build it inside the
callback of the scope.

The table keeps JSON. JSON does not keep a `Date`, a `Map`, a `Set`, a `bigint`,
or `undefined` inside a payload, so `append` rejects such a value and names its
path. If your events hold such a value, map it with a `PgEventCodec`. Upcasting
runs in the same place.

```ts
import { type PgEventCodec, PgEventStore } from "@shirudo/ddd-kit-pg";

const codec: PgEventCodec<OrderEvent> = {
  encode: (event) =>
    event.type === "OrderShipped"
      ? {
          ...event,
          payload: { shippedAt: event.payload.shippedAt.toISOString() },
        }
      : event,
  decode: (stored) =>
    stored.type === "OrderShipped"
      ? {
          ...stored,
          type: "OrderShipped",
          payload: { shippedAt: new Date(stored.payload.shippedAt) },
        }
      : (stored as OrderEvent),
};

const store = new PgEventStore<OrderEvent>(executor, { codec });
```

A test against `InMemoryEventStore` does not show a missing mapping, because that
store keeps every plain value. Run the contract suites against PostgreSQL.

To erase the personal data of an aggregate, call `removeStream` from the flush
of a repository definition with `physicalRemoval: true`. The history of the
aggregate is then gone. Delete its snapshot first, and purge the other copies of
the data: outbox records, projections, and idempotency outcomes.

A read rejects a gap in a stream with `PgEventStreamCorruptError`. A read cannot
see missing events at the end of a stream, because the highest position is the
head. Set `statement_timeout`: an abort signal stops the wait of a read, not the
statement on the connection.

An append and a removal take a lock per stream, so they run one after the other. A
transaction that writes several streams can deadlock with another one in the
opposite order. `PgTransactionScope` reports this as retryable, so wrap it in
`RetryingTransactionScope`. A removal runs only at READ COMMITTED, the default of
PostgreSQL. At another level, it throws `PgUnsupportedIsolationLevelError` and
deletes nothing.

## Outbox

One `PgOutbox` can serve every request, because `withCommit` hands it the open
transaction. The dispatcher polls on the pool.

```ts
import { PgOutbox, PgTransactionScope } from "@shirudo/ddd-kit-pg";

const outbox = new PgOutbox<OrderEvent>({ pool, codec });
const scope = new PgTransactionScope(pool);
```

Without `claim`, run one dispatcher per outbox. With `claim: { leaseMs }`, several
dispatchers can run at once. A poll holds back a later event of an aggregate while
an earlier one is claimed, so the order per aggregate stays. Choose a lease longer
than one delivery: a record returns to the other dispatchers when its lease ends,
and it is then delivered twice. A record whose delivery failed also waits for the
end of its lease, so a late failure report cannot release the claim of another
dispatcher. The claims of all dispatchers run one after another, each in a short
transaction at READ COMMITTED. A dispatcher deadline cancels a poll in the
database. If the caller aborts a claim before its `COMMIT`, the claim rolls back.
An abort during the `COMMIT` cannot stop it, and the records then wait for the
end of their lease.

The table keeps delivered records and dead letters. Wire `deadLetters()` to your
alerts, and delete old delivered records with your own job. Never delete a row of
`ddd_kit_outbox_source_head` whose `ended` is true: the removed aggregate could
then come back under its old id.

## Peer dependencies

The package takes `@shirudo/ddd-kit` as a peer dependency and does not bundle it,
so a process loads one copy of the kit.

Each peer range starts at the version that the CI of this package certifies, for
`@shirudo/ddd-kit` and for `pg`. It ends before the next major version. A new
major version needs a new certification, and then a new peer range.

## Tests

The tests start PostgreSQL in Docker, so Docker must run. The package reads the
kit from its `dist` directory, so build the kit first.

```sh
pnpm build
pnpm test:pg
```
