# Design Decisions

This page collects the non-obvious calls the kit has made and *why*: the choices a consumer is most likely to want to push back on before adopting the library.

## Result lives at the App-Service boundary, not in the domain

**The rule:**
- **Domain layer throws** `DomainError`-derived exceptions. Aggregates, value-object constructors, and the `validateEvent` hook all throw.
- **App-Service boundary returns `Result`.** `CommandBus.execute`, `QueryBus.execute`, `CommandHandler<C,R>`, `QueryHandler<Q,R>`, and `withCommit` return `Result<T, E>` so HTTP handlers can map errors to status codes / logs.
- **Infrastructure boundary returns `Result` where corruption is recoverable.** `EventSourcedAggregate.loadFromHistory` and `restoreFromSnapshotWithEvents` return `Result<void, DomainError>` because a corrupt event stream is the kind of failure the caller might want to inspect, not fail-fast on.

**Why:** mixing throw + Result in the same code path is the worst of both worlds. Vernon, Evans, and Khononov all model aggregate invariants as exceptions because that's what they are (programming-error level "this should never happen for a valid request"). Result is the right shape *at the boundary* where you serialise to JSON. See [Result vs Throw](./result-vs-throw.md) for the full discussion.

## In-process buses are first-class for edge runtimes

`CommandBus` and `QueryBus` are zero-config in-memory dispatchers. They're not toys for tests; they're the right tool for:

- **Cloudflare Workers / Vercel Edge / Deno Deploy:** each worker invocation is short-lived, no broker to call.
- **Modular monoliths:** in-process routing between bounded contexts; events leave the process via outbox when other services need them.
- **Tests and small CLIs.**

For cross-process messaging (RabbitMQ, NATS, Kafka, SQS), keep the `CommandHandler<C,R>` and `QueryHandler<Q,R>` types as the contract and wire them to your transport. No middleware/pipeline machinery in the library: wrap handlers with decorator functions for logging, auth, metrics.

## The Specification pattern was deliberately not shipped

`IQueryableRepository<TAgg, TId, TFilter>` is generic over the filter shape. Drizzle `SQL`, Prisma `WhereInput`, Mongo filter documents, plain predicates: every repository implementation owns its filter language. The library does **not** ship an `ISpecification<T>` interface because a brand-only marker with no `isSatisfiedBy` / `and` / `or` / `not` combinators can't be used generically, and a full Specification pattern in TypeScript fights the ORM query DSLs people actually use.

## Event sourcing structurally enforces "record-after-mutation"

`EventSourcedAggregate.apply(event)` is the only mutation path. The dispatch is atomic:

1. `validateEvent(event)`, which throws if the event violates an invariant
2. handler lookup (throws `MissingHandlerError` if absent)
3. compute `nextState`
4. **commit:** state, pending event, and version bump in one tick

If anything in (1)–(3) throws, no state is mutated and no event is queued. Vernon's canonical "events are facts of the past" rule is enforced by the structure, not by convention.

For `AggregateRoot` (non-event-sourced), use the `commit(newState, events)` helper to get the same guarantee. The unscoped `setState` + `addDomainEvent` pair stays available for cases that don't fit the helper (state-only mutations, audit-only events, multi-step transactions).

## Events are deeply frozen at construction

`createDomainEvent` returns a deeply frozen object. A mutating subscriber on the `EventBus` throws instead of poisoning subsequent handlers. Events are facts of the past, immutable by definition (Vernon, IDDD §8).

## Identity ids are branded strings, generated app-side

`Id<Tag>` is `string & { readonly __brand: Tag }`. Generators are bound to a single tag at creation:

```ts
const userIds: IdGenerator<"UserId"> = { next: () => ulid() as Id<"UserId"> };
```

Per Vernon's "Identity from User-Side", id generation happens in the application, not in the repository; `IRepository` deliberately does not expose `nextId()`. The library provides an `EventIdFactory` and `ClockFactory` for deterministic tests.

## `EventIdFactory` / `ClockFactory`: globals by default, DI on top when you need it

The kit ships module-level globals (`setEventIdFactory`, `setClockFactory`), scoped helpers (`withEventIdFactory`, `withClockFactory`), and per-call overrides on `createDomainEvent` (`{ eventId, occurredAt }`). This is **not** the DI-canonical shape Vernon's IDDD §13 prefers: Vernon's pattern is constructor-injected `clock: () => Date` and `idGen: () => string` threaded through every aggregate. Both designs are available; the kit defaults to globals because the production fast path (95% of methods emit events with default clock + UUID) benefits more from minimal aggregate-construction surface than from per-instance factory control.

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

### Vernon-DI works on top of the existing API, no library change needed

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

`Entity.state` is **shallowly frozen** on every assignment. Direct property writes (`entity.state.foo = …`) throw in strict mode, but writes to nested objects bypass the freeze. For deep immutability either model nested data with `vo()` (deep-freezes by construction) or reach for Immer / Immutable.js at the App layer. The shallow contract is deliberate: deep freezing on every state write would dominate hot paths.

## Version lives on the aggregate boundary, not on entities or value objects

`version` / `persistedVersion` enter the class hierarchy at `BaseAggregate`, between `Entity` and the two aggregate flavours; `Entity<TState, TId>` has identity and state but **no own version**. That split is deliberate, and the reasons differ for the two building blocks below it.

**Value Objects carry no version; it would contradict what a VO is.** A VO has no identity and no lifecycle: it is replaced wholesale, never mutated, and two VOs with equal attributes *are* the same value (`voEquals`). A version presupposes "the same thing over time whose changes you count", i.e. identity. The moment you want a versioned VO, you actually want an Entity. (The only version-like concept near VOs is the schema/event `version` used for [upcasting](./event-upcasting.md), a serialisation concern at the persistence edge, not a VO attribute.)

**Child entities carry no version because OCC belongs to the consistency boundary.** The `version` the kit tracks is an optimistic-concurrency token (`WHERE version = persistedVersion` on save; see [Concurrency](./concurrency.md)). Per Evans and Vernon (IDDD §10) the aggregate is the unit of consistency and persistence: loaded, mutated, and saved transactionally as one whole, with OCC on the root. Giving a child entity its own version would imply it can be modified concurrently and independently, exactly what the aggregate boundary forbids. A child entity inherits its "versioning" through the version of *its* aggregate.

If you find yourself wanting a version lower down, one of these is the DDD-aligned move:

| What you actually want | Do this instead |
|---|---|
| A child entity that can be edited concurrently on its own | Promote it to its **own aggregate root**; then it has its own OCC version |
| "Which change was this?" per entity, for audit | **Domain events** (they carry `version` + `occurredAt`), not a field on the entity |
| Migrate the shape of an embedded structure | **Event upcasting**, or a schema-version field inside the plain-data state, not a library concept |

The absence of an entity-level version is a guard rail: a generic `version` on `Entity` would invite consumers to split work across what should be a single aggregate.

## TransactionScope stays minimal; the Unit of Work lives above it

The transaction abstraction is `TransactionScope.transactional<T>(fn): Promise<T>`: honest naming for what it actually does — delegate to the ORM's native transaction. The scope itself does no change tracking (`registerDirty` / `registerNew` / `registerDeleted`); ORMs handle row-level change detection differently (Prisma, Drizzle, TypeORM), and competing with them at that level only creates incompatibility.

Earlier versions of this page said flatly "no Fowler-style UoW". That stance has been **consciously revised** — not because the original reasoning was wrong, but because the pieces it argued against landed in different places than Fowler's pattern puts them:

- **Change detection lives on the aggregate, not in the scope.** `AggregateRoot.changedKeys` / `hasChanges` detect changes by a shallow reference diff against the state captured at the persistence-lifecycle markers — the aggregate reports *what* changed, the repository decides *what to write* (see [Partial writes for multi-table aggregates](./repository.md#partial-writes-for-multi-table-aggregates-changedkeys--haschanges)). This is deliberately NOT ORM-style change tracking: no proxies, no entity metadata, no registration calls — it falls out of the kit's immutable-`setState` convention for free.
- **Commit orchestration lives in `withCommit`** (the Vernon / Axon / EventFlow unit-of-work pattern): pending events are harvested into the outbox inside the transaction, `markPersisted` fires after the commit, the in-process publish happens last.
- **An opt-in `UnitOfWork` facade is the planned next layer** on top of `withCommit`: tx-bound repositories handed to the use case via a registry, a per-operation identity map, and repository-side aggregate enrollment (`save()` / `delete()` enroll the aggregate with the UoW). Enrollment-by-repository removes `withCommit`'s known footgun — forgetting to list an aggregate in the returned `aggregates` array silently drops its events; with enrollment, the mistake becomes impossible per call site and is tested once per repository implementation instead.

What stays true: `TransactionScope` remains the minimal port everything above builds on, and nothing forces the higher layers on you — `withCommit` with hand-rolled, tx-bound repositories remains a fully supported way to use the kit.

`withCommit` publishes events **after** `transactional` resolves, so an in-process EventBus subscriber never sees events from a rolled-back transaction.

## Domain Services are consumer constructs, no library marker

Vernon IDDD §7 describes Domain Services as the home for business logic that doesn't naturally belong to an Aggregate or a Value Object: operations that span multiple aggregates without owning state ("compute exchange rate", "check inventory across warehouses", "evaluate a credit-risk policy"). The kit deliberately ships no `IDomainService` marker, no `DomainService` base class, no decorator.

The reason is the same one Evans gives for not over-marking patterns: a marker that does nothing at the type or runtime level adds noise without adding constraint. A Domain Service in this kit is just a function or interface defined alongside your aggregates; file naming and module structure already identify it:

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

ddd-kit is bounded-context-agnostic. Each Bounded Context (Evans, *Domain-Driven Design* §14) is a module or package (or a separate repo for larger systems) that imports the kit; the library does not prescribe a layout, naming convention, or inter-BC integration pattern.

Inter-BC communication is typically via published domain events through the outbox + a message broker (the topology the kit is designed for, but enforces nothing). The receiving BC translates incoming events into its own ubiquitous language at the boundary (an Anti-Corruption Layer, Evans §14) using plain functions or adapter classes; again, no library construct.

The kit is small enough that a single TypeScript codebase can host multiple BCs comfortably, with each BC in its own directory tree of aggregates / repositories / use cases. Larger systems split BCs across repos and treat the outbox as the only contract that crosses the boundary.

## The kit is small on purpose

`dist/index.js` is around 30 KB. Operators that have entire ecosystems behind them (a Result type with 30+ combinators, a deep-equal that handles every corner of JavaScript, a frozen value-object library) are pulled in from peer deps rather than re-implemented. The kit's job is to ship the *DDD-specific* shapes; the surrounding TypeScript ecosystem is rich enough to handle the rest.
