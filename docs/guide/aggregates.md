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

### Construction: static factory methods, not public constructors

The example above uses `Order.draft(...)`, not `new Order(...)`. That is the convention everywhere in the kit's examples — and the convention Vernon IDDD §11 calls the **Aggregate Factory**.

```ts
class Order extends AggregateRoot<OrderState, OrderId, OrderEvent> {
  // Static factory: named with a domain verb (place / draft / register /
  // open / create / submit) — not the boilerplate `new`.
  static place(id: OrderId, customerId: string): Order {
    const order = new Order(id, { customerId, items: [], status: "draft" });
    // Record the creation event inside the factory, atomically with
    // the aggregate's appearance in the system.
    order.addDomainEvent(
      createDomainEvent(
        "OrderPlaced",
        { customerId },
        { aggregateId: id, aggregateType: "Order" },
      ),
    );
    return order;
  }
}
```

Three reasons this is the right shape:

1. **Domain language.** `Order.place(...)` reads like the ubiquitous language. `new Order(...)` reads like JavaScript boilerplate. Vernon's §11 framing: a factory captures the *act of creation* as a first-class domain operation.
2. **Encapsulated validation.** The factory can refuse to create an invalid aggregate (`Order.place` could throw if `customerId` is blank) before the object exists. A constructor can do this too, but a factory makes it the obvious place.
3. **Atomic creation event.** State-stored aggregates and event-sourced aggregates both need to record their birth event somewhere. The factory is the canonical home — the aggregate is *born* into a domain state that includes "having been created", and the event lands in `pendingEvents` immediately so the next `withCommit` picks it up.

The library does not auto-emit a creation event. If your bounded context cares (most do — `OrderPlaced`, `UserRegistered`, `AccountOpened`), record it inside the factory. If you don't (rare; usually internal scaffolding), skip it.

`AggregateRoot` and `EventSourcedAggregate` both declare `protected constructor(...)`, so `new Order(...)` from outside the aggregate's own file is a compile error. The static factory is the only public construction path.

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

## Where invariants live

DDD aggregates enforce **business rules** at the type and runtime level. The kit gives you four distinct locations to put them — pick by *what the rule is about*, not by what feels familiar.

| Location | What it guards | Throws on violation | Library hook |
|---|---|---|---|
| **1. Per-state (structural invariant)** | "the state itself must always be valid in isolation" — `total >= 0`, `items.length <= 100`, status is one of N values | `DomainError` subclass | `validateState(newState)` runs on every `setState` / `commit` |
| **2. Per-event (event-sourced only)** | "this event must be valid against the current state" — `OrderShipped` only after `OrderConfirmed` | `DomainError` subclass | `validateEvent(event)` runs at the start of `apply()` |
| **3. Per-method (domain method guard)** | "this operation only makes sense from certain states" — `confirm()` rejects if already shipped | `DomainError` subclass | Inline `if (...) throw ...` at the top of the domain method, before any state mutation |
| **4. Cross-aggregate (process manager / saga)** | "after Order is placed, Payment must eventually be received within 30 minutes" | Compensating commands, not exceptions | `EventBus` subscribers + a Process Manager aggregate. See [CQRS & Buses → Process Managers](./cqrs-and-buses.md#process-managers-sagas) and [examples/saga/](https://github.com/shi-rudo/2-ts/tree/main/examples/saga). |

### Per-state (`validateState`)

The state must always be valid on its own — independent of any history. If a state can never be reached without breaking a rule, `validateState` catches it:

```ts
class Order extends AggregateRoot<OrderState, OrderId, OrderEvent> {
  protected validateState(state: OrderState): void {
    if (state.items.length > 100) {
      throw new TooManyItemsError(this.id);
    }
    if (state.items.some((i) => i.qty < 1)) {
      throw new InvalidQuantityError(this.id);
    }
  }
}
```

Runs on **every** `setState` call (including via `commit`). Catches both legitimate domain violations and corrupted-state restorations.

### Per-event (`validateEvent` on `EventSourcedAggregate`)

The event must be valid against the *current* state at the moment of `apply()`. This is the canonical place for "lifecycle invariants" — operations that depend on prior history:

```ts
class Order extends EventSourcedAggregate<OrderState, OrderEvent, OrderId> {
  protected validateEvent(event: OrderEvent): void {
    if (event.type === "OrderConfirmed" && this.state.status === "confirmed") {
      throw new OrderAlreadyConfirmedError(this.id);
    }
    if (event.type === "OrderShipped" && this.state.status !== "confirmed") {
      throw new OrderCannotShipUnconfirmedError(this.id);
    }
  }
}
```

Runs **before** the handler computes `nextState`. Atomic — if it throws, no state mutates and no event lands in `pendingEvents`.

State-stored `AggregateRoot` has no `validateEvent` because there's no `apply()` — equivalent guards go in the domain method (location 3).

### Per-method (domain-method guard)

The most common location: a domain method's first responsibility is to refuse impossible operations from the current state. Vernon IDDD §10 calls these "command-side invariants":

```ts
class Order extends AggregateRoot<OrderState, OrderId, OrderEvent> {
  confirm(): void {
    if (this.state.status === "shipped") {
      throw new CannotConfirmShippedOrderError(this.id);
    }
    if (this.state.items.length === 0) {
      throw new CannotConfirmEmptyOrderError(this.id);
    }
    this.commit(
      { ...this.state, status: "confirmed" },
      createDomainEvent("OrderConfirmed", { orderId: this.id }),
    );
  }
}
```

The guards live at the top of the method, **before any mutation**, so a thrown error leaves the aggregate untouched.

::: tip Per-method vs per-event guards
For event-sourced aggregates, the same lifecycle rule could go in either `validateEvent` or the domain method. The convention: put the rule in `validateEvent` if it's also relevant during replay (a corrupt event stream needs the rule to catch the corruption); put it in the domain method only if it's a "you can't call this method right now" rule that shouldn't fire during replay.
:::

### Cross-aggregate (process manager / saga)

Some invariants span aggregates: "every confirmed order must result in a payment within 30 minutes", "every shipment failure must trigger a refund". These cannot be enforced transactionally — DDD aggregate boundaries are also transaction boundaries (Vernon §10: *modify one aggregate per transaction*). The right mechanism is **eventual consistency**: an `EventBus` subscriber listens for the triggering event, checks the cross-aggregate invariant, and dispatches a compensating command if it's violated.

```ts
// In a Process Manager aggregate (see examples/saga/)
eventBus.subscribe("OrderConfirmed", async (event) => {
  // Schedule a timeout check, or wait for PaymentReceived, etc.
});

eventBus.subscribe("ShippingFailed", async (event) => {
  // Compensate forward: refund payment + cancel order
  await commandBus.execute({ type: "RefundPayment", ... });
  await commandBus.execute({ type: "CancelOrder", ... });
});
```

If you find yourself wanting to enforce a cross-aggregate invariant transactionally, that's the strongest signal in DDD that **your aggregate boundaries are wrong** (Vernon §10). Merge the two aggregates, or accept the invariant as eventually-consistent and compensate via process managers.

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

Repository implementations should throw `ConcurrencyConflictError` (an `InfrastructureError` subclass) on save when the expected version doesn't match. `save()` itself is **pure persistence** — it does not touch the aggregate's in-memory state. The `withCommit` orchestrator harvests `pendingEvents` and calls `markPersisted` after the transaction commits. See [Repository](./repository.md) and [Outbox & Transactions](./outbox.md) for the full lifecycle.

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
