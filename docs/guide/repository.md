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
- **`getByIdOrFail`** — throws `AggregateNotFoundError` (a `DomainError`) when missing. Use when "missing is a programming/contract error in the calling Use Case".

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
