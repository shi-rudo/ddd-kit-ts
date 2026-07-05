# Repository

In DDD, a Repository is a collection illusion for aggregates: load by id, save the whole aggregate, delete the whole aggregate. The kit splits the contract in two:

- **`IRepository<TAgg, TId>`**: id-canonical CRUD. Every aggregate has one.
- **`IQueryableRepository<TAgg, TId, TFilter>`**: adds filter-based querying. Opt-in, parameterised over the persistence layer's native filter shape.

## `IRepository`: id-canonical access

```ts
interface IRepository<TAgg extends IAggregateRoot<TId>, TId extends Id<string>> {
  getById(id: TId):            Promise<TAgg | null>;
  getByIdOrFail(id: TId):      Promise<TAgg>;       // throws AggregateNotFoundError
  exists(id: TId):             Promise<boolean>;
  save(aggregate: TAgg):       Promise<void>;
  delete(aggregate: TAgg):     Promise<void>;
}
```

### `getById` vs `getByIdOrFail`

Two flavours so the Use Case picks the right contract:

- **`getById`** returns `null` when not found. Use when "missing is a valid outcome" (e.g. idempotent upsert, optional lookup).
- **`getByIdOrFail`** throws `AggregateNotFoundError` (an `InfrastructureError`) when missing. Use when "missing is a programming/contract error in the calling Use Case".

#### Inside the read path: reconstituting the aggregate

Both `getById` variants need to **reconstitute** the aggregate: read its persisted row(s), build the in-memory representation, and return it. This is *not* a factory call: the aggregate already exists; we're not creating it now, so no creation event should fire.

The aggregate's class exposes a `static reconstitute(...)` paired with its factory (see [Reconstitution](./aggregates.md#reconstitution-loading-existing-aggregates-from-persistence) in the aggregates guide). The repository just calls it:

```ts
// State-stored aggregate
async getById(id: OrderId): Promise<Order | null> {
  const row = await this.db
    .select()
    .from(orders)
    .where(eq(orders.id, id))
    .get();
  if (!row) return null;
  return Order.reconstitute(
    row.id as OrderId,
    row.state as OrderState,
    row.version as Version,
  );
}

// Event-sourced aggregate: loadFromHistory IS the reconstitution path
async getById(id: OrderId): Promise<Order | null> {
  const events = await this.eventStore.read(id);
  if (events.length === 0) return null;
  const order = new Order(id, blankInitialState);
  const result = order.loadFromHistory(events);
  if (result.isErr()) throw result.error; // corrupt stream
  return order;
}
```

The reconstituted aggregate has `pendingEvents` empty by construction, so no spurious events leak into the next `withCommit`.

### Identity Map: one instance per aggregate per Unit of Work

This is Fowler's **Identity Map** pattern (*Patterns of Enterprise Application Architecture*, 2002), implicitly assumed by Evans, Vernon, Khononov, and the broader DDD/CQRS-ES literature. The library relies on it for `withCommit`'s aggregate-dedupe to be conceptually sound, but the kit's interface doesn't enforce it; your `IRepository` implementation has to maintain it.

::: tip The Unit of Work ships an `IdentityMap`
Repositories built for the [`UnitOfWork` facade](./unit-of-work.md#identity-map) get a per-operation `session.identityMap` (class-keyed, deletion-tombstoned, cleared on close) instead of hand-rolling the per-UoW `Map` shown below. The hand-rolled pattern remains correct for `withCommit`-only setups.
:::

**The contract.** Two `getById(id)` calls (or `getByIdOrFail(id)`) within the same Unit of Work (typically the same `withCommit` invocation, or any sequence sharing a transactional scope) MUST return the **same in-memory instance**.

**Why it matters.** `withCommit` dedupes the returned `aggregates` array by JavaScript object identity (`new Set(aggregates)`). If two `getById` calls during one use case return the **same instance**, the dedupe works correctly: events are harvested once and `markPersisted` fires once. If two calls return **distinct instances with the same id** (i.e. your repository violates the Identity Map contract), the dedupe sees two different references and treats them as separate aggregates. Both get their events harvested into the outbox; `markPersisted` runs twice on two different instances. Silent duplicate dispatch.

**How to maintain it.** Most ORM-backed repositories get this for free:

- **Drizzle / Postgres.js**: the connection-bound transaction session naturally returns the same hydrated object for repeated lookups within the same `tx` block.
- **Prisma**: the `PrismaClient` instance per-request acts as the identity map across `findUnique` calls.
- **Entity Framework Core (.NET parallel)**: `DbContext` IS the identity map.
- **Mongo with a session**: the session boundary is your UoW; cache hydrated aggregates in a `Map<TId, TAgg>` keyed by id.

For hand-rolled in-memory or custom repositories, wrap the store with a per-UoW `Map<TId, TAgg>`:

```ts
class TxScopedOrderRepository implements IRepository<Order, OrderId> {
  private readonly identityMap = new Map<OrderId, Order>();

  constructor(private readonly tx: DrizzleTx) {}

  async getById(id: OrderId): Promise<Order | null> {
    const cached = this.identityMap.get(id);
    if (cached) return cached;

    const row = await this.tx
      .select()
      .from(orders)
      .where(eq(orders.id, id))
      .get();
    if (!row) return null;
    const agg = Order.reconstitute(
      row.id as OrderId,
      row.state as OrderState,
      row.version as Version,
    );
    this.identityMap.set(id, agg);
    return agg;
  }

  // …
}
```

The identity map's lifetime is **the Unit of Work**, fresh per `withCommit` call. Don't cache across UoW boundaries; that would silently bypass optimistic concurrency control.

### `save` and optimistic concurrency

`save()` is **pure persistence**. Implementations write the aggregate and throw on OCC conflict; that's it. They must NOT call `aggregate.markPersisted(...)`; the `withCommit` orchestrator handles the post-save lifecycle (harvest pending events, then mark persisted after the transaction commits). See [Outbox & Transactions](./outbox.md) for the full flow.

#### Insert vs update: the `persistedVersion` convention

Every aggregate exposes two version fields with distinct roles:

- **`aggregate.version`**: the in-memory post-mutation value. Bumped by `setState()`, `commit()`, and every `apply()` on an event-sourced aggregate.
- **`aggregate.persistedVersion`**: the version the persistence layer currently holds. `undefined` until the aggregate has been persisted or restored from persistence at least once. Repository implementations route INSERT vs UPDATE on this field and use it as the OCC baseline.

The two diverge as soon as a domain method mutates the aggregate: `version` advances; `persistedVersion` stays at the load-time / last-save baseline.

::: warning `version` is a mutation sequence, not a commit revision
Every version-bumping mutation (`commit()`, `setState()`, each `apply()` on an event-sourced aggregate) advances `version` by one. Three domain methods in one unit of work advance it by three: a baseline of 7 commits as 10, **not** 8. This is deliberate (it matches the event-sourced convention where version IS the mutation count), and it is OCC-correct either way, because the predicate compares against the load-time baseline (`WHERE version = 7`), never against deltas. If your tests assume `+1 per commit`, they are testing the wrong convention.
:::

```ts
// Drizzle-flavoured save
async save(aggregate: Order): Promise<void> {
  if (aggregate.persistedVersion === undefined) {
    // INSERT: never persisted, regardless of how many in-memory mutations
    // have advanced `aggregate.version` since construction.
    try {
      await this.db.insert(orders).values({
        id: aggregate.id,
        state: aggregate.state,
        version: aggregate.version,
      });
    } catch (e) {
      // Map the driver's unique-violation to the kit's error class so the
      // App layer can catch it. isUniqueViolation is YOUR driver predicate
      // (not a kit export), e.g. for Postgres: e.code === "23505" - or
      // e.cause?.code when your ORM wraps the driver error; MySQL: errno
      // 1062; SQLite: SQLITE_CONSTRAINT_UNIQUE.
      if (isUniqueViolation(e)) {
        throw new DuplicateAggregateError({ aggregateType: "Order", aggregateId: aggregate.id, cause: e });
      }
      throw e;
    }
    return;
  }

  // UPDATE: existing row; the OCC predicate uses the load-time baseline.
  const baseline = aggregate.persistedVersion;
  const result = await this.db
    .update(orders)
    .set({ state: aggregate.state, version: aggregate.version })
    .where(and(eq(orders.id, aggregate.id), eq(orders.version, baseline)));

  if (result.rowsAffected === 0) {
    // The row's version no longer matches `baseline`: concurrent writer.
    const current = await this.db.select({ version: orders.version })
      .from(orders).where(eq(orders.id, aggregate.id)).get();
    throw new ConcurrencyConflictError({
      aggregateType: "Order",
      aggregateId: aggregate.id,
      expectedVersion: baseline,
      actualVersion: current?.version ?? -1,
    });
  }
}
```

If the update affects zero rows, another writer raced you; throw `ConcurrencyConflictError`.

::: warning Don't route on `aggregate.version === 0`
Pre-rc.9 docs and consumer code routed INSERT vs UPDATE on `aggregate.version === 0`. That convention breaks the moment a fresh aggregate is mutated before its first save (factory call followed by an edit-wizard mutation, for example): the version advances past zero in memory, the row still doesn't exist in the DB, and the save flow tries an UPDATE that affects zero rows → false `ConcurrencyConflictError`. `persistedVersion === undefined` is the correct INSERT marker because it tracks the DB state, not the in-memory state.
:::

The "what becomes the new persisted version" formula:

- **`AggregateRoot`** (state-stored): `aggregate.version` already reflects every mutation by the time `save` runs, so use it as-is for the row's new version. The OCC predicate uses `aggregate.persistedVersion`.
- **`EventSourcedAggregate`**: `aggregate.version` equals the post-append event count (canonical ES per Greg Young / Vernon §9). For an event-store-backed implementation, the stream-revision check uses `aggregate.persistedVersion`; the append targets `aggregate.version` (= `persistedVersion + pendingEvents.length`).

After a successful save, `withCommit` calls `aggregate.markPersisted(aggregate.version)`, which syncs both fields and clears `pendingEvents`.

### Partial writes for multi-table aggregates: `changedKeys` / `hasChanges`

An aggregate whose state spans multiple tables (a root row plus N child-collection tables) used to leave `save()` with two bad options: write **everything** on every save (write amplification: eight collection tables rewritten because one opening-hours field changed), or have the application service orchestrate per-collection writes manually, which moves persistence knowledge out of the repository and reopens the door to forgotten OCC version bumps. Teams that take the second path end up with workarounds like a `markCollectionsRevised()` domain method whose only job is to "touch" the version, opt-in per service method and silently forgettable.

`AggregateRoot` solves this with built-in dirty tracking:

- **`aggregate.changedKeys: ReadonlySet<keyof TState & string>`**: the top-level state keys whose value (or presence) changed since the aggregate was loaded (`markRestored`) or last saved (`markPersisted`). A never-persisted aggregate reports **all** keys: the insert path.
- **`aggregate.hasChanges: boolean`**: `true` when the aggregate has never been persisted, the version moved past `persistedVersion`, there are unflushed `pendingEvents`, any key is dirty, or (for keyless states the per-key diff cannot see, such as primitive `TState` or zero-own-key objects) the state reference changed.

To be precise about the two signals, because the names invite conflation: **`hasChanges` means commit-relevant work exists** (skip the save only when it is `false`); **`changedKeys` is the state-write signal** (which tables to touch). `pendingEvents` can make `hasChanges` true **without** requiring a row update or a version bump: an event recorded via the decoupled `addDomainEvent` path (the deletion pattern below) must still ride through `withCommit` to reach the outbox, even though no row changes. Events alone never bump the version and never appear in `changedKeys`.

There is no proxy magic and no deep diff. `setState()` replaces state immutably and the state object is shallow-frozen, so an unchanged top-level sub-object keeps its reference identity across mutations; `changedKeys` is a shallow per-key `!==` comparison against the state reference captured at load time. O(top-level keys), exact under the kit's own immutability convention.

```ts
// Drizzle-flavoured save for a Restaurant aggregate with collection
// tables. The repo is tx-bound (constructor(private readonly tx: DrizzleTx),
// same convention as the Identity Map example above), so every statement
// below shares ONE transaction: when the OCC check throws, the child-table
// writes roll back with it.
async save(restaurant: Restaurant): Promise<void> {
  const { id, state, changedKeys } = restaurant;

  // The root row rides EVERY save, and it goes FIRST. On the insert
  // path the parent row must exist before child rows reference it (FK
  // constraints); on the update path the OCC predicate fails fast
  // before any child table is touched. This is where the version bump
  // lives, so a collection-only change still bumps the version, by
  // construction, not by a manual "touch" method.
  const baseline = restaurant.persistedVersion;
  if (baseline === undefined) {
    await this.insertRootRow(restaurant);
  } else {
    const result = await this.tx
      .update(restaurants)
      .set({ ...rootColumns(state), version: restaurant.version })
      .where(and(eq(restaurants.id, id), eq(restaurants.version, baseline)));
    if (result.rowsAffected === 0) {
      throw new ConcurrencyConflictError({ aggregateType: "Restaurant", aggregateId: id, expectedVersion: baseline, actualVersion: -1 });
    }
  }

  // Child-collection tables: write ONLY what changed (table-granular).
  if (changedKeys.has("openingHours")) {
    await this.replaceOpeningHours(id, state.openingHours); // delete + reinsert
  }
  if (changedKeys.has("menuSections")) {
    await this.replaceMenuSections(id, state.menuSections);
  }
}
```

Rules that make this sound:

1. **The root-row write (with the OCC version predicate) rides every save, and it goes first.** Only the child-table writes are scoped by `changedKeys`. Root-first ordering serves both paths: on insert, the parent row exists before child rows reference it; on update, an OCC conflict aborts the save before any child table is touched.
2. **The whole save shares one transaction.** A multi-statement save must run on the transaction handle the repository was constructed with (the `withCommit` scope), never on a bare connection; otherwise a `ConcurrencyConflictError` from the root-row predicate leaves already-executed child writes committed against the winner's root row.
3. **The OCC guarantee assumes version-bumping mutations.** `commit()` and `setState(newState)` always bump. A no-bump `setStateWithoutVersionBump(newState)` marks keys dirty but does **not** advance the version, so the save writes data without moving the OCC predicate: a concurrent writer holding the same version still passes its own check. Reserve no-bump mutations for data a concurrent writer may safely overwrite (cosmetic caches, denormalized counters); never use them for domain-meaningful changes.
4. **`changedKeys` is table-granular, not row-granular.** A dirty `openingHours` key means "this collection changed", not which rows. Delete + reinsert the child table, or run your own row diff inside that branch.
5. **Skipping `save()` entirely is safe exactly when `hasChanges === false`.** The version clause is what protects OCC: a state-only check would break in four steps: (1) `setState({...state})` with identical values bumps the version but leaves `changedKeys` empty; (2) the repo skips `save()`; (3) `withCommit` still calls `markPersisted(version)` after commit, so `persistedVersion` now claims a version the DB row never got; (4) the next uncontended save's OCC predicate matches zero rows → false `ConcurrencyConflictError`. The pending-events clause protects the decoupled `addDomainEvent` path (an event recorded with no state change, like the deletion pattern below): the aggregate still needs its trip through `withCommit`, so it must not look like "nothing to do".
6. **Don't mutate the aggregate after `save()` inside the `withCommit` callback.** Post-commit `markPersisted` re-baselines the diff against the *current* state; a mutation between `save()` and commit would be silently marked clean and lost on the next save. (See the `withCommit` JSDoc: mutate first, save last.)

::: warning The same immutability contract as `freezeShallow`
Dirty tracking is exactly as sound as the kit's existing immutability convention: it requires a plain-record `TState` mutated via `setState` / `commit` (whole-state replacement). Mutating a **nested** object in place bypasses the shallow freeze *and* the diff (one stale key); a **class-instance** `TState` mutated through its own methods defeats tracking entirely, because the state reference never changes. A **keyless** `TState` (primitive, bare `Date`) has nothing for `changedKeys` to report; `hasChanges` covers it with a reference-comparison fallback, so the skip-save signal stays sound, but partial writes are meaningless for such states anyway. The failure direction of the design is deliberate: a deep-equal value under a *new* reference reports a false positive (one harmless extra write), never silent data loss, but only under this contract.
:::

`EventSourcedAggregate` deliberately has no `changedKeys`: its `pendingEvents` *are* the change record. Repositories that need dirty information type against the concrete state-stored aggregate class, not `IAggregateRoot`.

### Deletion and Domain Events

`delete(aggregate)` is **pure persistence**: it removes the aggregate's row and nothing else. Since v3 the contract takes the AGGREGATE (one shape across `IRepository` and `IUnitOfWorkRepository`): deletion-event harvest, the identity-map tombstone, and an OCC predicate all need the instance, which a bare id cannot provide. Event harvest stays the orchestrator's job.

::: tip OCC applies to deletes too
When a delete races with concurrent updates in a way your domain cares about (cancel-vs-modify races), guard the delete with the same version predicate as updates: `DELETE FROM orders WHERE id = $id AND version = $persistedVersion`, throwing `ConcurrencyConflictError` on zero affected rows. An unguarded delete is last-write-wins by construction: acceptable for GC-style cleanup (Pattern 3), rarely acceptable for user-initiated deletion of contended aggregates.
:::

Before reaching for it, ask whether *"delete"* is the right domain verb at all. Most user-facing "deletes" are something else in the domain language: *cancel*, *archive*, *close*, *deactivate*, *terminate*, *withdraw*, *expire*. Those are **state transitions**, not row removals; they have proper names in the ubiquitous language and they record events. If your use case has a proper name, use it.

`delete(aggregate)` belongs in the toolkit for the genuinely different cases: regulated data must physically vanish, an aggregate has no domain meaning anymore, or you're cleaning up infrastructure rows that were never real domain objects in the first place. **Id-only bulk cleanup deliberately has no port method:** loading aggregates one by one just to purge them at scale is waste; declare a repository-specific method (e.g. `purgeExpired(before: Date)`) on your concrete class instead.

::: info Event-Sourcing note
In pure event-sourced systems `IRepository.delete` is rarely meaningful: the aggregate's end-of-lifecycle lives in the stream as an event (`Closed`, `Terminated`), and the identity persists in the event log forever. `delete` applies primarily to state-stored aggregates and to snapshot / projection tables.
:::

Three canonical patterns, applied per use case:

#### 1. State transition that records an event (the most common case)

When the user says "delete the order" but the domain actually means *cancel*, *archive*, or *close*, model it as a state transition with a domain method that records the corresponding event. The row stays in the table; a status column marks the transition. `delete` is never called.

```ts
// Domain method on the aggregate
class Order extends AggregateRoot<OrderState, OrderId, OrderEvent> {
  protected readonly aggregateType = "Order";

  archive(reason: string): void {
    if (this.state.status === "archived") {
      throw new OrderAlreadyArchivedError(this.id);
    }
    this.commit(
      { ...this.state, status: "archived", archivedAt: new Date() },
      this.recordEvent("OrderArchived", { reason, archivedAt: new Date() }),
    );
  }
}

// Use case
await withCommit({ scope, outbox, bus }, async (tx) => {
  const orderRepository = makeOrderRepository(tx);
  const order = await orderRepository.getByIdOrFail(orderId);
  order.archive(reason);
  await orderRepository.save(order);          // state change persists; outbox gets OrderArchived
  return { result: undefined, aggregates: [order] };
});
```

The audit trail is preserved (the event documents *who* archived *what* and *when*). Replays work cleanly: `OrderArchived` is just another event in the stream. Filter archived rows out of read queries (`WHERE status <> 'archived'`) or build a separate "active orders" projection.

#### 2. Hard-delete with event harvest

When the row genuinely must disappear from the primary store (privacy/regulatory deletion such as GDPR right-to-be-forgotten, data-retention purge after a contractual window, true subscription-termination) but the disappearance itself is a domain fact subscribers care about, record the deletion event on the aggregate first, then call `delete(aggregate)` inside the same transactional callback. Return the aggregate in `withCommit`'s `aggregates` array so its pending events flow through the outbox before the row is gone, and mark it in `deleted` so the post-save `onPersisted` hook does not fire for a row that no longer exists:

```ts
class Order extends AggregateRoot<OrderState, OrderId, OrderEvent> {
  protected readonly aggregateType = "Order";

  recordDeletion(reason: string): void {
    // No state change: the row is about to be deleted entirely.
    // We only need the event in pendingEvents for the outbox.
    this.addDomainEvent(
      this.recordEvent("OrderDeleted", { reason, deletedAt: new Date() }),
    );
  }
}

await withCommit({ scope, outbox, bus }, async (tx) => {
  const orderRepository = makeOrderRepository(tx);
  const order = await orderRepository.getByIdOrFail(orderId);
  order.recordDeletion(reason);              // records the event
  await orderRepository.delete(order);       // removes the row in the same tx
  return { result: undefined, aggregates: [order], deleted: [order] };
});
```

Order of operations inside the transaction:

1. `recordDeletion` puts `OrderDeleted` into `order.pendingEvents`
2. `delete(order)` removes the row
3. `withCommit` harvests `order.pendingEvents` and writes them to the outbox, *still inside the transaction*, so the event and the row removal commit atomically
4. After the transaction commits, downstream subscribers see `OrderDeleted` and react (clear caches, expire projections, etc.)

Because the aggregate is marked in `deleted`, `withCommit` clears its pending events directly instead of calling `markPersisted`; the caller typically discards the reference immediately, since the aggregate is gone.

#### 3. Hard-delete without event

When the aggregate has no domain meaning anymore and no subscriber needs to know (a single abandoned cart, an expired session row), load it and call `delete(aggregate)` directly. No event, no `withCommit` ceremony:

```ts
await scope.transactional(async (tx) => {
  const orderRepository = makeOrderRepository(tx);
  // getById, not getByIdOrFail: cleanup stays idempotent. A retried job
  // (or a concurrent cleaner) finding the row already gone is a no-op,
  // not an AggregateNotFoundError crash.
  const order = await orderRepository.getById(orderId);
  if (order) {
    await orderRepository.delete(order);
  }
});
```

For deletion **at scale** (nightly GC over thousands of expired rows), skip the port entirely: a repository-specific bulk method (`purgeExpired(before)`) issues one predicated statement instead of a load-then-delete per row.

Skip this path if anything else in the system might care about the disappearance. The cost of recording a deletion event is small; the cost of subscribers silently going stale is much higher.

#### Choosing between them

Decide by **what the operation means in your domain**, not by a default:

- **Pattern 1** if the user-facing "delete" maps to a real domain operation (*cancel*, *archive*, *close*, *deactivate*). This is most user-initiated cases. Audit trail + replay-safety come for free.
- **Pattern 2** if the row truly must vanish *and* the disappearance is something subscribers should react to (cache eviction, projection cleanup, archive copy elsewhere, downstream system notification).
- **Pattern 3** if deletion is invisible to the domain: abandoned-cart cleanup, expired session rows, infrastructure GC. If you find yourself wanting a Pattern 3 hard-delete for something that has identity in the ubiquitous language, you probably want Pattern 1 or 2 instead.

Aggregates have identity; identity has a lifecycle worth recording. Patterns 1 and 2 honour that. Pattern 3 is for rows that were never really aggregates to begin with.

## `IQueryableRepository`: bring your own filter

Aggregates that are queried by criteria opt in by implementing the extended interface:

```ts
interface IQueryableRepository<TAgg, TId, TFilter> extends IRepository<TAgg, TId> {
  findOne(filter: TFilter): Promise<TAgg | null>;
  find(filter: TFilter):    Promise<TAgg[]>;
}
```

`TFilter` is the filter shape your persistence layer speaks. The library does **not** prescribe a query DSL or Specification pattern; each Repository implementation owns its language.

### Examples per ORM

```ts
// In-memory: a plain predicate
type Predicate<T> = (t: T) => boolean;
class InMemoryOrders implements IQueryableRepository<Order, OrderId, Predicate<Order>> { ... }

// Drizzle: SQL expressions
import type { SQL } from "drizzle-orm";
class DrizzleOrders implements IQueryableRepository<Order, OrderId, SQL> { ... }

// Prisma: WhereInput
class PrismaOrders implements IQueryableRepository<Order, OrderId, Prisma.OrderWhereInput> { ... }

// Mongo: filter documents
class MongoOrders implements IQueryableRepository<Order, OrderId, Filter<OrderDoc>> { ... }
```

### `find` returns the full set, by design

`find(filter)` returns **every** match: there's no `limit` or `cursor` baked into the interface. Reasons:

1. **Aggregates are write-side objects.** Loading thousands of them by predicate is rarely what you want; that's a read-model concern (CQRS read side), and read models have their own typed access methods.
2. **Pagination semantics vary** (cursor vs offset vs keyset) and are storage-backend specific. The library doesn't commit to one.

If you need pagination on the write side, declare a domain-specific paged method on your concrete repository (`findPage(filter, cursor)`, `findRecent(limit)`, …). Don't extend `IQueryableRepository` to add pagination generically.

## `nextId` lives on `IdGenerator`, not on the Repository

Per Vernon's *Identity from User-Side*: identity generation happens in the application, not in the repository. The kit provides `IdGenerator<Tag>` for that:

```ts
import type { IdGenerator, Id } from "@shirudo/ddd-kit";
import { ulid } from "ulid";

type UserId = Id<"UserId">;
const userIds: IdGenerator<"UserId"> = {
  next: () => ulid() as UserId,
};

const id = userIds.next(); // Id<"UserId">
```

`IdGenerator<Tag>` binds the tag at the generator type, so a `UserId` generator is not interchangeable with an `OrderId` generator.

**Your factory must produce unique ids under concurrent calls.** The kit makes no attempt to dedupe or detect collisions. Collision-resistant choices: `crypto.randomUUID()` (UUIDv4), ULID, UUIDv7 (RFC 9562), KSUID, all designed for the job. Unsafe choices that look fine in tests but collide in production: `Date.now()` alone (duplicates within the same millisecond under load), a process-local counter without persistence (resets on restart, collides with prior runs), a sequential id derived from non-atomic state. The same requirement applies to `EventIdFactory`.

## `AggregateNotFoundError`, `ConcurrencyConflictError`, and `DuplicateAggregateError`

All three are `InfrastructureError` subclasses (not `DomainError`: the storage boundary decided the row is absent, stale, or already taken, not a business rule). They extend `@shirudo/base-error`'s `BaseError`, so they carry timestamps, cause chains, and `toJSON()` out of the box. For client-safe, localized messages, project them through the opt-in `@shirudo/base-error/public-error` subpath at the boundary; the technical core carries no user-facing message.

- **`AggregateNotFoundError({ aggregateType, id, cause? })`**: thrown by `getByIdOrFail`. The technical message carries the type and id; do not return it to a client unprojected. Not retryable (the row isn't there; retry won't help).
- **`ConcurrencyConflictError({ aggregateType, aggregateId, expectedVersion, actualVersion, cause? })`**: thrown by `save` on OCC mismatch. Marks itself `retryable: true` so the `someChainRetryable(err)` predicate from `@shirudo/base-error` picks it up even when an outer infrastructure layer wraps it; the canonical OCC pattern is to reload, re-apply, and retry **in a fresh unit of work**. Wrap your scope in [`RetryingTransactionScope`](./concurrency.md#retrying-conflicts-retryingtransactionscope) to automate exactly that (classification via `someChainRetryable`, exponential backoff with jitter, abort-bounded) instead of hand-rolling the loop.
- **`DuplicateAggregateError({ aggregateType, aggregateId, cause? })`**: thrown by `save`'s INSERT path when a row with the id already exists: two concurrent creators raced on a business-derived id, or the id generator collided. Same delegation model as the OCC predicate: the kit ships the class, your repository maps the driver's unique-violation signal to it (Postgres `23505`, MySQL `1062`, SQLite `SQLITE_CONSTRAINT_UNIQUE`) instead of letting a raw driver error escape. Not retryable: re-running the same INSERT cannot succeed; map to HTTP 409, or for idempotency-key flows load the existing aggregate and treat the request as already applied. The [repository contract test suite](./unit-of-work.md#proving-the-contract-the-repository-contract-test-suite) covers it (capability-gated on `createAggregateWithId`).

```ts
import {
  AggregateNotFoundError,
  ConcurrencyConflictError,
} from "@shirudo/ddd-kit";
import { someChainRetryable } from "@shirudo/base-error";

try {
  await orderRepository.save(order);
} catch (err) {
  if (err instanceof ConcurrencyConflictError) {
    // reload, re-apply use case, retry, or surface HTTP 409
  }
  if (err instanceof AggregateNotFoundError) {
    // map to HTTP 404
  }
  if (someChainRetryable(err)) {
    // delegate to retry middleware; walks the cause chain, so it matches
    // even when ConcurrencyConflictError is nested inside a wrapper error
  }
  throw err;
}
```

::: tip Why `someChainRetryable`, not `isChainRetryable` or `isRetryable`
`isChainRetryable` from `@shirudo/base-error` filters on the strict `StructuredError` shape (`code` + `category` + `retryable`) and returns `false` for `ConcurrencyConflictError`. `isRetryable(err)` only inspects the top-level error: if your infrastructure adapter wraps the conflict in another error, it misses it. `someChainRetryable` walks the whole chain with the loose predicate.
:::

Catch them at the App-Service layer to map to HTTP 404 / HTTP 409 as appropriate (`ConcurrencyConflictError` and `DuplicateAggregateError` are both 409-shaped, with different retry semantics: the former retries in a fresh unit of work, the latter never).
