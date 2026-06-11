# Event Sourcing

`EventSourcedAggregate<TState, TEvent, TId>` is the canonical event-sourced root. State is derived from events; `apply(event)` is the only mutation path.

## A minimal event-sourced aggregate

```ts
import {
  EventSourcedAggregate,
  DomainError,
  type Id,
  type DomainEvent,
} from "@shirudo/ddd-kit";

type OrderId = Id<"OrderId">;
type OrderState = { customerId: string; status: "pending" | "confirmed" };

type OrderCreated   = DomainEvent<"OrderCreated",   { customerId: string }>;
type OrderConfirmed = DomainEvent<"OrderConfirmed", { orderId: OrderId }>;
type OrderEvent = OrderCreated | OrderConfirmed;

class OrderAlreadyConfirmedError extends DomainError {
  constructor(public readonly id: OrderId) {
    super(`Order ${id} is already confirmed`);
  }
}

class Order extends EventSourcedAggregate<OrderState, OrderEvent, OrderId> {
  protected readonly aggregateType = "Order";

  static create(id: OrderId, customerId: string): Order {
    const order = new Order(id, { customerId, status: "pending" });
    order.apply(order.recordEvent("OrderCreated", { customerId }));
    return order;
  }

  confirm(): void {
    this.apply(this.recordEvent("OrderConfirmed", { orderId: this.id }));
  }

  // Optional: invariants that depend on current state
  protected validateEvent(event: OrderEvent): void {
    if (event.type === "OrderConfirmed" && this.state.status === "confirmed") {
      throw new OrderAlreadyConfirmedError(this.id);
    }
  }

  protected readonly handlers = {
    OrderCreated: (s: OrderState, e: OrderCreated): OrderState => ({
      ...s,
      customerId: e.payload.customerId,
    }),
    OrderConfirmed: (s: OrderState): OrderState => ({
      ...s,
      status: "confirmed",
    }),
  };
}
```

`apply()` runs three steps in lockstep:

1. **`validateEvent(event)`:** throws a `DomainError` subclass if the event violates an invariant in the current state
2. **handler lookup:** throws `MissingHandlerError` if no handler is registered for `event.type`
3. **atomic commit:** computes `nextState`, then assigns state, pushes the event onto `pendingEvents`, and bumps the version in one tick

If any step throws, **no state is mutated** and no event is queued. The "event for a fact that never happened" footgun is structurally impossible.

::: tip Why no `commit()` helper here
`EventSourcedAggregate` doesn't need a `commit()` helper because `apply()` already enforces the record-after-mutation ordering at the structural level: state is computed by the handler *from* the event, so the two can never be out of sync.
:::

## Persistence: pure-persistence `save()` + `withCommit` lifecycle

After `apply()`, the new event lands in `pendingEvents`. The repository is responsible for **persistence only**: appending the events to the event store with optimistic-concurrency. The `withCommit` orchestrator harvests pending events into the outbox and calls `markPersisted` after the transaction commits.

```ts
class OrderRepository implements IRepository<Order, OrderId> {
  async save(order: Order): Promise<void> {
    const events = order.pendingEvents;
    const expectedVersion = order.version - events.length;
    await this.eventStore.append(order.id, expectedVersion, events);
    // Do NOT call markPersisted here; withCommit handles it after the
    // transaction commits. Calling it inside save clears pendingEvents
    // before withCommit can harvest them, and the outbox would receive
    // nothing.
  }
  // ...
}
```

`markPersisted` is library-internal under the canonical `withCommit` path. It stays on `IAggregateRoot` for consumers running their own orchestration (call it manually **after** harvesting `pendingEvents`). See [Outbox & Transactions](./outbox.md) for the full lifecycle.

## Replay: `loadFromHistory`

```ts
const history: OrderEvent[] = await eventStore.read(orderId);

const order = new Order(orderId, blankState);
const result = order.loadFromHistory(history);

if (result.isErr()) {
  // result.error is a DomainError thrown by apply() during replay
  // common cause: corrupt event stream / failed validateEvent on a historical event
}
```

`loadFromHistory` returns `Result<void, DomainError>` because event-stream corruption is an *expected recoverable failure* at the infrastructure boundary. Unexpected throws (programmer errors, e.g. `TypeError`) still propagate.

The version is advanced **additively**: `startVersion + history.length`. A fresh aggregate (v=0) loading 3 events ends at v=3; an aggregate already at v=1 loading 2 events ends at v=3, not v=2.

## Snapshots: `restoreFromSnapshotWithEvents`

```ts
const snapshot = order.createSnapshot();
const eventsAfterSnapshot = await eventStore.readSince(orderId, snapshot.version);

const order2 = new Order(orderId, blankState);
const result = order2.restoreFromSnapshotWithEvents(snapshot, eventsAfterSnapshot);
```

**All-or-nothing**: if any event mid-replay throws a `DomainError`, the aggregate is rolled back to its pre-call state and version. Partial restoration is never observable to the caller.

### Snapshot state must be plain data: `toSnapshotState` / `fromSnapshotState`

A snapshot is a persistence artifact: it round-trips through your snapshot store as plain data, so prototypes cannot survive it. The default `createSnapshot` therefore **fails fast** (with the offending path) if the state graph contains class instances, functions, uncloneables (Promise/WeakMap/WeakSet), Errors (subclasses and custom fields do not survive `structuredClone`), or symbol-keyed properties (silently dropped by `structuredClone`), instead of producing a snapshot that silently lost state and breaks on the first call after restore.

If your state carries class-based child entities, declare a plain DTO shape via the `TSnapshotState` generic and override the two hooks:

```ts
type OrderSnapshotState = { items: Array<{ sku: string; qty: number }> };

class Order extends EventSourcedAggregate<OrderState, OrderEvent, OrderId, OrderSnapshotState> {
  protected override toSnapshotState(state: OrderState): OrderSnapshotState {
    return { items: state.items.map((i) => i.toPlainData()) };
  }
  protected override fromSnapshotState(stored: OrderSnapshotState): OrderState {
    return { items: stored.items.map(OrderItem.fromPlainData) };
  }
}
```

The override owns isolation: return fresh objects, not references into live state. `AggregateRoot.restoreFromSnapshot` honours the same hooks.

### Snapshot policies: when to snapshot

`createSnapshot` and `restoreFromSnapshotWithEvents` give you the **mechanism**; the **policy** is yours. For an aggregate with a few dozen events, replay from the beginning is cheap and you can skip snapshots entirely. For long-lived aggregates (subscriptions accumulating monthly billing events for years, devices emitting telemetry, etc.), the replay cost dominates load latency and snapshots become essential.

The three canonical strategies, in increasing operational complexity:

#### 1. Every-N-events

Snapshot after every N events have been applied since the last snapshot. Simple, predictable, and easy to reason about. The classic choice; mentioned in Vernon's IDDD §A, Greg Young's ES talks, and shipped by EventStoreDB / Marten as their default.

```ts
const SNAPSHOT_EVERY = 100;

class OrderRepository {
  async save(order: Order): Promise<void> {
    const events = order.pendingEvents;
    await this.eventStore.append(order.id, order.version - events.length, events);

    // Decide whether to snapshot. Read the last snapshot's version
    // (cheaply cacheable) and compare to the new version.
    const lastSnapVersion = await this.snapshotStore.lastVersion(order.id);
    if (order.version - lastSnapVersion >= SNAPSHOT_EVERY) {
      await this.snapshotStore.save(order.id, order.createSnapshot());
    }
  }
}
```

Trade-offs:

- **Pro:** zero coordination; the snapshot decision is local to the save path.
- **Con:** chatty aggregates oversample (a hot stream gets a snapshot every minute even when its state barely changes); cold streams undersample (a subscription that fires twice a year never reaches N).
- **Con:** the snapshot write happens synchronously with the save unless you fire-and-forget it (which costs you the consistency you might rely on under crash recovery).

Pick this when most aggregates have similar churn and you can tune N to a "good enough" middle ground.

#### 2. Time-based

Snapshot when the last snapshot is older than T (clock-time or wall-time since last snapshot). Smooths bursts and idle periods; aggregates with constant low traffic still get snapshots over time.

```ts
const SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

if (order.pendingEvents.length > 0) {
  const lastSnap = await this.snapshotStore.last(order.id);
  if (!lastSnap || Date.now() - lastSnap.snapshotAt.getTime() > SNAPSHOT_MAX_AGE_MS) {
    await this.snapshotStore.save(order.id, order.createSnapshot());
  }
}
```

Trade-offs:

- **Pro:** quiet aggregates still get snapshots eventually.
- **Con:** still synchronous with save; for high-throughput streams you pay the snapshot cost on the hot path.
- **Con:** "every save checks a timestamp" is a small but real per-write cost.

Pick this when traffic varies wildly across aggregates of the same type.

#### 3. On-demand / background job

Move the snapshot decision off the write path entirely. A separate worker (cron job, scheduled task, queue consumer) sweeps aggregates whose `(version - lastSnapVersion)` or `(now - lastSnapshotAt)` exceeds a threshold, loads each one, snapshots, and writes the snapshot back.

```ts
// pseudocode for a background sweeper
async function snapshotSweep(): Promise<void> {
  const candidates = await db.execute(sql`
    SELECT aggregate_id, last_snapshot_version
    FROM aggregate_versions
    WHERE current_version - last_snapshot_version >= ${SNAPSHOT_THRESHOLD}
    LIMIT 1000
  `);
  for (const { aggregate_id, last_snapshot_version } of candidates) {
    const order = await orderRepository.getByIdOrFail(aggregate_id);
    await snapshotStore.save(aggregate_id, order.createSnapshot());
  }
}
```

Trade-offs:

- **Pro:** zero impact on the write path. Snapshot pressure becomes a scheduling concern, not a hot-path one.
- **Pro:** snapshots can be batched, throttled, run on a separate worker pool, prioritised by aggregate size.
- **Con:** more operational machinery, a separate process to monitor, deploy, and reason about.
- **Con:** aggregates between snapshots may have replay latency until the sweep catches them.

Pick this at scale, or when the write path's latency budget is tight, or when you want to snapshot only when you have spare capacity.

#### What the kit does NOT ship

No `SnapshotPolicy` port, no default frequency, no built-in sweeper. Every event store has different snapshotting facilities (EventStoreDB has `LinkTo` + projections, Marten has its own snapshot API, Postgres-backed implementations write to a sibling table). The aggregate exposes `createSnapshot` / `restoreFromSnapshotWithEvents`; the policy lives next to your event-store wiring.

#### A note on snapshot invalidation

When you change an event schema (see [Event Upcasting](./event-upcasting.md)), existing snapshots may also need to be invalidated: the snapshot captured a state shape derived from the old event schema, and a code change to handlers can desync the snapshot from the events that would now replay differently. Two patterns: stamp snapshots with a schema-version number and discard mismatched ones on load (fall back to full replay), or rebuild affected snapshots during the upcast deploy. Neither is wrong; pick by how often you change schemas.

## Versioning

Every `apply()` bumps the aggregate version by one; this is the canonical event-sourcing invariant (Vernon IDDD §9, Greg Young): the aggregate version IS the event count, no opt-out. `loadFromHistory(N events)` advances the version by `N`.

If your event store has its own stream-position concept (EventStoreDB `streamRevision`, Marten / Equinox stream offsets), treat that as a store-layer detail; keep it separate from the aggregate's domain version. The domain version is what optimistic-concurrency callers compare against; the stream position is how your store happens to lay out events on disk.

## Schema evolution

Domain events carry a `version: number` field but the library deliberately does **not** ship a built-in upcaster; upcasting strategies (sync vs async, chained vs schema-registry, load-path vs projection-rebuild) vary too much. See [Event Upcasting](./event-upcasting.md) for the recommended consumer pattern.
