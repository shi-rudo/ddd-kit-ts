# Common Mistakes

This page collects mistakes that have shown up in real kit usage.

Read it less like a list of gotchas and more like a debugging guide. Each mistake points to a small mismatch in the mental model: where aggregate metadata comes from, who owns transaction state, when events are harvested, or what a repository is allowed to do.

The sections are ordered by how the mistake usually appears:

- **Compile-time mistakes** are noisy. TypeScript tells you something is wrong.
- **Runtime mistakes** are more dangerous. They compile and often pass happy-path tests.
- **Design and testing mistakes** can work mechanically, but they put the boundary in the wrong place.

## Compile-Time Mistakes

These fail during type-checking. The fix is usually mechanical, but the underlying model is still worth understanding.

### Missing `aggregateType`

Every concrete `AggregateRoot` and `EventSourcedAggregate` subclass needs an aggregate type:

```ts
class Order extends AggregateRoot<OrderState, OrderId, OrderEvent> {
  protected readonly aggregateType = "Order";
}
```

If you omit it, TypeScript reports that the class does not implement the inherited abstract member `aggregateType`.

This field is not decoration and it is not only for logging. It is part of the event routing contract. When an aggregate records an event through `recordEvent`, the kit writes both the aggregate id and the aggregate type into the event metadata. Outbox dispatchers, projection handlers, audit loggers, and cross-cutting subscribers can then route by "this event came from an `Order` with id `order-123`", not just by the event name.

Use the canonical domain name for the aggregate. If your domain calls it `Order`, write `"Order"`. Avoid infrastructure names such as `"orders_table"` or `"OrderAggregateRoot"`. Those names leak implementation details into events, and events tend to outlive implementation details.

Review signal: if an event consumer needs to guess the aggregate type from the event name, the aggregate metadata contract is probably missing or being bypassed. See [Aggregate Roots](./aggregates.md).

### Forgetting the Event Generic

`AggregateRoot` defaults its event type to `never`:

```ts
// Wrong: events are locked to `never`
class Order extends AggregateRoot<OrderState, OrderId> {}

// Right
class Order extends AggregateRoot<OrderState, OrderId, OrderEvent> {}
```

The symptom is an error on `addDomainEvent`, `commit(state, event)`, or `apply(event)` saying the event is not assignable to `never`.

This default is deliberate. Many aggregates do not emit events, and those aggregates should not be able to accidentally record one. For event-emitting aggregates, the third generic is how you opt into the event union.

The event union is also a design tool. It forces the aggregate to name the facts it can produce. If an `Order` can emit `OrderConfirmed` and `OrderShipped`, model that explicitly:

```ts
type OrderEvent = OrderConfirmed | OrderShipped;

class Order extends AggregateRoot<OrderState, OrderId, OrderEvent> {
  protected readonly aggregateType = "Order";
}
```

Do not work around the error with `any`. That turns a useful compile-time boundary into a runtime surprise. If the aggregate records events, pass the event union as the third generic. See [Aggregate Roots -> A Small Aggregate](./aggregates.md#state-version-domain-events).

### Using Old Domain Event Names

The aggregate event queue is called `pendingEvents`.

Use `pendingEvents` and `clearPendingEvents()` on both aggregate base classes. Older names such as `domainEvents` and `clearDomainEvents()` are not part of the current interface.

The word "pending" matters. These events have happened in memory, but they have not been safely handed to the transaction/outbox boundary yet. Calling them `domainEvents` makes them sound like a historical event log. They are not. They are a short-lived queue owned by the aggregate until `withCommit` harvests them and `markPersisted` clears them after commit.

Review signal: code that reads `pendingEvents` directly should be rare. Application code returns invocation-bound commit tokens and lets `withCommit` do the harvest. Direct reads are mostly for tests, custom orchestration, or diagnostics.

### Passing a Transaction to `repo.save`

`IRepository.save` takes the aggregate only:

```ts
await orderRepository.save(order);
```

Do not call `repo.save(tx, aggregate)`.

In this kit, a repository instance is already bound to the transaction. You create it inside the transaction boundary:

```ts
await withCommit({ scope, outbox }, async (tx, enrollment) => {
  const orderRepository = makeOrderRepository(tx);
  await orderRepository.save(order);

  return {
    result: order.id,
    commits: [enrollment.enrollSaved(order)],
  };
});
```

That shape keeps the transaction out of the domain-facing repository API. Callers should not have to thread `tx` through every method. More importantly, it prevents accidental mixing: a repository created for transaction A should not be called with transaction B.

This is a small version of dependency inversion. The application service asks for an order repository scoped to this operation; the adapter knows how to bind it to the database transaction. See [Repository](./repository.md).

### Returning Naked Aggregates Or Events From `withCommit`

The `withCommit` callback should return opaque commit tokens, not naked aggregates or manually harvested events.

```ts
// Wrong
return { result, events: order.pendingEvents };

// Also wrong: touching an aggregate does not prove it was saved
return { result, aggregates: [order] };

// Right, after the repository write succeeds
return {
  result,
  commits: [enrollment.enrollSaved(order)],
};
```

The callback's job is to provide commit evidence for repository writes that participated in this invocation. Tokens are opaque and invocation-scoped, so a forged token or one retained from an earlier call is rejected inside the transaction. Every token issued during the callback must be returned in `commits`; omitting one also rejects inside the transaction. If an enrolled write should not commit, throw so the transaction rolls back. `withCommit` then harvests events from those enrolled aggregates at the correct point in the lifecycle.

Manual harvesting is tempting because it looks explicit. The problem is timing. If every caller decides when to read events, clear events, or publish events, the transaction boundary stops being a boundary. Some callers will harvest before save, some after save, and some after an error. The whole point of `withCommit` is to centralize that order:

1. Run the application work.
2. Persist the aggregates.
3. Harvest pending events.
4. Write the outbox in the same transaction.
5. Commit.
6. Mark aggregates as persisted.

Return commit tokens and let the unit-of-work boundary do its job. See [Outbox & Transactions](./outbox.md).

## Runtime Mistakes

These compile. Some even pass happy-path tests. They are more dangerous because they usually show up as missing events, duplicate events, or false concurrency conflicts.

### Calling `createDomainEvent` Inside an Aggregate

Inside aggregate methods, prefer `this.recordEvent(type, payload)`.

```ts
this.commit(
  { ...this.state, status: "confirmed" },
  this.recordEvent("OrderConfirmed", { orderId: this.id }),
);
```

`createDomainEvent(...)` is still the right primitive outside aggregates. Process managers, tests, system events, and integration events can use it directly. Inside an aggregate, though, it skips the automatic `aggregateId` and `aggregateType` metadata.

That metadata is not incidental. It is how downstream code connects a fact back to the aggregate that produced it. A projection may need to know which order to update. An outbox dispatcher may need to shard or route by aggregate type. A process manager may need to correlate follow-up work.

`withCommit` has a harvest guard that catches events missing aggregate metadata. That guard is a last line of defense, not the preferred workflow. The preferred workflow is to record aggregate events through the aggregate so the metadata cannot be forgotten.

Review signal: `createDomainEvent` inside a method on an `AggregateRoot` or `EventSourcedAggregate` should draw attention. Outside aggregates it can be correct; inside aggregates it is usually the wrong abstraction. See [Domain Events](./domain-events.md).

### Overriding `markPersisted`

Do not override `markPersisted(version)` unless you are extending the framework lifecycle itself.

`markPersisted` is not a domain hook. It is lifecycle machinery. After a successful commit, it aligns the aggregate's persisted version and clears pending events. If an override forgets to call `super.markPersisted(version)`, the aggregate still carries events that were already written to the outbox. The next commit can dispatch them again.

For domain-specific post-save behavior, override `onPersisted(version)` instead:

```ts
protected override onPersisted(version: Version): void {
  this.lastPersistedVersionSeenByTests = version;
}
```

`onPersisted` runs after the framework cleanup. There is no parent implementation you need to remember to call, so it is the safer extension point.

Senior review rule: lifecycle methods that maintain invariants should be hard to override casually. If a subclass wants notification, use the notification hook, not the state-mutating lifecycle method.

### Calling `markPersisted` from `Repository.save`

`Repository.save` should persist data. It should not change the aggregate lifecycle.

`withCommit` calls `markPersisted` after the transaction commits. If `save` calls it earlier, pending events are cleared before `withCommit` can harvest them, and the outbox receives nothing.

This mistake usually comes from trying to make `save` feel complete: "I saved the row, so I should mark the aggregate saved." That is correct in a simple Active Record style model. It is wrong in an outbox-backed transaction model.

The database row save and the aggregate lifecycle marker happen at different moments:

1. The domain method changes the aggregate and records pending events.
2. The repository persists the aggregate state.
3. `withCommit` harvests pending events.
4. The outbox records are written in the same transaction.
5. The transaction commits.
6. The aggregate is marked persisted and pending events are cleared.

If the transaction rolls back after `save`, the in-memory aggregate must not pretend its events were flushed. That is why `save` is pure persistence and `withCommit` owns the post-commit marker.

Review signal: repository implementations should not call `markPersisted`, `clearPendingEvents`, or other aggregate lifecycle methods. See [Outbox & Transactions](./outbox.md).

### Using `version === 0` for Insert vs Update

Do not decide between insert and update with `aggregate.version === 0`.

A new aggregate can be mutated before its first save. A factory may record a creation event and bump the version to 1. A setup method may bump it again. The database row still does not exist.

That means `version` answers "how many version-worthy changes has this in-memory aggregate seen?" It does not answer "does this aggregate already exist in the database?"

Use `aggregate.persistedVersion === undefined` as the insert marker. That field tracks the persistence baseline:

- `undefined` means no successful load or save has established a database baseline.
- a number means the aggregate was loaded from or saved to persistence at that version.

The optimistic-concurrency predicate should also use `persistedVersion` as the expected database version:

```sql
UPDATE orders
SET state = ?, version = ?
WHERE id = ? AND version = ?
```

The last placeholder should be `aggregate.persistedVersion`, not `aggregate.version`. The current in-memory version is what you want to write. The persisted version is what you expect the database still to contain.

Review signal: any insert/update branch based on `version === 0` is suspect. The repository should branch on `persistedVersion === undefined`. See [Repository -> Insert vs update](./repository.md#insert-vs-update-the-persistedversion-convention).

### Returning Multiple Instances for the Same Aggregate

Within one Unit of Work, repeated `findById(id)` calls should return the same in-memory aggregate instance.

This is the Identity Map pattern from Fowler: one logical object, one in-memory object per unit of work. The reason is not memory optimization. The reason is correctness.

Consider this sequence:

```ts
const orderA = await orders.findById(orderId);
const orderB = await orders.findById(orderId);

orderA.confirm();
orderB.ship("tracking-123");

return {
  result: orderId,
  commits: [
    enrollment.enrollSaved(orderA),
    enrollment.enrollSaved(orderB),
  ],
};
```

If `orderA` and `orderB` are different objects with the same id, both can carry pending events and both can receive different commit tokens. Object-identity dedupe cannot help, because these are genuinely two JavaScript objects. Depending on save order, you can get duplicate events, stale state, or a concurrency conflict that looks random.

An identity map makes the second `findById` return the same object. Now the operation is forced to deal with one aggregate instance and one version history.

Use the [`UnitOfWork` identity map](./unit-of-work.md#identity-map), or keep a per-operation identity map in repositories that use `withCommit` directly. The map must be scoped to one operation. A process-wide identity map would leak stale state across requests. See [Repository](./repository.md).

### Sharing One Mutable Factory Across Tests or Requests

Mutable module configuration makes the last writer the effective owner. In parallel test runners or overlapping requests, that state leaks across operation boundaries.

This kind of leak is painful because each test passes alone. The failure only appears when the suite runs in a different order or when workers overlap.

Create an immutable factory owned by the test or request:

```ts
const domainEvents = createDomainEventFactory({
  eventIdFactory: () => "deterministic-id",
  clock: () => new Date("2026-01-01T00:00:00.000Z"),
});

const order = makeOrder({ domainEventFactory: domainEvents });
```

No reset is needed, and awaited code keeps using the same value because nothing is installed globally. If a test needs deterministic ids or clocks, keep that dependency visible in the test setup and pass it through aggregate construction or reconstitution. See [Domain Events -> Instance-bound factories](./domain-events.md#instance-bound-factories).

### Storing Aggregates in Edge Runtime Globals

Do not keep aggregate instances in module scope on Cloudflare Workers, Vercel Edge, or similar runtimes.

Those isolates can be reused across requests. Module scope is not request scope. A module-scoped aggregate can carry state from one user request into another user's request.

This is especially easy to miss in local development, where the runtime may feel like "one process for my test request." Edge runtimes optimize by keeping isolates warm. Anything in module scope should be treated as shared infrastructure: configuration, clients, immutable lookup tables. Aggregate instances are mutable domain state and belong inside the request or operation.

Correct shape:

```ts
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const orderRepository = makeOrderRepository(env.DB);
    const order = await orderRepository.getById(orderIdFrom(request));

    // Use the aggregate for this request only.
  },
};
```

See [Edge Runtimes](./edge-runtimes.md).

### Replaying Only the First EventStore Page

`EventStore.readStream` returns one bounded page, not the complete stream. A
repository that calls it once and immediately returns the aggregate silently
loads partial state whenever the stream exceeds its chosen `limit`.

Start at `fromVersion: 0`, record the first page's `lastVersion`, and pass that
value as `toVersion` on every later page. Advance `fromVersion` by the number of
events actually returned, because adapters may return fewer than requested.
Replay each page into the same fresh aggregate, and add it to the identity map
only after the cursor reaches the pinned head. A zero-length page before that
point is a violated adapter contract, not end-of-stream; throw
`NonProgressingEventStreamPageError` so the stream address and both cursors
survive into logs and telemetry.

Pinning the head matters. Without it, events appended during a slow load keep
moving the target, so one request can observe an open-ended mixture of stream
states. See [Event Sourcing](./event-sourcing.md#loading-from-history).

### Treating Kit Errors as Unstructured Errors

Older pre-v3 advice said that strict `base-error` helpers could not see kit errors. That is no longer true.

Kit errors now carry `code`, `category`, and `retryable`. Helpers such as `isStructuredError`, `isChainRetryable`, and `getFirstRetryableCause` work with kit errors. `RetryingTransactionScope` uses the tolerant `someChainRetryable(err)` helper so wrapped retryable errors still count.

The practical point: do not collapse kit errors into plain strings or generic `Error` instances at the boundary where retry, redaction, or user-facing mapping still matters. Preserve the structured error as the cause or return it through the result path your application uses.

Review signal: code that catches `ConcurrencyConflictError` and throws `new Error("conflict")` loses retryability and category information. Prefer wrapping with cause or mapping at the outermost boundary where you no longer need structured behavior. See [Result vs Throw](./result-vs-throw.md).

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

That test exercises your handler through the same dispatch path application code uses. A mocked bus mostly tests the mock.

The useful seam is usually one level lower. If the handler talks to a repository, fake the repository. If the handler publishes to an external broker, fake the broker adapter. But the in-process bus is not expensive, slow, or nondeterministic. Replacing it with a mock removes the dispatch behavior you actually rely on in production.

Senior review rule: mock across process or infrastructure boundaries, not across cheap in-process control flow. The bus is control flow. See [CQRS & Buses](./cqrs-and-buses.md).

## Review Checklist

When reviewing code that uses the kit, scan for these signals:

- aggregate events recorded with `this.recordEvent(...)` inside aggregates
- repositories created inside the transaction or unit-of-work scope
- repositories that do not call aggregate lifecycle methods
- insert/update branching on `persistedVersion`, not `version`
- one aggregate instance per id inside one unit of work
- event-sourced repositories continue bounded pages to a pinned stream head
- scoped test factories instead of leaked global factories
- edge/runtime code that loads aggregates per request
- structured errors preserved until the boundary that maps them

Most production bugs in this area come from moving responsibility one layer too early: repositories clearing events, callers harvesting events, tests owning globals, or application code bypassing aggregate metadata. Keep each responsibility at its boundary and the kit stays predictable.
