# Unit of Work

`UnitOfWork` coordinates **one application-level write operation**: all repository writes inside one `run()` callback share the same transaction and either persist completely or not at all. It contains no business logic — rules stay in aggregates, domain services, and application services.

It is built **on top of [`withCommit`](./outbox.md)**, not beside it. The commit orchestration is inherited: pending events are harvested into the outbox *inside* the transaction, `markPersisted` fires *after* the commit, and the best-effort in-process publish runs last. What the facade adds:

- **Tx-bound repositories via a registry** — the callback receives ready-made repositories instead of a raw transaction handle.
- **Enrollment instead of a returned aggregates array** — repositories enroll what they write, so "forgot to list the aggregate" (the `withCommit` footgun that silently drops events) cannot happen per call site.
- **A per-operation Identity Map** — one aggregate type+id maps to one in-memory instance per unit of work; repositories check it before hydrating.
- **A small lifecycle-error taxonomy** — `NestedUnitOfWorkError`, `TransactionClosedError`, `CommitError`, `RollbackError`, `AggregateDeletedError`.

`withCommit` with hand-rolled, tx-bound repositories remains fully supported; the facade is opt-in. See [TransactionScope stays minimal; the Unit of Work lives above it](./design-decisions.md#transactionscope-stays-minimal-the-unit-of-work-lives-above-it) for the design history.

## Wiring

The dependency object is the app-level singleton; it holds the scope, the outbox, an optional bus, and a **factory map**: for each repository, a function constructing it from the live transaction handle and the enrollment session.

```ts
import { UnitOfWork, type UnitOfWorkSession } from "@shirudo/ddd-kit";

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

Every factory is invoked once per `run()` with the **same** transaction handle, so all writes of one unit of work share one transaction by construction. The context also exposes `session` (manual enrollment) and `rawTransaction` — deliberately named to look like what it is: an **escape hatch**. A write on the raw handle leaves the unit of work's guarantees: no enrollment (events silently skipped unless you call `session.enrollSaved` yourself), no identity-map registration (a later `getById` hydrates a second instance — double harvest, double `markPersisted`). Prefer adding a repository method; reach for `rawTransaction` only for writes no repository could reasonably cover.

## The rules

These sentences are the contract. Internalize them before building repositories:

1. **The Unit of Work is the only write boundary.** Use cases never open transactions themselves.
2. **Repositories do not commit.** `save()`/`delete()` write rows and enroll aggregates; commit and rollback belong to `run()`.
3. **Optimistic concurrency is enforced at the aggregate-root level** — and it is a **repository contract, not a kit guarantee**: the kit ships the boundary, the `persistedVersion` baseline, the documented predicate, and `ConcurrencyConflictError`; *your* repository must implement `WHERE version = $persistedVersion` on every update (and OCC-checked deletes where deletion races matter). A repository that skips the predicate silently disables OCC for its aggregate.
4. **Child-entity changes increment the aggregate-root version.** There is no per-child versioning.
5. **`version` is a mutation sequence, not a commit revision.** Three domain methods bump it three times: a baseline of 7 commits as 10, and the OCC predicate still uses `WHERE version = 7` (the load-time `persistedVersion`). If you expect `+1 per commit`, your tests will be wrong — see [Versioning convention](./repository.md#insert-vs-update-the-persistedversion-convention).
6. **Domain events are persisted through the outbox in the same transaction.** Never publish from inside the callback.
7. **External side effects must not run inside the Unit of Work transaction** — see below.
8. **Nested Unit of Work scopes are not allowed.** A nested `run()` throws; it would not join the outer transaction.
9. **Do not reuse aggregate instances after a rollback.** They keep their in-memory mutations and pending events (deliberately, so a *fresh load* and retry is possible), but their state no longer corresponds to any row. Discard them; reload inside the next unit of work.

## No side effects inside the transaction

The callback runs inside an open database transaction. Nothing that talks to the outside world belongs there — no e-mail, no payment capture, no webhook, no file upload, no direct `eventBus.publish`:

```ts
// ❌ WRONG: external call inside the transaction
await uow.run(async ({ repositories }) => {
  const booking = await repositories.bookings.getByIdOrFail(id);
  booking.confirm();
  await stripe.capturePayment(paymentId); // ⚠️ tx still open!
  await repositories.bookings.save(booking);
});
```

Two failure modes: the external call succeeds and the transaction rolls back (payment captured, booking never confirmed), or the external call is slow and the transaction holds locks for its duration. The correct shape is outbox-first:

```ts
// ✅ Record the intent as a domain event; a worker does the call
booking.confirm(); // records BookingConfirmed / PaymentCaptureRequested
await repositories.bookings.save(booking);
// → outbox written in the same tx → commit → dispatcher calls Stripe
```

The in-process `bus` publish that `withCommit` performs happens **after** the commit and is best-effort by design; the outbox is the reliable path.

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
    // ONE call does all the deletion bookkeeping: the identity-map
    // entry is removed and tombstoned automatically.
    this.session.enrollDeleted(restaurant);
  }
}
```

Semantics:

- **Enrollment is idempotent per instance** — saving the same aggregate instance twice harvests its events once and calls `markPersisted` once (the same reference-dedupe `withCommit` performs).
- **Deleted aggregates still get their events harvested — but the post-save lifecycle is not a lie for them.** The [hard-delete-with-event-harvest pattern](./repository.md#2-hard-delete-with-event-harvest) maps 1:1: `restaurant.recordDeletion(reason)` then `repositories.restaurants.delete(restaurant)` — the deletion event reaches the outbox atomically with the row removal. After the commit, `markPersisted` is **skipped** for deleted aggregates (their pending events are cleared directly), so a user `onPersisted` hook doing cache fill or read-model warm-up never fires for a row that no longer exists.
- **Deletion is final within an operation — across instances.** `enrollDeleted` tombstones the aggregate's class+id in the identity map; saving the same instance *or a re-created instance with the same identity* afterwards throws `AggregateDeletedError`. Resurrecting a row the delete just removed is always a use-case bug.

This moves the event-handoff responsibility from *every call site* (the `withCommit` model: forget to return the aggregate → events silently dropped) to *every repository implementation* — implemented once, pinned by that repository's tests once.

## Identity Map

`session.identityMap` is the shipped implementation of [Fowler's Identity Map contract](./repository.md#identity-map-one-instance-per-aggregate-per-unit-of-work): within one unit of work, one aggregate type+id maps to exactly **one** in-memory instance. `withCommit`'s exactly-once event harvest and `markPersisted` are keyed on object identity — the map is what makes that dedupe sound by construction instead of by repo-implementer discipline.

The read path checks before hydrating and registers after:

```ts
async getById(id: OrderId): Promise<Order | null> {
  const cached = this.session.identityMap.get(Order, id);
  if (cached) return cached;
  // Deleted in this unit of work = uniformly not-found, even when the
  // physical delete is deferred and the row is still visible in the tx.
  if (this.session.identityMap.isDeleted(Order, id)) return null;

  const row = await this.loadRow(id);
  if (!row) return null;
  const order = Order.reconstitute(row.id as OrderId, row.state, row.version);
  this.session.identityMap.set(Order, id, order);
  return order;
}
```

Semantics worth knowing:

- **The type key is the aggregate class**, not a name string — `Restaurant:123` and `Booking:123` can never collide, and there is no naming discipline to maintain. Protected constructors (the kit's aggregate convention) are accepted.
- **`set()` is strict.** Re-registering the same instance is a no-op; registering a *different* instance for an occupied type+id throws — that is exactly the violation the map exists to prevent (hydrated twice without checking `get()` first).
- **Deletion tombstones, with a probe.** `enrollDeleted` (or a manual `delete(Type, id)`) removes the entry *and* blocks re-registration: a later `set()` of the same type+id throws `AggregateDeletedError`. The read path checks `isDeleted(Type, id)` and returns `null`, so a read-only probe of a deleted aggregate behaves like not-found instead of crashing — uniformly, whether the repository's physical delete already ran or is deferred.
- **Lifetime is one `run()`.** The map is created fresh per operation (a retrying `TransactionScope` gets a fresh map per attempt) and cleared on close; `session.identityMap` throws `TransactionClosedError` afterwards. Never cache aggregates across operations — that bypasses optimistic concurrency control.

## Error taxonomy

| Error | Means | Class |
|---|---|---|
| anything your callback threw | rolled back; **rethrown unchanged** — a repository's `ConcurrencyConflictError` stays catchable as-is, never converted to a generic error | — |
| `CommitError` | the callback completed, then the event harvest, outbox write, or commit rejected (the kit cannot see inside `transactional`, so these are deliberately one class; the real failure is the `cause`). Nothing committed, pending events survive — but **whether a retry helps depends on the cause**: a commit-time serialization failure is transient, while `withCommit`'s harvest guard (event missing `aggregateId`/`aggregateType` — a programming bug) fails deterministically forever. Inspect the `cause` before routing into retry logic | `InfrastructureError` |
| `RollbackError` | the callback threw AND the scope rejected with a *different* error that does not wrap the original — the strongest available signal that the rollback itself failed. The callback's error is the `cause` (cause-chain helpers still find it); the scope's error is in `rollbackCause` | `InfrastructureError` |
| `NestedUnitOfWorkError` | `run()` while the same instance is already running (nesting or instance-sharing across concurrent operations) | `BaseError` — programming bug, crash loud |
| `TransactionClosedError` | context/session used after `run()` settled | `BaseError` — programming bug |
| `AggregateDeletedError` | save (or identity-map re-registration) after delete of the same aggregate in one unit of work — same instance via the enrollment gate, *or* a different instance with the same class+id via the deletion tombstone (e.g. re-created through a factory, or re-hydrated by a deferred-write repository that skips the `isDeleted` check) | `BaseError` — programming bug |

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

After `run()` settles, the context getters (`repositories`, `rawTransaction`) and the session throw `TransactionClosedError`. That is the honest extent of the guarantee: the kit can only invalidate what it controls. A repository or raw `tx` handle captured into an outer variable *before* close keeps working as far as the kit can see — whether the underlying handle rejects is ORM-specific. Don't let references escape the callback.

The same honesty applies inside the callback: **do not mutate an aggregate after `save()`** — the post-commit `markPersisted` re-baselines dirty tracking against the *current* state, so a late mutation is silently marked clean (see the [`withCommit` ordering notes](./outbox.md)). Mutate first, save last.

## What v1 deliberately does not do

- **No auto-flush.** Explicit `save()` only. With [`hasChanges`](./repository.md#partial-writes-for-multi-table-aggregates-changedkeys--haschanges) a redundant save is a cheap no-op, and a *forgotten* save stays visible in tests instead of being hidden by magic.
- **No savepoints, no transaction joining, no distributed transactions.**
