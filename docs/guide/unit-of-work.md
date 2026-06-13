# Unit of Work

`UnitOfWork` coordinates **one application-level write operation**: all repository writes inside one `run()` callback share the same transaction and either persist completely or not at all. It contains no business logic: rules stay in aggregates, domain services, and application services.

It is built **on top of [`withCommit`](./outbox.md)**, not beside it. The commit orchestration is inherited: pending events are harvested into the outbox *inside* the transaction, `markPersisted` fires *after* the commit, and the best-effort in-process publish runs last. What the facade adds:

- **Tx-bound repositories via a registry**: the callback receives ready-made repositories instead of a raw transaction handle.
- **Enrollment instead of a returned aggregates array**: repositories enroll what they write, so "forgot to list the aggregate" (the `withCommit` footgun that silently drops events) cannot happen per call site.
- **A per-operation Identity Map**: one aggregate type+id maps to one in-memory instance per unit of work; repositories check it before hydrating.
- **A small lifecycle-error taxonomy**: `NestedUnitOfWorkError`, `TransactionClosedError`, `CommitError`, `RollbackError`, `AggregateDeletedError`, `EventHarvestError`.

::: info In Fowler's taxonomy: a transaction coordinator with registration and Identity Map
Measured against PoEAA's Unit of Work, what ships today is precisely that: Fowler's pattern *minus the commit-time flush*. The machinery for a full Unit of Work exists (enrollment ≈ `registerNew`/`registerDirty`/`registerDeleted`, `changedKeys`/`hasChanges` ≈ change detection), but writes stay **explicit** (`save()`), by design: a forgotten save fails in tests instead of being hidden by magic, and with `hasChanges` a redundant save is a cheap no-op. The name `UnitOfWork` describes the boundary it owns (one business transaction, all-or-nothing, with concurrency-problem resolution), not a claim to automatic change flushing. Auto-flush is a designed, optional later phase, to be built only against proven need.
:::

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

Every factory is invoked once per `run()` with the **same** transaction handle, so all writes of one unit of work share one transaction by construction. The context also exposes `session` (manual enrollment) and `rawTransaction`, deliberately named to look like what it is: an **escape hatch**. A write on the raw handle leaves the unit of work's guarantees: no enrollment (events silently skipped unless you call `session.enrollSaved` yourself), no identity-map registration (a later `getById` hydrates a second instance: double harvest, double `markPersisted`). Prefer adding a repository method; reach for `rawTransaction` only for writes no repository could reasonably cover.

A **read-only `run()`** is fine. A callback that only reads and enrolls nothing produces an empty harvest: no `outbox.add`, no `markPersisted`, no publish. The transaction still opens and commits, which at the storage layer is a no-op for reads. You get the callback's result back. Reach for it when several reads should share one consistent snapshot; for a single read, calling the repository directly is lighter.

## The rules

These sentences are the contract. Internalize them before building repositories:

1. **The Unit of Work is the only write boundary.** Use cases never open transactions themselves.
2. **Repositories do not commit.** `save()`/`delete()` write rows and enroll aggregates; commit and rollback belong to `run()`.
3. **Optimistic concurrency is enforced at the aggregate-root level**, and it is a **repository contract, not a kit guarantee**: the kit ships the boundary, the `persistedVersion` baseline, the documented predicate, and `ConcurrencyConflictError`; *your* repository must implement `WHERE version = $persistedVersion` on every update (and OCC-checked deletes where deletion races matter). A repository that skips the predicate silently disables OCC for its aggregate.
4. **Child-entity changes increment the aggregate-root version.** There is no per-child versioning.
5. **`version` is a mutation sequence, not a commit revision.** Each domain method that records an event bumps it by one, so an aggregate loaded at version 7 and mutated three times commits as version 10, while the OCC predicate still uses `WHERE version = 7` (the load-time `persistedVersion`). If you expect `+1 per commit`, your tests will be wrong; see [Versioning convention](./repository.md#insert-vs-update-the-persistedversion-convention).
6. **Domain events are persisted through the outbox in the same transaction.** Never publish from inside the callback.
7. **External side effects must not run inside the Unit of Work transaction**; see below.
8. **Nested Unit of Work scopes are not allowed.** A nested `run()` throws; it would not join the outer transaction.
9. **Do not reuse aggregate instances after a rollback.** They keep their in-memory mutations and pending events (deliberately, so a *fresh load* and retry is possible), but their state no longer corresponds to any row. Discard them; reload inside the next unit of work. One carve-out: a **never-persisted** aggregate whose first save rolled back has no row to reload; retrying its first save with the same instance is fine (its `persistedVersion` is still `undefined`, so it routes to INSERT again).
10. **A repository write rejection aborts the unit of work; never catch it and continue.** `save()` enrolls the aggregate *before* the row write, and the session has no un-enroll: catching a `ConcurrencyConflictError` inside `run()` and carrying on would commit the failed aggregate's events to the outbox and `markPersisted` it for a write that never happened, and the identity map would serve the same stale instance to any "reload" anyway. Retrying an OCC conflict means a **fresh `run()`**: reload, re-apply, save.

## No side effects inside the transaction

The callback runs inside an open database transaction. Nothing that talks to the outside world belongs there: no e-mail, no payment capture, no webhook, no file upload, no direct `eventBus.publish`. For example:

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
    // Enroll BEFORE the hasChanges skip, not after: the deleted-gate
    // throws AggregateDeletedError regardless of dirty state, so a clean
    // save of an aggregate deleted earlier in this unit of work cannot
    // slip through the early return. Enrollment is idempotent; a failed
    // write rolls the whole unit of work back anyway.
    this.session.enrollSaved(restaurant);
    if (!restaurant.hasChanges) return;        // skip the SQL write only
    // root row first (OCC), then changedKeys-scoped child tables;
    // see "Partial writes for multi-table aggregates" in the
    // Repository guide
    await this.writeRows(restaurant);
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

- **Enrollment is idempotent per instance**: saving the same aggregate instance twice harvests its events once and calls `markPersisted` once (the same reference-dedupe `withCommit` performs).
- **Deleted aggregates still get their events harvested, but the post-save lifecycle is not a lie for them.** The [hard-delete-with-event-harvest pattern](./repository.md#2-hard-delete-with-event-harvest) maps 1:1: `restaurant.recordDeletion(reason)` then `repositories.restaurants.delete(restaurant)`, and the deletion event reaches the outbox atomically with the row removal. After the commit, `markPersisted` is **skipped** for deleted aggregates (their pending events are cleared directly), so a user `onPersisted` hook doing cache fill or read-model warm-up never fires for a row that no longer exists.
- **Deletion is final within an operation, across instances.** `enrollDeleted` tombstones the aggregate's class+id in the identity map; saving the same instance *or a re-created instance with the same identity* afterwards throws `AggregateDeletedError`. Resurrecting a row the delete just removed is always a use-case bug. One caveat: the gate fires only when your `save()` actually reaches `enrollSaved`, so enroll before any `hasChanges`/no-op early return (as the example above does). A `save()` that returns on `!hasChanges` *before* enrolling lets a clean save of a deleted aggregate slip through silently.

This moves the event-handoff responsibility from *every call site* (the `withCommit` model: forget to return the aggregate → events silently dropped) to *every repository implementation*: implemented once, pinned by that repository's tests once.

## Identity Map

`session.identityMap` is the shipped implementation of [Fowler's Identity Map contract](./repository.md#identity-map-one-instance-per-aggregate-per-unit-of-work): within one unit of work, one aggregate type+id maps to exactly **one** in-memory instance. `withCommit`'s exactly-once event harvest and `markPersisted` are keyed on object identity; the map is what makes that dedupe sound by construction instead of by repo-implementer discipline.

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

- **The type key is the aggregate class**, not a name string: `Restaurant:123` and `Booking:123` can never collide, and there is no naming discipline to maintain. Protected constructors (the kit's aggregate convention) are accepted.
- **`set()` is strict.** Re-registering the same instance is a no-op; registering a *different* instance for an occupied type+id throws: that is exactly the violation the map exists to prevent (hydrated twice without checking `get()` first).
- **Deletion tombstones, with a probe.** `enrollDeleted` (or a manual `delete(Type, id)`) removes the entry *and* blocks re-registration: a later `set()` of the same type+id throws `AggregateDeletedError`. The read path checks `isDeleted(Type, id)` and returns `null`, so a read-only probe of a deleted aggregate behaves like not-found instead of crashing, uniformly, whether the repository's physical delete already ran or is deferred.
- **Lifetime is one `run()`.** The map is created fresh per operation (a retrying `TransactionScope` gets a fresh map per attempt) and cleared on close; `session.identityMap` throws `TransactionClosedError` afterwards. Never cache aggregates across operations: that bypasses optimistic concurrency control.

## Error taxonomy

| Error | Means | Class |
|---|---|---|
| anything your callback threw | rolled back; **rethrown unchanged**: a repository's `ConcurrencyConflictError` stays catchable as-is, never converted to a generic error | (none) |
| `CommitError` | the callback completed, then the outbox write or the commit itself rejected (the kit cannot see inside `transactional`, so these are deliberately one class; the real failure is the `cause`). Nothing committed, pending events survive. This is the **potentially transient** post-completion failure (a commit-time serialization failure is the classic case), so it is the one a retrying caller should consider re-running | `InfrastructureError` |
| `EventHarvestError` | the callback completed, but a harvested event is unsafe to commit: missing `aggregateId`/`aggregateType`, or an `aggregateVersion` ahead of the commit version. A `recordEvent`/`createDomainEvent` misuse, **deterministic** (fails identically on every retry). Kept off `InfrastructureError` on purpose, so a retry-on-infrastructure handler skips it instead of looping forever | `BaseError`: programming bug, crash loud |
| `RollbackError` | the callback threw AND the scope rejected with a *different* error that does not wrap the original: the strongest available signal that the rollback itself failed. The callback's error is the `cause` (cause-chain helpers still find it); the scope's error is in `rollbackCause` | `InfrastructureError` |
| `NestedUnitOfWorkError` | `run()` while the same instance is already running (nesting or instance-sharing across concurrent operations) | `BaseError`: programming bug, crash loud |
| `TransactionClosedError` | context/session used after `run()` settled | `BaseError`: programming bug |
| `AggregateDeletedError` | save (or identity-map re-registration) after delete of the same aggregate in one unit of work: same instance via the enrollment gate, *or* a different instance with the same class+id via the deletion tombstone (e.g. re-created through a factory, or re-hydrated by a deferred-write repository that skips the `isDeleted` check) | `BaseError`: programming bug |

Scopes that rethrow the callback's error (Drizzle, Prisma) never produce `RollbackError`; scopes that *wrap* it are detected via the standard `cause` chain and passed through unchanged.

## Nesting and instance discipline

One `UnitOfWork` instance owns **one logical operation at a time**. A nested `run()` would *not* join the outer transaction (it would open an independent one, silently breaking all-or-nothing), so it throws `NestedUnitOfWorkError` instead. If two pieces of work must commit together, they are one unit of work: merge them into a single callback.

Construct one instance per operation (construction stores a single reference; the deps object is the thing you share):

```ts
// per request / command execution
const uow = new UnitOfWork(deps);
await uow.run(/* … */);
```

Sequential reuse of an instance is fine; sharing one instance across concurrent operations is the same bug as nesting and surfaces as the same error.

## What the guard can and cannot enforce

After `run()` settles, the context getters (`repositories`, `rawTransaction`) and the session throw `TransactionClosedError`. That is the honest extent of the guarantee: the kit can only invalidate what it controls. A repository or raw `tx` handle captured into an outer variable *before* close keeps working as far as the kit can see; whether the underlying handle rejects is ORM-specific. Don't let references escape the callback.

The same honesty applies inside the callback: **do not mutate an aggregate after `save()`**: the post-commit `markPersisted` re-baselines dirty tracking against the *current* state, so a late mutation is silently marked clean (see the [`withCommit` ordering notes](./outbox.md)). Mutate first, save last.

## Cancellation and deadlines

`run()` takes an optional second argument carrying an `AbortSignal`. Use a plain `AbortController` for caller-driven cancellation, or `AbortSignal.timeout(ms)` for a deadline:

```ts
const result = await uow.run(
  async ({ repositories, signal }) => {
    const order = await repositories.orders.getByIdOrFail(orderId);
    order.confirm();
    // Poll between steps of a long operation and bail out cleanly.
    if (signal?.aborted) throw signal.reason;
    await repositories.orders.save(order);
    return order.id;
  },
  { signal: AbortSignal.timeout(5_000) },
);
```

Three things happen, in order of how much the kit can promise:

1. **Pre-flight (enforced).** If the signal is already aborted when `run()` is called, it rejects with the signal's `reason` *before* opening a transaction. No connection is taken, no callback runs. This matches the web convention (`fetch` rejects the same way), and `AbortSignal.timeout(ms)`'s reason is a `TimeoutError` `DOMException`.
2. **Cooperative checks (your job).** The signal is exposed on the context as `context.signal`. Poll `signal?.aborted` between steps of a long callback and `throw signal.reason` to bail; the throw rolls the unit of work back exactly like any other callback error (no harvest, no `markPersisted`, nothing in the outbox), and the error passes through `run()` unchanged.
3. **Query cancellation (scope-dependent).** The signal is forwarded to `TransactionScope.transactional(fn, { signal })`. A scope whose driver supports cancellation (an interactive-transaction timeout, an AbortSignal-aware query call) can use it to abort a query already in flight.

What the kit deliberately does **not** do: it does not race the work promise against the signal. Aborting mid-query does not kill a running statement unless your scope honors the signal in step 3, because abandoning the `await` would leave the transaction running uncontrolled toward an unmanaged commit or rollback. Cancellation here is cooperative by design, not a kill switch. For a hard ceiling on a runaway query, pair the signal with a statement/transaction timeout in your scope or driver config. When no signal is passed, behavior is unchanged.

The same `{ signal }` option is available on `withCommit` directly, with identical semantics, for the hand-rolled-repository path.

## Proving the contract: the repository contract test suite

::: danger Running the contract suite is mandatory, not recommended
Every guarantee on this page, exactly-once event harvest, correct `markPersisted`, and optimistic concurrency, is only as real as your repository's adherence to the enrollment, identity-map, and OCC contract. None of it is enforced structurally. A repository that skips the `WHERE version = ?` predicate silently disables OCC; one that forgets `enrollSaved` silently drops that aggregate's events (no error, they simply never reach the outbox). The contract test suite is the only thing that proves an adapter actually holds the contract. Run it against every repository you wire into a `UnitOfWork`: an adapter that has not passed it has not earned the unit-of-work guarantees, and should be treated as unproven, not as working.
:::

Rule 3 above has a consequence: since the OCC predicate lives in *your* repository's SQL, only a test can prove your adapter holds the contract. The kit ships that test as an opt-in entry point:

```ts
import { describe, it } from "vitest"; // or jest, or node:test
import { createRepositoryContractTests } from "@shirudo/ddd-kit/testing";

describe("DrizzleOrderRepository: repository contract", () => {
  for (const test of createRepositoryContractTests(harness)) {
    (test.skipped ? it.skip : it)(test.name, test.run);
  }
});
```

You supply a `RepositoryContractHarness`: per test it creates an isolated environment with your real adapter wired through your real `UnitOfWork` (the suite requires unit-of-work semantics: identity map, deletion gates; `withCommit`-only setups without equivalents are outside its scope), plus aggregate factories/mutators and read access to the committed outbox. Optional capabilities (`mutateVersionOnly`, `mutateChildCollection`, `createAggregateWithId`, `snapshotState`, `deletesAreVersionChecked`) widen the suite: tests for absent capabilities come back **marked `skipped`** with a `run()` that fails loud: bound with `it.skip` they stay visible in every report, and a naive binding can never turn a coverage gap into a green check. Provide everything your adapter supports; each capability closes a real OCC hole. The suite is framework-agnostic (assertions throw plain `Error`s; error matching is by *name* along the cause chain; the kit pins its error names against minification, so it works across bundle entries, subclassed errors, and even two installed kit versions) and covers the full contract: insert routing on `persistedVersion`, **duplicate inserts** (an existing id must reject with `DuplicateAggregateError` and leave the existing row untouched; gated on `createAggregateWithId`, with `insertsAreDuplicateChecked: false` as the explicit opt-out for deliberately upserting adapters), version arithmetic, rollback leaving nothing behind, identity-map sameness, deletion finality, the event lifecycle, stale deletes, and the **mandatory two-writer test**:

```txt
Two writers load the aggregate at version N.
Writer A mutates and commits → succeeds.
Writer B commits its stale instance → ConcurrencyConflictError.
Final persisted state equals A's. The outbox contains only A's events.
```

Two hard rules:

- **SQL/ORM adapters must run the suite against a real database** (testcontainers or equivalent). The kit's own [in-memory reference adapter](https://github.com/shi-rudo/ddd-kit-ts/blob/main/src/testing/repository-contract.test.ts), which follows every documented pattern, including real version predicates on update *and* delete, passes the suite, but it proves only itself: your `WHERE version = ?` is what needs proving. (The file lives in the repo, not in the npm package: it is a copyable example, not shipped code.)
- **An adapter that has not passed the suite has not demonstrated OCC.** Treat the suite as the compliance bar for any repository you wire into the unit of work, with one documented limitation: the suite runs sequential-deterministic, so lock interaction (`SELECT … FOR UPDATE`-style blocking, SERIALIZABLE engines surfacing raw serialization failures your adapter must map to `ConcurrencyConflictError`) needs adapter-specific tests on top.

## What v1 deliberately does not do

- **No auto-flush.** Explicit `save()` only. With [`hasChanges`](./repository.md#partial-writes-for-multi-table-aggregates-changedkeys--haschanges) a redundant save is a cheap no-op, and a *forgotten* save stays visible in tests instead of being hidden by magic.
- **No savepoints, no transaction joining, no distributed transactions.**
