# Concurrency & Thread Safety

JavaScript is single-threaded, but `async / await` creates concurrency risks. This page covers the patterns the kit assumes.

## What we mean by "operation"

- An **HTTP request** in a web API
- A **command execution** in CQRS (CreateOrder, UpdateQuantity, …)
- A **query execution** (GetOrder, ListOrders, …)
- A **background job** (email sender, report generator, scheduled task)
- An **event handler** processing a single domain event

The cardinal rule: **each operation loads fresh aggregate instances, makes changes, saves them, discards them.** Aggregates are never cached, shared, or held across operations.

## The race-condition trap

```ts
// ❌ DANGEROUS: race condition
class OrderService {
  private cachedOrder: Order; // NEVER cache aggregates

  async updateQuantity(itemId: ItemId, quantity: number) {
    const item = this.cachedOrder.getItem(itemId);
    const oldQty = item.state.quantity;       // reads 5

    await someAsyncOperation();               // ⚠️ context switch here
    // Meanwhile Request 2 updated qty to 10

    item.updateQuantity(oldQty + 1);          // writes 6, should be 11!
  }
}
```

What goes wrong:
- `await` yields control to the event loop
- Other async operations can run while we wait
- The cached aggregate now holds stale data
- Last write wins, silent data loss

## Solution 1: Operation-scoped aggregates (canonical)

Each operation gets its own aggregate instance. Load → Mutate → Save → Discard.

```ts
async function updateQuantity(orderId: OrderId, itemId: ItemId, quantity: number) {
  const order = await orderRepository.getByIdOrFail(orderId); // fresh load
  order.updateItemQuantity(itemId, quantity);
  await orderRepository.save(order);                          // save, throws on conflict
}
```

The kit's `withCommit` makes this the default shape: the transactional callback explicitly loads, mutates, returns. Nothing leaks across operations.

## Solution 2: Optimistic concurrency control (OCC)

When two operations might still race despite operation-scoping (two Workers, two replicas, retry storms), the version field catches the conflict:

```ts
async function save(order: Order): Promise<void> {
  const expectedVersion = order.version - order.pendingEvents.length;
  const writeResult = await db
    .update(orders)
    .set({ ...orderToRow(order) })
    .where(and(eq(orders.id, order.id), eq(orders.version, expectedVersion)))
    .returning();

  if (writeResult.length === 0) {
    throw new ConcurrencyConflictError("Order", order.id, expectedVersion, order.version);
  }

  order.markPersisted(order.version);
}
```

The Use Case catches `ConcurrencyConflictError` at the App-Service boundary and decides: retry the operation (re-load, re-mutate), surface the conflict to the caller (HTTP 409), or accept last-write-wins for that path.

The `version` lives on the aggregate root, not on its child entities or value objects; OCC is enforced at the consistency boundary. See [Version lives on the aggregate boundary](./design-decisions.md#version-lives-on-the-aggregate-boundary-not-on-entities-or-value-objects) for the rationale and the alternatives when you think a child needs its own version.

::: tip Multi-table aggregates: the version bump must ride every save
A classic OCC failure mode in aggregates that span multiple tables: collection writes are orchestrated outside the aggregate, so a collection-only change never bumps the root version, and teams patch over it with a manual "touch" method (`markCollectionsRevised()`-style) that every service method must remember to call. The kit's answer is [`changedKeys` / `hasChanges` on `AggregateRoot`](./repository.md#partial-writes-for-multi-table-aggregates-changedkeys--haschanges): the repository scopes child-table writes by dirty key while the root-row version write rides every save, and the touch-method workaround dissolves. One precondition: the bump rides the save only for **version-bumping mutations** — `commit()` (always bumps) or `setState(newState, true)`. A no-bump `setState(newState, false)` dirties the key without advancing the version, so the OCC predicate doesn't move; reserve no-bump mutations for data a concurrent writer may safely overwrite.
:::

## EventBus is sequential per event-type, parallel per handler

`EventBus.publish(events)`:

1. Events run in **input order**, sequentially. `publish([a, b, c])` dispatches `a`, awaits all of its handlers, then dispatches `b`, and so on.
2. Handlers within a single event run in **parallel** via `Promise.allSettled`.
3. Errors are collected and thrown **after** the whole batch dispatches: a single `Error` if one handler failed, an `AggregateError` ("Multiple event handlers failed") otherwise.

The bus does not provide retry, backpressure, or dead-letter handling; for cross-process delivery use the `Outbox` port and a dedicated dispatcher.

## The kit's invariants in summary

- `EventSourcedAggregate.apply()` is atomic: handler throws? state and events stay in sync
- `AggregateRoot.commit(state, events)` is atomic: validateState throws? no event recorded
- `withCommit` publishes events **after** the transaction commits, so rolled-back state never produces visible events
- `loadFromHistory` and `restoreFromSnapshotWithEvents` are atomic: a mid-replay failure rolls back to the pre-call state
- Domain events are deeply frozen, so a mutating subscriber can't poison its peers
- Repositories enforce OCC via `ConcurrencyConflictError`

If you stick to operation-scoped aggregates + the above invariants, the kit's concurrency story is well-defined.
