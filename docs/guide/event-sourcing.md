# Event Sourcing

`EventSourcedAggregate<TState, TEvent, TId>` is the aggregate root for models
where events are the source of truth.

The aggregate does not store its current state as the primary record. It derives
state by applying events in order. New business methods record new facts by
calling `apply(event)`. Reconstitution reads old facts and folds them back into
state with `loadFromHistory(...)`. A snapshot model can create a fresh
aggregate from a stored state DTO before the stream tail is replayed.

That split is the whole model:

- `apply(event)` is for new facts and always records a pending event.
- replay methods are for old facts and never record pending events.
- the aggregate version is the event count.
- the event store's stream position is the replay ordering authority.

## A small event-sourced aggregate

```ts
import {
  DomainError,
  EventSourcedAggregate,
  type DomainEvent,
  type Id,
  type UncommittedDomainEventOf,
} from "@shirudo/ddd-kit";

type OrderId = Id<"OrderId">;

type OrderState = {
  customerId?: string;
  status: "empty" | "pending" | "confirmed";
};

type OrderView = Readonly<{
  id: OrderId;
  version: number;
  customerId?: string;
  status: OrderState["status"];
}>;

type OrderCreated = DomainEvent<
  "OrderCreated",
  { customerId: string }
>;

type OrderConfirmed = DomainEvent<
  "OrderConfirmed",
  { orderId: OrderId }
>;

type OrderEvent = OrderCreated | OrderConfirmed;

class OrderNotCreatedError extends DomainError<"ORDER_NOT_CREATED"> {
  constructor(orderId: OrderId) {
    super({
      code: "ORDER_NOT_CREATED",
      message: `Order ${orderId} has not been created.`,
    });
  }
}

class OrderAlreadyConfirmedError extends DomainError<
  "ORDER_ALREADY_CONFIRMED"
> {
  constructor(orderId: OrderId) {
    super({
      code: "ORDER_ALREADY_CONFIRMED",
      message: `Order ${orderId} is already confirmed.`,
    });
  }
}

class Order extends EventSourcedAggregate<
  OrderState,
  OrderEvent,
  OrderId
> {
  protected readonly aggregateType = "Order";

  private constructor(id: OrderId, state: OrderState) {
    super(id, state);
  }

  static create(
    id: OrderId,
    customerId: string,
  ): Order {
    const order = Order.reconstitute(id);
    order.apply(
      order.createEvent("OrderCreated", { customerId }),
    );
    return order;
  }

  static reconstitute(id: OrderId): Order {
    return new Order(id, { status: "empty" });
  }

  confirm(): void {
    this.apply(
      this.createEvent("OrderConfirmed", {
        orderId: this.id,
      }),
    );
  }

  toView(): OrderView {
    return Object.freeze({
      id: this.id,
      version: this.version,
      customerId: this.state.customerId,
      status: this.state.status,
    });
  }

  protected override validateEvent(
    event: UncommittedDomainEventOf<OrderEvent>,
  ): void {
    if (event.type !== "OrderConfirmed") return;

    if (this.state.status === "empty") {
      throw new OrderNotCreatedError(this.id);
    }

    if (this.state.status === "confirmed") {
      throw new OrderAlreadyConfirmedError(this.id);
    }
  }

  protected readonly handlers = {
    OrderCreated: (
      _state: OrderState,
      event: UncommittedDomainEventOf<OrderCreated>,
    ): OrderState => ({
      customerId: event.payload.customerId,
      status: "pending",
    }),
    OrderConfirmed: (state: OrderState): OrderState => ({
      ...state,
      status: "confirmed",
    }),
  };
}
```

A domain method records a fact by creating an event and applying it. The handler
is the only code that changes state for that fact.

`apply(event)` runs in this order:

1. The address check runs. The aggregate supplies a missing `aggregateId` or
   `aggregateType`. A foreign address throws `MisaddressedEventError` before
   recording. `ForeignEventError` is the replay error for persisted rows.
2. `validateEvent(event)` decides whether this event is allowed in the current
   state.
3. The handler for `event.type` is found.
4. The handler computes the next state. A handler that returns `undefined`
   throws `HandlerReturnedNoStateError`.
5. The `validateState` function from the constructor config checks the next
   state. This is the same check that `setState` runs on a state-stored
   aggregate.
6. The aggregate stores the new state, records the event in `pendingEvents`, and
   bumps the version.

If validation, handler lookup, state computation, or the state check throws,
the aggregate does not record the event. This behavior is the event-sourcing safety rule. The
aggregate must not publish a fact that did not change state.

There is no `commit(...)` helper on `EventSourcedAggregate`. `apply(...)`
already ties the event and the state transition together.

Handlers must fold state from `type` and `payload` only. A live `apply(...)`
folds the event before the shell records it, so `eventId` and
`occurredAt` do not exist yet. Replay folds recorded events through the
same handlers, so those fields are present there at runtime. The handler
parameter type declares the uncommitted shape to keep them out of reach, but
TypeScript cannot protect an `as any` cast or plain JavaScript. A handler
that reads a stamp field folds `undefined` into live state and a value into
every replayed instance, and the two silently diverge. When a time changes a
business decision, pass it in the payload as a domain input.

## Persisting new events

After `apply(...)`, new events sit in `pendingEvents`. The use case makes all
of its decisions and then registers the final lifecycle intent:

```ts
await uow.run(async ({ repositories }) => {
  const order = await repositories.orders.getById(orderId);
  order.confirm();
  repositories.orders.update(order);
});
```

The event-store adapter receives an immutable write receipt. Append its exact
event batch and use the version captured by the unit of work during load:

```ts
interface ForStoringOrders
  extends AggregatePersistence<Order, OrderId> {}

const eventSourcedOrders = defineRepository<ForStoringOrders>()({
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

Use `add` for a new stream and `update` for an aggregate loaded by this unit of
work. Do not derive the distinction from `version`. `write.expectedVersion` is
absent for a new stream and contains the load-time stream version for an
update.

The append and outbox write share one transaction. Only after that transaction
commits does `UnitOfWork` acknowledge exactly the registered batch on the
aggregate. If append, outbox, or commit fails, the transaction rolls back and
the events remain pending on that in-memory instance. A retry starts a fresh
unit of work and replays the command from fresh history.

### Stream events and outbox events

The event store receives the recorded pending events. The outbox receives
envelopes that reference those same immutable objects. Calling
`recordPendingEvents` again during a retry does not generate another identity
or timestamp.

The outbox source finalizes those envelopes with the full cursor under `position`:
`aggregateVersion`, `commitSequence`, `commitSize`, and
`previousEventfulAggregateVersion`. The stream originals do not. State-only
saves (where applicable outside the event stream) do not advance that eventful
predecessor. A projection rebuilt from the event stream therefore composes each
event with the store's own gap-proof stream source and position before calling
`projector.project(...)`.

Projection handlers remain independent of cursor provenance. In event-sourced
systems, the event store's own stream position is the replay ordering authority.

## The EventStore port

The kit defines a small driven port for stream persistence:

```ts
interface EventStore<Evt extends AnyDomainEvent> {
  append(
    stream: AggregateAddress,
    events: readonly Evt[],
    options: { expectedVersion: number },
  ): Promise<void>;

  readStream(
    stream: AggregateAddress,
    options: {
      limit: number;
      fromVersion?: number;
      toVersion?: number;
    },
  ): Promise<StreamReadResult<Evt>>;
}

type StreamReadResult<Evt> =
  | { exists: false; lastVersion: 0; events: readonly [] }
  | { exists: true; lastVersion: number; events: readonly Evt[] };
```

Use one stream per aggregate. Its key is the tuple `(aggregateType,
aggregateId)`, not the raw id alone: `SalesOrder 1` and `FulfillmentOrder 1`
are independent streams. The stream version is the number of events in that
qualified stream, so it aligns with the aggregate version.

Persist both key fields in every primary/unique key, OCC predicate, and read
predicate. Treat `aggregateType` as a stable technical category. When bounded
contexts with the same domain name share storage, qualify it at the source
(`sales.order`, `fulfillment.order`); renaming it requires a stream migration.

`append(...)` must be atomic and guarded by optimistic concurrency:

- if the stream currently has exactly `expectedVersion` events, append the new
  events in order
- if not, throw `ConcurrencyConflictError`
- for a duplicate-create race on `expectedVersion: 0`, an adapter may throw
  `DuplicateAggregateError` when it can distinguish that case
- rejected appends must leave the stream unchanged
- equal raw ids under different aggregate types must remain isolated

`readStream(stream, options)` reports both stream state and one bounded event
page. `limit` is mandatory, so no port call can accidentally materialize an
unbounded stream. It must be a positive safe integer. An adapter may return
fewer events than requested, but an unread window must return at least one
event so continuation makes progress.

A missing stream is
`{ exists: false, lastVersion: 0, events: [] }`. An existing stream stays
`exists: true` even when its requested window is empty. An existing stream has
at least one event. Thus, `exists: true` implies `lastVersion >= 1`. Report
metadata or tombstones without events as absent.

`lastVersion` always reports the actual head (the event count). `fromVersion`
is the exclusive lower bound. `toVersion` is the inclusive upper bound. Both
values use 1-based stream positions. Together they select
`(fromVersion, toVersion]` without changing `lastVersion`.

`toVersion: 0` returns an empty window. A value beyond the head clamps to the
head. `fromVersion >= toVersion` describes an empty interval, not an error.
These rules distinguish an absent aggregate from a snapshot at the head. They
also make sure that the requested historical position does not exceed the
actual head.

`limit` must be a positive safe integer. Present stream bounds must be
non-negative safe integers.

Invalid options reject with `RangeError`.
Adapters must compute `exists`, `lastVersion`, and `events` from one consistent
view of the page. Do not assemble the result from racing reads.

Separate pages are separate store reads. For a stable replay:

1. Record the first page's `lastVersion`.
2. Pass it as `toVersion` on every continuation.
3. Advance `fromVersion` by the number of returned events.

New appends can move
the reported head while the load runs, but they cannot enter that pinned
prefix. The next repository load sees them. An update from the older prefix still
meets the normal OCC guard.

A database adapter must also reject duplicate or non-contiguous persisted
positions rather than silently folding a truncated stream.

`InMemoryEventStore` is the reference implementation for finite-lifetime tests
and demos. It is memory-only and does not participate in your database
transaction. Without options, its streams and events are unbounded. A
long-lived process must configure both `maxStreams` and `maxEvents`; crossing a
limit throws `InMemoryCapacityExceededError` before the append changes any
stream. History is never evicted automatically. Production adapters must
implement the same contract against durable storage.

Run both the EventStore and event-sourced repository contract suites against
your adapter:

```ts
import {
  createEsRepositoryContractTests,
  createEventStoreContractTests,
} from "@shirudo/ddd-kit/testing";

describe("PgEventStore", () => {
  for (const test of createEventStoreContractTests(eventStoreHarness)) {
    it(test.name, test.run);
  }
});

describe("PgOrderEventRepository", () => {
  for (const test of createEsRepositoryContractTests(harness)) {
    (test.skipped ? it.skip : it)(test.name, test.run);
  }
});
```

The store suite proves qualified-key isolation, OCC/atomicity, stream-state
reporting, per-page bounds, gapless continuation, ordering, and both position
bounds. The repository suite covers append
conflicts, duplicate creates, replay equality, rollback purity, commit
lifecycle, and point-in-time windows through the repository adapter. When the
harness provides `captureSnapshot`, the suite also proves that a snapshot
catch-up ends at the stream head and folds only the tail.

## Loading from history

Reconstitution builds the aggregate from the first page through
`reconstituteAggregateFromHistory` and folds later pages into it:

```ts
async function findById(id: OrderId): Promise<Order | null> {
  const address = { aggregateType: "Order", aggregateId: id };
  const first = await eventStore.readStream(address, { limit: 256 });
  if (!first.exists) return null;
  const targetVersion = first.lastVersion;

  const reconstituted = reconstituteAggregateFromHistory(
    () => Order.reconstitute(id),
    first.events,
  );
  if (reconstituted.isErr()) throw reconstituted.error;
  const order = reconstituted.value;
  let fromVersion = first.events.length;

  while (fromVersion < targetVersion) {
    const page = await eventStore.readStream(address, {
      fromVersion,
      toVersion: targetVersion,
      limit: 256,
    });
    if (!page.exists || page.events.length === 0) {
      throw new NonProgressingEventStreamPageError({
        ...address,
        fromVersion,
        targetVersion,
      });
    }

    const catchUp = order.loadFromHistory(page.events);
    if (catchUp.isErr()) throw catchUp.error;
    fromVersion += page.events.length;
  }

  if (order.version !== targetVersion) {
    throw new ReplayHeadMismatchError({
      ...address,
      targetVersion,
      actualVersion: order.version,
    });
  }
  return order;
}
```

The first page pins the authoritative head; subsequent pages replay only that
prefix. `reconstituteAggregateFromHistory` builds the instance inside the
call and yields it only when the first page folded. A rejected replay leaves
the repository with nothing to track. Each later page goes through
`loadFromHistory` on that instance, once per page, which keeps allocation
bounded. If a later page fails, discard the local aggregate and do not place
it in the identity map. Replay remains all-or-nothing per call, and no
partially loaded instance escapes the repository.

`reconstituteAggregateFromHistory(create, history)` returns
`Result<Order, DomainError>`: the aggregate exists only in the `Ok`.
`loadFromHistory(...)` returns `Result<void, DomainError>` because a persisted
stream can be corrupt in ways the domain can name (a handler that rejects a
payload it cannot map). Two groups of failures deliberately do NOT ride the
`Result`. The wiring errors `MissingHandlerError`, `HandlerReturnedNoStateError`,
`HostileStateKeyError`, and `UnreplayableAggregateError` throw, after the
rollback, because a code bug must not look like a corrupt stream.
`UnmintedEventError` belongs to `apply()` only: replay input comes from
storage rows, and the mint gate does not run on it. And an
event addressed to a different aggregate (`ForeignEventError`,
when a history event carries an `aggregateId` or `aggregateType` that does not
match the target) is an `InfrastructureError` and THROWS, because a wrong
stream read is wiring or data corruption, never an expected business
rejection a generic `Err` branch should absorb. The state rollback is the
same on both paths.

Replay does not run `validateEvent(...)`. History is already accepted fact,
and decision rules change over time; a stream that was valid when written must
stay loadable under tomorrow's rules. `validateEvent` guards new facts on the
`apply(...)` path only. Old storage shapes are not a replay-validation concern
either: decode and upcast persisted events at the read boundary (see
[Event Upcasting](./event-upcasting.md)) so handlers and replay always receive
the current event shape. Replay does not run `validateState(...)` either:
`loadFromHistory` stores each fold result as is, and only `apply(...)` runs
both gates for new facts. The constructor runs `validateState` once on the
initial state, unless the factory passes `trustInitialState: true`. A
snapshot `reconstitute` factory does. The stored state is then a fact like
the history, and a rule that tightened later does not break every restore.
The section [Where Invariants Live](./aggregates.md#where-invariants-live)
states the rule and the factory shape. Snapshots do get their own
STRUCTURAL gate: the adapter-owned `SnapshotModel` rejects blobs no version
of the model could have produced (missing fields, wrong types) by throwing
`SnapshotCorruptedError` from `migrate` or `reconstitute`. When a
reconstitution factory does run current rules and throws a `DomainError`,
`reconstituteAggregateFromSnapshot` surfaces it as `SnapshotCorruptedError`
too, and the load recipe answers both the same way: discard the snapshot and
refold from the stream. Rules and structure are different questions, and only
the first one is frozen in history.

Only `DomainError` is caught into the `Result`. Programmer errors still throw.
`MissingHandlerError` and `HandlerReturnedNoStateError` also throw, because a
forgotten event handler or a handler without a `return` is a code bug, not a
recoverable domain rejection.

Replay is all-or-nothing. If an event in the middle fails with a `DomainError`,
the aggregate rolls back to its pre-replay state and version before returning
`Err`.

Version advances additively:

- a fresh aggregate at version `0` loading three events ends at version `3`
- a persisted aggregate at version `10` catching up on two newer events ends at
  version `12`

Events carry no stream position, so the aggregate cannot detect a tail that
overlaps its version: a snapshot at version `10` fed five events of which two
were already folded ends at version `15`. The caller passes only the events
after the restored version, pins the stream head before the first page, and
checks the final version against it. On a mismatch the load recipe throws
`ReplayHeadMismatchError` (code `REPLAY_HEAD_MISMATCH`).

The replay target must be clean. If it carries unflushed `pendingEvents`,
`loadFromHistory(...)` throws `UnreplayableAggregateError` before anything
moves. The Unit of Work owns the factory-versus-load lifecycle, so the
aggregate carries no persistence flag and replay does not check one.

Use a fresh `Order.reconstitute(id)` target for normal loads.

### Point-in-time reconstruction

An audit or debugging query can fold only the history that existed at stream
position `N`. Keep that query outside the normal write repository. It creates a
historical view, not a live aggregate for updates.

```ts
async function findOrderAsOfVersion(
  id: OrderId,
  toVersion: number,
): Promise<OrderView | null> {
  if (!Number.isSafeInteger(toVersion) || toVersion < 0) {
    throw new RangeError("toVersion must be a non-negative stream position");
  }

  const address = { aggregateType: "Order", aggregateId: id };
  let page = await eventStore.readStream(
    address,
    { toVersion, limit: 256 },
  );

  if (!page.exists || toVersion === 0) return null;
  if (toVersion > page.lastVersion) {
    throw new RangeError(
      `Order stream ends at ${page.lastVersion}, before ${toVersion}`,
    );
  }

  const reconstituted = reconstituteAggregateFromHistory(
    () => Order.reconstitute(id),
    page.events,
  );
  if (reconstituted.isErr()) throw reconstituted.error;
  const historical = reconstituted.value;
  let fromVersion = page.events.length;
  while (fromVersion < toVersion) {
    page = await eventStore.readStream(address, {
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
    const result = historical.loadFromHistory(page.events);
    if (result.isErr()) throw result.error;
    fromVersion += page.events.length;
  }
  return historical.toView();
}
```

The explicit head check on the first page prevents a request for version `10` from silently
becoming "latest" when the stream currently ends at version `7`. For combined
snapshot and point-in-time reads, use `{ fromVersion: snapshot.version,
toVersion, limit }` and restore only when the snapshot version is at or below the
requested version.

## Snapshots

Snapshots are an optimization. The stream remains the source of truth.

When a stream gets long, loading from event zero on every request can dominate
latency. The snapshot path is:

1. Load the latest snapshot.
2. Reconstitute a fresh aggregate through its adapter-owned `SnapshotModel`.
3. Read and replay stream events after `snapshot.version`.
4. If the snapshot is missing or invalid, fall back to full replay.

```ts
async function findById(id: OrderId): Promise<Order | null> {
  const address = { aggregateType: "Order", aggregateId: id };
  const discardSnapshotAndRefold = async (): Promise<Order | null> => {
    const refolded = await replayFromZero(id);
    await snapshots.delete(address);
    return refolded;
  };

  const snapshot = await snapshots.load(address);
  if (snapshot === undefined) {
    return replayFromZero(id);
  }

  let tail = await eventStore.readStream(address, {
    fromVersion: snapshot.version,
    limit: 256,
  });

  if (
    !tail.exists ||
    tail.lastVersion < snapshot.version
  ) {
    return discardSnapshotAndRefold();
  }

  let order: Order;
  const targetVersion = tail.lastVersion;
  let fromVersion = snapshot.version;

  try {
    const restored = reconstituteAggregateFromHistory(
      () => reconstituteAggregateFromSnapshot(orderSnapshots, id, snapshot),
      tail.events,
    );
    if (restored.isErr()) {
      return discardSnapshotAndRefold();
    }
    order = restored.value;
    fromVersion += tail.events.length;

    while (fromVersion < targetVersion) {
      tail = await eventStore.readStream(address, {
        fromVersion,
        toVersion: targetVersion,
        limit: 256,
      });
      if (
        !tail.exists ||
        tail.lastVersion < targetVersion ||
        tail.events.length === 0
      ) {
        return discardSnapshotAndRefold();
      }

      const catchUp = order.loadFromHistory(tail.events);
      if (catchUp.isErr()) return discardSnapshotAndRefold();
      fromVersion += tail.events.length;
    }
  } catch (error) {
    if (
      error instanceof SnapshotSchemaMismatchError ||
      error instanceof SnapshotCorruptedError
    ) {
      return discardSnapshotAndRefold();
    }

    throw error;
  }

  if (order.version !== targetVersion) {
    throw new ReplayHeadMismatchError({
      ...address,
      targetVersion,
      actualVersion: order.version,
    });
  }
  return order;
}
```

The page checks are deliberate. A missing stream means the snapshot cannot
establish aggregate existence. A head behind the snapshot or behind the pinned
target means the authoritative stream was truncated or replaced. A zero-length
page before the cursor reaches the target cannot make progress and violates the
EventStore contract.

All three discard the derived snapshot and refold from the stream. None can
return the partially restored aggregate. Reaching the target
cursor proves every page bridged the snapshot to the pinned head without
materializing the whole tail.

`loadFromHistory(...)` keeps its `Result<void, DomainError>` boundary for
invalid historical facts. Snapshot DTO validation, migration, and
reconstitution belong to the adapter model and throw when stored data cannot
be interpreted. The repository can discard that derived snapshot and replay
from zero. Other infrastructure failures must still escape.

A schema mismatch throws `SnapshotSchemaMismatchError` unless the model
provides `migrate(stored, storedSchemaVersion)`. A missing schema version means
schema `1`, which lets v3 adapters migrate snapshots written by earlier
versions.

Delete snapshots before deleting streams during erasure. The reverse order has a
bad crash window: a stale snapshot can survive after the stream is gone and
resurrect the aggregate. Snapshot-first fails safe; a stream without a snapshot
just replays from zero.

### Snapshot storage

`SnapshotStore` stores the latest snapshot for `(aggregateType, aggregateId)`:

```ts
interface SnapshotStore<TState = unknown> {
  load(
    address: AggregateAddress,
  ): Promise<AggregateSnapshot<TState> | undefined>;

  save(
    address: AggregateAddress,
    snapshot: AggregateSnapshot<TState>,
  ): Promise<void>;

  delete(address: AggregateAddress): Promise<void>;
}
```

A snapshot is derived data. Save it after the write transaction commits, not
inside the transaction. If a snapshot save is lost, correctness is unchanged and
the next load replays more events. That is also why `SnapshotStore` has no
transaction context.

`InMemorySnapshotStore` is the reference implementation. Without retention
options it is unbounded and intended only for finite-lifetime tests and demos.
Snapshots are rebuildable derived data. Thus, this in-memory store can forget
state safely.

`maxEntries` enables least-recently-used eviction. `ttlMs` expires
entries relative to an optional instance-bound `clock`. Loading a snapshot
updates LRU recency but does not extend its TTL. Saving a snapshot extends it.
Production adapters must pass `createSnapshotStoreContractTests` from
`@shirudo/ddd-kit/testing`.

### Plain snapshot state

Snapshots must round-trip through storage as plain data.
`captureAggregateSnapshot(model, aggregate, snapshotAt)` fails fast if the
model's DTO contains values that cannot restore faithfully:

- class instances
- functions
- `Promise`, `WeakMap`, or `WeakSet`
- `Error` instances
- symbol-keyed state

If live state contains class-based child entities, define a plain snapshot DTO
and map both directions:

```ts
type OrderWithItemsState = {
  items: OrderItem[];
};

type OrderSnapshotState = {
  items: Array<{ id: ItemId; productId: string; quantity: number }>;
};

const orderSnapshots = defineSnapshotModel({
  aggregateType: "Order",
  schemaVersion: 2,
  capture: (order: Order): OrderSnapshotState => ({
    items: order.items.map((item) => ({
      id: item.id,
      productId: item.productId,
      quantity: item.quantity,
    })),
  }),
  reconstitute: (id, stored, version) =>
    Order.reconstituteFromSnapshot(
      id,
      {
        items: stored.items.map(
          (item) => new OrderItem(
            item.id,
            item.productId,
            item.quantity,
          ),
        ),
      },
      version,
    ),
  migrate: migrateOrderSnapshot,
});
```

The mapping must return fresh objects. Do not return references into the live
aggregate state or into the snapshot object loaded from storage.

### When to snapshot

The kit gives you the mechanism, not a policy. Choose the policy next to your
event-store adapter.

For short streams, skip snapshots. For long-lived streams, use one of these
shapes:

| Policy | When it fits | Trade-off |
| --- | --- | --- |
| Every N events | aggregates have similar event volume | simple, but hot streams can snapshot too often |
| Max snapshot age | traffic varies widely | quiet streams eventually get snapshots, but every save checks time |
| Background sweep | write-path latency matters | operationally heavier, but snapshot cost leaves the hot path |

The most common starting point is every N events after commit:

```ts
const SNAPSHOT_EVERY = 100;

async function snapshotAfterCommit(
  order: Order,
  snapshotAt: Date,
): Promise<void> {
  const lastSnapshotVersion =
    (await snapshotVersions.lastVersion("Order", order.id)) ?? 0;

  if (order.version - lastSnapshotVersion < SNAPSHOT_EVERY) return;

  await snapshots.save(
    { aggregateType: "Order", aggregateId: order.id },
    captureAggregateSnapshot(orderSnapshots, order, snapshotAt),
  );
}
```

At scale, move the decision to a background worker:

```ts
async function snapshotSweep(snapshotClock: () => Date): Promise<void> {
  const candidates = await snapshotVersions.findDue({
    aggregateType: "Order",
    minEventsSinceSnapshot: 100,
    limit: 1000,
  });

  for (const candidate of candidates) {
    const order = await orderRepository.getById(candidate.aggregateId);
    if (order === null) continue;

    await snapshots.save(
      { aggregateType: "Order", aggregateId: order.id },
      captureAggregateSnapshot(orderSnapshots, order, snapshotClock()),
    );
  }
}
```

There is no `SnapshotPolicy` port, no default frequency, and no built-in
sweeper. Different stores have different native snapshot facilities, and the
right policy depends on stream length, latency budget, and operational tooling.

When event schemas change, snapshots can need attention too. A snapshot is
state derived from historical events and old handler code. Increment the
model's `schemaVersion` and provide a migration, discard incompatible
snapshots, or rebuild them during the event-schema migration.

## Versioning

Every new `apply(...)` bumps the aggregate version by one. There is no opt-out.
For event-sourced aggregates, version means event count.

That gives the repository its optimistic-concurrency baseline:

```ts
await eventStore.append(
  { aggregateType: "Order", aggregateId: order.id },
  write.events,
  {
    expectedVersion: write.expectedVersion ?? 0,
  },
);
```

`write.expectedVersion` comes from the unit-of-work load record. `write.version`
is the aggregate version after the registered decision. Neither baseline is
stored as persistence metadata on the aggregate.

Keep this separate from store-specific positions. EventStoreDB revisions,
database sequence numbers, Kafka offsets, or projection checkpoints are
infrastructure positions. The aggregate version is the domain stream version
used to protect writes.

## Schema evolution

Domain events carry a `version` field for payload schema evolution. The kit does
not ship a built-in upcaster because strategies differ by store and deployment
style.

The usual rule is simple: upcast at the infrastructure boundary before events
reach the aggregate. Aggregate handlers should see the current event shape, not
every historical shape the system has ever emitted.

See [Event Upcasting](./event-upcasting.md).
