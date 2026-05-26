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
  protected readonly aggregateType = "Order";

  static draft(id: OrderId, customerId: string): Order {
    return new Order(id, { customerId, items: [], status: "draft" });
  }

  confirm(): void {
    if (this.state.status === "confirmed") {
      throw new OrderAlreadyConfirmedError(this.id);
    }
    this.commit(
      { ...this.state, status: "confirmed" },
      this.recordEvent("OrderConfirmed", { orderId: this.id }),
    );
  }
}
```

::: warning `aggregateType` and `recordEvent` are required as of rc.8
Every concrete `AggregateRoot` / `EventSourcedAggregate` subclass must declare `protected readonly aggregateType = "..."` as a string literal — both bases declare it `abstract readonly`, so omitting it is a compile error. Use `this.recordEvent(type, payload)` from inside aggregate methods (and `instance.recordEvent(...)` from inside static factories) to record events; the helper auto-injects `aggregateId` and `aggregateType` into the event metadata. Calling `createDomainEvent(...)` directly inside an aggregate method is still legal, but `withCommit`'s harvest guard throws if either field is missing — `recordEvent` makes the right thing impossible to forget. Outbox dispatchers and projection handlers route by both fields.
:::

### Construction: static factory methods, not public constructors

The example above uses `Order.draft(...)`, not `new Order(...)`. That is the convention everywhere in the kit's examples — and the canonical **Factory Method on the Aggregate Root** form of Vernon IDDD §11's *Factories*. (§11 also covers standalone factory classes — `OrderFactory.place(customerId, ...)` — for cases where construction needs dependencies the aggregate shouldn't know about. Both are valid; for most aggregates a static method on the class is enough.)

```ts
class Order extends AggregateRoot<OrderState, OrderId, OrderEvent> {
  protected readonly aggregateType = "Order";

  // Static factory: named with a domain verb, ideally a specific one
  // (place / draft / register / open / submit). `Order.create(...)`
  // works but is the weakest choice — it borrows the JS boilerplate
  // verb instead of the ubiquitous language. Reach for the more
  // specific verb when there is one.
  static place(id: OrderId, customerId: string): Order {
    const order = new Order(id, { customerId, items: [], status: "draft" });
    // Optional: record the creation event inside the factory.
    // `order.recordEvent(...)` is legal here — static methods have
    // access to the protected helper on instances of their own class.
    order.addDomainEvent(order.recordEvent("OrderPlaced", { customerId }));
    return order;
  }
}
```

The factory shape buys two things Vernon §11 specifically calls out, plus one event-sourcing concern that comes along for the ride:

1. **Domain language (Vernon §11).** `Order.place(...)` reads like the ubiquitous language; `new Order(...)` reads like JavaScript boilerplate. The factory names the *act of creation* as a first-class domain operation. This is §11's primary argument.
2. **Whole-object validity at construction (Vernon §11).** The factory can refuse to create an invalid aggregate — `Order.place` throws if `customerId` is blank — *before* the object exists. A constructor can do the same, but a factory makes it the obvious place and removes the temptation to scatter partial-init logic across multiple methods.
3. **Atomic creation event (ES / CQRS, not §11).** If your bounded context records a birth event (`OrderPlaced`, `UserRegistered`, `AccountOpened`), the factory is the natural home — the aggregate is born into a state that includes "having been created", and the event lands in `pendingEvents` immediately so the next `withCommit` picks it up. The library does NOT auto-emit a creation event; this is the consumer's call per bounded context.

`AggregateRoot` and `EventSourcedAggregate` both declare `protected constructor(...)`, so `new Order(...)` from outside the aggregate's own file is a compile error. The static factory is the only public construction path.

### Reconstitution: loading existing aggregates from persistence

`Order.place(...)` creates a *new* aggregate — the order is being born into the system, and the factory records the creation event. But when `Repository.getById(orderId)` reads an existing order's row from the database, the order *already exists in the world*. We just need to assemble its in-memory representation. No creation event should fire; the order wasn't placed just now, it was placed weeks ago.

Vernon IDDD §11 distinguishes these two paths explicitly:

- **Factory** — for *new* aggregates. Records creation events, validates new-state invariants.
- **Reconstitution** — for *existing* aggregates loaded from persistence. No events, just state assembly.

Terminology varies across DDD authors and the broader CQRS/ES community: Vernon uses *reconstitute* and *materialize* interchangeably, Khononov prefers *reconstitute*, Greg Young uses *rehydrate* (especially in event-sourcing contexts). They all describe the same operation.

#### State-stored aggregates: `Order.reconstitute(id, state, version)`

Add a second static method alongside the factory. It calls the protected constructor and the protected `markRestored(version)` lifecycle marker, both legal from inside the aggregate's own class body:

```ts
class Order extends AggregateRoot<OrderState, OrderId, OrderEvent> {
  protected readonly aggregateType = "Order";

  static place(id: OrderId, customerId: string): Order {
    // Factory: new aggregate, records creation event.
  }

  /**
   * Reconstitution: assemble an in-memory Order from a persisted row.
   * No events recorded — the order already exists in the world.
   */
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

`markRestored(version)` is the Post-Load symmetric of `markPersisted(version)` (Post-Save). It syncs both `version` and `persistedVersion` to the loaded DB version, so the next `repository.save(order)` sees `persistedVersion !== undefined` and routes to UPDATE (with the loaded version as the OCC baseline). Unlike `markPersisted`, it does NOT fire the `onPersisted` hook — load-time semantics are distinct from save-time semantics. The Factory-vs-Reconstitution distinction is Vernon's (IDDD §11).

::: warning Why `persistedVersion`, not `version === 0`, drives Insert vs Update
A naive Repository might route INSERT vs UPDATE on `aggregate.version === 0`. That breaks the moment a fresh aggregate is mutated before its first save. `Order.place(...)` typically calls `commit(state, event)` which bumps `version` to 1; a follow-up `order.updateProfile(...)` bumps it to 2 — but no DB row exists yet. Routing on `version === 0` would misroute to UPDATE, hit zero rows, and throw a spurious `ConcurrencyConflictError`. `persistedVersion === undefined` is the correct INSERT marker because it tracks the persistence layer's state, not in-memory mutations. See [Repository → Insert vs update](./repository.md#insert-vs-update-the-persistedversion-convention).
:::

The Repository's `getById` becomes mechanical:

```ts
async getById(id: OrderId): Promise<Order | null> {
  const row = await this.db
    .select()
    .from(orders)
    .where(eq(orders.id, id))
    .get();
  if (!row) return null;
  return Order.reconstitute(
    row.id as OrderId,
    row.state as OrderState,
    row.version as Version,
  );
}
```

`pendingEvents` is empty after reconstitution — `addDomainEvent` is never called along this path — so the next `withCommit` sees an aggregate with no events to harvest, exactly as the persistence layer represents it.

#### Event-sourced aggregates: `loadFromHistory` is the reconstitution path

For `EventSourcedAggregate`, reconstitution means *replaying the event history*. The kit already exposes this as `loadFromHistory(events)`:

```ts
async getById(id: OrderId): Promise<Order | null> {
  const events = await this.eventStore.read(id);
  if (events.length === 0) return null;

  const order = new Order(id, blankInitialState);  // empty canvas
  const result = order.loadFromHistory(events);
  if (result.isErr()) throw result.error;          // corrupt stream
  return order;
}
```

`loadFromHistory` calls each event's handler to fold state forward, advances the version by `events.length`, and records **nothing** in `pendingEvents` — events flowing through `loadFromHistory` are historical facts, not new ones. See [Event Sourcing → Replay](./event-sourcing.md#replay-loadfromhistory) for the full contract, and [Snapshots](./event-sourcing.md#snapshots-restorefromsnapshotwithevents) for the faster path past a threshold.

The "empty canvas" `blankInitialState` is the inert starting state your handlers fold events into — typically a minimal valid `OrderState` with no items, status `"draft"`, etc. Convention: expose it via a static `Order.empty(id)` if it's needed often, or inline it in the repository if it's only used in one place.

#### Why reconstitution must NOT record events

A reconstituted aggregate is, by definition, the same domain object it was before the process restarted. Recording an `OrderRehydrated` event would tell the rest of the system "this thing just happened" — when nothing did. Subscribers, projections, and the outbox would react to a non-event; the read model would double-count; sagas would re-trigger. The cardinal rule of reconstitution is *no side effects on the event pipeline*.

The kit's two reconstitution paths enforce this structurally: `markRestored` writes the version baseline without firing the `onPersisted` hook, and `loadFromHistory` folds state without recording new events. Both leave `pendingEvents` empty and align `persistedVersion` so the next `repository.save(order)` routes to UPDATE — load and save are mechanically distinct lifecycle markers (Vernon §11).

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
  protected readonly aggregateType = "Order";

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
  protected readonly aggregateType = "Order";

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
  protected readonly aggregateType = "Order";

  confirm(): void {
    if (this.state.status === "shipped") {
      throw new CannotConfirmShippedOrderError(this.id);
    }
    if (this.state.items.length === 0) {
      throw new CannotConfirmEmptyOrderError(this.id);
    }
    this.commit(
      { ...this.state, status: "confirmed" },
      this.recordEvent("OrderConfirmed", { orderId: this.id }),
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
