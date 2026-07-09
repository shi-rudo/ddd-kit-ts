# Unit Of Work

`UnitOfWork` coordinates one application-level write operation. All
repository writes inside one `run()` callback share one transaction. They
commit together or roll back together.

It is built on top of `withCommit`. That means the same commit lifecycle
applies:

1. Run the application work inside `TransactionScope.transactional(...)`.
2. Harvest pending events into the outbox inside the transaction.
3. Commit.
4. Mark persisted aggregates after commit.
5. Publish to the optional in-process bus last.

What `UnitOfWork` adds is repository wiring, enrollment, and an identity map.
Use plain `withCommit` when you are comfortable returning the aggregate list
from each use case. Use `UnitOfWork` when you want repositories to enroll the
aggregates they write.

## Wiring

The shared dependency object contains the transaction scope, outbox, optional
bus, and repository factories.

```ts
import {
  UnitOfWork,
  type UnitOfWorkSession,
} from "@shirudo/ddd-kit";

const deps = {
  scope: drizzleScope,
  outbox: drizzleOutbox,
  bus: eventBus,
  repositories: {
    orders: (tx: DrizzleTx, session: UnitOfWorkSession<AppEvent>) =>
      new DrizzleOrderRepository(tx, session),
    invoices: (tx: DrizzleTx, session: UnitOfWorkSession<AppEvent>) =>
      new DrizzleInvoiceRepository(tx, session),
  },
};
```

Create a `UnitOfWork` for one operation and call `run`:

```ts
const uow = new UnitOfWork(deps);

const orderId = await uow.run(async ({ repositories }) => {
  const order = await repositories.orders.getById(id);

  order.confirm();
  await repositories.orders.save(order);

  return order.id;
});
```

Every repository factory is called once for that `run()` with the same
transaction handle and the same session. The callback receives:

- `repositories`: ready-to-use repositories bound to the transaction.
- `session`: enrollment and identity-map access.
- `rawTransaction`: an escape hatch for writes no repository covers.
- `signal`: optional cancellation signal.

Prefer adding repository methods over using `rawTransaction`. A raw write
bypasses enrollment and the identity map unless you do the missing work
yourself.

Read-only `run()` calls are fine when several reads need the same
transactional snapshot. For one simple read, a direct query is lighter.

## Repository Contract

A Unit-of-Work repository receives both `tx` and `session`.

```ts
class DrizzleOrderRepository {
  constructor(
    private readonly tx: DrizzleTx,
    private readonly session: UnitOfWorkSession<OrderEvent>,
  ) {}
}
```

The read path uses the identity map:

```ts
async findById(id: OrderId): Promise<Order | null> {
  const cached = this.session.identityMap.get(Order, id);
  if (cached) return cached;

  if (this.session.identityMap.isDeleted(Order, id)) {
    return null;
  }

  const row = await this.loadRow(id);
  if (!row) return null;

  const order = Order.reconstitute(row.id as OrderId, row.state, row.version);
  this.session.identityMap.set(Order, id, order);
  return order;
}
```

The write path enrolls before the row write, and before no-op returns:

```ts
async save(order: Order): Promise<void> {
  this.session.enrollSaved(order);

  if (!order.hasChanges) {
    return;
  }

  await this.writeRows(order);
}
```

That ordering is intentional. If the aggregate was deleted earlier in the same
unit of work, `enrollSaved` throws `AggregateDeletedError` before the save can
quietly return.

Delete enrolls the aggregate as deleted:

```ts
async delete(order: Order): Promise<void> {
  await this.deleteRows(order);
  this.session.enrollDeleted(order);
}
```

`enrollDeleted` removes the identity-map entry, records a tombstone, keeps the
aggregate in the harvest set, and tells the post-commit lifecycle to clear its
pending events without calling `markPersisted`.

## Identity Map

`session.identityMap` gives one aggregate type and id one in-memory instance
inside a `run()`.

Why it matters: event harvest and `markPersisted` dedupe by JavaScript object
identity. If a repository hydrates the same aggregate twice, the unit of work
can see two objects and harvest both. The identity map prevents that.

Important behavior:

- The key is the aggregate class plus id, not a string name.
- `get` returns the current instance when it exists.
- `set` accepts the same instance again but rejects a different instance for
  the same type and id.
- `isDeleted` lets the read path treat "deleted in this run" as not found.
- `delete` tombstones the aggregate, so later re-registration throws
  `AggregateDeletedError`.
- The map is cleared when `run()` closes. Do not keep aggregate instances
  across operations.

## What Run Guarantees

Inside one `run()`:

- All repository writes share one transaction.
- Repositories enroll saved and deleted aggregates.
- Before commit, newly recorded pending events on loaded aggregates must be
  enrolled or `UnenrolledChangesError` is thrown.
- Enrolled events are written to the outbox inside the same transaction.
- After commit, saved aggregates are marked persisted.
- Deleted aggregates have pending events cleared without `markPersisted`.
- Optional bus publishing happens after commit and is best-effort.

The callback result is returned directly:

```ts
const id = await uow.run(async ({ repositories }) => {
  const order = await repositories.orders.getById(orderId);
  order.confirm();
  await repositories.orders.save(order);
  return order.id;
});
```

`run()` does not return a `Result`. If you use it inside a `CommandHandler`,
wrap success and failure at the command boundary.

## Rules For Use Cases

Keep these rules strict:

- Use one `UnitOfWork` instance for one logical operation at a time.
- Do not call `run()` inside another `run()` on the same instance.
- Do not open separate transactions inside the callback.
- Do not publish events inside the callback.
- Do not send emails, call payment providers, upload files, or call webhooks
  inside the transaction.
- Mutate first, save last.
- Do not mutate an aggregate after `save()` in the same callback.
- If a repository write rejects, let the callback fail. Do not catch the error
  and continue.
- After rollback, discard loaded aggregate instances and retry in a fresh
  `run()`.

A never-persisted aggregate whose first save rolled back is the narrow
exception to the last rule: there is no row to reload, and
`persistedVersion` is still `undefined`, so retrying the first insert with the
same instance can be valid.

## No Side Effects Inside The Transaction

This is wrong:

```ts
await uow.run(async ({ repositories }) => {
  const booking = await repositories.bookings.getById(id);

  booking.confirm();
  await stripe.capturePayment(paymentId);
  await repositories.bookings.save(booking);
});
```

If Stripe succeeds and the database rolls back, the system is inconsistent. If
Stripe is slow, the transaction holds locks while waiting for a network call.

Record intent and let the outbox drive the external call:

```ts
await uow.run(async ({ repositories }) => {
  const booking = await repositories.bookings.getById(id);

  booking.confirm();
  await repositories.bookings.save(booking);

  return booking.id;
});
```

`booking.confirm()` records a domain event such as `BookingConfirmed` or
`PaymentCaptureRequested`. A dispatcher handles the external payment after the
commit.

## Errors

Callback errors pass through unchanged in the normal case. A
`ConcurrencyConflictError` thrown by a repository is still catchable as
`ConcurrencyConflictError`.

The unit of work wraps only failures the callback cannot see:

| Error | Meaning |
| --- | --- |
| `CommitError` | callback completed, but outbox write or commit failed |
| `RollbackError` | callback threw, and rollback failed with a different error |
| `NestedUnitOfWorkError` | same instance entered `run()` while already running |
| `TransactionClosedError` | context or session used after `run()` settled |
| `AggregateDeletedError` | save or re-register after delete in the same run |
| `EventHarvestError` | harvested event is missing required aggregate routing data or has an invalid pre-set stamp |
| `UnenrolledChangesError` | loaded aggregate recorded new events but no repository enrolled it |

`CommitError` and `RollbackError` are infrastructure errors. The others are
wiring errors: fix the use case or repository implementation instead of
retrying blindly.

Retrying an optimistic concurrency conflict means a fresh operation:

```txt
reload aggregate
re-apply command
save
commit
```

Do not catch `ConcurrencyConflictError` inside the same `run()` and continue.
The failed aggregate was already enrolled, and the identity map still holds
the stale instance.

Use `RetryingTransactionScope` when you want automatic retry with backoff.

## Closed Context Guard

After `run()` settles, these throw `TransactionClosedError`:

- `context.repositories`
- `context.rawTransaction`
- `session.identityMap`
- `session.enrollSaved(...)`
- `session.enrollDeleted(...)`

This catches leaked contexts and un-awaited work. It cannot invalidate a raw
repository or raw transaction handle you copied into an outer variable before
close. Do not let those references escape the callback.

## Cancellation And Deadlines

Pass an `AbortSignal` as the second argument:

```ts
const orderId = await uow.run(
  async ({ repositories, signal }) => {
    const order = await repositories.orders.getById(orderId);

    order.confirm();

    if (signal?.aborted) {
      throw signal.reason;
    }

    await repositories.orders.save(order);
    return order.id;
  },
  { signal: AbortSignal.timeout(5_000) },
);
```

The behavior is cooperative:

- If the signal is already aborted, `run()` rejects before opening a
  transaction.
- The signal is exposed on the context so your callback can poll it.
- The signal is forwarded to `TransactionScope.transactional`.

The kit does not race the callback promise against the signal. Aborting a
running query requires support from your transaction scope or driver. Pair
this with database statement or transaction timeouts for hard ceilings.

`withCommit` supports the same signal option.

## Contract Tests

The unit of work relies on repository behavior that TypeScript cannot prove:
identity map checks, enrollment, OCC predicates, rollback purity, duplicate
insert mapping, delete finality, and outbox event harvest.

Run the repository contract suite against each real adapter:

```ts
import { createRepositoryContractTests } from "@shirudo/ddd-kit/testing";

describe("DrizzleOrderRepository", () => {
  for (const test of createRepositoryContractTests(harness)) {
    (test.skipped ? it.skip : it)(test.name, test.run);
  }
});
```

For SQL and ORM adapters, run it against a real database, not only an in-memory
fake. The point is to prove your real `WHERE version = ...` predicate and
transaction behavior.

Optional harness capabilities produce skipped tests when absent. Keep those
skips visible; they are documented gaps, not green coverage.

## What It Does Not Do

`UnitOfWork` is explicit-save by design:

- no auto-flush;
- no savepoints;
- no nested transaction joining;
- no distributed transaction;
- no automatic side-effect dispatch beyond the outbox and optional bus;
- no repository magic for queries that should be projections.

With `hasChanges`, a redundant save is cheap. A forgotten save should be found
by tests, not hidden behind implicit flushing.
