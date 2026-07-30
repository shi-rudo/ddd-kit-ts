# Repository

A repository is a persistence-oriented collection of aggregate roots. Its
public contract says whether an aggregate is new, loaded, or physically
removed. It does not publish events, expose ORM filters, or decide a business
lifecycle transition.

In v3 repository writes run through `UnitOfWork`. The use case calls `add`,
`update`, or `remove`; the adapter receives one immutable write receipt during
the commit phase.

## Public contracts

Most aggregate repositories extend `AggregatePersistence`:

```ts
import type {
  AggregatePersistence,
  Id,
  Repository,
} from "@shirudo/ddd-kit";

interface OrderPersistence
  extends AggregatePersistence<Order, OrderId> {
  findOpenByNumber(number: OrderNumber): Promise<Order | undefined>;
}
```

`AggregatePersistence` contains:

```ts
interface AggregatePersistence<TAggregate, TId> {
  findById(id: TId): Promise<TAggregate | undefined>;
  getById(id: TId): Promise<TAggregate>;
  add(aggregate: TAggregate): void;
  update(aggregate: TAggregate): void;
}
```

Use `Repository` when this persistence boundary genuinely supports physical
removal:

```ts
interface TemporaryOrderRepository
  extends Repository<Order, OrderId> {}
```

`Repository` adds `remove(aggregate)`. It is the full collection contract.
`AggregatePersistence` is the smaller contract for retained records and event
streams, where physical removal is not part of normal operation.

Absence is an expected outcome of `findById`, so the contract uses
`undefined`. `getById` throws `AggregateNotFoundError`. A repository returns a
domain aggregate, never an ORM entity or database row.

Concrete ports belong to the consuming bounded context. Add only lookups that
a command-side use case needs and name them in the ubiquitous language. A UI
list, report, search result, or dashboard belongs on a projection instead.

## Explicit lifecycle intent

Creation and update are not synonyms:

```ts
await new UnitOfWork(deps).run(async ({ repositories }) => {
  const order = Order.place(newOrderId(), customerId, items);
  recordPendingEvents(order, domainEvents);

  repositories.orders.add(order);
});
```

```ts
await new UnitOfWork(deps).run(async ({ repositories }) => {
  const order = await repositories.orders.getById(orderId);
  order.confirm();
  recordPendingEvents(order, domainEvents);

  repositories.orders.update(order);
});
```

`add` is valid only for an aggregate created in this unit of work. `update` is
valid only for the same instance that the repository loaded and tracked. This
removes the old guess based on `version === 0` and makes duplicate creation a
separate failure from optimistic concurrency.

The application-facing methods only register intent. Durable I/O happens
after the callback resolves, inside the active transaction. Make every domain
decision first and call `add`, `update`, or `remove` last.

## Loading is reconstitution

A creation factory represents a new business decision. A repository must not
call it while loading old facts.

For a state-stored aggregate, provide an explicit reconstitution factory:

```ts
class Order extends AggregateRoot<OrderState, OrderId, OrderEvent> {
  protected readonly aggregateType = "Order";

  static reconstitute(
    id: OrderId,
    state: OrderState,
    version: Version,
  ): Order {
    const order = new Order(id, state);
    order.markRestored(version);
    return order;
  }
}
```

`markRestored` restores the current domain version. It does not create a
persistence receipt on the aggregate and does not record events.

The adapter tracks the result before returning it:

```ts
async findById(id: OrderId): Promise<Order | undefined> {
  const cached = this.tracking.identityMap.get(Order, id) as
    | Order
    | undefined;
  if (cached) return cached;
  if (this.tracking.identityMap.isDeleted(Order, id)) return undefined;

  const row = await loadOrderRow(this.tx, id);
  if (!row) return undefined;

  return this.tracking.trackLoaded(
    Order.reconstitute(id, decodeOrderState(row.state), row.version),
  );
}
```

For event sourcing, construct a bare aggregate and replay a stable stream
prefix:

```ts
const order = Order.bare(id);
let fromVersion = 0;
let toVersion: number | undefined;

for (;;) {
  const page = await eventStore.readStream(address, {
    fromVersion,
    toVersion,
    limit: 256,
  });

  if (!page.exists) return undefined;
  toVersion ??= page.lastVersion;
  if (fromVersion === toVersion) break;

  if (page.events.length === 0) {
    throw new NonProgressingEventStreamPageError({
      ...address,
      fromVersion,
      targetVersion: toVersion,
    });
  }

  const replay = order.loadFromHistory(page.events);
  if (replay.isErr()) throw replay.error;
  fromVersion += page.events.length;
}

return tracking.trackLoaded(order);
```

Pin the first page's `lastVersion` and page toward that fixed head. This gives
the load one stable append-only prefix even if another writer appends while it
is running. Never identity-map a partly replayed aggregate.

## Adapter-owned persistence models

Different adapters persist different shapes. A relational adapter may split
one aggregate over several tables; a document adapter may replace one JSON
document; an event store writes no current-state row at all. The aggregate
should not carry one supposedly universal dirty-key model.

Each repository definition therefore owns a `PersistenceModel`:

```ts
interface PersistenceModel<TAggregate, TBaseline, TChangeSet> {
  capture(aggregate: TAggregate): TBaseline;
  changes(
    baseline: TBaseline | undefined,
    aggregate: TAggregate,
    lifecycle: "loaded" | "new",
  ): TChangeSet;
  isEmpty(changes: TChangeSet): boolean;
}
```

When an adapter loads an aggregate, `UnitOfWork` stores the model's baseline
behind an opaque `PersistenceBaseline` token. The use case and aggregate
cannot inspect it. At write registration, the same adapter capability derives
and seals the exact change set.

A full-row model can be small:

```ts
type OrderRow = {
  readonly state: OrderStateDto;
  readonly version: number;
};

const orderPersistence: PersistenceModel<
  Order,
  OrderRow,
  OrderRow | undefined
> = {
  capture: (order) => ({
    state: orderStateDto(order),
    version: order.version,
  }),
  changes: (baseline, order, lifecycle) => {
    const current = {
      state: orderStateDto(order),
      version: order.version,
    };

    return lifecycle === "loaded" && deepEqual(baseline, current)
      ? undefined
      : current;
  },
  isEmpty: (change) => change === undefined,
};
```

For a multi-table aggregate, choose a table-aware change set instead:

```ts
type RestaurantChanges = {
  readonly root?: RestaurantRootRow;
  readonly openingHours?: ReadonlyArray<OpeningHoursRow>;
  readonly menu?: ReadonlyArray<MenuRowChange>;
};

const restaurantPersistence: PersistenceModel<
  Restaurant,
  RestaurantProjection,
  RestaurantChanges
> = {
  capture: projectRestaurant,
  changes: (baseline, restaurant, lifecycle) =>
    diffRestaurant(baseline, projectRestaurant(restaurant), lifecycle),
  isEmpty: (changes) =>
    changes.root === undefined &&
    changes.openingHours === undefined &&
    changes.menu === undefined,
};
```

The adapter chooses full replacement, partial columns, collection-aware row
diffs, or a version-only write. `changes.empty` is only about stored state. An
event-only commit may still have a non-empty `events` batch and must not be
skipped.

Projection functions should read meaningful aggregate queries and return
detached persistence DTOs. Both `capture` and `changes` must avoid mutable
references into the aggregate: the Unit of Work cannot safely clone or freeze
an arbitrary adapter-native type. A baseline that aliases aggregate state can
move when the aggregate moves; a change set that aliases it can change after
registration. Do not add setters, baseline fields, or dirty flags to the
aggregate for the adapter's convenience.

## Defining the adapter boundary

`defineRepository` joins an application-owned repository port, its adapter,
persistence model, and commit-time flush. Name the port after the capability
the use case needs; do not expose the concrete ORM adapter as the contract.

```ts
interface ForStoringOrders extends Repository<Order, OrderId> {}

const orders = defineRepository<ForStoringOrders>()({
  aggregate: Order,
  persistence: orderPersistence,
  physicalRemoval: true,
  create: (tx: DrizzleTx, tracking: RepositoryTracking<Order>) =>
    new DrizzleOrderReadAdapter(tx, tracking),
  flush: async (tx: DrizzleTx, write) => {
    if (write.intent === "add") {
      const row = requireOrderRow(write.changes);
      try {
        await tx.insert(orderTable).values({
          id: write.aggregateId,
          state: row.state,
          version: write.version,
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new DuplicateAggregateError({
            aggregateType: "Order",
            aggregateId: write.aggregateId,
            cause: error,
          });
        }
        throw error;
      }
      return;
    }

    if (write.intent === "update") {
      const row = write.changes.value;
      if (row === undefined) return;

      const result = await tx
        .update(orderTable)
        .set({ state: row.state, version: write.version })
        .where(and(
          eq(orderTable.id, write.aggregateId),
          eq(orderTable.version, write.expectedVersion),
        ));

      if (result.rowsAffected === 0) {
        throw new ConcurrencyConflictError({
          aggregateType: "Order",
          aggregateId: write.aggregateId,
          expectedVersion: write.expectedVersion ?? -1,
          actualVersion: await loadOrderVersion(tx, write.aggregateId),
        });
      }
      return;
    }

    const result = await tx
      .delete(orderTable)
      .where(and(
        eq(orderTable.id, write.aggregateId),
        eq(orderTable.version, write.expectedVersion),
      ));

    if (result.rowsAffected === 0) {
      throw staleRemoval(write);
    }
  },
  mapError: (error, write) => {
    if (error instanceof InfrastructureError) return error;
    return new OrderStoreUnavailableError(write.aggregateId, error);
  },
});
```

The type argument is deliberately explicit. `ForStoringOrders` is the full
application port; `DrizzleOrderReadAdapter` implements only its read methods
because the Unit of Work installs `add`, `update`, and `remove`. The concrete
adapter may have diagnostics or ORM-specific helpers, but those do not become
application API. It can change without silently widening the port.

`mapError` is the storage boundary's last translation step. Known failures
such as `DuplicateAggregateError` and `ConcurrencyConflictError` pass through;
an unknown driver failure becomes an application-defined
`InfrastructureError`, here `OrderStoreUnavailableError`. If the mapper throws
or returns a raw value, the Unit of Work raises
`RepositoryErrorMappingFailedError` and preserves both failures for diagnosis.
That keeps ORM error types out of use cases without hiding the original cause.

The receipt's version relationship is the OCC contract:

- `add`: no `expectedVersion`; insert a new identity and map a uniqueness
  violation to `DuplicateAggregateError`;
- `update`: write `version`, predicate on `expectedVersion`;
- `remove`: delete the identity, predicate on `expectedVersion` when
  delete-vs-update races matter.

Zero affected rows means the optimistic-concurrency assumption was false.
Throw `ConcurrencyConflictError`; do not silently turn a stale update into an
insert.

## Event-sourced flush

For an event-sourced aggregate, the registered event batch is the write model:

```ts
const orderStreamPersistence: PersistenceModel<
  Order,
  number,
  number | undefined
> = {
  capture: (order) => order.version,
  changes: (baseline, order) =>
    baseline === order.version ? undefined : order.version,
  isEmpty: (version) => version === undefined,
};

interface ForAppendingOrderEvents
  extends AggregatePersistence<Order, OrderId> {}

const eventSourcedOrders = defineRepository<ForAppendingOrderEvents>()({
  aggregate: Order,
  persistence: orderStreamPersistence,
  create: (tx: EventStoreTx, tracking: RepositoryTracking<Order>) =>
    new EventSourcedOrderReadAdapter(tx, tracking),
  flush: async (tx: EventStoreTx, write) => {
    await tx.eventStore.append(
      { aggregateType: "Order", aggregateId: write.aggregateId },
      write.events,
      { expectedVersion: write.expectedVersion ?? 0 },
    );
  },
  mapError: mapOrderPersistenceError,
});
```

Use `write.events`, not `aggregate.pendingEvents`. The receipt is the exact
immutable batch registered by the use case. A retry rebuilds a fresh unit of
work and records a fresh batch; one transaction attempt never re-reads a
moving pending-event list.

The event-store append and outbox write must share the same transaction. A
failed append or outbox write rolls both back, and the aggregate acknowledges
nothing.

## Snapshots stay outside the aggregate

A snapshot is derived persistence data, not domain behavior. Define its shape
and migration next to the adapter:

```ts
const orderSnapshots = defineSnapshotModel({
  aggregateType: "Order",
  schemaVersion: 2,
  capture: (order: Order): OrderSnapshotV2 => ({
    status: order.status,
    items: order.items.map(toItemSnapshot),
  }),
  migrate: (stored, storedVersion) =>
    migrateOrderSnapshot(stored, storedVersion),
  reconstitute: (id, state, version) =>
    Order.reconstitute(id, fromOrderSnapshot(state), version),
});
```

The application decides when to capture and store it:

```ts
const snapshot = captureAggregateSnapshot(
  orderSnapshots,
  order,
  clock(),
);

await snapshotStore.save(address, snapshot);
```

Loading creates a fresh aggregate. For event sourcing, replay the tail on that
fresh instance:

```ts
const order = reconstituteAggregateFromSnapshot(
  orderSnapshots,
  orderId,
  snapshot,
);

const tail = await eventStore.readStream(address, {
  fromVersion: snapshot.version,
  limit: 256,
});

const replay = order.loadFromHistory(tail.events);
if (replay.isErr()) throw replay.error;
```

`captureAggregateSnapshot` supplies no hidden clock and performs no I/O. It
detaches the DTO and rejects functions, promises, errors, symbol-keyed fields,
and class instances that would not round-trip safely. Map child entities and
value objects to persistence DTOs explicitly.

A missing stored schema version means schema `1`. A mismatch without a
`migrate` function throws `SnapshotSchemaMismatchError`; the usual event-store
fallback is to discard the derived snapshot and refold the stream from zero.

## Domain deletion versus physical removal

Most user-facing “delete” actions are domain transitions: cancel, archive,
close, revoke, expire. Put that language on the aggregate and register an
update:

```ts
await new UnitOfWork(deps).run(async ({ repositories }) => {
  const order = await repositories.orders.getById(orderId);

  order.archive(reason, clock());
  recordPendingEvents(order, domainEvents);
  repositories.orders.update(order);
});
```

Use `remove` only when the row, document, or stream really must disappear:

```ts
await new UnitOfWork(deps).run(async ({ repositories }) => {
  const order = await repositories.orders.getById(orderId);

  order.recordErasure(erasedAt);
  recordPendingEvents(order, domainEvents);
  repositories.orders.remove(order);
});
```

The removal and its event/outbox batch commit atomically. After commit, the
kit discards the exact pending batch because there is no saved row to observe.
The identity map is tombstoned immediately, so the same identity cannot be
loaded or re-registered later in that run.

Bulk retention cleanup is a different port. Do not hydrate thousands of
aggregates only to delete rows with no business decision. Define an
infrastructure capability such as `ExpiredOrderPurger.purgeExpired(before)`
and keep its bounded, predicated statement outside the aggregate repository.

## Query methods and specifications

Keep adapter-native query languages out of the port:

```ts
interface InvoiceRepository
  extends AggregatePersistence<Invoice, InvoiceId> {
  findDunningCandidates(
    criteria: DunningCriteria,
    page: DunningPageRequest,
  ): Promise<DunningCandidatePage>;
}
```

A multi-result method needs a stable total order and a hard page bound. If the
result serves a screen or report, use a read-model query instead of loading
write-side aggregates.

When a criterion is genuinely domain language, a `Specification` can carry it:

```ts
class OverdueInvoice extends Specification<Invoice> {
  readonly name = "overdue invoice";

  constructor(readonly today: Date) {
    super();
  }

  isSatisfiedBy(invoice: Invoice): boolean {
    return invoice.status === "open" && invoice.dueDate < this.today;
  }
}
```

An in-memory adapter evaluates it directly. A database adapter translates
known specification types to bounded SQL. Test both paths against the same
fixtures so the predicate and translation cannot drift unnoticed.

## Identity and errors

Generate identities in the application before creating the aggregate. UUID
v4/v7, ULID, KSUID, or another collision-resistant generator works across
concurrent processes; `Date.now()` and process-local counters do not.

Repository failures are specific infrastructure signals:

- `AggregateNotFoundError`: `getById` found no aggregate;
- `DuplicateAggregateError`: `add` collided with an existing identity;
- `ConcurrencyConflictError`: a stale `update` or `remove` lost its OCC race.

A concurrency conflict is retryable only as a new application operation:
reload, reapply the command, and register the new write. A duplicate add is
deterministic for that identity and should not be retried unchanged.

## Certification

Run `createRepositoryContractTests` or
`createEsRepositoryContractTests` against the real adapter and database. The
suites cover explicit lifecycle routing, identity maps, duplicate creation,
stale writers, rollback, no-op writes, exact event batches, outbox atomicity,
and physical removal where declared.

```ts
for (const contract of createRepositoryContractTests(harness)) {
  (contract.skipped ? it.skip : it)(contract.name, contract.run);
}
```

Keep capability skips visible. They record a guarantee the adapter does not
yet prove.

For the breaking cutover from v2.2 or an earlier v3 release candidate, follow
[Migrating to v3](/guide/migrating-to-v3).
