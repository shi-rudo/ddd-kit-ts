# Concurrency & Thread Safety

JavaScript runs user code on one thread, but that does not make your domain model concurrency-safe.

Every `await` is a pause point. While one request is waiting for the database, another request, worker, retry, or background job can load and change the same aggregate. The kit's concurrency model is built around that fact:

- Keep aggregates scoped to one operation.
- Persist them with optimistic concurrency control.
- Retry only by rerunning the whole operation with fresh state.
- Publish domain events only after the transaction commits.

## What Counts as an Operation

An operation is one unit of application work:

- an HTTP request
- a CQRS command, such as `PlaceOrder` or `UpdateQuantity`
- a query, such as `GetOrder` or `ListOrders`
- a background job
- an event handler processing one event

The rule is simple: load fresh aggregate instances, make decisions, save, then discard them.

Do not cache aggregates across operations. Do not put them in module scope. Do not keep them on long-lived services. An aggregate is an in-memory view of persisted state at a point in time. Once the operation ends, that view is stale.

Within one operation, repeated loads of the same aggregate id should return the same object through an identity map. Across operations, they should not.

## The `await` Race

This is the bug JavaScript makes easy to underestimate:

```ts
class OrderService {
  private cachedOrder: Order;

  async incrementQuantity(itemId: ItemId): Promise<void> {
    const item = this.cachedOrder.getItem(itemId);
    const oldQty = item.state.quantity; // reads 5

    await someAsyncOperation();

    // Another request may have changed the same order while we waited.
    item.updateQuantity(oldQty + 1); // writes 6, even if the real value is 10
  }
}
```

Nothing ran in parallel inside that stack frame. The danger is that the stack frame paused. During the pause, another operation was free to run and commit.

The cached aggregate is now stale. If you save it, you can overwrite another writer's work. If you publish events from it, you can publish facts based on old state.

The fix is not a mutex in application memory. A mutex only protects one process. It does nothing across Node workers, serverless isolates, queue consumers, or another deployment replica. The fix is operation scope plus a database-level version predicate.

## Operation-Scoped Aggregates

Load the aggregate inside the operation that needs it. Make the decision there. Save it there. Then let it go.

```ts
async function updateQuantity(
  orderId: OrderId,
  itemId: ItemId,
  quantity: number,
): Promise<void> {
  await uow.run(async ({ orders }) => {
    const order = await orders.getById(orderId);

    order.updateItemQuantity(itemId, quantity);
    await orders.save(order);

    return { result: undefined, aggregates: [order] };
  });
}
```

This shape gives each operation its own aggregate instance. It also gives the repository one clear place to enforce optimistic concurrency.

The aggregate can still be loaded more than once inside the same operation. In that case the repository or `UnitOfWork` identity map should return the same object for the same id. That gives the operation one in-memory version history, not two competing copies.

## Optimistic Concurrency Control

Optimistic concurrency control, usually called OCC, assumes conflicts are possible but not constant. You let operations proceed without taking a lock up front, then reject the save if another writer committed first.

The aggregate carries two version values with different meanings:

- `aggregate.version` is the current in-memory version after domain changes.
- `aggregate.persistedVersion` is the version loaded from persistence, or `undefined` if the aggregate has never been persisted.

Those values diverge as soon as a domain method changes the aggregate. That is why the repository must use `persistedVersion` as the expected database version.

```ts
async function save(order: Order): Promise<void> {
  if (order.persistedVersion === undefined) {
    await db.insert(orders).values({
      id: order.id,
      state: order.state,
      version: order.version,
    });
    return;
  }

  const expectedVersion = order.persistedVersion;
  const nextVersion = order.version;

  const result = await db
    .update(orders)
    .set({
      state: order.state,
      version: nextVersion,
    })
    .where(and(eq(orders.id, order.id), eq(orders.version, expectedVersion)));

  if (result.rowsAffected === 0) {
    const current = await db
      .select({ version: orders.version })
      .from(orders)
      .where(eq(orders.id, order.id))
      .get();

    throw new ConcurrencyConflictError({
      aggregateType: "Order",
      aggregateId: order.id,
      expectedVersion,
      actualVersion: current?.version ?? -1,
    });
  }
}
```

Notice what the repository does not do: it does not call `order.markPersisted(...)`. `save()` is persistence only. `withCommit` and `UnitOfWork` mark aggregates as persisted after the transaction commits and after pending events have been harvested.

### Why `persistedVersion` Matters

Do not route insert vs update with `aggregate.version === 0`.

A new aggregate can already be at version 1 or 2 before its first save. A factory can record a creation event. A setup method can change state again. The row still does not exist in the database.

`version` answers, "how many version-worthy changes has this aggregate seen in memory?"

`persistedVersion` answers, "what version does persistence currently know about?"

The insert/update branch uses `persistedVersion === undefined`. The update predicate uses `persistedVersion` as the baseline. The row's new version is `version`.

See [Repository -> Insert vs update](./repository.md#insert-vs-update-the-persistedversion-convention).

### Multi-Table Aggregates

If one aggregate spans several tables, the root row still owns the version.

A common failure mode is to update only a child collection table and forget to move the root version. The next writer then sees the old version and commits over your change without a conflict.

The kit's state-stored aggregate support gives repositories two helpers:

- `changedKeys` tells the repository which top-level state keys changed.
- `hasChanges` tells the repository whether skipping `save()` is safe.

Use those helpers to scope child-table writes, but still write the root row version whenever the aggregate has version-worthy changes. This keeps the OCC predicate attached to the aggregate boundary, not scattered across child rows.

There is one deliberate escape hatch: `setStateWithoutVersionBump(newState)`. It marks state dirty without advancing the version. Use it only for data a concurrent writer may safely overwrite, such as cosmetic caches or denormalized display fields. Do not use it for domain-meaningful changes.

See [Repository -> Partial writes](./repository.md#partial-writes-for-multi-table-aggregates-changedkeys--haschanges).

## Handling Conflicts

When a repository throws `ConcurrencyConflictError`, the application service has three reasonable choices:

- retry the whole operation
- return a conflict to the caller, such as HTTP 409
- accept last-write-wins for a path where that is explicitly safe

Do not catch the conflict inside the same `run()` callback and keep going. The aggregate instance is stale. The identity map still points to it. Its pending events may describe a write that failed.

Retry means starting over: open a fresh transaction, reload the aggregate, re-apply the command, save again.

## Retrying with `RetryingTransactionScope`

The kit ships `RetryingTransactionScope` so retry logic can live at the transaction boundary instead of inside every use case.

```ts
import { RetryingTransactionScope, UnitOfWork } from "@shirudo/ddd-kit";

const scope = new RetryingTransactionScope(drizzleScope, {
  maxAttempts: 3,
  baseDelayMs: 50,
  maxDelayMs: 1000,
});

const uow = new UnitOfWork({ scope, outbox, repositories });
```

Use it as the `UnitOfWork` scope. Your application callback stays the same, but each retry gets fresh per-attempt state.

What it provides:

- retry classification through `someChainRetryable` by default, which matches `ConcurrencyConflictError` even when wrapped
- exponential backoff with jitter, capped at `maxDelayMs`
- the final error unchanged when attempts are exhausted
- cancellation through the `AbortSignal` passed to `run()`

Override `isRetryable` when your adapter surfaces database serialization errors directly, such as Postgres `40001`, MySQL `1213`, or SQLite `SQLITE_BUSY`.

The retried region is the transaction. Keep non-transactional side effects out of the callback. Do not send email, call webhooks, publish to a broker, or mutate process-global state before commit. Put those effects behind the outbox or after the committed operation.

::: warning Retry requires a transactional outbox
`outbox.add` must participate in the same database transaction as the aggregate write.

With a transactional outbox, rolled-back attempts roll back their events too. Only the committed attempt survives.

The in-memory outbox is not transactional. If you use it with retry, rolled-back attempts can leave orphaned events behind. Use `RetryingTransactionScope` only with a transactional outbox in production.
:::

## Isolation Levels

The kit's OCC pattern works under `READ COMMITTED`, the common default for Postgres. It also works under stronger isolation levels, though stronger databases may report conflicts differently.

The important part is the write predicate:

```sql
UPDATE orders
SET state = ?, version = ?
WHERE id = ? AND version = ?
```

The final `version = ?` compares against the loaded `persistedVersion`. If another transaction committed first, the row no longer matches and the update affects zero rows.

Three rules keep this sound:

1. Read the aggregate that drives the decision inside the same operation that writes it.
2. Keep transactions short.
3. Retry serialization failures by rerunning the operation with fresh state.

Serializable databases, including Postgres in `SERIALIZABLE` mode and CockroachDB, may abort a transaction with a serialization failure before your update returns zero rows. Treat that as another retryable infrastructure conflict by mapping the driver error or by configuring `RetryingTransactionScope.isRetryable`.

Pessimistic locking, such as `SELECT ... FOR UPDATE`, is not part of the kit contract. If a hot path genuinely needs it, put it inside an explicit repository method and document why OCC is not enough for that use case.

## EventBus Dispatch Order

`EventBus.publish(events)` has deterministic ordering at the event level:

1. Events are dispatched in input order. `publish([a, b, c])` finishes `a` before starting `b`.
2. Handlers for one event run in parallel.
3. Handler errors are collected and thrown after the whole `publish([...])` batch reaches the end.

If one handler fails for event `a`, the other handlers for `a` still run, and events `b` and `c` still publish. Once the batch is complete, `publish` throws the single captured error, or an `AggregateError` if several handlers failed.

The bus is an in-process dispatcher. It does not provide retry, backpressure, cross-process delivery, or dead-letter handling. For durable delivery, write events to an outbox in the same transaction and let a dispatcher publish them.

This matters for concurrency because in-process event handlers should not be treated as a durability boundary. The transaction and outbox are the durability boundary. The bus is delivery inside the current process.

## Invariants the Kit Protects

The kit's concurrency story depends on a few invariants:

- `AggregateRoot.commit(state, events)` records events only after state validation succeeds.
- `EventSourcedAggregate.apply(event)` records the event only after the handler produces valid state.
- `withCommit` harvests pending events inside the transaction and publishes after commit.
- `loadFromHistory` and `restoreFromSnapshotWithEvents` roll back in-memory replay if replay fails.
- Domain events are deeply frozen so one subscriber cannot mutate an event seen by another subscriber.
- Repositories enforce OCC with `ConcurrencyConflictError`.

If you keep aggregates operation-scoped, use `persistedVersion` as the OCC baseline, and let `withCommit` own event harvesting, the concurrency model stays predictable.
