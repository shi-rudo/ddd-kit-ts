# Event Sourcing

`EventSourcedAggregate<TState, TEvent, TId>` is the aggregate root for models
where events are the source of truth.

The aggregate does not store its current state as the primary record. It derives
state by applying events in order. New business methods record new facts by
calling `apply(event)`. Reconstitution reads old facts and folds them back into
state with `loadFromHistory(...)` or `restoreFromSnapshotWithEvents(...)`.

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
} from "@shirudo/ddd-kit";

type OrderId = Id<"OrderId">;

type OrderState = {
  customerId?: string;
  status: "empty" | "pending" | "confirmed";
};

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

  static create(id: OrderId, customerId: string): Order {
    const order = Order.reconstitute(id);
    order.apply(order.recordEvent("OrderCreated", { customerId }));
    return order;
  }

  static reconstitute(id: OrderId): Order {
    return new Order(id, { status: "empty" });
  }

  confirm(): void {
    this.apply(
      this.recordEvent("OrderConfirmed", {
        orderId: this.id,
      }),
    );
  }

  protected override validateEvent(event: OrderEvent): void {
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
      event: OrderCreated,
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

1. The address discipline runs: missing `aggregateId` / `aggregateType`
   fields are stamped from the aggregate (the `recordEvent` guarantee, by
   construction), and a present-but-foreign address throws the wiring error
   `MisaddressedEventError` before anything is recorded. `ForeignEventError`
   is the replay-side counterpart for persisted rows.
2. `validateEvent(event)` checks whether this event is allowed in the current
   state.
3. The handler for `event.type` is found.
4. The handler computes the next state.
5. The aggregate stores the new state, records the event in `pendingEvents`, and
   bumps the version.

If validation, handler lookup, or state computation throws, the aggregate does
not record the event. That is the event-sourcing safety rule in code form: the
aggregate should not publish a fact that did not successfully change state.

There is no `commit(...)` helper on `EventSourcedAggregate`. `apply(...)`
already ties the event and the state transition together.

## Saving new events

After `apply(...)`, new events sit in `pendingEvents`. The repository appends
those events to the stream. It should not clear pending events and it should not
call `markPersisted(...)`; `withCommit` owns that lifecycle after the
transaction commits.

```ts
import type {
  AggregateAddress,
  EventStore,
  UnitOfWorkSession,
} from "@shirudo/ddd-kit";

class OrderRepository {
  constructor(
    private readonly eventStore: EventStore<OrderEvent>,
    private readonly session: UnitOfWorkSession<OrderEvent>,
  ) {}

  private stream(id: OrderId): AggregateAddress<OrderId> {
    return { aggregateType: "Order", aggregateId: id };
  }

  async save(order: Order): Promise<void> {
    if (order.pendingEvents.length === 0) return;

    this.session.enrollSaved(order);

    await this.eventStore.append(this.stream(order.id), order.pendingEvents, {
      expectedVersion: order.persistedVersion ?? 0,
    });
  }
}
```

Save once per aggregate per unit of work, after all domain mutations. Until the
transaction commits, `pendingEvents` remain pending and `persistedVersion`
remains the old stream version. A second save of the same instance in the same
unit of work tries to append the same pending events again with a stale
`expectedVersion`; it should conflict even without another writer.

The normal lifecycle is:

1. Load or create the aggregate.
2. Run domain methods.
3. Save the aggregate once.
4. Return `{ result, aggregates: [aggregate] }` from `withCommit`.
5. `withCommit` writes outbox rows, commits the transaction, then calls
   `markPersisted(version)`.

That last step clears `pendingEvents` and aligns `persistedVersion`.

### Stream events and outbox events

The event store receives the original pending events. The outbox receives
envelopes that reference those same immutable events.

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
    options?: { fromVersion?: number },
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

`readStream(stream)` reports both stream state and events. A missing stream is
`{ exists: false, lastVersion: 0, events: [] }`. An existing stream stays
`exists: true` even when its requested window is empty. An existing stream has
at least one event, so `exists: true` implies `lastVersion >= 1`; metadata or
tombstones without events must be reported as absent. `lastVersion` always
reports the actual head (the event count); `fromVersion` filters only `events`
to positions after that 1-based count. This is how a snapshot-backed repository
distinguishes "aggregate is gone" from "snapshot is already at the head" and
detects a snapshot whose version lies beyond a truncated stream.
Adapters must compute `exists`, `lastVersion`, and `events` from one consistent
view of the stream; do not assemble the result from racing reads.

A database adapter should also reject duplicate or non-contiguous persisted
positions rather than silently folding a truncated stream.

`InMemoryEventStore` is the reference implementation for tests and demos. It is
memory-only and does not participate in your database transaction. Production
adapters must implement the same contract against durable storage.

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
reporting, ordering, and windows. The repository suite covers append conflicts,
duplicate creates, replay equality, rollback purity, commit lifecycle, and the
same missing-vs-empty snapshot semantics through the repository adapter.

## Loading from history

Reconstitution starts with a blank aggregate and folds the stream into it:

```ts
async function findById(id: OrderId): Promise<Order | null> {
  const stream = await eventStore.readStream({
    aggregateType: "Order",
    aggregateId: id,
  });
  if (!stream.exists) return null;

  const order = Order.reconstitute(id);
  const result = order.loadFromHistory(stream.events);

  if (result.isErr()) {
    throw result.error;
  }

  return order;
}
```

`loadFromHistory(...)` returns `Result<void, DomainError>` because a persisted
stream can be corrupt in ways the domain can name (a handler that rejects a
payload it cannot map). One corruption class deliberately does NOT ride the
`Result`: an event addressed to a different aggregate (`ForeignEventError`,
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
the current event shape. The same principle covers snapshots: restoring from
a snapshot does not re-check the historical state against today's
`validateState` rules, so a stream loads identically whether it is replayed
from zero or restored from a snapshot plus tail. Snapshots do get their own
STRUCTURAL gate: override `validateRestoredState(state)` to reject blobs no
version of the model could have produced (missing fields, wrong types); a
`DomainError` from it comes back as `Err`, and the load recipe answers by
discarding the snapshot and refolding from the stream. Rules and structure
are different questions, and only the first one is frozen in history.

Only `DomainError` is caught into the `Result`. Programmer errors still throw.
`MissingHandlerError` also throws, because a forgotten event handler is a code
bug, not a recoverable domain rejection.

Replay is all-or-nothing. If an event in the middle fails with a `DomainError`,
the aggregate rolls back to its pre-replay state and version before returning
`Err`.

Version advances additively:

- a fresh aggregate at version `0` loading three events ends at version `3`
- a persisted aggregate at version `10` catching up on two newer events ends at
  version `12`

The replay target must be clean. If it carries unflushed `pendingEvents`,
`loadFromHistory(...)` throws `UnreplayableAggregateError` before anything
moves. If it has an in-memory version that was never persisted, it also throws.
Replaying onto that object would mark unpersisted history as persisted and
corrupt the next repository save.

Use a fresh `Order.reconstitute(id)` target for normal loads.

## Snapshots

Snapshots are an optimization. The stream remains the source of truth.

When a stream gets long, loading from event zero on every request can dominate
latency. The snapshot path is:

1. Load the latest snapshot.
2. Read stream events after `snapshot.version`.
3. Restore the snapshot and replay the tail.
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

  const tail = await eventStore.readStream(
    address,
    { fromVersion: snapshot.version },
  );

  if (
    !tail.exists ||
    tail.lastVersion < snapshot.version ||
    tail.events.length !== tail.lastVersion - snapshot.version
  ) {
    return discardSnapshotAndRefold();
  }

  const order = Order.reconstitute(id);

  try {
    const result = order.restoreFromSnapshotWithEvents(snapshot, tail.events);

    if (result.isErr()) {
      return discardSnapshotAndRefold();
    }
  } catch (error) {
    if (error instanceof SnapshotSchemaMismatchError) {
      return discardSnapshotAndRefold();
    }

    throw error;
  }

  return order;
}
```

The three stream checks before restore are deliberate. A missing stream means
the snapshot cannot establish aggregate existence. A head behind the snapshot
means the authoritative stream was truncated or replaced. A tail length that
does not bridge `snapshot.version` to `lastVersion` means the adapter omitted a
position. All three discard the derived snapshot and refold from the stream;
none may return the snapshot-backed aggregate.

`restoreFromSnapshotWithEvents(...)` has the same `Result<void, DomainError>`
boundary as `loadFromHistory(...)`. A `DomainError` from snapshot conversion,
snapshot validation, or tail replay becomes `Err`. Non-domain failures throw.

Snapshot schema mismatches throw `SnapshotSchemaMismatchError` unless you
override `migrateSnapshotState(...)`. The usual fallback is to delete the stale
snapshot and replay from zero. The next snapshot save writes the new shape.

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

`InMemorySnapshotStore` is the reference implementation. Production adapters
should pass `createSnapshotStoreContractTests` from
`@shirudo/ddd-kit/testing`.

### Plain snapshot state

Snapshots must round-trip through storage as plain data. The default
`createSnapshot()` fails fast if aggregate state contains values that would not
restore faithfully:

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

abstract class SnapshottingOrder extends EventSourcedAggregate<
  OrderWithItemsState,
  OrderEvent,
  OrderId,
  OrderSnapshotState
> {
  protected override toSnapshotState(
    state: OrderState,
  ): OrderSnapshotState {
    return {
      items: state.items.map((item) => ({
        id: item.id,
        productId: item.productId,
        quantity: item.quantity,
      })),
    };
  }

  protected override fromSnapshotState(
    stored: OrderSnapshotState,
  ): OrderState {
    return {
      items: stored.items.map(
        (item) =>
          new OrderItem(
            item.id,
            item.productId,
            item.quantity,
          ),
      ),
    };
  }
}
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
| Every N events | aggregates have similar event volume | simple, but hot streams may snapshot too often |
| Max snapshot age | traffic varies widely | quiet streams eventually get snapshots, but every save checks time |
| Background sweep | write-path latency matters | operationally heavier, but snapshot cost leaves the hot path |

The most common starting point is every N events after commit:

```ts
const SNAPSHOT_EVERY = 100;

async function snapshotAfterCommit(order: Order): Promise<void> {
  const lastSnapshotVersion =
    (await snapshotVersions.lastVersion("Order", order.id)) ?? 0;

  if (order.version - lastSnapshotVersion < SNAPSHOT_EVERY) return;

  await snapshots.save(
    { aggregateType: "Order", aggregateId: order.id },
    order.createSnapshot(),
  );
}
```

At scale, move the decision to a background worker:

```ts
async function snapshotSweep(): Promise<void> {
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
      order.createSnapshot(),
    );
  }
}
```

There is no `SnapshotPolicy` port, no default frequency, and no built-in
sweeper. Different stores have different native snapshot facilities, and the
right policy depends on stream length, latency budget, and operational tooling.

When event schemas change, snapshots may need attention too. A snapshot is state
derived from historical events and old handler code. Either version snapshot
state with `snapshotSchemaVersion` and discard mismatches, or rebuild affected
snapshots during the event-schema migration.

## Versioning

Every new `apply(...)` bumps the aggregate version by one. There is no opt-out.
For event-sourced aggregates, version means event count.

That gives the repository its optimistic-concurrency baseline:

```ts
await eventStore.append(
  { aggregateType: "Order", aggregateId: order.id },
  order.pendingEvents,
  {
    expectedVersion: order.persistedVersion ?? 0,
  },
);
```

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
