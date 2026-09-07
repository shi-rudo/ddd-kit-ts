# Repository

A repository is a persistence-oriented collection of aggregate roots. Its
public contract says whether an aggregate is new, loaded, or physically
removed. It does not publish events, expose ORM filters, or decide a business
lifecycle transition.

In v3 repository writes run through `UnitOfWork`. The use case calls `add`,
`update`, or `remove`. The adapter receives one immutable write receipt during
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

If this persistence boundary supports physical removal, use `Repository`:

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
class Order extends StateStoredAggregate<OrderState, OrderId, OrderEvent> {
  protected readonly aggregateType = "Order";

  static reconstitute(
    id: OrderId,
    state: OrderState,
    version: Version,
  ): Order {
    const order = new Order(id, state);
    order.markReconstituted(version);
    return order;
  }
}
```

`markReconstituted` restores the current domain version. It does not create a
persistence receipt on the aggregate and does not record events. It accepts
only a clean instance at a version not above the restored one; see
[Aggregates -> State-Stored Aggregates](./aggregates.md#state-stored-aggregates).

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

For event sourcing, build the aggregate from the first page through
`reconstituteAggregateFromHistory` and replay the rest of the pinned prefix
into it:

```ts
const first = await eventStore.readStream(address, { limit: 256 });
if (!first.exists) return undefined;
const toVersion = first.lastVersion;

const reconstituted = reconstituteAggregateFromHistory(
  () => Order.bare(id),
  first.events,
);
if (reconstituted.isErr()) throw reconstituted.error;
const order = reconstituted.value;
let fromVersion = first.events.length;

while (fromVersion < toVersion) {
  const page = await eventStore.readStream(address, {
    fromVersion,
    toVersion,
    limit: 256,
  });
  if (!page.exists || page.events.length === 0) {
    throw new NonProgressingEventStreamPageError({
      ...address,
      fromVersion,
      targetVersion: toVersion,
    });
  }

  const replay = order.replayHistory(page.events);
  if (replay.isErr()) throw replay.error;
  fromVersion += page.events.length;
}

if (order.version !== toVersion) {
  throw new ReplayHeadMismatchError({
    ...address,
    targetVersion: toVersion,
    actualVersion: order.version,
  });
}
return tracking.trackLoaded(order);
```

The full recipe with the refold fallback is in
[Event Sourcing -> Loading from history](./event-sourcing.md#loading-from-history).

Pin the first page's `lastVersion` and page toward that fixed head. This gives
the load one stable append-only prefix even if another writer appends while it
is running. Never identity-map a partly replayed aggregate.

## Adapter-owned persistence models

Different adapters persist different shapes. A relational adapter can split
one aggregate over several tables. A document adapter can replace one JSON
document. An event store writes no current-state row. The aggregate must not
carry a universal dirty-key model.

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

A full-row model can be small. It reads the aggregate through its detached
read DTO; see
[Aggregates -> Reading State from Outside](./aggregates.md#reading-state-from-outside).
The row holds a JSON-safe encoding of that DTO: `encodeOrderState` maps each
`Money` field to a `MoneyDto`, and `decodeOrderState` maps it back on load.

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
    state: encodeOrderState(order.stateDto),
    version: order.version,
  }),
  changes: (baseline, order, lifecycle) => {
    const current = {
      state: encodeOrderState(order.stateDto),
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
event-only commit can still have a non-empty `events` batch and must not be
skipped. The reverse also holds: an empty change set with a bumped
`write.version` and no events is a version-only decision, and the adapter
must still persist the new version. Skipping the write desyncs the stored
version and produces false concurrency conflicts on later updates.

Projection functions must use meaningful aggregate queries and return
detached persistence DTOs. Both `capture` and `changes` must avoid mutable
references into the aggregate. The Unit of Work cannot safely clone or freeze
an arbitrary adapter-native type. A baseline that aliases aggregate state can
move when the aggregate moves. A change set that aliases it can change after
registration. Do not add setters, baseline fields, or dirty flags to the
aggregate for the adapter's convenience.

A column that the store owns never enters the aggregate or the capture.
Examples are an `updatedAt` that the adapter or the database stamps, and a row
version that the database manages. `capture` projects domain state only.
`flush` stamps the store-owned columns when it writes. A captured store column
is a defect on both sides: the next write pushes the stale value back, and a
change set that compares it marks every row as changed. A timestamp that the
domain decides is different. The domain sets it with a clock that the use case
passes in. It is domain state, so it belongs in the aggregate and in the
capture.

## Defining the adapter boundary

`defineRepository` joins an application-owned repository port, its adapter,
persistence model, and commit-time flush. Name the port after the capability
that the use case needs. Do not expose the concrete ORM adapter as the contract.

```ts
interface ForStoringOrders extends Repository<Order, OrderId> {}

const orders = defineRepository<ForStoringOrders>()({
  aggregate: Order,
  persistence: orderPersistence,
  physicalRemoval: true,
  create: (tx: DrizzleTx, tracking: RepositoryTracking<Order>) =>
    new DrizzleOrderReadAdapter(tx, tracking),
  flush: versionedFlush({
    aggregateType: "Order",
    insert: async (tx: DrizzleTx, write) => {
      const row = requireOrderRow(write.changes);
      await tx.insert(orderTable).values({
        id: write.aggregateId,
        state: row.state,
        version: write.version,
      });
    },
    isDuplicate: isUniqueViolation,
    update: async (tx, write) => {
      const result = await tx
        .update(orderTable)
        .set({ ...write.changes.value, version: write.version })
        .where(and(
          eq(orderTable.id, write.aggregateId),
          eq(orderTable.version, write.expectedVersion),
        ));
      return result.rowsAffected;
    },
    remove: async (tx, write) => {
      const result = await tx
        .delete(orderTable)
        .where(and(
          eq(orderTable.id, write.aggregateId),
          eq(orderTable.version, write.expectedVersion),
        ));
      return result.rowsAffected;
    },
    currentVersion: (tx, id) => loadOrderVersion(tx, id),
  }),
  mapError: (error, write) => {
    if (error instanceof InfrastructureError) return error;
    return new OrderStoreUnavailableError(write.aggregateId, error);
  },
});
```

`aggregate` is the class of the aggregate root. The Unit of Work uses it as
the key of the identity map, and for nothing else. The read adapter passes the
same class to `identityMap.get(Order, id)`, so export the class. The export
does not open `new Order(...)` to callers: the base constructor is protected,
and a subclass without a constructor of its own inherits that. The static
factories stay the only way to build an instance.

The type argument is deliberately explicit. `ForStoringOrders` is the full
application port. `DrizzleOrderReadAdapter` implements only its read methods
because the Unit of Work installs `add`, `update`, and `remove`. The concrete
adapter can have diagnostics or ORM-specific helpers, but those do not become
application API. It can change without silently widening the port.

A port can have no read methods. Then `create` returns an empty object, and it
still declares the transaction parameter: `create: (_tx: DrizzleTx) => ({})`.
The type of that parameter is the transaction type that `flush` receives. Do not
invent a read that no use case needs. Check the model before you choose that
shape. A fact that follows from a state change of another aggregate is a domain
event. The event metadata carries the user id, the correlation id, and the
causation id. So an audit trail or a log of such facts is a projection of the
outbox. A write-only repository fits a fact of its own that must commit in the
same transaction.

Such a fact is often append-only: the domain never changes it after `add`. A
ledger entry or an audit record is an example. Its port declares `add` and no
`update`. Set `appendOnly: true` on the definition, and the Unit of Work
installs no `update`:

```ts
interface ForAppendingLedgerEntries {
  add(entry: LedgerEntry): void;
}

const ledgerEntries = defineRepository<ForAppendingLedgerEntries>()({
  aggregate: LedgerEntry,
  persistence: ledgerEntryPersistence,
  appendOnly: true,
  create: (_tx: DrizzleTx) => ({}),
  flush: versionedFlush({
    aggregateType: "LedgerEntry",
    insert: (tx: DrizzleTx, write) => insertLedgerEntry(tx, write),
    isDuplicate: isUniqueViolation,
  }),
  mapError: (error, write) => {
    if (error instanceof InfrastructureError) return error;
    return new LedgerStoreUnavailableError(write.aggregateId, error);
  },
});
```

An append-only definition never updates, so its statements omit `update`. The
flush above shows that shape. A definition that also sets
`physicalRemoval: true` still supplies `remove` and `currentVersion`.

The facade of an append-only repository has no `update` property. An `update`
that the adapter defines stays hidden, as every adapter-defined lifecycle
method does. `appendOnly` and `physicalRemoval` are independent: an
append-only port can declare `remove` with `physicalRemoval: true`.

The port and the options must agree. If the port declares `remove`, set
`physicalRemoval: true`. If the port has no `remove`, omit the option.
`Repository` declares `remove`; `AggregatePersistence` does not. If the port
declares `update`, omit `appendOnly`. If the port has no `update`, set
`appendOnly: true`. On a mismatch the compiler rejects the definition with an
error that names the violated constraint. The error ends with a line of this
form:

```text
Property '"defineRepository: the port declares remove, so the definition must set physicalRemoval: true"' is missing in type ...
```

A port without `add` fails with the same form of error. So does a port whose
`add`, `update`, or `remove` does not accept the aggregate of the definition.
An optional `update?` or `remove?` fails as well: the port must declare the
member as required. A port that extends `ContractRepository` from the testing
entry inherits an optional `update`, so redeclare `update` on that port. A
port that is a function type or a union fails the same way. Both options take
the literal `true`; a value typed `boolean` fails the pairing.

`mapError` is the storage boundary's last translation step. Known failures
such as `DuplicateAggregateError` and `ConcurrencyConflictError` pass through.
An unknown driver failure becomes an application-defined
`InfrastructureError`, here `OrderStoreUnavailableError`. If the mapper throws
or returns a raw value, the Unit of Work raises
`RepositoryErrorMappingFailedError` and preserves both failures for diagnosis.
That keeps ORM error types out of use cases without hiding the original cause.

### The flush and the OCC contract

The receipt's version relationship is the OCC contract:

- `add` has no `expectedVersion`. Insert a new identity. A second insert of
  the same identity is `DuplicateAggregateError`.
- `update` writes `version` and uses `expectedVersion` in the predicate.
- `remove` deletes the identity and uses `expectedVersion` when
  delete-vs-update races matter.

Zero affected rows means the optimistic-concurrency assumption was false.
That is `ConcurrencyConflictError`. A stale update never becomes an insert.

The predicate belongs to the adapter, not to the kit. The compare-and-set must
run in the same statement that writes the row. Only the store can make the
version check and the write one atomic step. The kit does not know the store,
so it cannot write that statement. The kit owns the policy instead. It captures
`expectedVersion` when the aggregate joins the Unit of Work and stamps
`version`. It defines `ConcurrencyConflictError`, and the contract suite proves
the predicate.

`versionedFlush` is that policy as code. The kit exports it from the root
entry. The adapter supplies the store statements, and the helper owns the
branches:

- `insert` runs for `add`. If it throws and `isDuplicate(error)` is true, the
  helper raises `DuplicateAggregateError` with the error as cause. Every other
  error propagates unchanged and reaches `mapError`.
- `update` and `remove` run the compare-and-set and return the count of
  affected rows. On zero rows the helper reads `currentVersion` and raises
  `ConcurrencyConflictError` with `expectedVersion` and the stored version. If
  no row exists, `actualVersion` is `-1`.
- The helper runs `update` for every update, also for an empty change set,
  because the new version must reach the store. The statement above spreads
  `write.changes.value`, so an empty change set writes the version only.

The statements follow the definition options. A definition with
`physicalRemoval: true` supplies `remove`, and a definition without it omits
`remove`. A definition with `appendOnly: true` omits `update`. A definition
that supplies `update` or `remove` also supplies `currentVersion`. A
definition that never updates or removes supplies `insert` and `isDuplicate`
only. The compiler checks the `currentVersion` pairing, and the flush rejects
statements that carry `update` or `remove` without `currentVersion` when it
is built.

A defect in the statements is a wiring error, not a store failure. The helper
raises `InvalidFlushStatementError` for it, with a `reason` that names the
defect:

- `statement_absent`: the write needs a statement that the statements do not
  carry.
- `no_row_count`: the statement returned a value that is no row count.
- `no_expected_version`: the write carries no `expectedVersion`, so it did not
  come from a loaded aggregate.
- `predicate_beyond_version`: the statement affected no row, although the
  stored version equals `expectedVersion`. The predicate holds a condition
  beyond the version, for example a tenant id, so the write can never succeed.
  Without that check the write would look like a conflict and a retry would
  repeat it forever.

`currentVersion` reports the diagnostic `actualVersion` only. The zero row
count already proves the conflict, so a failed read never replaces it: the
helper reports `actualVersion` `-1` and carries the read failure as the
conflict's cause.

The row count is the one value the helper needs from the driver, and drivers
name it differently. A libsql result reports `rowsAffected`. A mysql2 result
reports `affectedRows`. A `pg` result reports `rowCount`, which can be `null`,
so that statement returns `result.rowCount ?? 0`. The statement returns the
number, whatever the driver calls it. `isDuplicate` is driver-specific too.
Postgres reports a unique violation as SQLSTATE `23505`. SQLite reports
`SQLITE_CONSTRAINT_UNIQUE`.

Annotate the transaction on `insert`, as the example does. The other
statements take the transaction type from that annotation. The aggregate and
the change set come from the definition. Without the annotation the
transaction type is `unknown`.

The helper is the default, not the only way. A flush that does not fit its
shape stays a hand-written function. An example is a flush that writes several
tables with different predicates. The event-sourced flush below is another one.
A hand-written flush owns the same branches:

```ts
flush: async (tx: DrizzleTx, write) => {
  if (write.intent === "add") {
    try {
      await insertOrder(tx, write);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      throw new DuplicateAggregateError({
        aggregateType: "Order",
        aggregateId: write.aggregateId,
        cause: error,
      });
    }
    return;
  }

  const affectedRows = write.intent === "update"
    ? await updateOrder(tx, write)
    : await deleteOrder(tx, write);
  if (affectedRows > 0) return;

  throw new ConcurrencyConflictError({
    aggregateType: "Order",
    aggregateId: write.aggregateId,
    expectedVersion: write.expectedVersion ?? -1,
    actualVersion: await loadOrderVersion(tx, write.aggregateId) ?? -1,
  });
},
```

`updateOrder` and `deleteOrder` carry the `expectedVersion` predicate, and
`updateOrder` also runs for an empty change set. A hand-written flush never
turns a stale update into an insert.

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
work and records a fresh batch. One transaction attempt never reads a
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

Loading creates a fresh aggregate. For event sourcing, replay the tail after
`snapshot.version` on that fresh instance and check that it ends at the
stream head:

```ts
const tail = await eventStore.readStream(address, {
  fromVersion: snapshot.version,
  limit: 256,
});

const restored = reconstituteAggregateFromHistory(
  () => reconstituteAggregateFromSnapshot(orderSnapshots, orderId, snapshot),
  tail.events,
);
if (restored.isErr()) throw restored.error;
const order = restored.value;
if (order.version !== tail.lastVersion) {
  throw new ReplayHeadMismatchError({
    ...address,
    targetVersion: tail.lastVersion,
    actualVersion: order.version,
  });
}
```

This reads one page. A tail longer than the page limit fails the head check
instead of loading a truncated aggregate; the paged recipe with the pinned
head and the refold fallback is in
[Event Sourcing -> Snapshots](./event-sourcing.md#snapshots).

`captureAggregateSnapshot` supplies no hidden clock and performs no I/O. It
detaches the DTO and rejects functions, promises, errors, symbol-keyed fields,
and class instances that cannot round-trip safely. Map child entities and
value objects to persistence DTOs explicitly.

A missing stored schema version means schema `1`. A mismatch without a
`migrate` function throws `SnapshotSchemaMismatchError`. The usual event-store
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

If the row, document, or stream must disappear, use `remove`:

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
concurrent processes. `Date.now()` and process-local counters do not.

Repository failures are specific infrastructure signals:

- `AggregateNotFoundError`: `getById` found no aggregate.
- `DuplicateAggregateError`: `add` collided with an existing identity.
- `ConcurrencyConflictError`: a stale `update` or `remove` lost its OCC race.

A concurrency conflict is retryable only as a new application operation:
reload, reapply the command, and register the new write. A duplicate add is
deterministic for that identity and must not be retried unchanged.

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

An append-only port has no `update`. Set `updatesAreSupported: false` on the
harness, and the suite skips every update proof. The duplicate-add proof is
the concurrency proof that remains, so it is mandatory there. Provide
`createAggregateWithId` and keep `insertsAreDuplicateChecked`, or the proof
fails instead of skipping. Keep the default for every port with `update`: the
skipped proofs are the OCC proofs.

The suite is the only proof of the OCC predicate. A missing or wrong predicate
raises no error: the stale write succeeds, and the newer state is lost. The
suite turns that silent loss into a failing test. Bind it to every adapter you
ship.

The harness supplies `committedOutboxEvents()` and `failNextOutboxWrite()`.
Put the adapter's own outbox writer behind them, in the same transaction as
the aggregate write. The suite reads back what the outbox writer received: the
event ids of the batch, and the position facts `aggregateVersion`,
`commitSequence`, and `commitSize`. It proves that a rollback and a failed
outbox write leave no record and roll the aggregate write back. It does not
prove the source head or `previousEventfulAggregateVersion`;
`createOutboxContractTests` proves those. For an in-memory adapter, the
harness in
[`src/testing/repository-contract.test.ts`](https://github.com/shi-rudo/ddd-kit-ts/blob/main/src/testing/repository-contract.test.ts)
is the model: its outbox records live inside the store that the transaction
snapshot covers, so a rollback discards them with the rows.

The suite needs overlapping `run` calls. The stale-writer proofs hold one
transaction open while a second one loads, writes, and commits. So `run` must
give each call its own transaction and connection, and the load must not lock
the row. A single-connection embedded database cannot host the suite: the
second `run` call waits for the first one, and nothing completes. The first
proof of the suite is an environment preflight. It holds one `run` call open
and starts a second one. When the second call does not complete within one
second, the preflight fails and names the requirement. The stale-writer proofs
apply the same bound to their committing `run` call, so they fail with the same
message. Give the harness a real database with a connection pool. Keep the
embedded database for tests that do not overlap. When a second connection or
a commit needs more than one second, set `overlappingCallsBoundMs` on the
harness. A slow network is one cause. The failure path takes up to twice the
bound. Keep that, plus environment creation and teardown, below the test
timeout of the runner.

For the breaking cutover from v2.2 or an earlier v3 release candidate, follow
[Migrating to v3](/guide/migrating-to-v3).
