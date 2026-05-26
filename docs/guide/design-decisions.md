# Design Decisions

This page collects the non-obvious calls the kit has made and *why* — the choices a consumer is most likely to want to push back on before adopting the library.

## Result lives at the App-Service boundary, not in the domain

**The rule:**
- **Domain layer throws** `DomainError`-derived exceptions. Aggregates, value-object constructors, and the `validateEvent` hook all throw.
- **App-Service boundary returns `Result`.** `CommandBus.execute`, `QueryBus.execute`, `CommandHandler<C,R>`, `QueryHandler<Q,R>`, and `withCommit` return `Result<T, E>` so HTTP handlers can map errors to status codes / logs.
- **Infrastructure boundary returns `Result` where corruption is recoverable.** `EventSourcedAggregate.loadFromHistory` and `restoreFromSnapshotWithEvents` return `Result<void, DomainError>` because a corrupt event stream is the kind of failure the caller might want to inspect, not fail-fast on.

**Why:** mixing throw + Result in the same code path is the worst of both worlds — Vernon, Evans, and Khononov all model aggregate invariants as exceptions because that's what they are (programming-error level "this should never happen for a valid request"). Result is the right shape *at the boundary* where you serialise to JSON. See [Result vs Throw](./result-vs-throw.md) for the full discussion.

## In-process buses are first-class for edge runtimes

`CommandBus` and `QueryBus` are zero-config in-memory dispatchers. They're not toys for tests — they're the right tool for:

- **Cloudflare Workers / Vercel Edge / Deno Deploy:** each worker invocation is short-lived, no broker to call.
- **Modular monoliths:** in-process routing between bounded contexts; events leave the process via outbox when other services need them.
- **Tests and small CLIs.**

For cross-process messaging (RabbitMQ, NATS, Kafka, SQS), keep the `CommandHandler<C,R>` and `QueryHandler<Q,R>` types as the contract and wire them to your transport. No middleware/pipeline machinery in the library — wrap handlers with decorator functions for logging, auth, metrics.

## The Specification pattern was deliberately not shipped

`IQueryableRepository<TAgg, TId, TFilter>` is generic over the filter shape. Drizzle `SQL`, Prisma `WhereInput`, Mongo filter documents, plain predicates — every repository implementation owns its filter language. The library does **not** ship an `ISpecification<T>` interface because a brand-only marker with no `isSatisfiedBy` / `and` / `or` / `not` combinators can't be used generically, and a full Specification pattern in TypeScript fights the ORM query DSLs people actually use.

## Event sourcing structurally enforces "record-after-mutation"

`EventSourcedAggregate.apply(event)` is the only mutation path. The dispatch is atomic:

1. `validateEvent(event)` — throws if the event violates an invariant
2. handler lookup (throws `MissingHandlerError` if absent)
3. compute `nextState`
4. **commit:** state + pending event + version bump in one tick

If anything in (1)–(3) throws, no state is mutated and no event is queued. Vernon's canonical "events are facts of the past" rule is enforced by the structure, not by convention.

For `AggregateRoot` (non-event-sourced), use the `commit(newState, events)` helper to get the same guarantee. The unscoped `setState` + `addDomainEvent` pair stays available for cases that don't fit the helper (state-only mutations, audit-only events, multi-step transactions).

## Events are deeply frozen at construction

`createDomainEvent` returns a deeply frozen object. A mutating subscriber on the `EventBus` throws instead of poisoning subsequent handlers. Events are facts of the past — immutable by definition (Vernon, IDDD §8).

## Identity ids are branded strings, generated app-side

`Id<Tag>` is `string & { readonly __brand: Tag }`. Generators are bound to a single tag at creation:

```ts
const userIds: IdGenerator<"UserId"> = { next: () => ulid() as Id<"UserId"> };
```

Per Vernon's "Identity from User-Side", id generation happens in the application, not in the repository — `IRepository` deliberately does not expose `nextId()`. The library provides an `EventIdFactory` and `ClockFactory` for deterministic tests.

## `EventIdFactory` / `ClockFactory`: globals by default, DI on top when you need it

The kit ships module-level globals (`setEventIdFactory`, `setClockFactory`), scoped helpers (`withEventIdFactory`, `withClockFactory`), and per-call overrides on `createDomainEvent` (`{ eventId, occurredAt }`). This is **not** the DI-canonical shape Vernon's IDDD §13 prefers — Vernon's pattern is constructor-injected `clock: () => Date` and `idGen: () => string` threaded through every aggregate. Both designs are available; the kit defaults to globals because the production fast path (95% of methods emit events with default clock + UUID) benefits more from minimal aggregate-construction surface than from per-instance factory control.

### Trade-off

|  | Globals + scoped helpers (kit default) | Vernon-style DI |
|---|---|---|
| Race-free structurally | ❌ (mitigated via `withEventIdFactory` / `withClockFactory` + per-call options) | ✅ |
| Aggregate constructor surface | minimal (`id, state`) | wider (`id, state, clock, idGen, …`) |
| Reconstitution signature | `Order.reconstitute(id, state, version)` | + factories threaded through |
| Test isolation | scoped helpers or per-call options | constructor-injected mocks |
| Edge-runtime plumbing | none (defaults work) | factories must be wired per worker invocation |
| DDD-canon strictness | pragmatic | hard Vernon §13 |

If you're shipping a production aggregate that mostly records events with default clock + UUID, the globals + scoped helpers cover you with zero ceremony. If you're shipping a research / time-travel / multi-tenant codebase where time-control is per-call, Vernon-DI eliminates the race window entirely and is worth the heavier constructors.

### Vernon-DI works on top of the existing API — no library change needed

`createDomainEvent` already accepts per-call `{ eventId, occurredAt }`. A consumer can ignore the globals entirely:

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
    // `recordEvent` here auto-injects aggregateId + aggregateType but
    // still threads through the per-call eventId/occurredAt overrides,
    // so the DI pattern survives.
    order.addDomainEvent(
      order.recordEvent(
        "OrderPlaced",
        { customerId },
        {
          eventId: idGen(),
          occurredAt: clock(),  // per-call options bypass the globals
        },
      ),
    );
    return order;
  }
}
```

That's Vernon-pure: no globals touched, no scoped helpers needed, every event's clock and id come from the aggregate's injected factories. Test mocks pass in deterministic factories at construction time.

### When the scoped helpers still win

Even in a DI-leaning codebase, `withEventIdFactory` / `withClockFactory` remain the right tool for one case: **events constructed deep inside a domain method** where threading an explicit `{ eventId, occurredAt }` through every `createDomainEvent` call is awkward. A test that wraps the whole operation in `withEventIdFactory(() => "deterministic", () => order.processBatch(...))` is cleaner than refactoring `processBatch` to thread the id-gen through three layers of internal helpers.

## No deep clone on every state read

`Entity.state` is **shallowly frozen** on every assignment. Direct property writes (`entity.state.foo = …`) throw in strict mode, but writes to nested objects bypass the freeze. For deep immutability either model nested data with `vo()` (deep-freezes by construction) or reach for Immer / Immutable.js at the App layer. The shallow contract is deliberate — deep freezing on every state write would dominate hot paths.

## TransactionScope, not "Unit of Work"

The transaction abstraction is `TransactionScope.transactional<T>(fn): Promise<T>` — honest naming for what it actually does. The library does **not** ship a Fowler-style UoW (no `registerDirty` / `registerNew` / `registerDeleted` change tracking). That's the ORM's job — Prisma, Drizzle, TypeORM all handle it differently, and competing with them only creates incompatibility.

`withCommit` publishes events **after** `transactional` resolves, so an in-process EventBus subscriber never sees events from a rolled-back transaction.

## Domain Services are consumer constructs — no library marker

Vernon IDDD §7 describes Domain Services as the home for business logic that doesn't naturally belong to an Aggregate or a Value Object — operations that span multiple aggregates without owning state ("compute exchange rate", "check inventory across warehouses", "evaluate a credit-risk policy"). The kit deliberately ships no `IDomainService` marker, no `DomainService` base class, no decorator.

The reason is the same one Evans gives for not over-marking patterns: a marker that does nothing at the type or runtime level adds noise without adding constraint. A Domain Service in this kit is just a function or interface defined alongside your aggregates — file naming and module structure already identify it:

```ts
// pricing/exchange-rate.service.ts
export function calculateShippingCost(
  order: Order,
  destination: Address,
  rates: ExchangeRateTable,
): Money {
  // pure function over aggregates + value objects; no state of its own
}
```

If you find yourself wanting to make a Domain Service stateful, that's the strongest signal in DDD that you've found a new aggregate (Vernon §7). Promote it.

## Bounded Contexts: the kit is agnostic

ddd-kit is bounded-context-agnostic. Each Bounded Context (Evans, *Domain-Driven Design* §14) is a module or package — or a separate repo for larger systems — that imports the kit; the library does not prescribe a layout, naming convention, or inter-BC integration pattern.

Inter-BC communication is typically via published domain events through the outbox + a message broker (the topology the kit is designed for, but enforces nothing). The receiving BC translates incoming events into its own ubiquitous language at the boundary — an Anti-Corruption Layer (Evans §14) — using plain functions or adapter classes; again, no library construct.

The kit is small enough that a single TypeScript codebase can host multiple BCs comfortably, with each BC in its own directory tree of aggregates / repositories / use cases. Larger systems split BCs across repos and treat the outbox as the only contract that crosses the boundary.

## The kit is small on purpose

`dist/index.js` is around 30 KB. Operators that have entire ecosystems behind them (a Result type with 30+ combinators, a deep-equal that handles every corner of JavaScript, a frozen value-object library) are pulled in from peer deps rather than re-implemented. The kit's job is to ship the *DDD-specific* shapes; the surrounding TypeScript ecosystem is rich enough to handle the rest.
