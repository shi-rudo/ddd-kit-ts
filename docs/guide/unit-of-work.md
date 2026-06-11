# Unit of Work

`UnitOfWork` coordinates **one application-level write operation**: all repository writes inside one `run()` callback share the same transaction and either persist completely or not at all. It contains no business logic — rules stay in aggregates, domain services, and application services.

It is built **on top of [`withCommit`](./outbox.md)**, not beside it. The commit orchestration is inherited: pending events are harvested into the outbox *inside* the transaction, `markPersisted` fires *after* the commit, and the best-effort in-process publish runs last. What the facade adds:

- **Tx-bound repositories via a registry** — the callback receives ready-made repositories instead of a raw transaction handle.
- **Enrollment instead of a returned aggregates array** — repositories enroll what they write, so "forgot to list the aggregate" (the `withCommit` footgun that silently drops events) cannot happen per call site.
- **A small lifecycle-error taxonomy** — `NestedUnitOfWorkError`, `TransactionClosedError`, `CommitError`, `RollbackError`, `AggregateDeletedError`.

`withCommit` with hand-rolled, tx-bound repositories remains fully supported; the facade is opt-in. See [TransactionScope stays minimal; the Unit of Work lives above it](./design-decisions.md#transactionscope-stays-minimal-the-unit-of-work-lives-above-it) for the design history.

## Wiring

The dependency object is the app-level singleton; it holds the scope, the outbox, an optional bus, and a **factory map**: for each repository, a function constructing it from the live transaction handle and the enrollment session.

```ts
import { UnitOfWork } from "@shirudo/ddd-kit";

const deps = {
  scope: drizzleScope,        // TransactionScope<DrizzleTx>
  outbox: drizzleOutbox,      // Outbox<AppEvent>
  bus: eventBus,              // optional, in-process fast path
  repositories: {
    restaurants: (tx: DrizzleTx, session: UnitOfWorkSession<AppEvent>) =>
      new DrizzleRestaurantRepository(tx, session),
    bookings: (tx: DrizzleTx, session: UnitOfWorkSession<AppEvent>) =>
      new DrizzleBookingRepository(tx, session),
  },
};
```

A use case then runs:

```ts
const uow = new UnitOfWork(deps);

const result = await uow.run(async ({ repositories }) => {
  const restaurant = await repositories.restaurants.getByIdOrFail(restaurantId);

  restaurant.changeOpeningHours(openingHours);

  await repositories.restaurants.save(restaurant); // save() enrolls
  return restaurant.id;
});
```

Every factory is invoked once per `run()` with the **same** transaction handle, so all writes of one unit of work share one transaction by construction. The context also exposes `transaction` (the raw handle, for writes no repository covers) and `session` (manual enrollment for exactly that case).

## Enrollment: the repository's contract

Repositories built for the unit of work take the session alongside the transaction handle and enroll every aggregate they write:

```ts
class DrizzleRestaurantRepository {
  constructor(
    private readonly tx: DrizzleTx,
    private readonly session: UnitOfWorkSession<AppEvent>,
  ) {}

  async save(restaurant: Restaurant): Promise<void> {
    if (!restaurant.hasChanges) return;        // safe no-op skip
    // root row first (OCC), then changedKeys-scoped child tables —
    // see "Partial writes for multi-table aggregates" in the
    // Repository guide
    await this.writeRows(restaurant);
    this.session.enrollSaved(restaurant);
  }

  async delete(restaurant: Restaurant): Promise<void> {
    await this.deleteRows(restaurant.id);
    this.session.enrollDeleted(restaurant);
  }
}
```

Semantics:

- **Enrollment is idempotent per instance** — saving the same aggregate instance twice harvests its events once and calls `markPersisted` once (the same reference-dedupe `withCommit` performs).
- **Deleted aggregates still get their events harvested.** The [hard-delete-with-event-harvest pattern](./repository.md#2-hard-delete-with-event-harvest) maps 1:1: `restaurant.recordDeletion(reason)` then `repositories.restaurants.delete(restaurant)` — the deletion event reaches the outbox atomically with the row removal.
- **Deletion is final within an operation.** `enrollSaved` after `enrollDeleted` of the same instance throws `AggregateDeletedError`: saving a row the delete just removed is always a use-case bug.

This moves the event-handoff responsibility from *every call site* (the `withCommit` model: forget to return the aggregate → events silently dropped) to *every repository implementation* — implemented once, pinned by that repository's tests once.

## Error taxonomy

| Error | Means | Class |
|---|---|---|
| anything your callback threw | rolled back; **rethrown unchanged** — a repository's `ConcurrencyConflictError` stays catchable as-is, never converted to a generic error | — |
| `CommitError` | the callback completed, then the event harvest, outbox write, or commit rejected (the kit cannot see inside `transactional`, so these are deliberately one class; the real failure is the `cause`). Nothing committed; pending events survive; safe to retry | `InfrastructureError` |
| `RollbackError` | the callback threw AND the scope rejected with a *different* error that does not wrap the original — the strongest available signal that the rollback itself failed. The callback's error is the `cause` (cause-chain helpers still find it); the scope's error is in `rollbackCause` | `InfrastructureError` |
| `NestedUnitOfWorkError` | `run()` while the same instance is already running (nesting or instance-sharing across concurrent operations) | `BaseError` — programming bug, crash loud |
| `TransactionClosedError` | context/session used after `run()` settled | `BaseError` — programming bug |
| `AggregateDeletedError` | save after delete of the same instance in one unit of work | `BaseError` — programming bug |

Scopes that rethrow the callback's error (Drizzle, Prisma) never produce `RollbackError`; scopes that *wrap* it are detected via the standard `cause` chain and passed through unchanged.

## Nesting and instance discipline

One `UnitOfWork` instance owns **one logical operation at a time**. A nested `run()` would *not* join the outer transaction — it would open an independent one, silently breaking all-or-nothing — so it throws `NestedUnitOfWorkError` instead. If two pieces of work must commit together, they are one unit of work: merge them into a single callback.

Construct one instance per operation (construction stores a single reference; the deps object is the thing you share):

```ts
// per request / command execution
const uow = new UnitOfWork(deps);
await uow.run(/* … */);
```

Sequential reuse of an instance is fine; sharing one instance across concurrent operations is the same bug as nesting and surfaces as the same error.

## What the guard can and cannot enforce

After `run()` settles, the context getters (`repositories`, `transaction`) and the session throw `TransactionClosedError`. That is the honest extent of the guarantee: the kit can only invalidate what it controls. A repository or raw `tx` handle captured into an outer variable *before* close keeps working as far as the kit can see — whether the underlying handle rejects is ORM-specific. Don't let references escape the callback.

The same honesty applies inside the callback: **do not mutate an aggregate after `save()`** — the post-commit `markPersisted` re-baselines dirty tracking against the *current* state, so a late mutation is silently marked clean (see the [`withCommit` ordering notes](./outbox.md)). Mutate first, save last.

## What v1 deliberately does not do

- **No auto-flush.** Explicit `save()` only. With [`hasChanges`](./repository.md#partial-writes-for-multi-table-aggregates-changedkeys--haschanges) a redundant save is a cheap no-op, and a *forgotten* save stays visible in tests instead of being hidden by magic.
- **No identity map yet** — planned as the next phase. Until then the [Identity Map contract](./repository.md#identity-map-one-instance-per-aggregate-per-unit-of-work) remains the repository implementer's responsibility.
- **No savepoints, no transaction joining, no distributed transactions.**
