# Common Mistakes

This page collects mistakes that have shown up in real kit usage.

Use it as a troubleshooting guide. The first section covers mistakes TypeScript usually catches. The second section covers runtime bugs that are more dangerous because they can pass tests and fail later. The last section covers design and testing choices that work mechanically but point in the wrong direction.

## Compile-Time Mistakes

These fail during type-checking. The fix is usually mechanical.

### Missing `aggregateType`

Every concrete `AggregateRoot` and `EventSourcedAggregate` subclass needs an aggregate type:

```ts
class Order extends AggregateRoot<OrderState, OrderId, OrderEvent> {
  protected readonly aggregateType = "Order";
}
```

If you omit it, TypeScript reports that the class does not implement the inherited abstract member `aggregateType`.

The value should be the canonical domain name for the aggregate. Outbox dispatchers, projection handlers, audit logs, and other event consumers use it for routing. See [Aggregate Roots](./aggregates.md).

### Forgetting the Event Generic

`AggregateRoot` defaults its event type to `never`. That is useful for aggregates that do not emit events, but it is noisy when you forgot the generic.

```ts
// Wrong: events are locked to `never`
class Order extends AggregateRoot<OrderState, OrderId> {}

// Right
class Order extends AggregateRoot<OrderState, OrderId, OrderEvent> {}
```

The symptom is an error on `addDomainEvent`, `commit(state, event)`, or `apply(event)` saying the event is not assignable to `never`.

If the aggregate records events, pass the event union as the third generic. See [Aggregate Roots -> A Small Aggregate](./aggregates.md#state-version-domain-events).

### Using Old Domain Event Names

The aggregate event queue is called `pendingEvents`.

Use `pendingEvents` and `clearPendingEvents()` on both aggregate base classes. Older names such as `domainEvents` and `clearDomainEvents()` are not part of the current interface.

### Passing a Transaction to `repo.save`

`IRepository.save` takes the aggregate only:

```ts
await orderRepository.save(order);
```

Do not call `repo.save(tx, aggregate)`. Repositories are already bound to a transaction when you create them inside `withCommit` or `UnitOfWork`.

```ts
await withCommit({ tx }, async (tx) => {
  const orderRepository = makeOrderRepository(tx);
  await orderRepository.save(order);

  return { result: order.id, aggregates: [order] };
});
```

See [Repository](./repository.md).

### Returning Events from `withCommit`

The `withCommit` callback should return participating aggregates, not manually harvested events.

```ts
// Wrong
return { result, events: order.pendingEvents };

// Right
return { result, aggregates: [order] };
```

The callback declares which aggregates participated. `withCommit` harvests pending events itself after the save path has run. See [Outbox & Transactions](./outbox.md).

## Runtime Mistakes

These compile. Some even pass happy-path tests. They are more dangerous because they usually show up as missing events, duplicate events, or false concurrency conflicts.

### Calling `createDomainEvent` Inside an Aggregate

Inside aggregate methods, prefer `this.recordEvent(type, payload)`.

`createDomainEvent(...)` is still the right primitive outside aggregates: process managers, tests, system events, and integration events can use it directly. But inside an aggregate it skips the automatic `aggregateId` and `aggregateType` metadata.

`withCommit` catches missing aggregate metadata at the harvest boundary, but the better fix is to record aggregate events through the aggregate:

```ts
this.commit(
  { ...this.state, status: "confirmed" },
  this.recordEvent("OrderConfirmed", { orderId: this.id }),
);
```

See [Domain Events](./domain-events.md).

### Overriding `markPersisted`

Do not override `markPersisted(version)` unless you are extending the framework lifecycle itself.

`markPersisted` clears pending events after a successful commit. If an override forgets to call `super.markPersisted(version)`, the same events remain pending and can be dispatched again on the next commit.

For domain-specific post-save behavior, override `onPersisted(version)` instead. It runs after the framework cleanup.

### Calling `markPersisted` from `Repository.save`

`Repository.save` should persist data. It should not change the aggregate lifecycle.

`withCommit` calls `markPersisted` after the transaction commits. If `save` calls it earlier, pending events are cleared before `withCommit` can harvest them, and the outbox receives nothing.

The lifecycle is:

1. The domain method changes the aggregate and records pending events.
2. The repository persists the aggregate.
3. `withCommit` harvests events for the outbox.
4. The transaction commits.
5. The aggregate is marked persisted.

See [Outbox & Transactions](./outbox.md).

### Using `version === 0` for Insert vs Update

Do not decide between insert and update with `aggregate.version === 0`.

A new aggregate can be mutated before its first save. A factory may record a creation event and bump the version to 1; a setup method may bump it again. The database row still does not exist.

Use `aggregate.persistedVersion === undefined` as the insert marker. That field tracks whether the aggregate has ever been loaded from or saved to persistence.

The optimistic-concurrency predicate should also use `persistedVersion` as the expected database version. See [Repository -> Insert vs update](./repository.md#insert-vs-update-the-persistedversion-convention).

### Returning Multiple Instances for the Same Aggregate

Within one Unit of Work, repeated `findById(id)` calls should return the same in-memory aggregate instance.

This is the Identity Map pattern from Fowler: one logical object, one in-memory object per unit of work. Without it, two separate `Order` instances with the same id can both collect events, and object-identity dedupe will not recognize that they are the same aggregate.

Use the [`UnitOfWork` identity map](./unit-of-work.md#identity-map), or keep a per-operation identity map in repositories that use `withCommit` directly. See [Repository](./repository.md).

### Setting Global Factories Directly in Tests

`setEventIdFactory` and `setClockFactory` change module-level state. In parallel test runners, that state can leak between tests.

Use the scoped helpers:

```ts
withEventIdFactory(() => "deterministic-id", () => {
  // The factory is restored after this function returns, throws, or awaits.
});
```

The same rule applies to `withClockFactory`. See [Domain Events -> Factory bootstrap](./domain-events.md).

### Storing Aggregates in Edge Runtime Globals

Do not keep aggregate instances in module scope on Cloudflare Workers, Vercel Edge, or similar runtimes.

Those isolates can be reused across requests. A module-scoped aggregate can leak state from one request into another. Load aggregates per request through a repository instead. See [Edge Runtimes](./edge-runtimes.md).

### Treating Kit Errors as Unstructured Errors

Older pre-v3 advice said that strict `base-error` helpers could not see kit errors. That is no longer true.

Kit errors now carry `code`, `category`, and `retryable`. Helpers such as `isStructuredError`, `isChainRetryable`, and `getFirstRetryableCause` work with kit errors. `RetryingTransactionScope` uses the tolerant `someChainRetryable(err)` helper so wrapped retryable errors still count. See [Result vs Throw](./result-vs-throw.md).

## Design and Testing Mistakes

These choices can still produce working code, but they usually test the wrong thing or blur a boundary the kit is trying to keep explicit.

### Mocking `CommandBus` or `QueryBus`

The buses are already in-process dispatchers. In most unit tests, register the real handler on a fresh bus instead of mocking the bus itself.

```ts
const bus = new CommandBus<MyCommandMap>();
bus.register("PlaceOrder", placeOrderHandler);

const result = await bus.execute({
  type: "PlaceOrder",
  payload: { customerId },
});
```

That test exercises your handler through the same dispatch path application code uses. A mocked bus mostly tests the mock. See [CQRS & Buses](./cqrs-and-buses.md).
