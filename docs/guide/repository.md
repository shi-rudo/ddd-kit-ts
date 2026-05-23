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

`save()` returns `Promise<void>`. Implementations should:

1. Throw `ConcurrencyConflictError` (a `DomainError`) when `aggregate.version` doesn't match the version currently persisted
2. After a successful write, call `aggregate.markPersisted(newVersion)` so the in-memory aggregate reflects the new version and clears any recorded domain events

`markPersisted` is declared on the `IAggregateRoot` interface, so a repository can call it via the public contract without coupling to the concrete abstract class.

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

Both are `DomainError` subclasses with structured context:

```ts
class AggregateNotFoundError extends DomainError {
  constructor(public readonly aggregateType: string, public readonly id: string) {
    super(`Aggregate not found: ${aggregateType}(${id})`);
  }
}

class ConcurrencyConflictError extends DomainError {
  constructor(
    public readonly aggregateType: string,
    public readonly aggregateId: string,
    public readonly expectedVersion: number,
    public readonly actualVersion: number,
  ) {
    super(`Concurrency conflict on ${aggregateType}(${aggregateId}): expected ${expectedVersion}, actual ${actualVersion}`);
  }
}
```

Catch them at the App-Service layer to map to HTTP 404 / HTTP 409 as appropriate.
