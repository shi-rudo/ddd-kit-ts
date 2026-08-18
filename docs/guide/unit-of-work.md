# Unit of Work

`UnitOfWork` is the write boundary for an application operation. It opens one
transaction, gives the use case repositories bound to that transaction, and
commits aggregate state and events together.

The important part is not the class name. It is the ownership rule: the use
case makes domain decisions, then registers `add`, `update`, or `remove`. The
repository adapter does not write early, and the aggregate does not carry a
database baseline.

## The commit sequence

One successful `run()` follows this order:

1. Open `TransactionScope.transactional(...)`.
2. Build the transaction-bound read adapters and a fresh identity map.
3. Run the use case.
4. Make sure that every tracked aggregate is valid. Freeze each write receipt.
5. Call each repository definition's `flush` in registration order.
6. Write the exact registered event batches to the outbox in the same
   transaction.
7. Commit the transaction.
8. Acknowledge exactly those event batches on the aggregates.
9. Run the optional post-commit observer and in-process event bus.

If any step through the outbox write fails, the transaction rolls back and no
event is acknowledged. A retry starts a fresh unit of work, reloads the
aggregate, and applies the command again.

### Reads do not see registered writes

Durable I/O happens at step 5, after the use case returned. A repository
query inside the use case therefore reads the storage state from before the
run. `findById` is the exception: the identity map returns the tracked
instance for an id the run already knows, including an aggregate that
`add(...)` registered. A secondary-key finder such as `findByEmail` has no
identity-map cover, because the map keys by class and id only. When a use
case adds an aggregate and then queries it by a secondary key in the same
`run()`, the finder returns `undefined`. Branch on the tracked instance you
already hold instead of re-reading it, and protect uniqueness with a
database constraint: a violating `add` fails at flush with
`DuplicateAggregateError`.

## Wiring a repository

A repository definition has six parts:

- The application supplies a repository port to `defineRepository`.
- The aggregate class is the identity-map key.
- The adapter owns a `PersistenceModel`.
- `create` builds the transaction-bound read adapter.
- `flush` performs the registered write.
- `mapError` translates a failed flush into an application-facing
  `InfrastructureError`.

Physical removal is opt-in.

```ts
import {
  defineRepository,
  InfrastructureError,
  type PersistenceModel,
  type Repository,
  type RepositoryTracking,
  UnitOfWork,
} from "@shirudo/ddd-kit";

type OrderRow = {
  readonly state: OrderState;
  readonly version: number;
};

type OrderChange = OrderRow | undefined;

interface ForStoringOrders extends Repository<Order, OrderId> {}

const orderPersistence: PersistenceModel<
  Order,
  OrderRow,
  OrderChange
> = {
  capture: (order) => ({
    state: orderStateDto(order),
    version: order.version,
  }),
  changes: (baseline, order, lifecycle) => {
    const current = {
      state: orderStateDto(order),
      version: order.version,
    };

    return lifecycle === "loaded" && deepEqual(baseline, current)
      ? undefined
      : current;
  },
  isEmpty: (change) => change === undefined,
};

const orderRepositoryDefinition = defineRepository<ForStoringOrders>()({
  aggregate: Order,
  persistence: orderPersistence,
  physicalRemoval: true,
  create: (tx: DrizzleTx, tracking: RepositoryTracking<Order>) =>
    new DrizzleOrderReadAdapter(tx, tracking),
  flush: async (tx: DrizzleTx, write) => {
    switch (write.intent) {
      case "add":
        await insertOrder(tx, write);
        return;
      case "update":
        await updateOrder(tx, write);
        return;
      case "remove":
        await removeOrder(tx, write);
        return;
    }
  },
  mapError: (error, write) => {
    if (error instanceof InfrastructureError) return error;
    return new OrderStoreUnavailableError(write.aggregateId, error);
  },
});

const deps = {
  scope: drizzleScope,
  outbox: drizzleOutbox,
  bus: eventBus,
  repositories: {
    orders: orderRepositoryDefinition,
  },
};
```

The explicit type is the full application port. The adapter returned by
`create` implements only its non-lifecycle methods. It can be a larger concrete
class, but its extra methods do not become application API. `UnitOfWork` supplies
`add` and `update`, and supplies `remove` when both the port and definition opt
into physical removal. An adapter method with one of those names is never
called through the facade.

Only the helper-created definition is accepted. An unbranded object fails with
`InvalidRepositoryDefinitionError`, including for JavaScript callers.

This is deliberate. A write method cannot accidentally issue SQL before the
rest of the operation is ready, forget event harvesting, or use a different
transaction.

`mapError` runs only when `flush` fails. It must preserve a deliberate kit
`InfrastructureError` and translate every database-specific error into one of
the application's infrastructure errors. The mapper is part of the adapter
contract, not a catch-all in the use case.

## Use cases: decide first, register last

Creating and updating are intentionally different operations:

```ts
const orderId = await new UnitOfWork(deps).run(async ({ repositories }) => {
  const order = Order.place(newOrderId(), customerId, items);
  recordPendingEvents(order, domainEvents);

  repositories.orders.add(order);
  return order.id;
});
```

```ts
await new UnitOfWork(deps).run(async ({ repositories }) => {
  const order = await repositories.orders.getById(orderId);

  order.confirm();
  recordPendingEvents(order, domainEvents);

  repositories.orders.update(order);
});
```

`add` means that the aggregate is new in this operation. `update` means that
this operation loaded the exact instance. The call site shows this distinction.
The adapter and aggregate do not infer it from `version`.

Call the registration method last. After a successful `add`, `update`, or
`remove`, the aggregate is sealed for that run. A later version change, event
change, or adapter-projection change throws `AggregateTrackingError` and rolls
the transaction back. The guard runs once before flush and again afterward,
because an asynchronous adapter can yield to other work while the transaction
is still open.

## Read adapters and the identity map

Every successful load calls `tracking.trackLoaded` before returning the
aggregate:

```ts
class DrizzleOrderReadAdapter {
  constructor(
    private readonly tx: DrizzleTx,
    private readonly tracking: RepositoryTracking<Order>,
  ) {}

  async findById(id: OrderId): Promise<Order | undefined> {
    const cached = this.tracking.identityMap.get(Order, id) as
      | Order
      | undefined;
    if (cached) return cached;

    if (this.tracking.identityMap.isDeleted(Order, id)) {
      return undefined;
    }

    const row = await loadOrderRow(this.tx, id);
    if (!row) return undefined;

    const order = Order.reconstitute(id, row.state, row.version);
    return this.tracking.trackLoaded(order);
  }

  async getById(id: OrderId): Promise<Order> {
    const order = await this.findById(id);
    if (!order) {
      throw new AggregateNotFoundError({
        aggregateType: "Order",
        aggregateId: id,
      });
    }
    return order;
  }
}
```

The map enforces one object per aggregate class and id for the duration of the
operation. This is a correctness rule, not just a cache: event batches and
write receipts are bound to object identity. The map is cleared when `run()`
settles, and a removed identity remains tombstoned until then.

Application code cannot access the raw transaction or the tracking capability.
The `UnitOfWorkContext` contains only `repositories` and the optional
cooperative-cancellation `signal`. That keeps infrastructure details out of
the use case and removes the old enrollment escape hatch.

## What a flush receives

`flush` receives an immutable `AggregatePersistenceWrite`:

```ts
interface AggregatePersistenceWrite<TAggregate, TChangeSet> {
  readonly intent: "add" | "update" | "remove";
  readonly aggregateId: TAggregate["id"];
  readonly expectedVersion: Version | undefined;
  readonly version: Version;
  readonly changes: {
    readonly value: TChangeSet;
    readonly empty: boolean;
  };
  readonly events: ReadonlyArray<PendingDomainEvent>;
}
```

The receipt object, its `changes` envelope, and its event array are frozen.
`TChangeSet` remains adapter-owned, so `PersistenceModel.changes` must return a
detached or immutable value rather than a mutable reference into the
aggregate. The Unit of Work cannot safely deep-freeze arbitrary database
driver values.

For `add`, `expectedVersion` is absent. For `update` and `remove`, it is the
version captured when the adapter loaded the aggregate. `version`, `changes`,
and `events` describe the exact moment the use case registered its intent.

Do not read mutable state from the aggregate during flush. The aggregate is
intentionally absent from the receipt. Use `write.changes` for state storage
and `write.events` for an event stream. Use `write.expectedVersion` in the
optimistic-concurrency predicate.

An empty state change does not imply an empty commit. An event-only decision
still needs its outbox or event-stream write. Conversely, a state-only change
can have an empty event batch.

## Atomicity and external effects

Only persistence work belongs in `flush`. The aggregate row or stream append,
physical removal, and outbox write share the transaction.

Do not send email, capture a payment, upload a file, or call a webhook inside
`run()`. A remote call cannot participate in the database transaction and can
succeed even when the database rolls back.

Record the decision as a domain event and let the outbox trigger the external
effect after commit:

```ts
await new UnitOfWork(deps).run(async ({ repositories }) => {
  const booking = await repositories.bookings.getById(bookingId);

  booking.requestPayment(paymentId);
  recordPendingEvents(booking, domainEvents);
  repositories.bookings.update(booking);
});
```

Here, an effect is observable work outside the domain decision. Examples
include a network request, database write, message delivery, timer, or file
operation. The aggregate decides the required action. The application shell
runs the effect with timeouts, cancellation, retries, and observability.

## Cancellation

Pass an `AbortSignal` as the second argument:

```ts
await new UnitOfWork(deps).run(
  async ({ repositories, signal }) => {
    const order = await repositories.orders.getById(orderId);
    order.confirm();
    recordPendingEvents(order, domainEvents);

    if (signal?.aborted) throw signal.reason;
    repositories.orders.update(order);
  },
  { signal: AbortSignal.timeout(5_000) },
);
```

An already-aborted signal prevents the transaction from opening. During the
operation, cancellation is cooperative: the callback can poll the signal and
the transaction scope receives it. If the driver or scope honors the signal, a
database query stops early. Also configure database statement and transaction
timeouts as hard ceilings.

## Errors and retries

The most useful failures are intentionally specific:

| Error | Meaning |
| --- | --- |
| `AggregateTrackingError` | invalid add/update/remove lifecycle or mutation after registration |
| `UnenrolledChangesError` | a loaded aggregate changed but the use case never called `update` |
| `ConcurrencyConflictError` | the adapter's expected-version predicate lost a race |
| `DuplicateAggregateError` | an `add` collided with an existing identity |
| `InvalidRepositoryAdapterError` | a repository factory returned no adapter object |
| `CommitError` | work completed, but the outbox write or transaction commit failed |
| `RollbackError` | work failed and the scope reported a different rollback failure |
| `NestedUnitOfWorkError` | one instance was entered while already running |
| `TransactionClosedError` | a leaked context or tracking capability was used after close |

Do not catch a concurrency conflict and continue inside the same `run()`. The
identity map still holds the stale instance. Retry the whole application
operation with a new `UnitOfWork`, reload, and apply the command again.

Also discard aggregate instances after rollback. Recreate even a new instance.
A failed adapter can leave resources in an uncertain state. A background task
can also keep a reference.

## Contract tests

TypeScript can describe the protocol, but it cannot prove your SQL predicate
or transaction wiring. Run the reusable suite against every real adapter:

```ts
import { createRepositoryContractTests } from "@shirudo/ddd-kit/testing";

describe("DrizzleOrderRepository", () => {
  for (const contract of createRepositoryContractTests(harness)) {
    (contract.skipped ? it.skip : it)(contract.name, contract.run);
  }
});
```

The state-stored suite checks add/update routing, duplicate add, stale update
and removal, identity mapping, no-op behavior, nested state, exact outbox
harvest, and rollback. The event-sourced suite checks exact append batches,
replay, OCC, identity mapping, and atomic stream-plus-outbox rollback.

Optional capabilities produce visible skipped tests. A skip is an unproven
guarantee, not a pass. Run SQL or ORM adapters against a real database. An
in-memory fake cannot prove the actual `WHERE version = ...` clause.

## Deliberate limits

`UnitOfWork` does not provide nested transaction joining, savepoints,
distributed transactions, implicit dirty-object scanning, or an attach API for
detached aggregates. One `run()` is one consistency transaction. Repository
writes are explicit, and the compiler makes a forgotten migration site loud.

For the v2.2 and release-candidate cutover, see
[Migrating to v3](/guide/migrating-to-v3).
