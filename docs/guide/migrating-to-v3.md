# Migrating to v3

The v3 persistence change is a change in responsibility, not a method rename.
Aggregates no longer remember what a database last stored. Repository writes
no longer guess whether to insert or update. One `UnitOfWork` owns the load
receipt, the explicit write intent, the exact state change, and the exact event
batch for an application operation.

That is why this migration has no automatic codemod and no deprecated
compatibility aliases. A tool can rename `save` to something, but it cannot
know whether that call means “insert this new aggregate” or “update the
instance loaded by this operation.” The compiler should make every such
decision visible to you.

## What remains reusable

This is primarily a source and orchestration break. Correctly stored business
state, aggregate versions, event streams, outbox records, and compatible
snapshot DTOs remain valid unless your own persistence schema changes.

The redesign does not require renaming tables, rewriting event history, or
resetting versions. It changes who holds the expected version and when a write
is allowed to execute.

Snapshots need special attention because their policy moved out of aggregate
methods. If the stored DTO is still compatible, describe its existing shape
with a `SnapshotModel`; do not rewrite it merely because the API moved.

## The new ownership model

The old flow mixed four responsibilities:

```ts
const order = await orders.getById(orderId);
order.confirm();
await orders.save(order);
```

The repository inspected aggregate persistence metadata to choose insert or
update. It might also enroll events manually.

The v3 flow is explicit:

```ts
await new UnitOfWork(deps).run(async ({ repositories }) => {
  const order = await repositories.orders.getById(orderId);

  order.confirm();
  recordPendingEvents(order, domainEvents);
  repositories.orders.update(order);
});
```

Loading captures the expected version in the unit of work. `update` seals the
adapter's change set and pending-event batch. `flush` later performs the state
write or stream append inside the same transaction as the outbox.

## Migrate in this order

Do the source migration on a branch while v2 writers continue serving
production. The actual deployment is a short, coordinated cutover described
later.

### 1. Make aggregate reconstitution explicit

Keep business factories for new aggregates. Add or retain a separate factory
for persisted facts:

```ts
class Order extends AggregateRoot<OrderState, OrderId, OrderEvent> {
  static create(id: OrderId, customerId: CustomerId): Order {
    return new Order(id, initialOrderState(customerId));
  }

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

Reconstitution restores valid domain state and the current version without
recording a new decision. Remove domain code that reads `persistedVersion`,
`hasChanges`, or `changedKeys`; those members no longer exist.

For event-sourced aggregates, keep a bare factory and load accepted history
with `loadFromHistory`. A clean reconstituted aggregate may load a later tail
additively.

### 2. Replace repository contracts

Replace `IRepository` and `IUnitOfWorkRepository` with one of the explicit v3
contracts:

```ts
interface OrderRepository
  extends AggregatePersistence<Order, OrderId> {
  findByNumber(number: OrderNumber): Promise<Order | undefined>;
}
```

Use `Repository<Order, OrderId>` only when physical removal is part of this
persistence boundary. It extends `AggregatePersistence` with `remove`.

The public method changes are:

| Before | v3 | Meaning |
| --- | --- | --- |
| `save(newAggregate)` | `add(newAggregate)` | insert a new identity |
| `save(loadedAggregate)` | `update(loadedAggregate)` | OCC update of the loaded instance |
| `delete(loadedAggregate)` | `remove(loadedAggregate)` | physical persistence removal |

Do not convert a business action named “delete” mechanically to `remove`.
Most such actions are `cancel`, `archive`, `close`, `revoke`, or `expire` on
the aggregate, followed by `update`. Use `remove` only when persistence really
loses the identity.

### 3. Move every write use case into `UnitOfWork.run`

Repository writes are valid only through the application-facing facade:

```ts
await new UnitOfWork(deps).run(async ({ repositories }) => {
  const order = Order.create(newOrderId(), customerId);
  order.addItems(items);
  recordPendingEvents(order, domainEvents);

  repositories.orders.add(order);
});
```

```ts
await new UnitOfWork(deps).run(async ({ repositories }) => {
  const order = await repositories.orders.getById(orderId);
  order.addItems(items);
  recordPendingEvents(order, domainEvents);

  repositories.orders.update(order);
});
```

Let TypeScript find every removed `save` and `delete` call. Decide each site
from the use case's lifecycle. Do not add a temporary wrapper that restores a
single `save` method; it hides precisely the decision this migration needs to
surface.

Make all domain decisions before the final registration call. Mutating the
aggregate after `add`, `update`, or `remove` is now a deterministic wiring
error.

### 4. Split read adapters from commit-time writes

An adapter definition creates a transaction-bound read adapter:

```ts
interface ForStoringOrders
  extends AggregatePersistence<Order, OrderId> {}

const orders = defineRepository<ForStoringOrders>()({
  aggregate: Order,
  persistence: orderPersistence,
  create: (tx: DrizzleTx, tracking: RepositoryTracking<Order>) =>
    new OrderReadAdapter(tx, tracking),
  flush: (tx: DrizzleTx, write) => flushOrder(tx, write),
  mapError: mapOrderPersistenceError,
});
```

On every successful load:

1. check `tracking.identityMap`;
2. honor its removal tombstone;
3. reconstitute the aggregate;
4. return `tracking.trackLoaded(aggregate)`.

Delete adapter-side manual enrollment. Application code cannot see the
tracking capability or raw transaction, and adapter `add`/`update`/`remove`
methods are not the durable write path.

### 5. Define the adapter's baseline and change set

Move persistence projection and dirty detection into a `PersistenceModel`:

```ts
const orderPersistence: PersistenceModel<
  Order,
  OrderRow,
  OrderRow | undefined
> = {
  capture: (order) => rowFor(order),
  changes: (baseline, order, lifecycle) => {
    const current = rowFor(order);
    return lifecycle === "loaded" && deepEqual(baseline, current)
      ? undefined
      : current;
  },
  isEmpty: (change) => change === undefined,
};
```

Choose the change-set shape that matches the adapter. A document adapter can
return a full replacement. A relational adapter can return root-column and
child-row changes. An event-store adapter can use the aggregate version as its
small baseline and write the registered event batch.

The baseline is opaque outside the adapter capability. Do not put its fields
back on the aggregate under new names.

### 6. Implement explicit flush routing and OCC

`flush` receives a sealed `AggregatePersistenceWrite`.

For `add`:

- insert unconditionally for that identity;
- map a uniqueness violation to `DuplicateAggregateError`;
- never turn the insert into an upsert.

For `update`:

- write `write.version`;
- predicate on `write.expectedVersion`;
- map zero affected rows to `ConcurrencyConflictError`;
- never fall back to insert.

For `remove`:

- predicate on `write.expectedVersion` when removal races matter;
- map zero affected rows to `ConcurrencyConflictError`;
- keep removal and its event/outbox batch in the same transaction.

For event sourcing, append `write.events` with
`expectedVersion: write.expectedVersion ?? 0`. Do not re-read
`aggregate.pendingEvents` during flush.

### 7. Move snapshots to `SnapshotModel`

Replace aggregate-owned snapshot methods:

```ts
const orderSnapshots = defineSnapshotModel({
  aggregateType: "Order",
  schemaVersion: 2,
  capture: (order: Order) => orderSnapshotDto(order),
  migrate: migrateOrderSnapshot,
  reconstitute: (id, dto, version) =>
    Order.reconstitute(id, orderStateFromSnapshot(dto), version),
});
```

Capture at an application-supplied time:

```ts
const snapshot = captureAggregateSnapshot(orderSnapshots, order, clock());
await snapshotStore.save(address, snapshot);
```

Load by creating a fresh aggregate:

```ts
const order = reconstituteAggregateFromSnapshot(
  orderSnapshots,
  orderId,
  snapshot,
);
```

For event sourcing, pass the events after `snapshot.version` to
`order.loadFromHistory`. Snapshot timing, DTO mapping, schema migration,
storage, and fallback-to-full-replay now belong to the adapter or application
shell.

### 8. Run the contract suites against real infrastructure

Run the state-stored or event-sourced suite for every adapter:

```ts
for (const contract of createRepositoryContractTests(harness)) {
  (contract.skipped ? it.skip : it)(contract.name, contract.run);
}
```

Do this against the database and transaction wiring used in production. The
suite must prove:

- duplicate add does not overwrite;
- stale update and stale removal do not commit;
- aggregate state or stream append and outbox write roll back together;
- identity mapping returns one instance;
- event batches are exact and ordered;
- no-op, state-only, event-only, and nested-state changes behave honestly;
- unsupported optional capabilities remain visible as skips.

Then run the package typecheck, lint, tests, build, and documentation build.

## Production cutover: one coordinated switch

Do not run v2 and v3 writers against the same bounded-context persistence at
the same time. Their source protocols differ, and a mixed deployment makes it
unclear which process owns the expected version and exact event batch.

Use a Big-Bang writer cutover per bounded context:

1. Deploy and verify any schema changes that are backward-compatible with the
   current readers. The kit redesign itself requires none.
2. Confirm all applicable repository contract suites pass against a staging
   copy of the real infrastructure.
3. Take a database and event-store backup and verify the restore procedure,
   not only the backup command.
4. Pause incoming commands and message consumers that can write the bounded
   context.
5. Let active transactions finish. Stop all v2 and earlier-RC writers.
6. Record the current database, stream, and outbox health: pending counts,
   latest versions, dead letters, and replication lag.
7. Deploy the v3 writers.
8. Start one controlled canary writer and exercise create, update, conflict,
   event dispatch, and physical removal where supported.
9. Validate row and stream versions, outbox continuity, projection progress,
   duplicate protection, and error rates.
10. Start the remaining writers and reopen traffic.

Read-only v2 processes may overlap only if their data decoding remains
compatible and they perform no acknowledgements or writes. Treat any process
that updates a checkpoint, lease, outbox record, or aggregate as a writer.

## Rollback boundary

Before the first v3 write, rollback is operationally simple: keep writers
stopped and redeploy the previous version.

After the first v3 write, there is no supported in-place downgrade to v2 or an
earlier release candidate. Restore the pre-cutover backup and reconcile any
accepted commands, or fix forward on v3. This boundary is intentional: the
new code may have committed event and outbox batches under guarantees the old
writer does not understand.

Plan the cutover so the backup, command pause, and fix-forward ownership are
explicit. “We can always roll back the binary” is not a data rollback plan.

## Unsupported migration shortcuts

The following are deliberately unsupported:

- an automatic codemod for `save`;
- deprecated aliases for removed repository or aggregate persistence APIs;
- a compatibility repository that accepts both `save` and `add`/`update`;
- mixed v2/v3 writers for one bounded context;
- attaching detached aggregates to a unit of work without a fresh load;
- in-place downgrade after the first v3 write.

These restrictions keep one persistence model in the codebase. They also make
mistakes compiler-visible instead of preserving ambiguous behavior behind a
shim.

## Appendix: v3.0.0-rc.1 to rc.2 or later

If you adopted `3.0.0-rc.1`, the stored business data is still reusable, but
the source break is broader than the v2.2 repository rename:

- remove `persistedVersion`, `hasChanges`, and `changedKeys` reads;
- remove aggregate `createSnapshot*`, `restoreFromSnapshot*`,
  `snapshotSchemaVersion`, `toSnapshotState`, `fromSnapshotState`, and
  `migrateSnapshotState` overrides;
- replace `UnitOfWorkSession` factories with `defineRepository` definitions;
- declare a capability-named application repository port and pass it explicitly
  as `defineRepository<ForStoringOrders>()`;
- make adapter `create` paths read-only and call `tracking.trackLoaded`;
- move insert/update/remove SQL into `flush`;
- add `mapError` to every definition so ORM and driver errors cannot cross the
  application boundary;
- replace manual `enrollSaved`/`enrollDeleted` calls in unit-of-work
  repositories with application-facing `add`/`update`/`remove`;
- move dirty detection to `PersistenceModel`;
- move snapshot DTOs and migration to `SnapshotModel`;
- use the new state-stored and event-sourced repository contract harnesses.

Do not carry an rc.1 compatibility layer into the next candidate. Upgrade all
writers for the bounded context together, run the same cutover checklist, and
keep the pre-cutover backup until post-deployment validation is complete.
