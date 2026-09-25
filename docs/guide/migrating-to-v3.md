# Migrating to v3

The v3 persistence change is a change in responsibility, not a method rename.
Aggregates no longer remember what a database last stored. Repository writes
no longer guess whether to insert or update. One `UnitOfWork` owns the load
receipt, the explicit write intent, the exact state change, and the exact event
batch for an application operation.

This migration has no automatic codemod or deprecated compatibility aliases. A
tool can rename `save`. It cannot select `add` or `update` from the use-case
intent. The compiler makes each decision visible.

The guide has two parts. [Migrate in this order](#migrate-in-this-order)
moves the persistence code to the new ownership model.
[Breaking changes by area](#breaking-changes-by-area) lists every other
breaking change since 2.2.0, with the 3.0.0 names. A user of a 3.0.0 release
candidate starts at the
[appendices for release candidates](#appendices-for-release-candidates).

## What remains reusable

This is primarily a source and orchestration break. Correctly stored business
state, aggregate versions, event streams, outbox records, and compatible
snapshot DTOs remain valid unless your own persistence schema changes.

The redesign does not require renaming tables, rewriting event history, or
resetting versions. It changes who holds the expected version and when a write
can occur. One schema change is the exception: an event store keys a stream
by the aggregate type and the id. The section
[Streams take the aggregate identity](#streams-take-the-aggregate-identity)
describes it.

Value objects need no change when they keep their state in `props`. Version
2.2.0 rejected a value object inside another value object; v3 accepts it again,
kept by reference. A nested value object with an own field outside `props` is
rejected; move such a field into `props` or into a getter. `voEquals` and
`deepEqual` now see the class of a value object instance: two instances of
different classes are not equal, and an instance is not equal to a plain
`{ props }` record.

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

### 1. Make aggregate reconstitution and reads explicit

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

For event-sourced aggregates, keep a bare factory. Load the accepted history
with `readStreamPages` and `reconstituteAggregateFromStreamPages`, as
[Event Sourcing -> Loading from history](./event-sourcing.md#loading-from-history)
shows.

`Entity.state` is `protected` in v3. Every `order.state.x` read outside the
aggregate no longer compiles. Replace application reads with domain queries
(`order.status`). Give the persistence adapter one detached read DTO:

```ts
class Order extends StateStoredAggregate<OrderState, OrderId, OrderEvent> {
  get stateDto(): Readonly<OrderState> {
    return deepFreeze(detachState(this.state));
  }
}
```

`detachState` throws when the state carries a class instance, a function, a
symbol, or another value a structured clone would lose, and names the field
path. A state with class-based child entities
needs an explicit mapper to plain data instead of the clone. See
[Aggregates -> Reading State from Outside](./aggregates.md#reading-state-from-outside).

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
| `delete(id)` on `IRepository`, `delete(aggregate)` on `IUnitOfWorkRepository` | `remove(loadedAggregate)` | physical persistence removal |
| `getById(id)`, returns `null` when absent | `findById(id)`, returns `undefined` when absent | load by identity |
| `getByIdOrFail(id)` | `getById(id)` | load or throw `AggregateNotFoundError` |
| `exists(id)` | a method of your own port, when a command needs it | existence query |

Rename the two load methods in three steps, because the compiler does not
flag a missed site. An old `getById` call compiles against the new throwing
`getById`: the null check becomes dead code, and absence now throws. First
rename `getByIdOrFail` to a placeholder, then rename every `getById` to
`findById`, then rename the placeholder to `getById`. Then replace each
`=== null` check on a `findById` result with `=== undefined`.

Do not convert a business action named “delete” mechanically to `remove`.
Most such actions are `cancel`, `archive`, `close`, `revoke`, or `expire` on
the aggregate, followed by `update`. If persistence really loses the identity,
use `remove`. Id-only bulk cleanup has no method on an aggregate repository.
Keep it in an adapter-side maintenance component, or give it a port of its
own, for example `ExpiredOrderPurger.purgeExpired(before)`.

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

The work context of `run` no longer carries `rawTransaction` or `session`.
A use case sees its repositories and the cancellation `signal`. The
transaction and the tracking capability go to the repository definition
only.

### 4. Split read adapters from commit-time writes

`UnitOfWorkDeps.repositories` takes repository definitions in place of the
`RepositoryFactories` functions. An adapter definition creates a
transaction-bound read adapter:

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

Delete adapter-side manual enrollment. `UnitOfWorkSession` with its
`enrollSaved` and `enrollDeleted` is gone. Application code cannot see the
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
  capture: (order) => ({ state: order.stateDto, version: order.version }),
  changes: (baseline, order, lifecycle) => {
    const current = { state: order.stateDto, version: order.version };
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

`flush` receives a sealed `AggregatePersistenceWrite`. It carries the intent,
`aggregateIdentity`, `expectedVersion`, `version`, the change set, and the
event batch. `versionedFlush` builds a flush from your store statements and
owns the branches below. The
[repository guide](./repository.md#the-flush-and-the-occ-contract) shows it.

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

For event sourcing, append `write.events` to `write.aggregateIdentity` with
`expectedVersion: write.expectedVersion ?? 0`. Do not re-read
`aggregate.pendingEvents` during flush.

### 7. Move snapshots to `SnapshotModel`

Replace aggregate-owned snapshot methods: `createSnapshot`,
`restoreFromSnapshot`, `restoreFromSnapshotWithEvents`,
`snapshotSchemaVersion`, `toSnapshotState`, `fromSnapshotState`, and
`migrateSnapshotState`. The aggregate classes lose their `TSnapshotState`
type parameter.

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
await snapshotStore.save(order.aggregateIdentity, snapshot);
```

Load by creating a fresh aggregate:

```ts
const order = reconstituteAggregateFromSnapshot(
  orderSnapshots,
  orderId,
  snapshot,
);
```

For event sourcing, read the events after `snapshot.version` with
`readStreamPages` and replay them onto the restored aggregate with
`reconstituteAggregateFromStreamPages`. See
[Event Sourcing -> Snapshots](./event-sourcing.md#snapshots). Snapshot
timing, DTO mapping, schema migration, storage, and fallback-to-full-replay
now belong to the adapter or application shell.

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

The v3 suites replace the 2.2.0 harnesses under the same names. They are not
a compatibility layer for the `save`/`delete` protocol. Their failure
messages start with "Contract violated:" and "Contract test skipped:".
Update a log search or a snapshot test that matched the old
"Repository contract" prefixes.

Then run the package typecheck, lint, tests, build, and documentation build.

## Breaking changes by area

This part lists every breaking change since 2.2.0 outside the persistence
steps above, with the 3.0.0 names. The compiler finds most of them. Where it
does not, the section says so and names the search that finds the sites.

### Errors

#### Match an error on its code

Every kit error carries a stable `code`, and `error.name === error.code`. The
class name is no longer in `error.name`. The union `KitErrorCode` lists
every code the kit produces. The compiler does not flag a string comparison
on `error.name`; search for `.name ===` and `.name ==`.

```ts
// before
if (error.name === "ConcurrencyConflictError") retry();

// after
if (error.code === "CONCURRENCY_CONFLICT") retry();
```

`instanceof DomainError`, `instanceof InfrastructureError`, `retryable`, and
`cause` work as before. The toolbox of `@shirudo/base-error` (`matchError`,
`isStructuredError`, the public-error pipeline) works on every kit error, but
the kit does not require it.

#### A subclass passes its code in an options object

A subclass of `DomainError` or `InfrastructureError` passes `code` and
`message` in one options object. The base class sets `category`, and
`retryable` defaults to `false`.

```ts
// before
class OrderAlreadyShippedError extends DomainError {
  constructor(id: string) {
    super(`Order ${id} is already shipped`);
  }
}

// after
class OrderAlreadyShippedError extends DomainError<"ORDER_ALREADY_SHIPPED"> {
  constructor(id: string) {
    super({
      code: "ORDER_ALREADY_SHIPPED",
      message: `Order ${id} is already shipped`,
    });
  }
}
```

#### Kit errors carry the aggregate identity

An aggregate id is unique only within its aggregate type. Every kit error
that names one aggregate carries one `identity` field of the shape
`{ aggregateType, aggregateId }`, and every kit message renders it as
`Type(id)`. Every kit error takes an options object.

| Before | After |
| --- | --- |
| `new ConcurrencyConflictError({ aggregateType, aggregateId, expectedVersion, actualVersion })` | `new ConcurrencyConflictError({ identity, expectedVersion, reason, actualVersion })` |
| `new AggregateNotFoundError({ aggregateType, id })` | `new AggregateNotFoundError({ identity })` |
| `new DuplicateAggregateError({ aggregateType, aggregateId })` | `new DuplicateAggregateError({ identity })` |
| `new AggregateDeletedError(aggregateId)` | `new AggregateDeletedError({ identity })` |
| `new UnenrolledChangesError(aggregateId)` | `new UnenrolledChangesError({ identity })` |
| `new UnreplayableAggregateError(aggregateId, reason)` | `new UnreplayableAggregateError({ identity, reason })` |
| `error.aggregateType`, `error.aggregateId` | `error.identity.aggregateType`, `error.identity.aggregateId` |
| `error.id` on `AggregateNotFoundError` | `error.identity.aggregateId` |

An aggregate passes its own identity as `order.aggregateIdentity`. A flush
passes `write.aggregateIdentity`. The log object of a serialized error
carries the nested `identity`.

#### A concurrency conflict names its reason

`ConcurrencyConflictError` requires a `reason` of type
`ConcurrencyConflictReason`:

- `stale_version`: the aggregate is stored at another version, and
  `actualVersion` carries it.
- `version_unchanged`: the write matched nothing although the stored version
  equals the expected one.
- `aggregate_absent`: the aggregate no longer exists.
- `version_unknown`: the version read failed, and the failure is the cause.

`actualVersion` is `number | null`. It is required for `stale_version` and
`version_unchanged` and is `null` for the other two. The `-1` sentinel is
gone. `retryable` follows the reason: `version_unchanged` is not retryable,
because a retry repeats a defect of the adapter. A state-stored flush does
not classify the conflict by hand. `versionedFlush` names the reason, and a
hand-written flush throws the result of `classifyConcurrencyConflict`, which
applies the same rule. An `EventStore.append` adapter raises the conflict
itself: it passes `reason: "stale_version"` with the stream head as
`actualVersion`, where it used `-1` for a missing stream before. A stream
that was never created is at version 0. The unit of work adds the `intent`
of the write.

#### `toProblemDetails` returns a result object

`toProblemDetails` delegates to `toProblem` of `@shirudo/base-error` and
returns `{ status, headers, body, outcome }`. The field issues are under
`details.issues`, and the body carries the public `code`. The `member` option
and the `ValidationProblemMember` type are gone.

```ts
// before
return Response.json(toProblemDetails(error), { status: 422 });

// after
const problem = toProblemDetails(error);
return Response.json(problem.body, {
  status: problem.status,
  headers: problem.headers,
});
```

A client reads the issues from `details.issues` instead of `errors`.

#### `toPublicErrorView` resolves the locale

`toPublicErrorView` moved to the `@shirudo/ddd-kit/public-errors` entry point
(see [Entry points](#entry-points-and-platform)). It returns the
`LocalizedPublicError` of `@shirudo/base-error`. The `locale` option is a
preference. The view carries the locale that resolved, so
`locale: "de-DE"` with the built-in English messages yields `locale: "en"`.
`createKitPublicErrors()` builds a catalog of the kit codes that you extend
at the composition root.

### Aggregates and entities

#### One lifecycle vocabulary

One term per lifecycle step, and the same generic order on both aggregate
classes. Every rename is a one-to-one replacement.

| Before | After |
| --- | --- |
| `AggregateRoot` (class) | `StateStoredAggregate` |
| `IAggregateRoot` (contract) | `Aggregate` |
| `IEventSourcedAggregate` (contract) | `ReplayableAggregate` |
| `AggregateRoot<TState, TId, TEvent, TSnapshotState>` | `StateStoredAggregate<TState, TId, TEvent>` |
| `EventSourcedAggregate<TState, TEvent, TId, TSnapshotState>` | `EventSourcedAggregate<TState, TId, TEvent>` |
| `commit(newState, events)` | `setState(newState, events)` |
| `loadFromHistory(history)` | `replayHistory(history)` |
| `markRestored(version)` | `markReconstituted(version)` |
| `protected readonly handlers` on an event-sourced aggregate | `protected readonly folds` |
| `MissingHandlerError` from `apply()` or replay | `MissingFoldError` (code `MISSING_FOLD`) |
| `DomainEvent.version`, option `version` | `schemaVersion` |

Apply the class and contract renames with one command over your TypeScript
sources. The order matters, because the contract takes the name that the
class gives up:

```sh
perl -pi \
  -e 's/\bAggregateRoot\b/StateStoredAggregate/g;' \
  -e 's/\bIAggregateRoot\b/Aggregate/g;' \
  -e 's/\bIEventSourcedAggregate\b/ReplayableAggregate/g;' \
  $(git ls-files '*.ts')
```

Apply the member renames with one command:

```sh
perl -pi \
  -e 's/this\.commit\(/this.setState(/g;' \
  -e 's/\bloadFromHistory\b/replayHistory/g;' \
  -e 's/\bmarkRestored\b/markReconstituted/g;' \
  -e 's/\breadonly handlers\b/readonly folds/g;' \
  $(git ls-files '*.ts')
```

Then run the compiler. It flags every `EventSourcedAggregate` subclass whose
type arguments are in the old order; swap the second and the third argument,
and drop a fourth one. It flags every read of `event.version` and every event
literal with a `version` field; rename them to `schemaVersion`. Do not touch
the `version` field of an `IntegrationMessage` or a `PublishedCommand`: those
are wire contracts, and the boundary mappers translate.

`MissingHandlerError` stays for `projectionFromHandlers`, so the compiler does
not flag it. Search for `MissingHandlerError` and `MISSING_HANDLER`, and
change the sites that guard an aggregate to `MissingFoldError` and
`MISSING_FOLD`.

`commit` names the transaction only: `withCommit`, `committedVersion`,
`CommittedDomainEvent`.

#### `setState` always bumps the version

`setState(newState)` always advances the version. A mutation that does not
bump is a named method now, and the `autoVersionBump` option is gone. The
no-bump path permitted silent lost updates: a save whose version did not move
writes over a concurrent writer without a conflict.

| Before | After |
| --- | --- |
| `this.setState(next)` without `autoVersionBump` | `this.setState(next)`, which now bumps |
| `this.setState(next, false)` | `this.setStateWithoutVersionBump(next)` |
| `this.setState(next, true)` | `this.setState(next)` |
| `autoVersionBump: true` in the config | remove the option |
| `this.apply(event, isNew)` | `this.apply(event)` |

The compiler does not flag the first row. Audit every `setState` call. Keep
the one-argument call for a domain mutation. Use `setStateWithoutVersionBump`
only for state that tolerates loss under a concurrent write, for example a
cosmetic cache. `apply()` records only new facts; replay goes through
`replayHistory`. An event-sourced aggregate that calls `setState` throws
`DirectStateMutationError`, because its state changes only through `apply()`.

#### The aggregate decides; the shell records

A domain method creates an uncommitted event with `this.createEvent(type,
payload)`. The event carries the fact and the aggregate identity only. The
application shell stamps the event id, the time, and the metadata with
`recordPendingEvents`, before the repository registration.

```ts
// before
confirm(): void {
  this.commit(nextState, this.recordEvent("OrderConfirmed", payload));
}

// after
confirm(): void {
  this.setState(nextState, this.createEvent("OrderConfirmed", payload));
}

await new UnitOfWork(deps).run(async ({ repositories }) => {
  const order = await repositories.orders.getById(command.orderId);
  order.confirm();
  recordPendingEvents(order, domainEvents, {
    metadata: { correlationId: command.correlationId },
  });
  repositories.orders.update(order);
});
```

`withCommit` rejects an event that was not recorded. Event ids and the clock
come from an immutable factory value. The six module setters are gone:
`setEventIdFactory`, `resetEventIdFactory`, `withEventIdFactory`,
`setClockFactory`, `resetClockFactory`, and `withClockFactory`.

```ts
// before
setEventIdFactory(() => uuidv7());
setClockFactory(requestClock);
const event = createDomainEvent("OrderConfirmed", payload);

// after
const domainEvents = createDomainEventFactory({
  eventIdFactory: () => uuidv7(),
  clock: requestClock,
  source: "sales",
});
const event = domainEvents.create("OrderConfirmed", payload);
```

The top-level `createDomainEvent` uses the frozen
`defaultDomainEventFactory`. `createDomainEventFromFacts` builds an event
whose caller owns the identity and the time, outside an aggregate.

#### Events are readonly and minted

Every field of `DomainEvent` is `readonly`. The recording paths accept only
events that the kit constructors minted. A hand-built object literal throws
`UnmintedEventError` (code `UNMINTED_EVENT`) before the state moves. The
compiler does not flag a literal, because a literal satisfies the readonly
interface. Search for event objects built by hand.

```ts
// before
this.apply({ eventId, type: "OrderConfirmed", payload, occurredAt, version: 1 });

// after
this.apply(this.createEvent("OrderConfirmed", payload));
```

`createDomainEvent` rejects binary buffers in the payload and the metadata:
`ArrayBuffer`, `SharedArrayBuffer`, a typed array, and a `DataView`. Freezing
does not cover them, and JSON does not keep them. Encode binary data as a
string, or store it outside the event. `EventMetadata` fields are readonly,
and the metadata gains `traceparent` and `tracestate`.

#### Entity state is protected, and its field is private

`Entity.state` is `protected`, and `IEntity<TId, TState>` is `IEntity<TId>`.
A public live state let a caller change nested state past every rule. Step 1
shows the domain queries and the detached read DTO that replace it.

A subclass no longer sees `_state` and `freezeState`. Every write goes
through `setState`, which validates and freezes.

| Before | After |
| --- | --- |
| `order.state.status` outside the aggregate | `order.status`, a domain query |
| `this._state = next` in a domain method | `this.setState(next)` |
| `this._state = this.freezeState(restored)` in a reconstitution override | `super(id, restored, { trustInitialState: true })` in the reconstitution factory |

`trustInitialState` skips the validator for a persisted state, because the
state is an accepted fact. The structural gates still run.

#### Pass the state validator in the config

`Entity.validateState` is no longer a method that a subclass overrides. The
base constructor called the override before the subclass fields existed.
Pass a pure function through `EntityConfig.validateState`:

```ts
// before
class Order extends AggregateRoot<OrderState, OrderId> {
  protected validateState(state: OrderState): void {
    if (state.items.length > 100) throw new TooManyItemsError();
  }
}

// after
function validateOrderState(state: OrderState): void {
  if (state.items.length > 100) throw new TooManyItemsError();
}

class Order extends StateStoredAggregate<OrderState, OrderId> {
  constructor(id: OrderId, state: OrderState) {
    super(id, state, { validateState: validateOrderState });
  }
}
```

A subclass member named `validateState` fails to compile. A JavaScript
subclass does not fail: its method is never called, so migrate it by hand.
On an event-sourced aggregate, the validator runs on each `apply()`.

#### The persistence lifecycle leaves the aggregate

These members are gone from the aggregate: `persistedVersion`, `hasChanges`,
`changedKeys`, `markPersisted`, `clearPendingEvents`, and the protected
`onPersisted(version)` hook. The unit of work acknowledges a commit through a
capability of the kit. Move post-commit work to the observer at the
composition root:

```ts
// before
class Order extends AggregateRoot<OrderState, OrderId, OrderEvent> {
  protected override onPersisted(version: Version): void {
    orderCache.evict(this.id, version);
  }
}

// after
const deps = {
  scope,
  outbox,
  repositories: { orders },
  onPersisted: async (aggregate: Aggregate<OrderId, OrderEvent>, version: Version) => {
    await orderCache.evict(aggregate.id, version);
  },
  onPersistError: (error: unknown, aggregate: Aggregate<OrderId, OrderEvent>) => {
    logger.error({ error, identity: aggregate.aggregateIdentity });
  },
};
```

A failure of the observer goes to `onPersistError`. It never makes a
committed write look failed. To abandon an instance in memory, discard it
and reconstitute a fresh one.

#### Replay trusts history, and events name their aggregate

Replay no longer runs `validateEvent`: history is an accepted fact, and a
rule that changes later must not make a stored stream unloadable. Decode and
upcast old event shapes at the read boundary, as the
[event upcasting guide](./event-upcasting.md) shows.

In exchange, both paths check the aggregate identity of an event. On
`apply()`, `setState`, and `addDomainEvent`, the aggregate stamps a missing
`aggregateId` or `aggregateType`. An event that names another aggregate
throws `MisattributedEventError` (code `MISATTRIBUTED_EVENT`) before the
state moves. On replay, a history event that names another aggregate throws
`ForeignEventError` (code `FOREIGN_EVENT`), an `InfrastructureError`. History
events without the optional fields pass.

Two more rules apply on both paths. A fold that returns `undefined` throws
`FoldReturnedNoStateError`; model an absent state as `null` or as a status
field. A fold result with an own `"__proto__"` key throws
`HostileStateKeyError`, and `createDomainEvent` throws it for such a
payload. Replay throws both errors after the rollback, instead of returning
`Err`. Fix such folds before you load the streams that contain the events.

#### Helpers return readonly arrays, and inputs are validated

`updateEntityById`, `replaceEntityById`, and `removeEntityById` return
`ReadonlyArray<T>` in place of `T[]`. They return the input array when
nothing changed, and that array can be frozen. Spread the result where you
need a mutable copy. `deepFreeze` takes one argument; the second parameter
for the visited set is gone.

| Before | After |
| --- | --- |
| `const items: Item[] = updateEntityById(items, id, update)` | `const items: readonly Item[] = updateEntityById(items, id, update)` |
| `deepFreeze(value, visited)` | `deepFreeze(value)` |

Two inputs are now checked where they enter. The `Entity` constructor
throws `MissingEntityIdError` for an id that is not a non-blank string.
`markReconstituted` and `setVersion` throw `InvalidVersionError` for a
version that is not a safe integer of at least zero. Brand a stored version
with `toVersion(row.version)` in place of `row.version as Version`.

#### An aggregate exposes its full identity

The `Aggregate` interface has a read-only `aggregateIdentity:
AggregateIdentity<TId>`. The base classes build it, so an aggregate that
extends them needs no change. A hand-written implementation of `Aggregate`,
for example a test stub, adds the property.

The unit of work and the recording functions reject an instance that the
kit did not construct with `UnmanagedInstanceError` (code
`UNMANAGED_INSTANCE`): a repository DTO, a structural lookalike, or an
instance from a copy of the kit with an older capability shape. Extend
`StateStoredAggregate` or `EventSourcedAggregate`. Run one kit version per
process.

### Repositories and the Unit of Work

The persistence steps cover the repository contracts, the definitions, and
the flush. These changes remain.

#### `IQueryableRepository` is gone

Its adapter-native filter put the storage vocabulary into the port, and its
`find` returned an unbounded set. Declare the query on your own port:

```ts
// before
interface Invoices
  extends IQueryableRepository<Invoice, InvoiceId, Prisma.InvoiceWhereInput> {}

// after
interface InvoiceRepository extends AggregatePersistence<Invoice, InvoiceId> {
  findByNumber(number: InvoiceNumber): Promise<Invoice | undefined>;
  findDunningCandidates(
    criteria: DunningCriteria,
    page: { after?: DunningCursor; limit: DunningPageSize },
  ): Promise<DunningCandidatePage>;
}
```

Give a single-result method a uniqueness law from the domain. Give a
multi-result method a validated limit, one stable order, and a cursor.
`Specification<T>` names domain criteria that such a method accepts.

#### `withCommit` takes commit tokens

A direct caller of `withCommit` returns tokens from the enrollment
capability, not the aggregates it touched. A touched aggregate is no proof
that its write joined the transaction.

```ts
// before
await withCommit({ scope, outbox, bus }, async (tx) => {
  const order = await orders(tx).getByIdOrFail(orderId);
  order.confirm();
  await orders(tx).save(order);
  return { result: order.id, aggregates: [order] };
});

// after
await withCommit({ scope, outbox, bus }, async (tx, enrollment) => {
  const order = await orders(tx).getById(orderId);
  order.confirm();
  recordPendingEvents(order, domainEvents);
  await orders(tx).save(order);
  return { result: order.id, commits: [enrollment.enrollSaved(order)] };
});
```

For a physical removal, return `enrollment.enrollDeleted(aggregate)`. The
`deleted` array is gone. Every token that the callback mints must be in
`commits`. A `UnitOfWork` use case keeps returning its result directly.

#### The outbox dependency is the write half

`outbox` in `WithCommitDeps` and `UnitOfWorkDeps` has the type
`OutboxWriter`. A full `Outbox` still passes. Code that read
`deps.outbox.getPending` back from the dependencies keeps its own reference
to the full outbox. For a setup without delivery reliability,
`outboxWriterAcceptingEventLoss()` states that decision at the call site.

#### `IdentityMap.set` takes the aggregate only

`set(type, aggregate)` reads the id from `aggregate.aggregateIdentity`, so
the id and the instance cannot disagree. A repository adapter calls
`tracking.trackLoaded(aggregate)` and never calls `set`.

| Before | After |
| --- | --- |
| `identityMap.set(Order, order.id, order)` | `identityMap.set(Order, order)` |

### Event store

#### Streams take the aggregate identity

`EventStore.append` and `readStream` take an `AggregateIdentity` in place of
the raw id. The same id under two aggregate types is two streams.

```ts
// before
await eventStore.append(order.id, order.pendingEvents, { expectedVersion });

// after, in the flush of a repository definition
await eventStore.append(write.aggregateIdentity, write.events, {
  expectedVersion: write.expectedVersion ?? 0,
});
```

A production schema keys a stream, its OCC predicate, and its uniqueness
constraint on `(aggregate_type, aggregate_id, position)`. Backfill the
aggregate type before the switch. A later rename of an aggregate type is a
stream-key migration.

#### Reads report the stream state and come in bounded pages

`readStream` returns a `StreamReadResult` in place of an event array, and
its options object with `limit` is required. A missing stream is
`{ exists: false }`, and `lastVersion` reports the real head. A loader
does not page by hand. It uses the kit read and the kit replay:

```ts
// before
const history = await eventStore.readStream(orderId);
order.loadFromHistory(history);

// after
const read = await readStreamPages(eventStore, identity, { limit: 256 });
if (!read.reachable) return undefined;
const loaded = await reconstituteAggregateFromStreamPages(
  () => Order.reconstitute(identity.aggregateId),
  read,
);
if (loaded.isErr()) throw loaded.error;
return tracking.trackLoaded(loaded.value);
```

`readStreamPages` pins the stream head on the first page and reads toward
it. A page that breaks the `readStream` contract throws
`InvalidEventStreamPageError`. A replay that does not end at the pinned
version throws `ReplayTargetMismatchError`. A stored event that the domain
rejects comes back as `Err(ReplayRejectedError)` with the `DomainError` as
the cause. An adapter implements `readStream` and passes
`createEventStoreContractTests`.

### Messaging

#### The event bus port has more members

A hand-written `EventBus` implements `subscribeAll`, `subscribeMany`, and
`close`, and `publish` accepts `PublishOptions`. An `EventHandler` receives
an `ExecutionContext` with a `signal` as its second argument. `EventBusImpl`
users need no change.

```ts
// before
const bus: EventBus<OrderEvent> = {
  publish: async () => {},
  subscribe: () => () => {},
  once: () => new Promise(() => {}),
};

// after
const bus: EventBus<OrderEvent> = {
  publish: async () => {},
  subscribe: () => () => {},
  subscribeAll: () => () => {},
  subscribeMany: () => () => {},
  once: () => new Promise(() => {}),
  close: () => {},
};
```

After `close()`, `publish`, `subscribe`, `subscribeAll`, and `once` throw
`EventBusClosedError`. `publish` has a default time budget of 30 seconds;
set `timeoutMs` to change it. `createEventBusContractTests` proves an
implementation.

#### The outbox stores committed events

`OutboxWriter.add` takes `EventCommitCandidate` values from `withCommit`,
not bare events. An `OutboxRecord` is a `CommittedDomainEvent` with a
`dispatchId`: it carries `event`, the `source` identity, and the commit
`position`. `DispatchTrackingOutbox.markFailed` returns the dead-letter record
on the call that crosses the attempt ceiling, and `undefined` otherwise. The
poll methods accept an optional `ExecutionContext`. `InMemoryOutbox` users
need no change. A custom outbox passes `createOutboxContractTests`, which
proves the commit positions and the source cursor.

`DomainEvent` has no `aggregateVersion` any more, and `createDomainEvent`
takes no such option. The commit envelope carries the position: an outbox
record reads `position.aggregateVersion`, next to `commitSequence` and
`commitSize`. The compiler flags a read of `event.aggregateVersion`.

### Command and query buses

#### An unregistered message type throws

`CommandBus.execute` and `QueryBus.execute` throw `UnregisteredHandlerError`
instead of returning it through the error channel. The compiler does not
flag an old error branch; it becomes dead code. Remove branches that matched
"No handler registered" or `UnregisteredHandlerError`. Catch the error only
at a deliberate seam.

#### Map only the expected failures

The total `errorMapper` option is gone, with its string fallback. Without a
policy, a handler throw propagates unchanged. A handler returns `err(E)` for
a failure it owns. For an exception-first dependency, decide per error:

```ts
// before
const bus = new CommandBus<Commands, AppError>({ errorMapper: toAppError });

// after
const bus = new CommandBus<Commands, AppError>({
  mapExpectedError: (thrown) =>
    thrown instanceof OrderAlreadyConfirmedError
      ? { error: toAppError(thrown) }
      : undefined,
});
```

`undefined` means "not mine" and rethrows the original. Do not rename a
total mapper mechanically: it rebuilds the old catch-all.

#### A typed bus map owns the result type

With a concrete `TMap`, the map entry is the result type of `execute` and
`executeUnsafe`. An explicit result generic that contradicts the map no
longer compiles. Remove such generics. The loose overload stays for the
default `Record<string, unknown>` map.

### Entry points and platform

| Before | After |
| --- | --- |
| `import { deepOmit } from "@shirudo/ddd-kit/utils"` | `import { deepOmit } from "@shirudo/ddd-kit"` |
| `import { toPublicErrorView } from "@shirudo/ddd-kit/presentation"` | `import { toPublicErrorView } from "@shirudo/ddd-kit/public-errors"` |
| type `Key` of `deepOmit` | `DeepOmitKey` |
| type `PathSegment` of `deepOmit` | `DeepOmitPathSegment` |
| `computeBackoffDelay` | not exported; the retry behavior is unchanged |
| `engines.node` `>=20` | `>=22` |
| peer `@shirudo/base-error` `^7.1.1` | `^8.3.0` |

The `utils` entry point duplicated the root, so only the import path
changes. `@shirudo/ddd-kit/money` is a new entry point. Node 20 reached its
end of life on 2026-04-30. `@shirudo/base-error` before 8.1.0 does not mask
the fields that a kit error adds when you log it with `redactAllow`. Follow
the migration notes of `@shirudo/base-error` 8 where you use its API
directly.

## Production cutover: one coordinated switch

Do not run v2 and v3 writers against the same bounded-context persistence at
the same time. Their source protocols differ, and a mixed deployment makes it
unclear which process owns the expected version and exact event batch.

Use a Big-Bang writer cutover per bounded context:

1. Deploy backward-compatible schema changes. The kit redesign requires no
   schema change beyond the stream key of an event store.
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

## Appendices for release candidates

Each appendix leads from one release candidate to the next. It uses the
names of the candidate that it leads to. A later appendix renames some of
them again, so follow the appendices in order up to 3.0.0.

### Appendix: v3.0.0-rc.1 to rc.2 or later

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

### Appendix: v3.0.0-rc.2 to rc.3 or later

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
  enforces the version post-condition and rejects a factory that ignores it
  with `SnapshotVersionNotRestoredError` (code `SNAPSHOT_VERSION_NOT_RESTORED`).
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

### Appendix: v3.0.0-rc.3 to rc.4 or later

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

### Appendix: v3.0.0-rc.4 to rc.5 or later

rc.5 breaks the source at the entry points, on the event bus port, in the
aggregate vocabulary, on the entity state field, and on two subclass
members. The main part describes each change with the 3.0.0 names:

- [Entry points and platform](#entry-points-and-platform): the `utils` entry
  point is gone, and `presentation` is `public-errors`.
- [The event bus port has more members](#the-event-bus-port-has-more-members):
  `close()` and `subscribeMany()`.
- [One lifecycle vocabulary](#one-lifecycle-vocabulary), including the folds.
- [Entity state is protected, and its field is private](#entity-state-is-protected-and-its-field-is-private).
- [Pass the state validator in the config](#pass-the-state-validator-in-the-config):
  a subclass member named `validateState` fails to compile.
- [Replay trusts history, and events name their aggregate](#replay-trusts-history-and-events-name-their-aggregate):
  a fold must return a state, and the hostile own-key guard covers the fold
  result and the payload.
- [An aggregate exposes its full identity](#an-aggregate-exposes-its-full-identity):
  one code, `UNMANAGED_INSTANCE`, names an instance that the kit does not
  manage.

Four changes concern names that only rc.4 had:

| rc.4 | rc.5 |
| --- | --- |
| `stampNewEventAddress(event)` | `addressNewEvent(event)` |
| `new MisaddressedEventError(expectedId, expectedType, eventType, actualId, actualType)` | `new MisaddressedEventError({ expected, actual, eventType })` |
| `new ForeignEventError(expectedId, expectedType, eventType, actualId, actualType)` | `new ForeignEventError({ expected, actual, eventType })` |
| `this.pendingEventCount` in a subclass | `this.pendingEvents.length` |

The next appendix renames `addressNewEvent` and `MisaddressedEventError`
again.

### Appendix: v3.0.0-rc.5 or later to 3.0.0

Each item names the candidate that introduced it. If your candidate is
later than that, the item is already done.

**rc.6.** A value object accepts a nested value object again, and `voEquals`
and `deepEqual` compare the class of a value object instance. `detachState`
is new, and the snapshot model guards its state with it: the messages start
with `detachState: state`, and a snapshot state rejects more values, for
example an accessor property or a symbol-keyed property.

**rc.8.** The repository contract suites start with a preflight that holds
one `run` call open and starts a second one. An environment that serializes
`run` fails with a message that names the requirement. The harness option
`overlappingCallsBoundMs` raises the bound of one second.

**rc.9.** `defineRepository` accepts an append-only port with
`appendOnly: true`. `ContractRepository.update` is optional, so a port that
extends `ContractRepository` redeclares `update`. The repository definition
brand key is `v2`: run one kit version per process. A violated port
constraint is one compiler error that names it. Three definitions that
compiled by accident now fail: a `remove(id: OrderId)`, a `physicalRemoval`
typed `boolean`, and a union of port types.

**rc.10.**

- `ConcurrencyConflictError` requires a `reason`, and `actualVersion` is
  `number | null`. See
  [A concurrency conflict names its reason](#a-concurrency-conflict-names-its-reason).
- `AggregateTrackingFailure` is `AggregateTrackingReason`.
- A wiring error from the flush reaches the caller unchanged, not through
  `mapError`. `isWiringErrorLike` checks for it across kit copies.
- `UnitOfWork` names a violated wiring constraint. A scope over a union of
  transaction contexts no longer compiles against a definition that accepts
  one member only.
- A serialized kit error carries the fields it declares, for example
  `reason` and `expectedVersion`.

**3.0.0.**

| rc.10 | 3.0.0 |
| --- | --- |
| `AggregateAddress` | `AggregateIdentity` |
| `AggregateAddressMismatchOptions` | `AggregateIdentityMismatchOptions` |
| `MisaddressedEventError` (code `MISADDRESSED_EVENT`) | `MisattributedEventError` (code `MISATTRIBUTED_EVENT`) |
| `DomainEventValidationCode` `EVENT_ADDRESS_INVALID` | `EVENT_AGGREGATE_IDENTITY_INVALID` |
| protected `addressNewEvent(event)` | protected `stampNewEventIdentity(event)` |
| error fields `aggregateType`, `aggregateId` | `identity.aggregateType`, `identity.aggregateId` |
| positional constructors of `AggregateDeletedError`, `AggregateTrackingError`, `DirectStateMutationError`, `DuplicateEventIdError`, `PendingEventBatchMismatchError`, `ReentrantEventRecordingError`, `RepositoryErrorMappingFailedError`, `UnenrolledChangesError`, `UnreplayableAggregateError` | one options object with `identity` |
| `identityMap.set(Order, id, order)` | `identityMap.set(Order, order)` |
| `write.aggregateId` in a flush | `write.aggregateIdentity.aggregateId` |
| `versionedFlush({ aggregateType: "Order", ... })` | `versionedFlush({ ... })` |
| `NonProgressingEventStreamPageError` (code `NON_PROGRESSING_EVENT_STREAM_PAGE`) | `InvalidEventStreamPageError` (code `INVALID_EVENT_STREAM_PAGE`) with a `reason` |
| `ReplayHeadMismatchError` (code `REPLAY_HEAD_MISMATCH`) | `ReplayTargetMismatchError` (code `REPLAY_TARGET_MISMATCH`) with a `reason` |
| peer `@shirudo/base-error` `^8.0.0` | `^8.3.0` |

A hand-written `Aggregate` adds `aggregateIdentity`; see
[An aggregate exposes its full identity](#an-aggregate-exposes-its-full-identity).
`readStreamPages` and `reconstituteAggregateFromStreamPages` are new. They
replace a load loop that pages by hand; see
[Reads report the stream state and come in bounded pages](#reads-report-the-stream-state-and-come-in-bounded-pages).
The internal capability registry keys changed again, and the repository
definition brand key is `v3`, so run one kit version per process. A
definition from an earlier copy fails with `InvalidRepositoryDefinitionError`.

Behavior that a use case or an adapter can notice:

- Registration closes when the flush starts. A repository call that the
  callback did not await and that registers later throws
  `AggregateTrackingError` with the reason `registered_during_flush`, and
  the run fails. Await every repository call.
- A read adapter returns the result of `tracking.trackLoaded`, not its
  argument. When two loads of one id overlap, the first tracked instance
  wins. An `add` of a second instance with a tracked identity throws
  `AggregateTrackingError` with the reason `identity_already_tracked`, not a
  plain `Error`.
- A port whose `add`, `update`, or `remove` returns a value, for example a
  promise or `this`, no longer compiles. `defineRepository` throws a
  `TypeError` for a persistence model without `capture`, `changes`, or
  `isEmpty`, and for a lifecycle flag that is not a boolean.
- The outbox receives a frozen candidate array. An adapter that sorts or
  changes the array in place fails the commit.
- A time option above 2147483647 ms throws a `RangeError`, and an invalid
  time option throws a `RangeError` in place of an `Error`.
- A custom scope that retries calls `onAttemptStart` from the transactional
  options before each attempt, so `run()` labels a failure by its attempt.
- An identity whose aggregate committed events cannot be created again after
  a removal. Give the new aggregate a new id.
- `OutboxWriter` and `CommandOutboxWriter` require `endEventSources`. A
  durable adapter keeps an `ended` flag on the source head, sets it there,
  and rejects a new event of an ended source. `outboxWriterAcceptingEventLoss`
  and `routeEventsToCommandOutbox` implement it. A contract harness supplies
  `endEventSourcesCommitted`, and `endEventSourcesRolledBack` with
  `providesRolledBackEnds`.
