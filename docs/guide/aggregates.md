# Aggregate Roots

An aggregate root is the object your application loads, changes, and saves as one consistency boundary.

Application code should talk to the root. It should not hold references to child entities or mutate value objects behind the root's back. That keeps the aggregate's business rules in one place: the methods on the root.

In DDD terms, the aggregate boundary is also a consistency boundary. Everything inside the boundary should be valid together at the end of a transaction. Rules that need several objects to be checked atomically belong inside the same aggregate; rules that can settle later usually belong in a process manager or saga.

The kit gives you two base classes:

- **`AggregateRoot<TState, TId, TEvent>`** for aggregates whose current state is stored directly.
- **`EventSourcedAggregate<TState, TEvent, TId>`** for aggregates whose state is rebuilt from events. See [Event Sourcing](./event-sourcing.md).

<a id="state-version-domain-events"></a>

## A Small Aggregate

```ts
import {
  AggregateRoot,
  DomainError,
  type DomainEvent,
  type Id,
} from "@shirudo/ddd-kit";
import type { Money } from "@shirudo/ddd-kit/money";

type OrderId = Id<"OrderId">;

type OrderState = {
  customerId: string;
  items: { id: string; qty: number; price: Money }[];
  status: "draft" | "confirmed" | "shipped";
};

type OrderConfirmed = DomainEvent<"OrderConfirmed", { orderId: OrderId }>;
type OrderShipped = DomainEvent<
  "OrderShipped",
  { orderId: OrderId; tracking: string }
>;
type OrderEvent = OrderConfirmed | OrderShipped;

class OrderAlreadyConfirmedError extends DomainError<"ORDER_ALREADY_CONFIRMED"> {
  constructor(public readonly id: OrderId) {
    super({
      code: "ORDER_ALREADY_CONFIRMED",
      message: `Order ${id} is already confirmed`,
    });
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
      this.createEvent("OrderConfirmed", { orderId: this.id }),
    );
  }
}
```

`aggregateType` and `createEvent` are intentionally visible in every aggregate:

- `aggregateType` tells event dispatchers, outbox processors, and projections what kind of aggregate produced an event.
- `createEvent(type, payload)` adds the aggregate id and aggregate type while
  reading neither a clock nor an id generator.

Calling `createDomainEvent(...)` directly still works, but inside an aggregate
`createEvent(...)` is the safer default. The application records the pending
decision with `recordPendingEvents(...)` before persistence.

## Creating New Aggregates

Prefer static factory methods over public constructors.

```ts
class Order extends AggregateRoot<OrderState, OrderId, OrderEvent> {
  protected readonly aggregateType = "Order";

  static place(
    id: OrderId,
    customerId: string,
  ): Order {
    const order = new Order(id, { customerId, items: [], status: "draft" });

    order.addDomainEvent(
      order.createEvent("OrderPlaced", { customerId }),
    );

    return order;
  }
}
```

The method name should use your domain language. `Order.place(...)`, `User.register(...)`, and `Account.open(...)` tell the reader what happened. `Order.create(...)` is valid, but it usually says less.

A factory gives you one public path for creating a valid aggregate. It can reject bad input before the object exists, set the first valid state, and optionally record the aggregate's birth event.

The library does not emit creation events automatically. Some bounded contexts care about `OrderPlaced` or `UserRegistered`; others do not. That choice belongs to your domain.

`AggregateRoot` and `EventSourcedAggregate` use protected constructors, so application code cannot call `new Order(...)` directly. The factory is the public construction API.

This is the aggregate-root version of the Factory Method pattern. Vernon describes factories as the place to create whole, valid aggregates. A standalone factory class can still make sense when construction needs dependencies the aggregate should not know about, but most aggregates only need a named static method on the root.

<a id="reconstitution-loading-existing-aggregates-from-persistence"></a>

## Loading Existing Aggregates

Creating an aggregate and loading an aggregate are different operations.

`Order.place(...)` means a new order is entering the system. A repository load means the order already exists and is only being rebuilt in memory. Loading must not record a new domain event.

DDD literature usually calls that second path reconstitution, rehydration, or materialization. The names vary, but the idea is the same: turn persisted facts back into an in-memory aggregate without making new domain facts.

### State-Stored Aggregates

For state-stored aggregates, add a static reconstitution method next to the factory:

```ts
import type { Version } from "@shirudo/ddd-kit";

class Order extends AggregateRoot<OrderState, OrderId, OrderEvent> {
  protected readonly aggregateType = "Order";

  static place(
    id: OrderId,
    customerId: string,
  ): Order {
    const order = new Order(id, { customerId, items: [], status: "draft" });
    order.addDomainEvent(
      order.createEvent("OrderPlaced", { customerId }),
    );
    return order;
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

`markRestored(version)` tells the aggregate, "these are the domain facts at
this version." It sets the aggregate's current version without recording an
event. It does not remember a database baseline; that belongs to the
operation-scoped `UnitOfWork`.

A repository can then be straightforward:

```ts
async findById(id: OrderId): Promise<Order | undefined> {
  const row = await this.db
    .select()
    .from(orders)
    .where(eq(orders.id, id))
    .get();

  if (!row) return undefined;

  const order = Order.reconstitute(
    row.id as OrderId,
    row.state as OrderState,
    row.version as Version,
  );

  return this.tracking.trackLoaded(order);
}
```

::: warning Creation and update are explicit
Call `repositories.orders.add(order)` for a new aggregate and
`repositories.orders.update(order)` for the exact instance loaded by that
unit of work. Never infer this lifecycle from `version`: a new aggregate may
already have advanced its version before its first persistence operation.

See [Repository -> Explicit lifecycle intent](./repository.md#explicit-lifecycle-intent).
:::

### Event-Sourced Aggregates

For event-sourced aggregates, reconstitution means replaying history. Expose a factory for the empty replay target, then let the repository load history into it:

```ts
class Order extends EventSourcedAggregate<OrderState, OrderEvent, OrderId> {
  protected readonly aggregateType = "Order";

  static reconstitute(id: OrderId): Order {
    return new Order(id, blankInitialState);
  }
}

async findById(id: OrderId): Promise<Order | null> {
  const events = await this.eventStore.read(id);
  if (events.length === 0) return null;

  const order = Order.reconstitute(id);
  const result = order.loadFromHistory(events);

  if (result.isErr()) throw result.error;

  return order;
}
```

`loadFromHistory(events)` folds old events into state, advances the version, and leaves `pendingEvents` empty. Replayed events are historical facts, not new facts.

The initial state should be inert: enough structure for your handlers to fold events into, but not a new domain event. If you use it often, expose it as something like `Order.empty(id)`.

For longer streams, see [Snapshots](./event-sourcing.md#snapshots).

### Why Loading Must Stay Quiet

A reconstituted aggregate is the same domain object it was before the process restarted. Recording an `OrderRehydrated` event would tell subscribers that something happened, even though nothing did.

That kind of spurious event can double-count projections, re-trigger process managers, or publish outbox messages for work that has already happened. The rule is simple: factories may record new facts; reconstitution must not.

## Changing State with `commit`

Use `commit(newState, events)` for normal aggregate changes.

It does three things in order:

1. Validates and assigns the new state.
2. Records the event or events.
3. Bumps the aggregate version.

If state validation fails, no event is recorded and the version does not change. That makes `commit` safer than calling `setState` and `addDomainEvent` by hand.

```ts
this.commit(
  { ...this.state, status: "confirmed" },
  this.createEvent("OrderConfirmed", { orderId: this.id }),
);

this.commit(newState, [eventA, eventB]);
this.commit({ ...this.state, lastViewedAt: new Date() });
```

The last example changes state without recording an event, but still bumps the version.

::: info `commit()` always bumps the version
Changing aggregate state should normally move the version. If you deliberately need a mutation that does not participate in optimistic concurrency, use `setStateWithoutVersionBump(newState)` directly and do not call `commit`.
:::

## Where Invariants Live

An aggregate should reject impossible business states and impossible business operations. The right place for the check depends on what the rule is about.

This is where the theory matters most. Aggregate invariants are not just validation sprinkled around the codebase; they are the rules that protect the aggregate's consistency boundary. Put each rule where the aggregate can enforce it reliably.

| Location | Use it for | Kit seam |
| --- | --- | --- |
| `EntityConfig.validateState(newState)` | Rules that must be true for the state itself, such as non-empty ids or valid quantities | Runs during construction, `setState`, and `commit` |
| `validateEvent(event)` | Event-sourced rules that must hold before an event is applied | Runs during `apply()` |
| Domain method guard | Rules about whether this method can run now | Inline check before mutation |
| Process manager / saga | Rules that span multiple aggregates | Event subscriber plus command dispatch |

### State Invariants

Pass a pure `validateState` function for rules that must always be true when
the aggregate holds a state.

```ts
function validateOrderState(state: OrderState): void {
  if (state.items.length > 100) {
    throw new TooManyItemsError();
  }

  if (state.items.some((item) => item.qty < 1)) {
    throw new InvalidQuantityError();
  }
}

class Order extends AggregateRoot<OrderState, OrderId, OrderEvent> {
  protected readonly aggregateType = "Order";

  constructor(id: OrderId, state: OrderState) {
    super(id, state, { validateState: validateOrderState });
  }
}
```

The validator runs on construction and every `setState` call, including calls
made by `commit` and state-stored snapshot restoration. It catches both bad
domain transitions and corrupt state loaded from persistence. It does not run
while event-sourced history evolves; replay uses historical facts and pure
event handlers rather than today's decision rules.

### Event-Sourced Invariants

Use `validateEvent` when an event must be valid against the aggregate's current state before it is applied.

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

`validateEvent` runs before the event handler calculates the next state. If it throws, state is unchanged and the event is not added to `pendingEvents`.

State-stored aggregates do not have `validateEvent`, because they do not apply events as the source of truth. Put the same kind of guard in the domain method instead.

### Method Guards

Most business rules live at the top of domain methods. The method checks whether the operation is allowed, then changes state.

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
      this.createEvent("OrderConfirmed", { orderId: this.id }),
    );
  }
}
```

Put guards before any mutation. If the method throws, the aggregate should be exactly as it was before the call.

::: tip Method guard or `validateEvent`?
For event-sourced aggregates, use `validateEvent` when the rule should also protect replay from a corrupt event stream.

Use a method guard when the rule is only about the public operation being called right now.
:::

### Cross-Aggregate Rules

Some rules span more than one aggregate:

- a confirmed order must be paid within 30 minutes
- a failed shipment must trigger a refund
- a subscription cancellation must stop future billing

Those rules cannot be enforced inside one aggregate transaction unless the affected objects are actually one aggregate. If they are separate aggregates, model the rule with eventual consistency.

This is the practical version of the "modify one aggregate per transaction" rule. If two objects must change together immediately, they may be one aggregate. If they can coordinate through events, keep the boundary smaller and compensate when needed.

```ts
eventBus.subscribe("OrderConfirmed", async (event) => {
  // Schedule a timeout check or wait for PaymentReceived.
});

eventBus.subscribe("ShippingFailed", async (event) => {
  await commandBus.execute({ type: "RefundPayment", ... });
  await commandBus.execute({ type: "CancelOrder", ... });
});
```

If a cross-aggregate rule must be immediate and transactional, revisit the aggregate boundary. Otherwise, use a process manager or saga to react, wait, and compensate. See [CQRS & Buses -> Process Managers](./cqrs-and-buses.md#process-managers-sagas) and [examples/saga](https://github.com/shi-rudo/ddd-kit-ts/tree/main/examples/saga).

## Optimistic Concurrency

Aggregates carry a version. Repositories use that version to detect concurrent writes.

```ts
import { sameVersion } from "@shirudo/ddd-kit";

const before = await repo.findById(id);

// Time passes. Another writer may update the same aggregate.

const after = await repo.findById(id);

if (!sameVersion(before!, after!)) {
  // Another writer changed the aggregate.
}
```

Repository adapters should throw `ConcurrencyConflictError` when the row or
stream no longer matches the version captured during load. The
`UnitOfWork` owns that baseline and passes it to `flush` as
`write.expectedVersion`; the aggregate does not carry persistence metadata.

The use case registers `add`, `update`, or `remove` only after its domain
decisions are complete. The unit of work then persists the immutable change
set and exact event batch atomically.

See [Repository](./repository.md) and [Outbox & Transactions](./outbox.md) for the full lifecycle.

## Snapshots

Snapshots capture aggregate state and version so an aggregate can be restored
without replaying or rebuilding everything from scratch. Their stored shape is
an adapter concern, so the mapping lives outside the aggregate.

```ts
import {
  captureAggregateSnapshot,
  defineSnapshotModel,
  reconstituteAggregateFromSnapshot,
} from "@shirudo/ddd-kit";

const orderSnapshots = defineSnapshotModel({
  aggregateType: "Order",
  schemaVersion: 2,
  capture: (order: Order) => orderStateDto(order),
  reconstitute: (id: OrderId, state: OrderStateDto, version: Version) =>
    Order.reconstitute(id, stateFromDto(state), version),
  migrate: (stored, storedSchemaVersion) =>
    migrateOrderSnapshot(stored, storedSchemaVersion),
});

const snapshot = captureAggregateSnapshot(
  orderSnapshots,
  order,
  clock(),
);
const fresh = reconstituteAggregateFromSnapshot(
  orderSnapshots,
  order.id,
  snapshot,
);
```

`captureAggregateSnapshot` validates the application-supplied time and detaches
the persistence DTO, so later mutations cannot alter stored snapshot data.
Reconstitution always creates a fresh aggregate through the model; it never
mutates a live instance or records a new domain fact.

Live aggregate state remains `protected`. Give the persistence adapter an
explicit DTO projection such as `orderStateDto(order)` rather than exposing a
generic public state getter. For event-sourced aggregates, restore the
snapshot first and then call `loadFromHistory` with only the stream tail.

## When to Skip `commit`

`commit()` is the default for aggregate changes. Reach for lower-level methods only when you need behavior `commit` deliberately does not provide:

- state changes that should not bump the version, such as cosmetic cache fields
- audit-only events that do not change state still use
  `commit({ ...this.state }, event)` so their persisted commit gets a unique
  version/cursor
- a multi-step operation where you want exactly one version bump at the end

When you do this, mutate state first and record events second. An
already-persisted aggregate may not harvest events without advancing its
version: `withCommit` rejects that cursor collision.

::: warning Un-bumped mutations can lose concurrent writes
A mutation that does not bump the version is invisible to optimistic concurrency. Another writer can load the same version, update successfully, and overwrite your change without a `ConcurrencyConflictError`.

That is why the method is named `setStateWithoutVersionBump`. Use it only for data where a lost update is acceptable.
:::
