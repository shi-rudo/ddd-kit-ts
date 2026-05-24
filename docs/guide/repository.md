# Repository

In DDD, a Repository is a collection illusion for aggregates: load by id, save the whole aggregate, delete by id. The kit splits the contract in two:

- **`IRepository<TAgg, TId>`** — id-canonical CRUD. Every aggregate has one.
- **`IQueryableRepository<TAgg, TId, TFilter>`** — adds filter-based querying. Opt-in, parameterised over the persistence layer's native filter shape.

## `IRepository` — id-canonical access

```ts
interface IRepository<TAgg extends IAggregateRoot<TId>, TId extends Id<string>> {
  getById(id: TId):            Promise<TAgg | null>;
  getByIdOrFail(id: TId):      Promise<TAgg>;       // throws AggregateNotFoundError
  exists(id: TId):             Promise<boolean>;
  save(aggregate: TAgg):       Promise<void>;
  delete(id: TId):             Promise<void>;
}
```

### `getById` vs `getByIdOrFail`

Two flavours so the Use Case picks the right contract:

- **`getById`** — returns `null` when not found. Use when "missing is a valid outcome" (e.g. idempotent upsert, optional lookup).
- **`getByIdOrFail`** — throws `AggregateNotFoundError` (an `InfrastructureError`) when missing. Use when "missing is a programming/contract error in the calling Use Case".

#### Inside the read path: reconstituting the aggregate

Both `getById` variants need to **reconstitute** the aggregate — read its persisted row(s), build the in-memory representation, and return it. This is *not* a factory call: the aggregate already exists; we're not creating it now, so no creation event should fire.

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

// Event-sourced aggregate — loadFromHistory IS the reconstitution path
async getById(id: OrderId): Promise<Order | null> {
  const events = await this.eventStore.read(id);
  if (events.length === 0) return null;
  const order = new Order(id, blankInitialState);
  const result = order.loadFromHistory(events);
  if (result.isErr()) throw result.error; // corrupt stream
  return order;
}
```

The reconstituted aggregate has `pendingEvents` empty by construction — no spurious events leak into the next `withCommit`.

### `save` and optimistic concurrency

`save()` is **pure persistence**. Implementations write the aggregate and throw on OCC conflict — that's it. They must NOT call `aggregate.markPersisted(...)`; the `withCommit` orchestrator handles the post-save lifecycle (harvest pending events, then mark persisted after the transaction commits). See [Outbox & Transactions](./outbox.md) for the full flow.

#### Insert vs update — the `version` convention

A fresh aggregate begins at `version === 0`. After its first versioned mutation (`setState(_, true)`, `apply()`, `commit()`) the version is `> 0`. Implementations distinguish the two paths by the incoming `aggregate.version`:

- `aggregate.version === 0` → **INSERT** (no existing row to lock against)
- `aggregate.version  >  0` → **UPDATE** with the OCC predicate `WHERE id = ? AND version = expected`

If the update affects zero rows, another writer raced you — throw `ConcurrencyConflictError`.

```ts
// Drizzle-flavoured save
async save(aggregate: Order): Promise<void> {
  if (aggregate.version === 0) {
    // INSERT — fresh aggregate, never persisted
    await this.db.insert(orders).values({
      id: aggregate.id,
      state: aggregate.state,
      version: 1, // first persisted version
    });
    return;
  }

  // UPDATE — existing aggregate, lock against concurrent writers
  const expected = aggregate.version;
  const result = await this.db
    .update(orders)
    .set({ state: aggregate.state, version: expected + 1 })
    .where(and(eq(orders.id, aggregate.id), eq(orders.version, expected)));

  if (result.rowsAffected === 0) {
    // The row's version no longer matches `expected` — concurrent writer
    const current = await this.db.select({ version: orders.version })
      .from(orders).where(eq(orders.id, aggregate.id)).get();
    throw new ConcurrencyConflictError(
      "Order",
      aggregate.id,
      expected,
      current?.version ?? -1,
    );
  }
}
```

The actual "what becomes the new persisted version" formula varies by aggregate flavour:

- **`AggregateRoot`** (state-stored): the aggregate's local version was bumped by `setState(_, true)` / `commit()` calls inside the use case. By the time `save` runs, `aggregate.version` already reflects the post-mutation state — use it as-is for the row's new version.
- **`EventSourcedAggregate`**: the aggregate's version equals its event count (canonical ES per Greg Young / Vernon §9). `aggregate.version` is the new total. For an event-store-backed implementation, `save` typically appends events to the stream; the store's stream-revision matches the aggregate's version after a successful append.

The Drizzle snippet above uses `expected + 1` for clarity, but in a state-stored aggregate `aggregate.version` already IS `expected + 1` after `setState(_, true)` — either form works.

### Deletion and Domain Events

`delete(id)` is **pure persistence** — it removes the row by id and nothing else. The contract takes only the id, so there's no aggregate to harvest pending events from.

Before reaching for it, ask whether *"delete"* is the right domain verb at all. Most user-facing "deletes" are something else in the domain language — *cancel*, *archive*, *close*, *deactivate*, *terminate*, *withdraw*, *expire*. Those are **state transitions**, not row removals; they have proper names in the ubiquitous language and they record events. If your use case has a proper name, use it.

`delete(id)` belongs in the toolkit for the genuinely different cases: regulated data must physically vanish, an aggregate has no domain meaning anymore, or you're cleaning up infrastructure rows that were never real domain objects in the first place.

::: info Event-Sourcing note
In pure event-sourced systems `IRepository.delete` is rarely meaningful — the aggregate's end-of-lifecycle lives in the stream as an event (`Closed`, `Terminated`), and the identity persists in the event log forever. `delete` applies primarily to state-stored aggregates and to snapshot / projection tables.
:::

Three canonical patterns, applied per use case:

#### 1. State transition that records an event (the most common case)

When the user says "delete the order" but the domain actually means *cancel*, *archive*, *close* — model it as a state transition with a domain method that records the corresponding event. The row stays in the table; a status column marks the transition. `delete(id)` is never called.

```ts
// Domain method on the aggregate
class Order extends AggregateRoot<OrderState, OrderId, OrderEvent> {
  archive(reason: string): void {
    if (this.state.status === "archived") {
      throw new OrderAlreadyArchivedError(this.id);
    }
    this.commit(
      { ...this.state, status: "archived", archivedAt: new Date() },
      { type: "OrderArchived", reason, archivedAt: new Date() },
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

The audit trail is preserved (the event documents *who* archived *what* and *when*). Replays work cleanly — `OrderArchived` is just another event in the stream. Filter archived rows out of read queries (`WHERE status <> 'archived'`) or build a separate "active orders" projection.

#### 2. Hard-delete with event harvest

When the row genuinely must disappear from the primary store — privacy/regulatory deletion (GDPR right-to-be-forgotten), data-retention purge after a contractual window, true subscription-termination — but the disappearance itself is a domain fact subscribers care about, record the deletion event on the aggregate first, then call `delete(id)` inside the same transactional callback. Return the aggregate in `withCommit`'s `aggregates` array so its pending events flow through the outbox before the row is gone:

```ts
class Order extends AggregateRoot<OrderState, OrderId, OrderEvent> {
  recordDeletion(reason: string): void {
    // No state change — the row is about to be deleted entirely.
    // We only need the event in pendingEvents for the outbox.
    this.addDomainEvent({ type: "OrderDeleted", reason, deletedAt: new Date() });
  }
}

await withCommit({ scope, outbox, bus }, async (tx) => {
  const orderRepository = makeOrderRepository(tx);
  const order = await orderRepository.getByIdOrFail(orderId);
  order.recordDeletion(reason);              // records the event
  await orderRepository.delete(orderId);     // removes the row in the same tx
  return { result: undefined, aggregates: [order] };
});
```

Order of operations inside the transaction:

1. `recordDeletion` puts `OrderDeleted` into `order.pendingEvents`
2. `delete(orderId)` removes the row
3. `withCommit` harvests `order.pendingEvents` and writes them to the outbox — *still inside the transaction*, so the event and the row removal commit atomically
4. After the transaction commits, downstream subscribers see `OrderDeleted` and react (clear caches, expire projections, etc.)

The in-memory `order` object still has its version and (now-empty) state after `withCommit` calls `markPersisted`, but the caller typically discards the reference immediately — the aggregate is gone.

#### 3. Hard-delete without event

When the aggregate has no domain meaning anymore and no subscriber needs to know — abandoned-cart cleanup, internal garbage collection, expired session rows — call `delete(id)` directly. No event, no `withCommit` ceremony:

```ts
await scope.transactional(async (tx) => {
  const orderRepository = makeOrderRepository(tx);
  await orderRepository.delete(orderId);
});
```

Skip this path if anything else in the system might care about the disappearance. The cost of recording a deletion event is small; the cost of subscribers silently going stale is much higher.

#### Choosing between them

Decide by **what the operation means in your domain**, not by a default:

- **Pattern 1** if the user-facing "delete" maps to a real domain operation (*cancel*, *archive*, *close*, *deactivate*). This is most user-initiated cases. Audit trail + replay-safety come for free.
- **Pattern 2** if the row truly must vanish *and* the disappearance is something subscribers should react to (cache eviction, projection cleanup, archive copy elsewhere, downstream system notification).
- **Pattern 3** if deletion is invisible to the domain — abandoned-cart cleanup, expired session rows, infrastructure GC. If you find yourself wanting a Pattern 3 hard-delete for something that has identity in the ubiquitous language, you probably want Pattern 1 or 2 instead.

Aggregates have identity; identity has a lifecycle worth recording. Patterns 1 and 2 honour that. Pattern 3 is for rows that were never really aggregates to begin with.

## `IQueryableRepository` — bring your own filter

Aggregates that are queried by criteria opt in by implementing the extended interface:

```ts
interface IQueryableRepository<TAgg, TId, TFilter> extends IRepository<TAgg, TId> {
  findOne(filter: TFilter): Promise<TAgg | null>;
  find(filter: TFilter):    Promise<TAgg[]>;
}
```

`TFilter` is the filter shape your persistence layer speaks. The library does **not** prescribe a query DSL or Specification pattern — each Repository implementation owns its language.

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

### `find` returns the full set — by design

`find(filter)` returns **every** match — there's no `limit` or `cursor` baked into the interface. Reasons:

1. **Aggregates are write-side objects.** Loading thousands of them by predicate is rarely what you want — that's a read-model concern (CQRS read side), and read models have their own typed access methods.
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

## `AggregateNotFoundError` and `ConcurrencyConflictError`

Both are `InfrastructureError` subclasses (not `DomainError` — the storage boundary decided the row is absent or stale, not a business rule). They extend `@shirudo/base-error`'s `BaseError`, so they carry timestamps, cause chains, `toJSON()`, and `getUserMessage()` out of the box.

- **`AggregateNotFoundError(aggregateType, id, cause?)`** — thrown by `getByIdOrFail`. Carries a user-safe message that does NOT leak the id. Not retryable (the row isn't there; retry won't help).
- **`ConcurrencyConflictError(aggregateType, aggregateId, expectedVersion, actualVersion, cause?)`** — thrown by `save` on OCC mismatch. Marks itself `retryable: true` so the `isRetryable(err)` predicate from `@shirudo/base-error` picks it up — the canonical OCC pattern is to reload, re-apply, and retry.

```ts
import {
  AggregateNotFoundError,
  ConcurrencyConflictError,
} from "@shirudo/ddd-kit";
import { isRetryable } from "@shirudo/base-error";

try {
  await orderRepository.save(order);
} catch (err) {
  if (err instanceof ConcurrencyConflictError) {
    // reload, re-apply use case, retry — or surface HTTP 409
  }
  if (err instanceof AggregateNotFoundError) {
    // map to HTTP 404
  }
  if (isRetryable(err)) {
    // delegate to retry middleware
  }
  throw err;
}
```

Catch them at the App-Service layer to map to HTTP 404 / HTTP 409 as appropriate.
