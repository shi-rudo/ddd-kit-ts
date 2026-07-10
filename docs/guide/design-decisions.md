# Design Decisions

This page explains the choices in the kit that are not obvious from the API alone.

Most of these decisions are trade-offs, not universal rules. The point is to show where the kit draws its boundaries, why those boundaries exist, and when a consumer might reasonably choose a different shape on top.

## Result lives at the App-Service boundary, not in the domain

The kit keeps one clear error axis:

- Domain code throws typed errors.
- Application boundaries decide whether to turn those errors into `Result`.
- Infrastructure replay paths return `Result` when corrupted input is an expected recoverable case.

Aggregates, entities, value-object constructors, `validateState`, and `validateEvent` throw `DomainError` subclasses. That matches the DDD model: an invariant violation means the current operation tried to put the domain into a state the domain rejects. A stack trace and a concrete class such as `OrderAlreadyConfirmedError` are useful there.

The boundary is different. A command handler or HTTP adapter often wants to return `Result` because it is translating an application outcome into a transport response:

```ts
const result = await commandBus.execute({
  type: "ConfirmOrder",
  orderId,
});

if (result.isErr()) {
  return conflictOrBadRequest(result.error);
}
```

Be precise about the APIs:

- `CommandHandler<C, R, E>` returns `Promise<Result<R, E>>`.
- `CommandBus.execute(...)` returns `Promise<Result<R, E>>`.
- `QueryHandler<Q, R>` returns `Promise<R>` because read handlers usually return data directly.
- `QueryBus.execute(...)` wraps query output in `Result<R, E>` for callers that want a safe boundary.
- `QueryBus.executeUnsafe(...)` returns `R` and lets handler failures throw.
- `withCommit(...)` returns the committed result `R`; it is a transaction orchestrator, not a `Result` wrapper.

Event-sourced replay is a third case. `loadFromHistory` and `restoreFromSnapshotWithEvents` return `Result<void, DomainError>` because a persisted stream or snapshot can be corrupt. The repository may need to inspect that error, rebuild from zero, discard a bad snapshot, or fail the load without treating it as a programmer bug.

The design goal is not "never throw" or "always throw". The design goal is that each layer uses one failure style for the job it owns. See [Result vs Throw](./result-vs-throw.md).

## In-process buses are first-class for edge runtimes

`CommandBus` and `QueryBus` are small in-memory dispatchers. They are not fake production buses. They are the right tool when the handler runs in the same process as the caller:

- Cloudflare Workers, Vercel Edge, Deno Deploy, and similar runtimes
- modular monoliths
- tests
- CLIs and local scripts

The important limitation is equally deliberate: they are not message brokers. They do not provide retries, dead-letter queues, backpressure, cross-process delivery, or transport-level observability.

That split keeps handlers portable. `CommandHandler<C, R>` and `QueryHandler<Q, R>` are the contract. The in-process bus is one dispatcher for that contract. RabbitMQ, Kafka, SQS, NATS, or a framework-specific bus can be another dispatcher.

The kit also avoids middleware pipeline machinery. Logging, authorization, metrics, tracing, and correlation can be added with handler decorators. A library-level pipeline would quickly become an application framework, and this kit intentionally stops before that point.

## The Specification primitive ships without translation machinery

The repository query extension is `IQueryableRepository<TAgg, TId, TFilter>`, and the filter type is owned by the adapter:

- a Drizzle repository can use SQL fragments
- a Prisma repository can use `WhereInput`
- a Mongo repository can use filter documents
- an in-memory repository can use predicates

For criteria that belong to the domain language rather than to a storage language, the kit ships `Specification<T>`: a named, executable criterion with `isSatisfiedBy`, combinators for `and`/`or`/`not`, and an introspectable composite structure, usable as the `TFilter`.

What the kit still does not ship is translation machinery. A `Specification<T>` powerful enough to translate itself across Drizzle, Prisma, Mongo, and SQL builders would have to become an expression-tree system, and an expression-tree system is a query framework. So predicates stay opaque, evaluation stays in memory, and a storage adapter translates the named leaves explicitly, recursing through the composite structure. The repository guide's Specifications section walks through this, including the drift risk when one rule lives as both a predicate and a query, and the shared-fixture test that contains it.

The same reasoning explains why there is no visitor interface in the kit: a visitor's methods enumerate the specifications of one particular domain, and only that domain's owner can write them. What the kit guarantees instead is that such a layer stays buildable. The combinators can be overridden and the composite structure can be set by subclasses; the repository guide shows the full double-dispatch construction for teams that want the compiler to enforce translation completeness across several targets.

## Event sourcing structurally enforces "record-after-mutation"

In an event-sourced aggregate, `apply(event)` is the only mutation path for new facts.

The order is:

1. Validate the event against current state.
2. Find the handler.
3. Compute the next state.
4. Assign state, record the event, and bump the version.

If validation, handler lookup, or state computation fails, the aggregate is unchanged and no event is queued.

That is the important event-sourcing rule in code form: an event is a fact that happened. The aggregate must not record an event for a transition that did not successfully change state.

State-stored aggregates get the same safety through `commit(newState, events)`. Lower-level `setState` and `addDomainEvent` stay available for unusual cases, but the normal path should be `commit` because it preserves the order: state first, event second, version with the transition.

## `commit()` keeps its transaction-flavored name

The name `commit()` is intentionally a little mechanical.

The public aggregate API should be domain language: `confirm()`, `cancel()`, `ship()`, `register()`. Inside those methods, `commit()` is the protected helper that says "this state change, these events, and this version bump land together."

Alternatives were worse:

- `record()` sounds like it only records an event.
- `applyChange()` collides conceptually with event-sourced `apply()`.
- a domain-specific name cannot work for a shared base-class helper.

The method name communicates atomicity. It is protected, so it does not leak into the application-facing aggregate API.

## Events are deeply frozen at construction

`createDomainEvent` returns a deeply frozen event.

That is not just defensive programming. Domain events are facts. A subscriber should not be able to mutate a fact before the next subscriber sees it. In an in-process `EventBus`, all handlers receive the same event object. Without freezing, one handler could rewrite metadata, payload, or correlation fields and poison its peers.

Freezing makes that failure loud. If a handler needs a derived shape, it should create one.

## Identity ids are branded strings, generated app-side

`Id<Tag>` is a branded string:

```ts
type UserId = Id<"UserId">;

const userIds: IdGenerator<"UserId"> = {
  next: () => ulid() as UserId,
};
```

The brand keeps ids from different concepts from being accidentally passed to the wrong API. A `UserId` and an `OrderId` are both strings at runtime, but they are not interchangeable in TypeScript.

Id generation belongs in the application, not in the repository. The repository persists and loads aggregates; it does not decide their identity. That keeps creation workflows explicit and makes ids available before the first save, which is useful for domain events, child references, idempotency, and API responses.

The kit provides event id and clock factories because events need ids and timestamps even when the consumer does not care about custom generation. Aggregate ids stay app-side.

## `EventIdFactory` / `ClockFactory`: globals by default, DI on top when you need it

The kit offers three levels of control:

- module-level defaults through `setEventIdFactory` and `setClockFactory`
- scoped test helpers through `withEventIdFactory` and `withClockFactory`
- per-event overrides on `createDomainEvent` and `recordEvent`

This is a pragmatic default, not the purest possible dependency-injection design.

Vernon-style DI would inject a clock and id generator into every aggregate that emits events. That is structurally race-free and very explicit. It also widens every constructor and every reconstitution path, even for aggregates that only need a timestamp and UUID once in a while.

The kit optimizes for the common path: production aggregates can record events without carrying factories through every constructor. Tests and specialized domains still get deterministic control through scoped helpers or per-call overrides.

### Trade-off

| Concern | Globals + scoped helpers | Constructor DI |
| --- | --- | --- |
| Aggregate constructor surface | small | wider |
| Reconstitution signature | simple | must thread factories |
| Test isolation | use scoped helpers or per-call options | inject mocks |
| Edge-runtime setup | no extra wiring | wire factories per invocation |
| Race-free by construction | no, use scopes carefully | yes |
| DDD strictness | pragmatic | stricter Vernon-style DI |

Use constructor DI when time and id generation are part of the domain's explicit test surface, or when concurrent tests cannot tolerate module-level overrides. Use the kit defaults when the aggregate should not care how event ids and timestamps are made.

### Vernon-DI works on top of the existing API, no library change needed

Per-call event options let consumers avoid the globals entirely:

```ts
class Order extends AggregateRoot<OrderState, OrderId, OrderEvent> {
  protected readonly aggregateType = "Order";

  protected constructor(
    id: OrderId,
    state: OrderState,
    private readonly clock: () => Date,
    private readonly idGen: () => string,
  ) {
    super(id, state);
  }

  static place(
    id: OrderId,
    customerId: string,
    clock: () => Date,
    idGen: () => string,
  ): Order {
    const order = new Order(id, { customerId, status: "draft" }, clock, idGen);

    order.addDomainEvent(
      order.recordEvent(
        "OrderPlaced",
        { customerId },
        {
          eventId: idGen(),
          occurredAt: clock(),
        },
      ),
    );

    return order;
  }
}
```

`recordEvent` still injects `aggregateId` and `aggregateType`; the per-call options supply the event id and timestamp.

### When the scoped helpers still win

Scoped helpers are useful when you want deterministic tests without widening the domain API:

```ts
withEventIdFactory(() => "event-1", () => {
  withClockFactory(() => fixedDate, () => {
    order.processBatch(input);
  });
});
```

Use them around one synchronous operation, not around an entire test file. They deliberately reject async callbacks, because restoring a global factory before awaited code resumes would make the test nondeterministic. For async flows, use per-call event options, constructor-injected factories, or an application-level async context. Module-level factories are global state; scoped helpers keep that state contained.

## Collection helpers practice structural sharing

`updateEntityById`, `replaceEntityById`, and `removeEntityById` preserve references when nothing changed.

That means:

- no matching entity returns the original array
- an updater that returns the same entity reference returns the original array
- replacing with the same reference returns the original array
- unchanged siblings keep their identity

This is the same immutable-update idea used by Redux, Immer, and persistent data structures. In this kit it is load-bearing because `AggregateRoot.changedKeys` is a shallow reference diff. If a helper returned a fresh array for a no-op, a repository would think the collection changed and perform unnecessary child-table writes.

The return type is `ReadonlyArray<T>` because the returned value may be the shallow-frozen input. If a caller needs a mutable copy, it can spread the result.

A missing child is also a silent no-op at the helper level. The helper does not know whether "missing" is a domain error. The aggregate method does:

```ts
const nextItems = updateEntityById(this.state.items, itemId, update);

if (nextItems === this.state.items) {
  throw new OrderItemNotFoundError(itemId);
}
```

The structural sharing gives the aggregate a cheap way to decide.

## No deep clone on every state read

`Entity.state` is shallowly frozen on assignment. Direct writes to top-level state fail in strict mode. Nested objects are not deeply frozen by the entity base.

That is intentional. Deep cloning or deep freezing on every read/write would make hot aggregate paths pay for a guarantee many models do not need.

The contract is:

- replace state through `setState`, `commit`, or event-sourced `apply`
- model deeply immutable nested data as value objects with `vo()` or `ValueObject`
- use an immutable-update library at the application layer if your state is deeply nested

Do not mutate nested state in place and expect `changedKeys` to notice. The aggregate change model is whole-state replacement with shallow structural sharing.

## Version lives on the aggregate boundary, not on entities or value objects

`version` and `persistedVersion` belong to aggregates, not to every entity and value object.

That follows directly from the DDD consistency boundary.

Value objects have no identity. They are values. If two value objects have the same attributes, they are the same value. A version would imply "this same thing changed over time", which is identity language. If you need that, you probably need an entity.

Child entities do have identity, but they do not own persistence. They live inside the aggregate boundary. The aggregate is loaded, changed, and saved as one consistency unit, so optimistic concurrency belongs on the aggregate root.

If a child needs independent concurrent editing, it is probably not a child entity. Promote it to its own aggregate root.

| What you want | Better model |
| --- | --- |
| independently edited child state | a separate aggregate root |
| audit history for a child | domain events |
| migration of embedded state shape | event upcasting or state schema migration |
| conflict detection for one part of a large aggregate | reconsider the aggregate boundary |

A generic `version` field on `Entity` would invite consumers to split work across what should be one consistency boundary. The kit leaves it out on purpose.

## TransactionScope stays minimal; the Unit of Work lives above it

`TransactionScope` has one job:

```ts
transactional<T>(fn: (ctx: TCtx) => Promise<T>): Promise<T>
```

It delegates to the persistence layer's native transaction and returns the callback result. It does not track dirty objects, register new aggregates, flush changes, or own an identity map.

That minimal shape keeps it compatible with Drizzle, Prisma, Mongo sessions, custom SQL adapters, and in-memory tests. ORMs already disagree about row-level change tracking. A generic transaction port should not pretend to solve that.

The higher-level pieces live above it:

- aggregates track their own dirty state through `changedKeys` and `hasChanges`
- repositories decide what rows to write
- `withCommit` orchestrates save, event harvest, outbox write, commit, mark-persisted, and post-commit publish
- `UnitOfWork` adds tx-bound repositories, enrollment, and a per-operation identity map

Earlier docs said "no Fowler-style Unit of Work" too bluntly. The current design is more precise: the kit does ship an opt-in unit-of-work facade, but not an ORM-style auto-flush engine.

In Fowler's terms, it is a transaction coordinator with registration and Identity Map. Repositories enroll aggregates when `save()` or `delete()` is called. Writes stay explicit. Auto-flush remains outside the current public contract.

`withCommit` with hand-rolled transaction-bound repositories remains supported. `UnitOfWork` is a convenience layer for teams that want repository registration and identity-map support built in.

## Domain Services are consumer constructs, no library marker

A Domain Service holds domain logic that does not naturally belong to one aggregate or value object.

Examples:

- calculate a shipping cost from an order, destination, and rate table
- evaluate a credit policy across several inputs
- check inventory across warehouses

The kit does not ship `DomainService`, `IDomainService`, or a decorator. A marker would not enforce any useful rule. It would only add ceremony.

Use a function or interface in your domain module:

```ts
export function calculateShippingCost(
  order: Order,
  destination: Address,
  rates: ExchangeRateTable,
): Money {
  // Pure domain logic, no state of its own.
}
```

If the service starts carrying identity, lifecycle, state transitions, or versioned persistence, it is no longer a stateless domain service. That is a signal to look for a missing aggregate.

## Bounded Contexts: the kit is agnostic

The kit does not prescribe a bounded-context layout.

A bounded context can be a directory, a package, a repository, or a deployable service. The kit provides tactical building blocks inside that context: aggregates, value objects, repositories, events, buses, and unit-of-work orchestration.

Inter-context communication is a boundary concern. A common shape is:

1. One bounded context publishes domain events through an outbox.
2. Another bounded context receives those events through a broker or dispatcher.
3. The receiver translates the incoming event into its own language at the boundary.

That translation is the Anti-Corruption Layer. It can be a function, adapter, mapper, or application service. The kit does not need a special class for it.

Small systems can host several bounded contexts in one TypeScript codebase. Larger systems can split them across packages or repositories. In both cases, the important rule is the same: do not let another context's model leak directly into your domain objects.

## Ports speak the domain's language {#ports-speak-the-domains-language}

A driven port belongs to the core that declares it, so its signature is
written in the core's types. Whatever shape the outside world uses, the
translation into the domain's language happens inside the adapter, on
the far side of the port. The consequences differ by port, but the rule
is the same one four times over:

- A **repository** returns fully reconstituted aggregates, never rows,
  ORM entities, or DTOs. Evans described the repository as the illusion
  of an in-memory collection of aggregate roots, and that illusion only
  holds when what comes out is the real domain object with its
  invariants intact. The mapping from storage shape to aggregate lives
  in the adapter; see [Repository](./repository.md).
- A **gateway** to an external system (a payment provider, an exchange
  rate source) returns value objects the core owns. The provider's
  response DTO exists only inside the adapter, and folding it into the
  core's type is exactly the Anti-Corruption Layer described above. A
  port like `rateFor(pair): ExchangeRate` hands the caller a validated
  value object, not the provider's JSON with a new name.
- A **query port** serving a view may return flat read models. That is
  the legitimate DTO case, and it works precisely because the result
  never feeds domain logic. The shape is still a type the core defines
  for its screens, not a persistence or wire format passed through; see
  [CQRS and Buses](./cqrs-and-buses.md).
- A **technical port** such as `OutboxStore` or `DeadlineStore` returns
  records of its own mechanic. Those look like DTOs but are not:
  delivery and dueness are the ubiquitous language of that port, and
  there is no richer model behind them being flattened away.

The litmus test: the moment a returned value is going to feed domain
logic, it must already be a validated domain object when it crosses the
port. If the caller has to map or re-validate first, the translation
has leaked out of the adapter.

## The kit is small on purpose

The kit is not trying to be a full application framework.

It ships DDD-specific shapes:

- aggregate and entity bases
- domain events
- repository and transaction ports
- command, query, and event buses
- outbox and projection support
- value-object helpers
- testing contracts for adapters

It relies on peer dependencies and the TypeScript ecosystem for general-purpose concerns such as `Result`, structured errors, deep equality, money calculations, HTTP frameworks, and database clients.

That keeps the surface area small enough to understand. The trade-off is that the kit asks you to compose it with your application architecture instead of hiding that architecture behind framework magic.
