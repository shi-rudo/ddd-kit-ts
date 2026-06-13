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
A classic OCC failure mode in aggregates that span multiple tables: collection writes are orchestrated outside the aggregate, so a collection-only change never bumps the root version, and teams patch over it with a manual "touch" method (`markCollectionsRevised()`-style) that every service method must remember to call. The kit's answer is [`changedKeys` / `hasChanges` on `AggregateRoot`](./repository.md#partial-writes-for-multi-table-aggregates-changedkeys--haschanges): the repository scopes child-table writes by dirty key while the root-row version write rides every save, and the touch-method workaround dissolves. One precondition: the bump rides the save only for **version-bumping mutations**: `commit()` (always bumps) or `setState(newState, true)`. A no-bump `setState(newState, false)` dirties the key without advancing the version, so the OCC predicate doesn't move; reserve no-bump mutations for data a concurrent writer may safely overwrite.
:::

### Retrying conflicts: `RetryingTransactionScope`

Retrying an OCC conflict means a **fresh `run()`**: reload, re-apply, save. The kit ships a `TransactionScope` wrapper that does exactly that, so you do not hand-roll the retry loop (the part teams reliably get wrong):

```ts
import { RetryingTransactionScope, UnitOfWork } from "@shirudo/ddd-kit";

const scope = new RetryingTransactionScope(drizzleScope, {
  maxAttempts: 3,   // default; 1 initial + 2 retries
  baseDelayMs: 50,  // default; doubles each retry
  maxDelayMs: 1000, // default ceiling
});
const uow = new UnitOfWork({ scope, outbox, repositories });
```

Compose it transparently as the unit of work's scope; nothing else changes. What it guarantees so you don't have to:

- **Classification, not guesswork.** Only errors a predicate accepts are retried (default `someChainRetryable`, which matches `ConcurrencyConflictError` even when wrapped). A `DomainError`, `EventHarvestError`, `UnenrolledChangesError`, `DuplicateAggregateError`, or any non-retryable error surfaces immediately instead of looping. Override `isRetryable` to add driver serialization codes (Postgres 40001, MySQL 1213, SQLite SQLITE_BUSY) your adapter has not mapped to a retryable kit error.
- **Exponential backoff with a +/-20% jitter band**, capped at `maxDelayMs`, to decorrelate simultaneous conflicts without unbounded latency.
- **Last error unchanged on exhaustion**, so the caller can still match `ConcurrencyConflictError` and return HTTP 409.
- **Cancellation via the existing `AbortSignal`.** Pass `AbortSignal.timeout(ms)` to `run()`; it aborts the backoff *waits* between attempts and the pre-attempt check. It does **not** interrupt a query already in flight unless your scope's driver honors the signal (see [`TransactionalOptions`](./outbox.md)), so a single slow attempt can still overshoot the deadline; there is no separate max-elapsed knob.

The retried region is the transaction only: each attempt opens a fresh transaction and the unit of work resets its per-attempt state, so your work callback must reload its aggregates inside `run()` and avoid non-transactional side effects before commit. The post-commit publish runs once, after the retried region.

::: warning Retry requires a transactional outbox
`outbox.add` runs **inside** the retried transaction. With a transactional outbox (the events row participates in the same DB transaction as the aggregate write, the production pattern), a rolled-back attempt's events roll back with it, so only the committed attempt's events survive. The shipped in-memory reference outbox is **not** transactional: a rolled-back attempt's events stay in it, and because each retry reloads the aggregate and records events with fresh ids, those orphans accumulate (a dispatcher would publish phantom events for transactions that never committed). Use `RetryingTransactionScope` only with a transactional outbox; the in-memory outbox is for tests and single-attempt flows.
:::

## Isolation levels: what the kit assumes

The kit's OCC pattern is correct under **READ COMMITTED** (the default of Postgres, MySQL/InnoDB's default, REPEATABLE READ, differs, but the predicate works there too): the version predicate compares against the row's committed state at write time, so a concurrent committed write makes the `UPDATE … WHERE version = $baseline` affect zero rows regardless of what was read earlier in the transaction. Three rules keep that sound:

1. **Reads that feed decisions happen inside the same transaction** as the write (the `withCommit` / `UnitOfWork.run()` shape does this naturally). Deciding outside the transaction and writing blindly later defeats OCC: the version you compare against must be the version you loaded.
2. **Keep transactions short.** No external calls inside (see the Unit of Work guide); long transactions turn OCC conflicts into lock waits and serialization failures.
3. **SERIALIZABLE-class databases** (CockroachDB, Postgres with `SERIALIZABLE`) may abort transactions with serialization failures instead of letting the predicate miss; wrap your scope in [`RetryingTransactionScope`](#retrying-conflicts-retryingtransactionscope) (mapping the driver's serialization code to a retryable error via `isRetryable`), since the kit's `UnitOfWork` creates fresh per-attempt state, so scope-level retries are safe.

Pessimistic locking (`SELECT … FOR UPDATE`) is not part of any kit contract; if a hot row genuinely needs it, implement it inside a repository method, explicitly, and document why OCC was insufficient.

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
