# Event Sourcing

`EventSourcedAggregate<TState, TEvent, TId>` is the canonical event-sourced root. State is derived from events; `apply(event)` is the only mutation path.

## A minimal event-sourced aggregate

```ts
import {
  EventSourcedAggregate,
  createDomainEvent,
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
  static create(id: OrderId, customerId: string): Order {
    const order = new Order(id, { customerId, status: "pending" });
    order.apply(createDomainEvent("OrderCreated", { customerId }));
    return order;
  }

  confirm(): void {
    this.apply(createDomainEvent("OrderConfirmed", { orderId: this.id }));
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

1. **`validateEvent(event)`** — throws a `DomainError` subclass if the event violates an invariant in the current state
2. **handler lookup** — throws `MissingHandlerError` if no handler is registered for `event.type`
3. **atomic commit** — computes `nextState`, then assigns state, pushes the event onto `pendingEvents`, and bumps the version in one tick

If any step throws, **no state is mutated** and no event is queued. The "event for a fact that never happened" footgun is structurally impossible.

::: tip Why no `commit()` helper here
`EventSourcedAggregate` doesn't need a `commit()` helper because `apply()` already enforces the record-after-mutation ordering at the structural level — state is computed by the handler *from* the event, so the two can never be out of sync.
:::

## Persistence: `pendingEvents` + `markPersisted`

After `apply()`, the new event lands in `pendingEvents`. The repository writes them to the event store and then calls `markPersisted(version)`:

```ts
class OrderRepo implements IRepository<Order, OrderId> {
  async save(order: Order): Promise<void> {
    const events = order.pendingEvents;
    await this.eventStore.append(order.id, order.version - events.length, events);
    order.markPersisted(order.version); // pushes new version + clears pendingEvents
  }
  // ...
}
```

`markPersisted` is required by the `IAggregateRoot` interface, so a repository can implement against the interface alone without coupling to the concrete class.

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

## Versioning

Every `apply()` bumps the aggregate version by one — this is the canonical event-sourcing invariant (Vernon IDDD §9, Greg Young): the aggregate version IS the event count, no opt-out. `loadFromHistory(N events)` advances the version by `N`.

If your event store has its own stream-position concept (EventStoreDB `streamRevision`, Marten / Equinox stream offsets), treat that as a store-layer detail — keep it separate from the aggregate's domain version. The domain version is what optimistic-concurrency callers compare against; the stream position is how your store happens to lay out events on disk.

## Schema evolution

Domain events carry a `version: number` field but the library deliberately does **not** ship a built-in upcaster — upcasting strategies (sync vs async, chained vs schema-registry, load-path vs projection-rebuild) vary too much. See [Event Upcasting](./event-upcasting.md) for the recommended consumer pattern.
