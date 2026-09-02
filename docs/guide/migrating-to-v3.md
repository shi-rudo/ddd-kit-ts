# Migrating to v3

The v3 persistence change is a change in responsibility, not a method rename.
Aggregates no longer remember what a database last stored. Repository writes
no longer guess whether to insert or update. One `UnitOfWork` owns the load
receipt, the explicit write intent, the exact state change, and the exact event
batch for an application operation.

This migration has no automatic codemod or deprecated compatibility aliases. A
tool can rename `save`. It cannot select `add` or `update` from the use-case
intent. The compiler makes each decision visible.

## What remains reusable

This is primarily a source and orchestration break. Correctly stored business
state, aggregate versions, event streams, outbox records, and compatible
snapshot DTOs remain valid unless your own persistence schema changes.

The redesign does not require renaming tables, rewriting event history, or
resetting versions. It changes who holds the expected version and when a write
can occur.

Snapshots need special attention because their policy moved out of aggregate
methods. If the stored DTO is still compatible, describe its existing shape
with a `SnapshotModel`. Do not rewrite it only because the API moved.

## The new ownership model

The old flow mixed four responsibilities:

```ts
const order = await orders.getById(orderId);
order.confirm();
await orders.save(order);
```

The repository inspected aggregate persistence metadata to choose insert or
update. Some repositories also enrolled events manually.

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
class Order extends StateStoredAggregate<OrderState, OrderId, OrderEvent> {
  static create(id: OrderId, customerId: CustomerId): Order {
    return new Order(id, initialOrderState(customerId));
  }

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

Reconstitution restores valid domain state and the current version without
recording a new decision. Remove domain code that reads `persistedVersion`,
`hasChanges`, or `changedKeys`. Those members no longer exist.

`markReconstituted` accepts only a clean instance at a version not above the
restored one. A factory that calls `setState` before `markReconstituted` puts the
instance at version 1 first, so a row stored at version 0 fails with
`InvalidVersionError`. A constructor that records a creation event fails
with `UnreplayableAggregateError` on every load. Pass the stored state
through the constructor, and record creation events in the business factory
only. See
[Aggregates -> State-Stored Aggregates](./aggregates.md#state-stored-aggregates).

For event-sourced aggregates, keep a bare factory and load accepted history
with `replayHistory`. A clean reconstituted aggregate can load a later tail
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

If physical removal is part of this persistence boundary, use
`Repository<Order, OrderId>`. It extends `AggregatePersistence` with `remove`.

A secondary-key finder like `findByNumber` reads the storage state from
before the run: durable I/O happens at flush, after the use case returned,
and only `findById` is covered by the identity map. v2 code that saved an
aggregate and re-read it by a secondary key in the same operation must
branch on the tracked instance instead. See the unit-of-work guide, "Reads
do not see registered writes".

The public method changes are:

| Before | v3 | Meaning |
| --- | --- | --- |
| `save(newAggregate)` | `add(newAggregate)` | insert a new identity |
| `save(loadedAggregate)` | `update(loadedAggregate)` | OCC update of the loaded instance |
| `delete(loadedAggregate)` | `remove(loadedAggregate)` | physical persistence removal |

Do not convert a business action named “delete” mechanically to `remove`.
Most such actions are `cancel`, `archive`, `close`, `revoke`, or `expire` on
the aggregate, followed by `update`. If persistence really loses the identity,
use `remove`.

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
single `save` method. It hides the decision that this migration must
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

1. Read `tracking.identityMap` before storage.
2. Honor its removal tombstone.
3. Reconstitute the aggregate.
4. Return `tracking.trackLoaded(aggregate)`.

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

- Insert unconditionally for that identity.
- Map a uniqueness violation to `DuplicateAggregateError`.
- Do not turn the insert into an upsert.

For `update`:

- Write `write.version`.
- Use `write.expectedVersion` in the predicate.
- Map zero affected rows to `ConcurrencyConflictError`.
- Do not use insert as a fallback.

For `remove`:

- If removal races matter, use `write.expectedVersion` in the predicate.
- Map zero affected rows to `ConcurrencyConflictError`.
- Keep removal and its event/outbox batch in the same transaction.

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
`order.replayHistory`. Snapshot timing, DTO mapping, schema migration,
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
suite must prove these properties:

- A duplicate add does not overwrite data.
- A stale update or removal does not commit.
- The state write or stream append rolls back with the outbox write.
- The identity map returns one instance.
- Event batches are exact and ordered.
- No-op, state-only, event-only, and nested changes use their correct paths.
- A test skip identifies each unsupported optional capability.

Then run the package typecheck, lint, tests, build, and documentation build.

## Production cutover: one coordinated switch

Do not run v2 and v3 writers against the same bounded-context persistence at
the same time. Their source protocols differ, and a mixed deployment makes it
unclear which process owns the expected version and exact event batch.

Use a Big-Bang writer cutover per bounded context:

1. Deploy backward-compatible schema changes. The kit redesign requires no
   schema change.
2. Make sure that all repository contract suites pass against the staging
   infrastructure.
3. Make a database and event-store backup. Make sure that the restore procedure
   works.
4. Pause incoming commands and message consumers that can write the bounded
   context.
5. Let active transactions finish. Stop all v2 and earlier-RC writers.
6. Record the current database, stream, and outbox health: pending counts,
   latest versions, dead letters, and replication lag.
7. Deploy the v3 writers.
8. Start one controlled canary writer.
9. Exercise creation, update, conflict, event dispatch, and supported physical
   removal.
10. Make sure that row and stream versions are correct.
11. Make sure that the outbox, projections, duplicate protection, and error
    rates are correct.
12. Start the remaining writers.
13. Reopen traffic.

If their data decoding remains compatible, read-only v2 processes can overlap.
They must perform no acknowledgements or writes. Treat any process
that updates a checkpoint, lease, outbox record, or aggregate as a writer.

## Rollback boundary

Before the first v3 write, keep writers stopped and deploy the previous
version. This rollback does not require data recovery.

After the first v3 write, there is no supported in-place downgrade to v2 or an
earlier release candidate. Restore the pre-cutover backup and reconcile any
accepted commands, or fix forward on v3. This boundary is intentional. The
new code can commit event and outbox batches under guarantees that the old
writer does not understand.

Plan the cutover so the backup, command pause, and fix-forward ownership are
explicit. “We can always roll back the binary” is not a data rollback plan.

## Unsupported migration shortcuts

The following are deliberately unsupported:

- An automatic codemod for `save`.
- Deprecated aliases for removed persistence APIs.
- A repository that accepts both `save` and `add`/`update`.
- Mixed v2 and v3 writers for one bounded context.
- Attachment of detached aggregates without a fresh load.
- In-place downgrade after the first v3 write.

These restrictions keep one persistence model in the codebase. They also make
mistakes compiler-visible instead of preserving ambiguous behavior behind a
shim.

## Appendix: v3.0.0-rc.1 to rc.2 or later

If you adopted `3.0.0-rc.1`, the stored business data is still reusable, but
the source break is broader than the v2.2 repository rename:

- Remove `persistedVersion`, `hasChanges`, and `changedKeys` reads.
- Remove aggregate `createSnapshot*`, `restoreFromSnapshot*`,
  `snapshotSchemaVersion`, `toSnapshotState`, `fromSnapshotState`, and
  `migrateSnapshotState` overrides.
- Replace `UnitOfWorkSession` factories with `defineRepository` definitions.
- Declare a capability-named application repository port. Pass it explicitly
  as `defineRepository<ForStoringOrders>()`.
- Make adapter `create` paths read-only. Call `tracking.trackLoaded`.
- Move insert, update, and removal SQL into `flush`.
- Add `mapError` to every definition. Do not expose ORM or driver errors to the
  application.
- Replace manual `enrollSaved` and `enrollDeleted` calls with
  application-facing `add`, `update`, and `remove`.
- Move dirty detection to `PersistenceModel`.
- Move snapshot DTOs and migration to `SnapshotModel`.
- Use the new repository contract harnesses.

Do not carry an rc.1 compatibility layer into the next candidate. Upgrade all
writers for the bounded context together. Use the same cutover procedure. Keep
the backup until the post-deployment checks are complete.



## Appendix: v3.0.0-rc.2 to rc.3 or later

Stored business data stays reusable. The source break is narrow and comes
from four review rounds on the persistence redesign:

- Remove uses of the deleted names: the `DomainEventFacts` and
  `CreateDomainEventFactsOptions` aliases, the factory `createFacts` member,
  the aggregate `recordEvent` and `recordEventFromFactory` helpers, and
  `AggregateConfig.domainEventFactory`. Use `createEvent` in the aggregate
  and `recordPendingEvents` in the shell, or `createDomainEventFromFacts`
  when the caller owns identity and time.
- Update error handling that matched `error.name` on
  `DomainEventValidationError` or `SnapshotTimeValidationError`: `name` now
  equals `code`, like every other kit error. Code-based matching does not
  change.
- Reconstitution factories must call `markReconstituted(version)` on a clean
  instance whose version is not above `version`. The snapshot restore path
  enforces the version post-condition and rejects a factory that ignores it.
- A `PersistenceModel.capture` must be deterministic for an unchanged
  aggregate. A capture that rebuilds object Set members or Map keys per
  call supplies the optional `captureEquals`.
- Run one kit version per process during the cutover. The internal
  capability registry keys changed with the capability shape, so an
  aggregate built by an rc.2 copy fails enrollment under an rc.3 copy with
  `UnmanagedInstanceError` (code `UNMANAGED_INSTANCE`).

Behavior changes that need no code change: a repeated `remove` of the same
instance is an accepted no-op, and a repeated enrollment without
`expectedVersion` makes no OCC assertion.

## Appendix: v3.0.0-rc.3 to rc.4 or later

There is no source break. No name changes, no signature changes. The
candidate corrects behavior on the event and delivery periphery. Read
this list if your code observes one of these paths:

- `InMemoryOutbox.add` rejects the whole batch before the first insert
  when one candidate carries a stale head position. Before, it inserted
  the earlier candidates first and rejected late. Exact retries still
  deduplicate.
- `EventBus.publish` throws an `AggregateError` when the time budget
  expires after handler failures. The abort error is the first element,
  the handler failures follow. Before, the abort error surfaced alone and
  the failures were lost. Code that matches the bare abort error reads it
  from `errors[0]`.
- The deadline processor counts the expiry of its own delivery budget as
  a failed attempt. A handler that ignores `context.signal` reaches the
  dead letter after `maxAttempts`. Before, it retried forever.
- `defineSnapshotModel` rejects a model whose members live on a
  prototype, for example a class instance. Before, the definition passed
  and the first snapshot write failed.
- `run()` rethrows the caller's abort reason unchanged when cancellation
  interrupts a retry wait. Before, the abort surfaced as
  `ROLLBACK_FAILED` with a retryable cause.
- `withIdempotentCommit` abandons the staged claim when the commit
  fails. The key is free for a retry. Before, the key stayed blocked
  until lease expiry.
- `InMemoryEventStore` clones events on append and on read. A mutation
  of a read event does not change stored history. Test doubles that
  relied on shared references see copies now.

## Appendix: v3.0.0-rc.4 to rc.5 or later

Source breaks at the entry points, on the event bus port, and in the
aggregate vocabulary. The vocabulary renames are mechanical; the sections
[One lifecycle vocabulary](#one-lifecycle-vocabulary) and [Folds](#folds)
list them with the commands that apply them.

### The `utils` entry point is gone

```ts
// before
import { deepEqual, deepEqualExcept, deepOmit } from "@shirudo/ddd-kit/utils";

// after
import { deepEqual, deepEqualExcept, deepOmit } from "@shirudo/ddd-kit";
```

The four types travel with the functions: `DeepEqualExceptOptions`,
`DeepOmitKey`, `DeepOmitOptions` and `DeepOmitPathSegment`.

### The `presentation` entry point is now `public-errors`

The names it exports stay the same. The old name said where the code
lived, not what the entry point gives.

```ts
// before
import { toPublicErrorView } from "@shirudo/ddd-kit/presentation";

// after
import { toPublicErrorView } from "@shirudo/ddd-kit/public-errors";
```

The `money`, `http` and `testing` entry points keep their names. Each of
them carries symbols that the root entry deliberately omits, so none of
them duplicates anything.
### The event bus has a lifecycle

`EventBus` gained `close()` and `subscribeMany()`. Every implementation of the
port and every test double needs both.

Before:

```ts
const bus: EventBus<OrderEvent> = {
  publish: async () => {},
  subscribe: () => () => {},
  subscribeAll: () => () => {},
  once: () => new Promise(() => {}),
};
```

After:

```ts
const bus: EventBus<OrderEvent> = {
  publish: async () => {},
  subscribe: () => () => {},
  subscribeAll: () => () => {},
  once: () => new Promise(() => {}),
  subscribeMany: () => () => {},
  close: () => {},
};
```

Call it when the scope that owns the bus ends. After the call, `publish`,
`subscribe`, `subscribeAll` and `once` throw `EventBusClosedError`, and a
pending `once()` rejects instead of waiting for an event that cannot arrive.
Closing releases the subscriptions. It does not stop a handler that is already
running.

### One lifecycle vocabulary

One term per lifecycle step, and the same generic order on both aggregate
flavours. No behavior changes; every rename is a one-to-one replacement.

| Before | After |
| --- | --- |
| `AggregateRoot` (class) | `StateStoredAggregate` |
| `IAggregateRoot` (contract) | `Aggregate` |
| `IEventSourcedAggregate` (contract) | `ReplayableAggregate` |
| `EventSourcedAggregate<TState, TEvent, TId>` | `EventSourcedAggregate<TState, TId, TEvent>` |
| `commit(newState, events)` | `setState(newState, events)` |
| `loadFromHistory(history)` | `replayHistory(history)` |
| `markRestored(version)` | `markReconstituted(version)` |
| `stampNewEventAddress(event)` | `addressNewEvent(event)` |
| `DomainEvent.version`, option `version` | `schemaVersion` |

Apply the class and contract renames with one command over your
TypeScript sources; the order matters, because the contract takes the
name the class gave up:

```sh
perl -pi \
  -e 's/\bAggregateRoot\b/StateStoredAggregate/g;' \
  -e 's/\bIAggregateRoot\b/Aggregate/g;' \
  -e 's/\bIEventSourcedAggregate\b/ReplayableAggregate/g;' \
  $(git ls-files '*.ts')
```

Apply the method renames with one command over your TypeScript sources:

```sh
sed -i '' \
  -e 's/this\.commit(/this.setState(/g' \
  -e 's/loadFromHistory/replayHistory/g' \
  -e 's/markRestored/markReconstituted/g' \
  -e 's/stampNewEventAddress/addressNewEvent/g' \
  $(git ls-files '*.ts')
```

Then run the compiler. It flags every `EventSourcedAggregate` subclass
whose type arguments are in the old order; swap the second and the third
argument. It also flags every read of `event.version` and every event
literal with a `version` field; rename them to `schemaVersion`. Do not
touch the `version` field of an `IntegrationMessage` or a
`CommandMessageContent`: those are wire contracts, and the boundary mappers
translate between `schemaVersion` and `version`.

`commit` is the transaction term only: `withCommit`, `committedVersion`,
`CommittedDomainEvent`. `setState(newState)` without events is unchanged.

### Folds

The state function of an event-sourced aggregate is a fold, and the kit
names it so. "Handler" stays the term for command handlers, query handlers,
projection handlers, and bus subscribers. No behavior changes.

| Before | After |
| --- | --- |
| `protected readonly handlers = { ... }` | `protected readonly folds = { ... }` |
| `MissingHandlerError` from `apply()` or replay | `MissingFoldError` (code `MISSING_FOLD`) |
| `HandlerReturnedNoStateError` (code `HANDLER_RETURNED_NO_STATE`) | `FoldReturnedNoStateError` (code `FOLD_RETURNED_NO_STATE`) |

Apply the member rename and the class rename with one command over your
TypeScript sources:

```sh
perl -pi \
  -e 's/\breadonly handlers\b/readonly folds/g;' \
  -e 's/\bHandlerReturnedNoStateError\b/FoldReturnedNoStateError/g;' \
  -e 's/\bHANDLER_RETURNED_NO_STATE\b/FOLD_RETURNED_NO_STATE/g;' \
  $(git ls-files '*.ts')
```

Then run the compiler. It flags every event-sourced aggregate that still
declares `handlers`, and every catch that names the removed class.
`MissingHandlerError` still exists for `projectionFromHandlers`, so the
compiler does not flag it: search for `MissingHandlerError` and
`MISSING_HANDLER` and change the sites that guard an aggregate to
`MissingFoldError` and `MISSING_FOLD`.
