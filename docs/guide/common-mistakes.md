# Common Mistakes

A working catalogue of footguns the kit has accumulated from real consumer reports. Grouped by failure mode: compile-time errors first (TypeScript catches you immediately), then silent runtime bugs (passes type-check, fails in production), then architectural / testing mistakes (the code "works" but the design is wrong).

If you hit any of these and the fix below doesn't unblock you, the corresponding deep-dive guide page usually has the worked example.

## Compile-time errors

These fail to build. TypeScript points at them; the fix is mechanical.

### Aggregate subclass without `protected readonly aggregateType = "..."`

Both `AggregateRoot` and `EventSourcedAggregate` declare `aggregateType` as `abstract readonly`. Every concrete subclass MUST declare it as a string literal:

```ts
class Order extends AggregateRoot<OrderState, OrderId, OrderEvent> {
  protected readonly aggregateType = "Order";
  // ...
}
```

TS error if missing: *"Non-abstract class 'X' does not implement inherited abstract member aggregateType"*. The string is what downstream consumers (outbox dispatchers, projection handlers, audit logs) route by, so pick the canonical domain name. See [Aggregate Roots](./aggregates.md).

### Forgetting the `TEvent` generic on an aggregate that emits events

```ts
// Wrong: TEvent defaults to `never`, every event-recording call errors
class Order extends AggregateRoot<OrderState, OrderId> { /* ... */ }

// Right
class Order extends AggregateRoot<OrderState, OrderId, OrderEvent> { /* ... */ }
```

Forgetting the third generic locks `TEvent` to `never`; every `addDomainEvent` / `commit(state, event)` / `apply(event)` call becomes *"argument not assignable to never"*. This is the most common compile-time footgun newcomers hit. See [Aggregate Roots → State + Version + Domain Events](./aggregates.md#state-version-domain-events).

### Using `aggregate.domainEvents` / `clearDomainEvents()`

Wrong names. Use `pendingEvents` / `clearPendingEvents()` on both aggregate flavours; they are part of the `IAggregateRoot` interface.

### Calling `repo.save(tx, aggregate)`

Wrong shape. `IRepository.save` takes only the aggregate. The transaction is bound to the repository at construction (factory pattern: `const orderRepository = makeOrderRepository(tx)` inside the `withCommit` callback). See [Repository](./repository.md).

### Returning `{ result, events: aggregate.pendingEvents }` from the `withCommit` callback

Wrong shape; type-rejected. Return `{ result, aggregates: [aggregate, ...] }` and let `withCommit` harvest the events itself. The callback's job is to declare *which aggregates participated*; harvesting their pending events is the framework's job, not yours. See [Outbox & Transactions](./outbox.md).

## Silent runtime bugs (the dangerous ones)

These compile, often pass tests, and fail in production, usually as silently dropped events, double-dispatched events, or false `ConcurrencyConflictError`s. Read all of these before going to production.

### Calling `createDomainEvent(...)` directly inside an aggregate domain method

Skips the auto-injection of `aggregateId` + `aggregateType`. The `withCommit` harvest boundary catches it at runtime with a guard (*"withCommit: event 'X' is missing aggregateId and aggregateType"*), but the right move is `this.recordEvent(type, payload)` inside aggregates, which auto-injects both fields from `this.id` and `this.aggregateType`. Downstream consumers (outbox dispatchers, projection handlers) route by these fields. See [Domain Events](./domain-events.md).

### Overriding `markPersisted(version)` instead of `onPersisted(version)`

Without `super.markPersisted(version)` the framework's `pendingEvents = []` cleanup never runs; the next `withCommit` re-dispatches the same events through the outbox. Override `protected onPersisted(version)` instead: it fires *after* the cleanup, and there is nothing in the parent implementation to call `super` on. See [Aggregate Roots → onPersisted hook](./aggregates.md).

### Calling `aggregate.markPersisted(...)` from inside `Repository.save`

`save` is pure persistence; `withCommit` calls `markPersisted` post-commit. Doing it from `save` clears `pendingEvents` *before* the harvest, and the outbox receives nothing.

### Routing `Repository.save` INSERT vs UPDATE on `aggregate.version === 0`

Broken in any flow where a fresh aggregate is mutated before its first save (factory + setup wizard, factory + profile editor). The version advances past zero in memory while the DB row still doesn't exist; the save tries an UPDATE that affects zero rows and throws a spurious `ConcurrencyConflictError`.

Use `aggregate.persistedVersion === undefined` for the INSERT marker: that field tracks the DB state, not in-memory mutations. The OCC predicate's `WHERE version = ?` also uses `persistedVersion` (the load-time / last-save baseline), not `aggregate.version`. Reconstitute factories use `order.markRestored(version)`, not `order.setVersion(version)`. See [Repository → Insert vs update](./repository.md#insert-vs-update-the-persistedversion-convention).

### Repository that returns a fresh aggregate instance for every `getById(id)` call within one `withCommit`

Violates the Identity Map contract (Fowler PoEAA). `withCommit`'s aggregate-dedupe is by JS object identity; two distinct instances with the same logical id slip through the dedupe and double-dispatch events. Repositories must maintain an identity map per Unit of Work. See [Repository](./repository.md).

### Setting `setEventIdFactory` / `setClockFactory` per-test without `withEventIdFactory` / `withClockFactory`

Module globals leak across vitest's parallel test workers. Use the scoped helpers (try/finally restore + thenable-guard) for test isolation:

```ts
withEventIdFactory(() => "deterministic-id", () => {
  // test body: global factory is restored on return / throw / await
});
```

See [Domain Events → Factory bootstrap](./domain-events.md).

### Storing aggregate instances at module top level on Cloudflare Workers / Vercel Edge

Worker isolates are shared across requests; a module-scoped aggregate instance leaks state cross-request. Aggregates are per-request, loaded from `Repository.getById(id)` inside the request handler. See [Edge Runtimes](./edge-runtimes.md).

### Calling `isChainRetryable(err)` on a wrapped ddd-kit error

`@shirudo/base-error`'s `isChainRetryable` filters strictly on the `StructuredError` shape (`code` + `category` + `retryable`). ddd-kit's errors (`DomainError`, `InfrastructureError`, `ConcurrencyConflictError`, `AggregateNotFoundError`) extend `BaseError` directly without `code` / `category` (they discriminate by class, not RFC 9457 fields), so `isChainRetryable` returns `false` silently and OCC retry middleware skips the conflict.

Use `someChainRetryable(err)` for whole-chain checks or `isRetryable(err)` for single-level. Same trap for `getRootCauseRetryable` and `getFirstRetryableCause`. See [Result vs Throw](./result-vs-throw.md).

## Architectural / testing mistakes

These compile *and* often pass review: the design is the bug.

### Mocking `CommandBus` / `QueryBus` in unit tests

The buses are already in-process dispatchers: register your real handler against a fresh `new CommandBus()` in the test, no mock needed. Mocking the bus tests the bus, not your handler.

```ts
// Right
const bus = new CommandBus<MyCommandMap>();
bus.register("PlaceOrder", placeOrderHandler);
const result = await bus.execute({ type: "PlaceOrder", payload: { /* ... */ } });
```

See [CQRS & Buses](./cqrs-and-buses.md).
