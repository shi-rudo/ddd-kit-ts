# Concurrency & Thread Safety

JavaScript runs ordinary user code on one thread, but that does not make a
domain model concurrency-safe. Every `await` is a pause point. While one
request waits, another request, worker, retry, or deployment replica can load
and change the same aggregate.

The kit therefore combines four rules:

- Aggregate instances live for one application operation.
- A `UnitOfWork` returns one instance per aggregate identifier in that operation.
- Repository adapters use optimistic concurrency control.
- domain events become durable in the same transaction as aggregate state.

## One operation, one object graph

An operation is one command, request, queue delivery, scheduled job, or event
reaction. Load the aggregate inside that operation, make the decision, register
the write, and then discard the object.

Do not cache aggregates in module scope or on long-lived services. An
aggregate is an in-memory view of persisted facts at a particular version.
Once the operation ends, that view is stale.

```ts
async function updateQuantity(
  orderId: OrderId,
  itemId: ItemId,
  quantity: number,
): Promise<void> {
  await uow.run(async ({ repositories }) => {
    const order = await repositories.orders.getById(orderId);

    order.updateItemQuantity(itemId, quantity);
    repositories.orders.update(order);
  });
}
```

Inside `run`, repeated loads of the same aggregate class and id return the same
object from the identity map. This behavior is more than a cache. Two instances
can let incompatible decisions and event batches claim the same
identity in one transaction.

## What the `await` race looks like

This service is unsafe even though no individual stack frame runs in parallel:

```ts
class OrderService {
  private cachedOrder: Order;

  async incrementQuantity(itemId: ItemId): Promise<void> {
    const oldQuantity = this.cachedOrder.itemQuantity(itemId);
    await someAsyncOperation();
    this.cachedOrder.changeItemQuantity(itemId, oldQuantity + 1);
  }
}
```

While the method waits, another operation can commit a newer order. An
in-process mutex protects only one process. It cannot coordinate another
Node worker, serverless isolate, queue consumer, or deployment replica. The
reliable boundary is a database version predicate.

## Where the expected version lives

The aggregate exposes only its current domain version. It does not know which
version a database row or event stream held when this operation loaded it.

The repository read adapter supplies that fact to `RepositoryTracking`:

```ts
const row = await loadOrderRow(tx, id);
if (!row) return undefined;

const order = Order.reconstitute(id, row.state, row.version);
return tracking.trackLoaded(order);
```

`UnitOfWork` captures the loaded version and later supplies it to the adapter's
`flush` callback as `write.expectedVersion`. It also supplies the current
`write.version`, the adapter-owned change set, and the exact event batch
registered by the use case.

The kit does not infer creation from a version number:

```ts
repositories.orders.add(newOrder);       // no expected version
repositories.orders.update(loadedOrder); // expected version from the load
```

A new aggregate can already be at version 1 or 2 because its factory recorded
facts. Conversely, an existing aggregate can legitimately be at version 0.
Explicit `add` and `update` make the lifecycle unambiguous.

## Optimistic concurrency in `flush`

For an update, compare the stored row with `write.expectedVersion` and write
`write.version` as the new value:

```ts
async function updateOrder(
  tx: DrizzleTx,
  write: AggregatePersistenceWrite<Order, OrderChange>,
): Promise<void> {
  if (write.expectedVersion === undefined) {
    throw new AggregateTrackingError("update requires a loaded version");
  }

  const result = await tx
    .update(orders)
    .set({
      ...write.changes.value,
      version: write.version,
    })
    .where(and(
      eq(orders.id, write.aggregateId),
      eq(orders.version, write.expectedVersion),
    ));

  if (result.rowsAffected === 0) {
    const current = await loadOrderVersion(tx, write.aggregateId);
    throw new ConcurrencyConflictError({
      aggregateType: "Order",
      aggregateId: write.aggregateId,
      expectedVersion: write.expectedVersion,
      actualVersion: current ?? -1,
    });
  }
}
```

For `add`, use an insert protected by the aggregate id's unique constraint. For
an event stream, append `write.events` with `write.expectedVersion ?? 0`.

The receipt is immutable. The adapter must not inspect mutable aggregate state
during the flush. `UnitOfWork` compares the registered version, event batch,
and persistence projection before and after the asynchronous flush. If one
value changes, the transaction rolls back with `AggregateTrackingError`.

## Multi-table aggregates

When one aggregate spans several tables, the root row still owns the OCC
version. The adapter's `PersistenceModel` captures a baseline at load and
derives an explicit change set when the use case registers `update`.

That change set can identify changed child collections or contain a complete
replacement DTO. Either strategy is valid. What matters is that the root-row
version predicate still participates in the same transaction. Updating only a
child table while leaving the root version unchanged permits a later writer to
overwrite the change undetected.

`setStateWithoutVersionBump` remains a deliberate escape hatch for data where
a lost concurrent update is acceptable, such as a disposable display cache.
Do not use it for domain-meaningful state.

## Handling conflicts

When an adapter throws `ConcurrencyConflictError`, the application has three
choices. It can retry the operation, return HTTP 409, or accept
last-write-wins for that path.

Do not catch the conflict inside the same `run` callback and continue using the
aggregate. Its decision was made from stale facts. A retry must start a fresh
unit of work, open a fresh transaction, reload fresh instances, and run the
command again.

## Retrying the operation

`RetryingTransactionScope` keeps retry policy at the transaction boundary:

```ts
const scope = new RetryingTransactionScope(drizzleScope, {
  maxAttempts: 3,
  baseDelayMs: 50,
  maxDelayMs: 1_000,
});

const uow = new UnitOfWork({
  scope,
  outbox: transactionalOutbox,
  repositories,
});
```

Each attempt receives a new transaction, new repository adapters, and a new
identity map. By default, the scope recognizes wrapped
`ConcurrencyConflictError` instances and uses exponential backoff with jitter.
If a driver exposes serialization failures directly, configure `isRetryable`.
Examples include PostgreSQL `40001` and SQLite `SQLITE_BUSY`.

Keep non-transactional effects out of the callback. A rolled-back attempt must
not already have sent email, called a webhook, or published to a broker. Put
durable external delivery behind a transactional outbox.

::: warning Retry needs a transactional outbox
The outbox write must use the same database transaction as aggregate state.
`InMemoryOutbox` cannot roll back rows from a failed attempt and is therefore a
test and demo adapter, not a production companion for transaction retries.
:::

## Isolation levels

The OCC pattern works under common `READ COMMITTED` databases:

```sql
UPDATE orders
SET state = ?, version = ?
WHERE id = ? AND version = ?
```

The final placeholder is the version captured during load. If another writer
commits first, the predicate matches no row. Stronger isolation levels can
abort the transaction earlier. Map the serialization error to the same retry
policy for the whole operation.

Pessimistic locking is not part of the repository contract. If a genuinely hot
path needs `SELECT ... FOR UPDATE`, keep it inside an intent-revealing adapter
operation and document why OCC is insufficient there.

## Publication after commit

`UnitOfWork` writes the registered event batches to the outbox before the
database transaction commits. Only after commit does it acknowledge exactly
those batches and run optional in-process observers or the `EventBus`.

The bus remains an in-process dispatcher. It gives deterministic event order,
but it is not a durability, cross-process delivery, or retry boundary. The
transaction and outbox provide durability.

## Invariants to preserve

- Use one aggregate instance per class and id inside an operation.
- Register `add`, `update`, or `remove` only after domain decisions finish.
- Compare updates and deletes with `write.expectedVersion`.
- If only child tables changed, advance the root version.
- Persist `write.changes` and `write.events`. Do not read the aggregate again.
- Retry conflicts by rerunning the whole operation with fresh state.
- Keep external effects outside retryable transactions or behind the outbox.

With those rules, JavaScript pause points and multi-process execution do not
turn ordinary aggregate updates into silent lost writes.
