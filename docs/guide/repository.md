# Repository

A repository is the persistence boundary for an aggregate. It should feel like
a collection of aggregate roots: load by id, save the aggregate, delete the
aggregate.

It is not a query service, not an event publisher, and not the owner of the
aggregate lifecycle after commit. Those boundaries matter:

- The repository writes rows and maps storage errors.
- `withCommit` or `UnitOfWork` harvests events and acknowledges the aggregate
  through an internal capability after the transaction commits.
- Read-side queries that need lists, search, or denormalized data belong on
  projections, not on write-side repositories.

## Interfaces

Every aggregate repository implements id-based access:

```ts
interface IRepository<
  TAgg extends IAggregateRoot<TId>,
  TId extends Id<string>,
> {
  findById(id: TId): Promise<TAgg | null>;
  getById(id: TId): Promise<TAgg>;
  exists(id: TId): Promise<boolean>;
  save(aggregate: TAgg): Promise<void>;
  delete(aggregate: TAgg): Promise<void>;
}
```

Use `findById` when absence is a valid outcome. Use `getById` when absence is
a broken precondition for the use case:

```ts
async getById(id: OrderId): Promise<Order> {
  const order = await this.findById(id);
  if (!order) {
    throw new AggregateNotFoundError({
      aggregateType: "Order",
      id,
    });
  }
  return order;
}
```

`exists` can be cheaper than loading the aggregate when the storage backend has
an `exists` query.

The return type is the aggregate itself, never a row shape, an ORM
entity, or a DTO: the port belongs to the domain side, so its signature
speaks domain types, and the mapping from storage shape to aggregate is
the adapter's job. See
[Ports speak the domain's language](/guide/design-decisions#ports-speak-the-domains-language)
for how this rule plays out across the other port kinds.

`UnitOfWork` repositories use the same shape without `exists` and receive a
`UnitOfWorkSession` for enrollment and identity-map access.

## Loading Means Reconstitution

Loading an aggregate is not the same as creating one. A factory such as
`Order.create(...)` records creation events. A repository must reconstitute
the already-existing aggregate without producing new domain events.

For state-stored aggregates, call a reconstitution factory:

```ts
async findById(id: OrderId): Promise<Order | null> {
  const cached = this.identityMap.get(Order, id);
  if (cached) return cached;

  const row = await this.tx.query.orders.findFirst({
    where: eq(orders.id, id),
  });
  if (!row) return null;

  const order = Order.reconstitute(
    row.id as OrderId,
    row.state as OrderState,
    row.version as Version,
  );

  this.identityMap.set(Order, id, order);
  return order;
}
```

For event-sourced aggregates, replay history into a fresh instance:

```ts
async findById(id: OrderId): Promise<Order | null> {
  const cached = this.identityMap.get(Order, id);
  if (cached) return cached;

  const address = { aggregateType: "Order", aggregateId: id };
  const order = Order.reconstitute(id);
  let fromVersion = 0;
  let targetVersion: number | undefined;

  for (;;) {
    const page = await this.eventStore.readStream(address, {
      fromVersion,
      toVersion: targetVersion,
      limit: 256,
    });
    if (!page.exists) return null;
    targetVersion ??= page.lastVersion;
    if (fromVersion === targetVersion) break;
    if (page.events.length === 0) {
      throw new NonProgressingEventStreamPageError({
        ...address,
        fromVersion,
        targetVersion,
      });
    }
    const result = order.loadFromHistory(page.events);
    if (result.isErr()) throw result.error;
    fromVersion += page.events.length;
  }

  this.identityMap.set(Order, id, order);
  return order;
}
```

The mandatory `limit` keeps each store allocation bounded. Pin the first
page's `lastVersion` as `toVersion`, then advance `fromVersion` by the number of
events actually returned. That gives the repository a stable append-only
prefix even if a concurrent writer appends while replay is running. Never put
the aggregate in the identity map until every page has replayed successfully.

A correctly reconstituted aggregate has no pending events from the load path.
If loading an aggregate records an event, the repository is using the wrong
factory.

## Identity Map

Within one unit of work, loading the same aggregate twice must return the same
JavaScript object.

That is not just an optimization. Commit enrollment is idempotent by object
identity. If a repository returns two different instances for the same
aggregate id, it can mint two different commit tokens and both instances can
be harvested and marked independently.

The map is per operation:

```ts
class TxScopedOrderRepository implements IRepository<Order, OrderId> {
  constructor(
    private readonly tx: DrizzleTx,
    private readonly identityMap: IdentityMap,
  ) {}

  async findById(id: OrderId): Promise<Order | null> {
    const cached = this.identityMap.get(Order, id);
    if (cached) return cached;

    if (this.identityMap.isDeleted(Order, id)) return null;

    const row = await loadOrderRow(this.tx, id);
    if (!row) return null;

    const order = Order.reconstitute(row.id, row.state, row.version);
    this.identityMap.set(Order, id, order);
    return order;
  }
}
```

When you use `UnitOfWork`, use `session.identityMap`. It is created fresh for
each `run()` and cleared when the run closes. Do not cache aggregate instances
across operations; that bypasses optimistic concurrency.

## Save Is Pure Persistence

`save(aggregate)` writes the aggregate and maps storage conflicts. It does not
publish events or mutate aggregate lifecycle state.

With plain `withCommit`, the callback receives an invocation-scoped enrollment
capability. After the repository write succeeds, enroll the saved aggregate
and return the opaque token. A naked aggregate is not commit evidence:

```ts
await withCommit({ scope, outbox, bus }, async (tx, enrollment) => {
  const orders = makeOrderRepository(tx);
  const order = await orders.getById(orderId);

  order.confirm(domainEvents.createFacts());
  await orders.save(order);

  const commit = enrollment.enrollSaved(order);
  return { result: order.id, commits: [commit] };
});
```

The token proves that this invocation's enrollment capability issued it. It
cannot prove what an arbitrary storage adapter did internally, so only the
repository should attest its participating write. This is a crash-loud
contract boundary against accidental smuggling, not a security boundary
against application code deliberately claiming a write it never made. Return
every token the callback obtains: omitting an enrolled write rejects the
transaction. Throw instead when that write must roll back.

With `UnitOfWork`, the repository enrolls the aggregate before the row write:

```ts
async save(order: Order): Promise<void> {
  this.session.enrollSaved(order);

  if (!order.hasChanges) return;
  await this.writeOrder(order);
}
```

Enroll before writing and before no-op returns. If the aggregate was deleted
earlier in the same unit of work, `enrollSaved` throws
`AggregateDeletedError` before the save can quietly return.

## Insert, Update, And Versions {#insert-vs-update-the-persistedversion-convention}

Every aggregate exposes two version values:

- `aggregate.version` is the in-memory version after domain mutations.
- `aggregate.persistedVersion` is the version currently known to be in
  storage.

Route insert vs update on `persistedVersion`, not on `version`.

```ts
async save(order: Order): Promise<void> {
  if (!order.hasChanges) return;

  const memento = order.createSnapshot(this.clock());

  if (order.persistedVersion === undefined) {
    try {
      await this.tx.insert(orders).values({
        id: order.id,
        state: memento.state,
        version: memento.version,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DuplicateAggregateError({
          aggregateType: "Order",
          aggregateId: order.id,
          cause: error,
        });
      }
      throw error;
    }
    return;
  }

  const expected = order.persistedVersion;
  const result = await this.tx
    .update(orders)
    .set({
      state: memento.state,
      version: memento.version,
    })
    .where(and(eq(orders.id, order.id), eq(orders.version, expected)));

  if (result.rowsAffected === 0) {
    const current = await loadOrderVersion(this.tx, order.id);
    throw new ConcurrencyConflictError({
      aggregateType: "Order",
      aggregateId: order.id,
      expectedVersion: expected,
      actualVersion: current ?? -1,
    });
  }
}
```

A new aggregate can have `version > 0` before its first save because factories
and domain methods can record events before persistence. That aggregate still
needs an insert. `persistedVersion === undefined` is the reliable marker.

For updates, the row gets `aggregate.version`, while the `WHERE` predicate
checks `aggregate.persistedVersion`. If the predicate affects zero rows,
another writer won. Throw `ConcurrencyConflictError`.

Version is a mutation sequence, not "plus one per transaction". If an
aggregate is loaded at version `7` and three version-bumping methods run, it
can commit as version `10`. That is correct.

After the transaction commits, `withCommit` or `UnitOfWork` uses a non-exported
capability to sync `persistedVersion`, clear pending events, and re-baseline
dirty tracking.

## Event-Sourced Repositories

For event-sourced aggregates, pending events are the write model. The
repository appends them with the stream version the aggregate was loaded from:

```ts
async save(order: Order): Promise<void> {
  if (order.pendingEvents.length === 0) return;

  this.session.enrollSaved(order);

  await this.eventStore.append(
    { aggregateType: "Order", aggregateId: order.id },
    order.pendingEvents,
    { expectedVersion: order.persistedVersion ?? 0 },
  );
}
```

The event store saves the bare domain events. `withCommit` composes the same
pending events into committed outbox envelopes. Do not clear
`pendingEvents` in the repository.

Save once per aggregate per unit of work, after all mutations. A second save
of the same event-sourced instance before commit will try to append the same
pending events again with a stale expected version.

## Partial Writes {#partial-writes-for-multi-table-aggregates-changedkeys--haschanges}

Some state-stored aggregates span several tables: a root row plus child
collections. You still save the aggregate as one unit, but you do not have to
rewrite every child table every time.

`AggregateRoot` exposes two signals:

- `changedKeys`: top-level state keys whose value or presence changed since
  load or last persisted.
- `hasChanges`: whether anything commit-relevant exists.

Use them differently:

- `hasChanges === false` means `save()` can return immediately.
- `changedKeys` tells the repository which table-sized parts to write.

```ts
async save(restaurant: Restaurant): Promise<void> {
  if (!restaurant.hasChanges) return;

  const { id, state, changedKeys } = restaurant;
  const expected = restaurant.persistedVersion;

  if (expected === undefined) {
    await this.insertRootRow(restaurant);
  } else {
    const result = await this.tx
      .update(restaurants)
      .set({
        ...rootColumns(state),
        version: restaurant.version,
      })
      .where(and(eq(restaurants.id, id), eq(restaurants.version, expected)));

    if (result.rowsAffected === 0) {
      throw new ConcurrencyConflictError({
        aggregateType: "Restaurant",
        aggregateId: id,
        expectedVersion: expected,
        actualVersion: -1,
      });
    }
  }

  if (changedKeys.has("openingHours")) {
    await this.replaceOpeningHours(id, state.openingHours);
  }

  if (changedKeys.has("menuSections")) {
    await this.replaceMenuSections(id, state.menuSections);
  }
}
```

Keep these rules:

- The root row write with the OCC predicate runs on every save and runs first.
- The whole save runs on the transaction handle.
- `changedKeys` is table-granular, not row-granular. Diff rows inside the
  branch if you need that.
- `setStateWithoutVersionBump` can mark keys dirty without advancing OCC. Use
  it only for data that a concurrent writer may safely overwrite.
- Do not mutate an aggregate after `save()` inside the same `withCommit`
  callback. Post-commit re-baselining would mark the later mutation clean.

Dirty tracking is shallow by design. It assumes plain state records replaced
through `setState` or `commit`. Mutating nested objects in place can bypass the
diff. A class instance as `TState` is the wrong shape for this feature.

`EventSourcedAggregate` has no `changedKeys`; its pending events are the
change record.

## Delete Is A Domain Decision

`delete(aggregate)` removes the row. It does not decide whether a user-facing
"delete" should be modeled as row removal.

Most user-facing deletes are domain transitions: cancel, archive, close,
deactivate, terminate, expire. If the operation has a domain name, model it as
a method and save the aggregate.

```ts
class Order extends AggregateRoot<OrderState, OrderId, OrderEvent> {
  protected readonly aggregateType = "Order";

  archive(
    reason: string,
    archivedAt: Date,
    facts: DomainEventFacts,
  ): void {
    if (this.state.status === "archived") {
      throw new OrderAlreadyArchivedError(this.id);
    }

    this.commit(
      { ...this.state, status: "archived", archivedAt },
      this.recordEvent("OrderArchived", { reason, archivedAt }, facts),
    );
  }
}

await withCommit({ scope, outbox, bus }, async (tx, enrollment) => {
  const orders = makeOrderRepository(tx);
  const order = await orders.getById(orderId);

  const archivedAt = clock();
  order.archive(
    reason,
    archivedAt,
    domainEvents.createFacts({ occurredAt: archivedAt }),
  );
  await orders.save(order);

  return {
    result: undefined,
    commits: [enrollment.enrollSaved(order)],
  };
});
```

Use hard delete only when the row really must vanish.

### Hard Delete With An Event

If the row must disappear and subscribers must react, record the event first,
then delete the aggregate in the same transaction.

```ts
class Order extends AggregateRoot<OrderState, OrderId, OrderEvent> {
  protected readonly aggregateType = "Order";

  recordDeletion(
    reason: string,
    deletedAt: Date,
    facts: DomainEventFacts,
  ): void {
    this.commit(
      { ...this.state },
      this.recordEvent("OrderDeleted", { reason, deletedAt }, facts),
    );
  }
}

await withCommit({ scope, outbox, bus }, async (tx, enrollment) => {
  const orders = makeOrderRepository(tx);
  const order = await orders.getById(orderId);

  const deletedAt = clock();
  order.recordDeletion(
    reason,
    deletedAt,
    domainEvents.createFacts({ occurredAt: deletedAt }),
  );
  await orders.delete(order);

  return {
    result: undefined,
    commits: [enrollment.enrollDeleted(order)],
  };
});
```

The deleted commit token tells `withCommit` to harvest the event and discard it
after commit without acknowledging a saved row, because that row no longer
exists. In a `UnitOfWork`
repository, `delete` should call `session.enrollDeleted(order)`, which also
tombstones the identity map entry for the rest of the run.

Use the same version predicate for deletes when delete-vs-update races matter:

```sql
delete from orders
where id = $1 and version = $2
```

Zero affected rows should map to `ConcurrencyConflictError`.

### Hard Delete Without An Event

Use this only for data whose disappearance has no domain meaning: expired
session rows, abandoned-cart cleanup, or infrastructure garbage collection.

```ts
await scope.transactional(async (tx) => {
  const orders = makeOrderRepository(tx);
  const order = await orders.findById(orderId);

  if (order) {
    await orders.delete(order);
  }
});
```

For bulk cleanup, do not load aggregates one by one. Infrastructure-owned
cleanup belongs in an adapter-side maintenance component. If an application
use case invokes it, define a separate consumer-owned port such as
`ExpiredOrderPurger.purgeExpired(before)` and implement one predicated
statement. The use case should not depend on the concrete repository class.

In pure event-sourced systems, hard delete is rarely the aggregate lifecycle.
End-of-life is usually an event in the stream; the identity remains in the
log.

## Consumer-Owned Query Ports

`IRepository` deliberately stops at aggregate identity and lifecycle. When a
command-side use case needs another lookup, define a port in the consumer's
domain or application layer with a method named after that intent. Do not leak
SQL, Prisma `WhereInput`, Mongo filters, or another adapter's query language
through the port.

A single-result method needs a real uniqueness law:

```ts
interface OrderRepository extends IRepository<Order, OrderId> {
  /** Customer email is unique among active orders. */
  findActiveByCustomerEmail(email: EmailAddress): Promise<Order | null>;
}
```

State that uniqueness as a domain rule and enforce it with an authoritative
consistency mechanism, typically a database uniqueness constraint. If several
rows may match, a `findOne` method without an explicit stable order is not a
valid substitute.

Multi-result aggregate selection must be bounded and ordered by contract. The
page vocabulary belongs to the consumer too:

```ts
declare const dunningCursorBrand: unique symbol;
declare const dunningPageSizeBrand: unique symbol;

type DunningCursor = string & { readonly [dunningCursorBrand]: true };
type DunningPageSize = number & { readonly [dunningPageSizeBrand]: true };

function dunningPageSize(value: number): DunningPageSize {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new RangeError("Dunning page size must be an integer from 1 to 100");
  }
  return value as DunningPageSize;
}

interface DunningCriteria {
  readonly dueBefore: DueDate;
  readonly maximumReminders: number;
}

interface DunningPageRequest {
  readonly after?: DunningCursor;
  readonly limit: DunningPageSize;
}

interface DunningCandidatePage {
  readonly items: ReadonlyArray<Invoice>;
  readonly nextCursor: DunningCursor | null;
}

interface InvoiceRepository extends IRepository<Invoice, InvoiceId> {
  findDunningCandidates(
    criteria: DunningCriteria,
    page: DunningPageRequest,
  ): Promise<DunningCandidatePage>;
}
```

This port must define one stable total order, for example `dueDate ASC,
invoiceId ASC`. Its cursor is tied to that order, and `nextCursor` continues
strictly after the last returned item. For an unchanged source dataset,
traversal returns each match exactly once. The validated page-size constructor
makes the hard upper bound unavoidable at call sites. An adapter contract can
then exercise empty, single-page, multi-page, and equal-sort-key fixtures
through a consumer-supplied harness.

For high-volume command processing, consider selecting bounded IDs first and
loading each aggregate in its own operation. If the query serves a UI list,
search page, dashboard, or report, build a projection and a read-model query
port instead of hydrating aggregates.

## Specifications

Sometimes the lookup criteria belong to the domain, not to the storage
layer. "Which invoices qualify for dunning?" is a business question, and the
answer changes when the business changes. For criteria like that, write a
`Specification` and accept it through a consumer-owned, bounded port:

```ts
import { Specification, type SpecificationComposite, specification } from "@shirudo/ddd-kit";

class OverdueInvoice extends Specification<Invoice> {
  readonly name = "overdue invoice";
  constructor(readonly today: Date) { super(); } // readonly: adapters read it
  isSatisfiedBy(invoice: Invoice): boolean {
    return invoice.dueDate < this.today && invoice.status === "open";
  }
}

const dunningCandidates = new OverdueInvoice(today).and(
  specification("in dunning grace period", (i: Invoice) => i.remindersSent < 3),
);

interface InvoiceRepository extends IRepository<Invoice, InvoiceId> {
  findSatisfying(
    specification: Specification<Invoice>,
    page: DunningPageRequest,
  ): Promise<DunningCandidatePage>;
}
```

What does this buy over an inline predicate? Three things.

First, it runs in memory as-is. Domain logic can ask
`spec.isSatisfiedBy(candidate)` directly, and an in-memory repository or
test fake implements the criterion as a plain filter before applying the
port's stable ordering and page bound:
`rows.filter((r) => spec.isSatisfiedBy(r))`. Your tests never need a
translation layer. `findSatisfying` is only an example name; prefer a more
specific use-case name when the ubiquitous language provides one.

Second, it composes. `and`, `or`, and `not` build rules that still read
like the business rule, and the derived names, for example
`"(overdue invoice and (not high value))"`, show up in error messages and
test output.

Third, a storage adapter can translate it. The adapter recurses through the
`composite` structure for combinator nodes and translates each leaf
explicitly. Note that there are two kinds of leaves: one without parameters,
where the name alone tells the adapter what to emit, and one with parameters
(the reference date above), where the adapter has to narrow to the class and
read its fields, because the name cannot carry the data:

```ts
function toSql(spec: Specification<Invoice>): SQL {
  const composite = spec.composite;
  if (composite) {
    switch (composite.operator) {
      case "and": return and(toSql(composite.left), toSql(composite.right));
      case "or":  return or(toSql(composite.left), toSql(composite.right));
      case "not": return not(toSql(composite.inner));
    }
  }
  // A parameterized leaf: narrow to the class, translate the whole
  // predicate (both conditions), and take the date from the instance
  // rather than substituting the adapter's own clock.
  if (spec instanceof OverdueInvoice) {
    return and(eq(invoices.status, "open"), lt(invoices.dueDate, spec.today));
  }
  // Parameterless leaves: the name alone identifies the translation.
  switch (spec.name) {
    case "in dunning grace period": return lt(invoices.remindersSent, 3);
    default:
      throw new Error(`No SQL translation for specification '${spec.name}'`);
  }
}
```

### A visitor layer on top (double dispatch)

The recursive walker above is single dispatch plus type narrowing, which is
how TypeScript usually replaces the classic visitor pattern, and for most
codebases it is the right place to stop. It has one weakness worth knowing
about. Leaves are matched by name or `instanceof` in a switch, so when
someone adds a new specification, nothing forces the translator to handle
it. The gap only shows up at runtime, as the `No SQL translation` error.
With a single translation target and decent test coverage, that loud
runtime error is a perfectly workable contract.

The picture changes once several translators exist for the same
specifications, say SQL for the write side, a Mongo filter for an archive,
and a search-index query. Now a forgotten leaf means three places to hunt
down. This is where classic double dispatch earns its ceremony: each new
specification adds a method to a visitor interface, and every translator
stops compiling until it handles the new leaf. The compiler does the
hunting. The kit's combinators are deliberately overridable so that you can
build this layer yourself when you reach that point:

```ts
interface InvoiceSpecVisitor<R> {
  visitOverdue(spec: OverdueInvoice): R;
  visitGracePeriod(spec: InGracePeriod): R;
  visitAnd(left: TranslatableSpec, right: TranslatableSpec): R;
  visitOr(left: TranslatableSpec, right: TranslatableSpec): R;
  visitNot(inner: TranslatableSpec): R;
}

abstract class TranslatableSpec extends Specification<Invoice> {
  abstract accept<R>(visitor: InvoiceSpecVisitor<R>): R;

  // Override the combinators so composites are visitor-aware too. The
  // overrides narrow the operand type: inside this hierarchy you can
  // only combine translatable specifications, which is the point.
  override and(other: TranslatableSpec): TranslatableSpec {
    return new AndSpec(this, other);
  }
  override or(other: TranslatableSpec): TranslatableSpec {
    return new OrSpec(this, other);
  }
  override not(): TranslatableSpec {
    return new NotSpec(this);
  }
}

class OverdueInvoice extends TranslatableSpec {
  readonly name = "overdue invoice";
  constructor(readonly today: Date) { super(); }
  isSatisfiedBy(i: Invoice): boolean {
    return i.dueDate < this.today && i.status === "open";
  }
  accept<R>(v: InvoiceSpecVisitor<R>): R {
    return v.visitOverdue(this);
  }
}

class AndSpec extends TranslatableSpec {
  override readonly composite: SpecificationComposite<Invoice>;
  constructor(readonly left: TranslatableSpec, readonly right: TranslatableSpec) {
    super();
    // Set `composite` like the kit's own combinators do: walker-based
    // tooling and adapters keep working unchanged, whoever built the tree.
    this.composite = Object.freeze({ operator: "and" as const, left, right });
  }
  get name(): string {
    return `(${this.left.name} and ${this.right.name})`;
  }
  isSatisfiedBy(i: Invoice): boolean {
    return this.left.isSatisfiedBy(i) && this.right.isSatisfiedBy(i);
  }
  accept<R>(v: InvoiceSpecVisitor<R>): R {
    return v.visitAnd(this.left, this.right);
  }
}
// OrSpec / NotSpec follow the same shape.

// A translator is now a compile-time-complete implementation:
class SqlVisitor implements InvoiceSpecVisitor<SQL> {
  visitOverdue(s: OverdueInvoice) {
    return and(eq(invoices.status, "open"), lt(invoices.dueDate, s.today));
  }
  visitGracePeriod() { return lt(invoices.remindersSent, 3); }
  visitAnd(l: TranslatableSpec, r: TranslatableSpec) {
    return and(l.accept(this), r.accept(this));
  }
  visitOr(l: TranslatableSpec, r: TranslatableSpec) {
    return or(l.accept(this), r.accept(this));
  }
  visitNot(inner: TranslatableSpec) { return not(inner.accept(this)); }
}
```

Everything else keeps working as before. `isSatisfiedBy`, the derived
names, and the `composite` introspection behave the same whether the kit's
combinators or yours built the tree, so in-memory evaluation and any
walker-based tooling don't care which hierarchy they are looking at.

One caveat: mixed trees. A factory-built specification from
`specification("...", ...)` has no `accept` method, so if one ends up inside
a `TranslatableSpec` tree, the pure visitor path breaks on it. You can
either keep the hierarchy closed, which the narrowed combinator overrides
already enforce at compile time, or give your visitor a fallback that walks
`composite` for nodes and matches leaves without `accept` by name. That
fallback is exactly the walker from the previous section, so you lose
nothing by having it around.

If you are unsure which to pick: start with the walker. It is less ceremony,
and its runtime error is hard to miss. Reach for the visitor layer when a
second translation target appears, or when new specifications arrive often
enough that you would rather have the compiler find the untranslated leaf
than production. The kit ships neither a visitor interface nor a base class
for this, because both would have to enumerate your domain's specifications,
and only you can do that. What the kit promises instead is that the layer
stays buildable: the combinators can be overridden, `composite` can be set
by subclasses, and nothing is sealed.

Be aware of what dual use actually means: a specification that is both
evaluated in memory and translated to SQL is one rule with two
implementations, the predicate and the translation, and the two can drift
apart without anything failing. The way to keep them honest is a shared
fixture test, where the same set of candidates goes through `isSatisfiedBy`
and through the translated query against a real store, and both must select
the same rows. If that test is more than you want to maintain, use the
specification on one side only. A specification that never leaves memory
(domain logic, test fakes) needs no translation in the first place.

A final word on scope. Specifications are for write-side lookups whose
criteria live in the domain language. A UI list or a dashboard query still
belongs in a projection, and a one-off lookup is usually better served by an
intent-revealing method like `findByEmail` than by a specification nobody
would ever name in conversation.

## Id Generation

Identity generation belongs in the application, not in the repository.

```ts
import type { Id, IdGenerator } from "@shirudo/ddd-kit";
import { ulid } from "ulid";

type OrderId = Id<"OrderId">;

const orderIds: IdGenerator<"OrderId"> = {
  next: () => ulid() as OrderId,
};

const id = orderIds.next();
```

The generator binds the tag. An `IdGenerator<"OrderId">` does not produce a
`UserId`.

Use collision-resistant ids under concurrent calls: UUID v4, UUID v7, ULID,
KSUID, or another generator designed for distributed creation. `Date.now()`
and process-local counters are not enough.

## Error Mapping

Repository errors are infrastructure errors because the storage boundary
detected them:

- `AggregateNotFoundError`: `getById` did not find a row. Map to a 404-shaped
  application response.
- `ConcurrencyConflictError`: the OCC predicate failed. Retry by starting a
  fresh unit of work, reloading, reapplying the command, and saving again; or
  map to a 409-shaped response.
- `DuplicateAggregateError`: insert hit an existing id. Map the driver unique
  violation to this error instead of leaking raw SQL errors.

```ts
import {
  AggregateNotFoundError,
  ConcurrencyConflictError,
  DuplicateAggregateError,
} from "@shirudo/ddd-kit";
import { someChainRetryable } from "@shirudo/base-error";

try {
  await orders.save(order);
} catch (error) {
  if (error instanceof AggregateNotFoundError) {
    throw notFound();
  }

  if (error instanceof DuplicateAggregateError) {
    throw conflict();
  }

  if (error instanceof ConcurrencyConflictError || someChainRetryable(error)) {
    throw retryOrConflict();
  }

  throw error;
}
```

`ConcurrencyConflictError` is retryable. `DuplicateAggregateError` is not:
running the same insert again cannot make it succeed.

## Contract Tests

Optimistic concurrency is not guaranteed by the interface. It is guaranteed by
your repository's SQL and transaction wiring.

Use `createRepositoryContractTests` from `@shirudo/ddd-kit/testing` against a
real database adapter:

```ts
import { createRepositoryContractTests } from "@shirudo/ddd-kit/testing";

describe("DrizzleOrderRepository", () => {
  for (const test of createRepositoryContractTests(harness)) {
    (test.skipped ? it.skip : it)(test.name, test.run);
  }
});
```

The suite checks the important failure modes: stale writers, insert routing,
rollback purity, identity map behavior, delete finality, duplicate inserts,
outbox event harvest, and optional delete version checks.

For SQL adapters, do not run this only against an in-memory fake. The point is
to prove the real `WHERE version = ...` predicate and transaction behavior.
