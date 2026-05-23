# Aggregate Roots

An Aggregate Root is the entry-point Entity of an aggregate — the only object outside code is allowed to hold a reference to. All access to child entities and value objects goes through the root.

The kit ships two flavours:

- **`AggregateRoot<TState, TId, TEvent>`** — state stored directly. Behaviour mutates state and optionally records domain events.
- **`EventSourcedAggregate<TState, TEvent, TId>`** — state is derived from events. See [Event Sourcing](./event-sourcing.md).

## State + Version + Domain Events

```ts
import {
  AggregateRoot,
  DomainError,
  type Id,
  type DomainEvent,
} from "@shirudo/ddd-kit";

type OrderId = Id<"OrderId">;
type OrderState = {
  customerId: string;
  items: { id: string; qty: number; priceCents: number }[];
  status: "draft" | "confirmed" | "shipped";
};

type OrderConfirmed = DomainEvent<"OrderConfirmed", { orderId: OrderId }>;
type OrderShipped   = DomainEvent<"OrderShipped",   { orderId: OrderId; tracking: string }>;
type OrderEvent = OrderConfirmed | OrderShipped;

class OrderAlreadyConfirmedError extends DomainError {
  constructor(public readonly id: OrderId) {
    super(`Order ${id} is already confirmed`);
  }
}

class Order extends AggregateRoot<OrderState, OrderId, OrderEvent> {
  static draft(id: OrderId, customerId: string): Order {
    return new Order(id, { customerId, items: [], status: "draft" });
  }

  confirm(): void {
    if (this.state.status === "confirmed") {
      throw new OrderAlreadyConfirmedError(this.id);
    }
    this.commit(
      { ...this.state, status: "confirmed" },
      createDomainEvent("OrderConfirmed", { orderId: this.id }),
    );
  }
}
```

### `commit(newState, events)`

The canonical record-after-mutation helper:

1. Calls `setState(newState, /* bumpVersion */ true)` — runs `validateState`, throws on rejection
2. Only if state mutated successfully, appends the event(s) via `addDomainEvent`
3. Always bumps the version

If `validateState` throws, **no event is recorded and no version is bumped** — atomicity preserved without ceremony. Use this instead of calling `setState` + `addDomainEvent` separately to make the "event for a fact that never happened" footgun impossible.

`commit()` accepts a single event or an array. Pass `[]` (or omit) for state-only mutations:

```ts
this.commit({ ...this.state, lastViewedAt: new Date() }); // no event
this.commit(newState, [eventA, eventB]); // two events in one transition
```

::: info `commit()` always bumps the version
The `bumpVersion` parameter was deliberately removed. Recording a domain event implies "something version-worthy happened" — if you need to mutate state without bumping (cosmetic caches, internal state), call `setState(newState, false)` directly.
:::

## Optimistic Concurrency

```ts
import { sameVersion } from "@shirudo/ddd-kit";

const before = await repo.getById(id);
// ... time passes, maybe another writer comes in
const after = await repo.getById(id);

if (!sameVersion(before!, after!)) {
  // version mismatch — another writer modified the aggregate
}
```

Repository implementations should throw `ConcurrencyConflictError` (a `DomainError` subclass) on save when the expected version doesn't match. After a successful save the repository calls `aggregate.markPersisted(newVersion)` to push the new version back into the in-memory aggregate and clear any recorded domain events. See [Repository](./repository.md).

## Snapshots

```ts
const snapshot = order.createSnapshot();
// { state, version, snapshotAt: Date } — state is deep-cloned

const fresh = new Order(id, blankState);
fresh.restoreFromSnapshot(snapshot);
// fresh.version === snapshot.version
// fresh.state   === snapshot.state (deep-cloned)
```

`createSnapshot` uses `structuredClone` so the snapshot is fully isolated from later mutations. `restoreFromSnapshot` runs `validateState` on the restored state before assigning it.

## When to skip `commit()`

`commit()` is the safe default. Reach for `setState` + `addDomainEvent` separately when:

- The state change should not bump the version (cosmetic, audit-side cache)
- You're emitting an audit-only event without changing state (`OrderViewed`)
- Multiple state transitions belong to one logical operation and the version should bump only once

In any of those cases, **mutate state first, then record events.** See [Design Decisions](./design-decisions.md#event-sourcing-structurally-enforces-record-after-mutation).
