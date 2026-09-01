# Design Decisions

This page explains the choices in the kit that are not obvious from the API alone.

Most of these decisions are trade-offs, not universal rules. The point is to show where the kit draws its boundaries, why those boundaries exist, and when a consumer might reasonably choose a different shape on top.

## Result lives at the App-Service boundary, not in the domain

The kit keeps one clear error axis:

- Domain code throws typed errors.
- Application boundaries decide whether to turn those errors into `Result`.
- Infrastructure replay paths return `Result` when corrupted input is an expected recoverable case.

Aggregates, entities, value-object constructors, instance-bound state validators, and `validateEvent` throw `DomainError` subclasses. That matches the DDD model: an invariant violation means the current operation tried to put the domain into a state the domain rejects. A stack trace and a concrete class such as `OrderAlreadyConfirmedError` are useful there.

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
- `withCommit(...)` returns the committed result `R`. It is a transaction
  orchestrator, not a `Result` wrapper.

Event-sourced replay is a third case. `replayHistory` returns
`Result<void, DomainError>` because a persisted stream can contain invalid
historical facts. A repository can reject the load or refold from another
source. Snapshot DTO migration and reconstitution live
in an adapter-owned `SnapshotModel` and throw when stored data cannot be
interpreted. Not everything belongs on the recoverable channel:
`ForeignEventError`, for example, means a stream row was addressed to the wrong
aggregate and needs a human. The rule of thumb is that `Err` covers historical
domain input the load recipe can answer, while wiring and misrouted data throw.

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

## Query ports belong to the consumer; Specification has no translator

The kit's repository contract stops at aggregate identity and lifecycle. It deliberately ships no generic filter repository. SQL fragments, Prisma `WhereInput`, Mongo filter documents, and similar adapter-native filters would make application code depend on an outbound adapter's language. A generic `find` would also leave the important use-case laws unstated: whether a single result is unique, how a result set is bounded and ordered, and what a continuation cursor means.

Consumer applications declare intent-revealing repository or query ports instead. A unique lookup can be `findByEmail(email)`. A multi-result aggregate selection can be `findDunningCandidates(criteria, { after, limit })`, with a validated maximum page size, stable ordering, and cursor semantics in that port's contract. UI lists, search, reporting, and other read-heavy access normally use projection ports rather than hydrating aggregates. The use case depends on the consumer-owned interface, never on the concrete database adapter.

For criteria that belong to the domain language rather than to a storage language, the kit still ships `Specification<T>`: a named, executable criterion with `isSatisfiedBy`, combinators for `and`/`or`/`not`, and an introspectable composite structure. A consumer-owned port may accept such a specification alongside its explicit bounds and ordering contract.

What the kit still does not ship is translation machinery. A `Specification<T>` powerful enough to translate itself across Drizzle, Prisma, Mongo, and SQL builders would have to become an expression-tree system, and an expression-tree system is a query framework. So predicates stay opaque, evaluation stays in memory, and a storage adapter translates the named leaves explicitly, recursing through the composite structure. The repository guide's Specifications section walks through this, including the drift risk when one rule lives as both a predicate and a query, and the shared-fixture test that contains it.

The same reasoning explains why there is no visitor interface in the kit: a visitor's methods enumerate the specifications of one particular domain, and only that domain's owner can write them. What the kit guarantees instead is that such a layer stays buildable. Subclasses can override the combinators and set the composite structure. The repository guide shows the full double-dispatch construction for teams that want the compiler to enforce translation completeness across several targets.

## Event sourcing structurally enforces "record-after-mutation"

In an event-sourced aggregate, `apply(event)` is the only mutation path for new facts.

The order is:

1. Validate the event against current state.
2. Find the handler.
3. Compute the next state.
4. Assign state, record the event, and bump the version.

If validation, handler lookup, or state computation fails, the aggregate is unchanged and no event is queued.

That is the important event-sourcing rule in code form: an event is a fact that happened. The aggregate must not record an event for a transition that did not successfully change state.

State-stored aggregates get the same safety through `setState(newState, events)`. Lower-level `addDomainEvent` stays available for unusual cases, but the normal path is `setState` with the events of the change, because it preserves the order: state first, version bump, events last.

## One write helper per flavour: `setState(newState, events)` and `apply(event)`

The public aggregate API should be domain language: `confirm()`, `cancel()`, `ship()`, `register()`. Inside those methods, one protected helper says "this state change, this version bump, and these events land together": `setState(newState, events)` on a state-stored aggregate, `apply(event)` on an event-sourced one.

The state-stored helper is the same `setState` that every entity has; the events are an optional second argument, not a second name. A second name would carry no difference the parameter does not already state.

`commit` stays the transaction term: `withCommit`, `committedVersion`, `CommittedDomainEvent`. One word, one meaning.

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

Identifier generation belongs in the application, not in the repository. The
repository persists and loads aggregates. It does not decide their identity.
This rule makes identifiers available before the first insert. Domain events,
child references, idempotency keys, and API responses can then use them.

The kit provides event id and clock factories because events need ids and timestamps even when the consumer does not care about custom generation. Aggregate ids stay app-side.

## Event identity and time cross the application boundary explicitly

The top-level `createDomainEvent(...)` uses one immutable
`defaultDomainEventFactory`: Web Crypto UUID v4 plus the platform clock. It is
not replaceable. Consumers that need another policy call
`createDomainEventFactory({ eventIdFactory, clock })` and receive a frozen
factory object that permanently captures those dependencies.

This draws a deliberate boundary:

- The zero-configuration path uses nondeterministic values.
- The application composition owns each custom policy.
- Request and test isolation use object identity, not restore discipline.
- Per-event options remain available for an exceptional identifier or timestamp.

Mutable module factories were rejected because their effective owner is the
last caller. A synchronous scoped helper can restore a global with
`try/finally`, but it cannot make that global request-local across overlapping
async work. The correct fix is to remove the shared write location.

### Aggregates decide and the application records

An aggregate first produces an immutable, uncommitted domain event. The value
is already a domain fact. The aggregate accepted the type and payload after its
state changed. The value is not yet a technical event record. It has no
generated identifier, recording time, or trace metadata.

```ts
const domainEvents = createDomainEventFactory({
  eventIdFactory: () => uuidv7(),
  clock: requestClock,
});

await uow.run(async ({ repositories }) => {
  const order = await repositories.orders.getById(command.orderId);
  order.confirm();
  recordPendingEvents(order, () =>
    domainEvents.createStamp({
      metadata: { correlationId: command.correlationId },
    }),
  );
  repositories.orders.update(order);
});
```

Inside the aggregate, `createEvent(type, payload, { version })` adds the
aggregate address and payload schema version but does not read the factory,
clock, or Web Crypto. Equal aggregate state and command data therefore produce
equal decisions. `recordPendingEvents` is the application-shell step that
attaches a `DomainEventStamp` exactly once. A retry sees the already recorded
events and reuses their identities.

Snapshot creation follows the same boundary. The application supplies a time
to `captureAggregateSnapshot(snapshotModel, aggregate, snapshotAt)`, while the
adapter-owned model projects a plain persistence DTO. The aggregate neither
reads a clock nor knows the stored snapshot schema.

`occurredAt` is recording information, not a universal business clock. If a
time changes a business decision, pass it as a domain input. Put this time in
the payload. The application can use the same instant for both roles. It then
supplies the value as business input and as the stamp recording time. This
equality becomes an explicit decision instead of an effect of a hidden clock.

## Private process facts do not double as participant commands

An event-sourced Process Manager needs durable history and durable outgoing
work, but those are two different contracts. Its stream contains private facts
such as `CheckoutAdvancedToShipping`: completed decisions that rebuild the
coordinator's own state. A participant receives `RequestShipping`: an
imperative request addressed to one handler. Publishing the first value to one
subscriber and treating it as the second hides command semantics behind an
event-shaped object.

Three designs were considered:

1. A dedicated command outbox stores addressed commands beside the process
   commit.
2. One generalized message outbox stores both publish/subscribe events and
   point-to-point commands behind a common envelope.
3. The process stream stores pending effects that a worker later claims and
   runs.

The kit chooses the first, narrow seam. A generalized envelope makes
destination, subscriber cardinality, and acknowledgement rules conditional on
a message-kind flag. Those differences define the boundary. Persisted effects
put delivery lifecycle into the process model. Replay must then distinguish
history from unfinished work.
A dedicated command outbox keeps both meanings honest without introducing a
workflow engine.

`routeEventsToCommandOutbox` adapts the event-candidate port used by
`withCommit`. It runs the application's fact-to-command mapper inside the
transaction and passes a `CommandOutboxWriter` only an origin receipt and the
exact addressed messages. It never attaches the private fact or copies its
payload automatically. The application mapper selects the fields that belong
in each command contract.

That mapper is also the Published-Language boundary. A local `Command` can use
domain value objects because it never has to survive another runtime.
`PublishedCommand`, by contrast, has the stable shape
`{ type, version, payload }`. Its payload must be JSON-safe.

A payment mapper therefore converts `Money` to `MoneyDto`. It does not give
`bigint` or a domain object to an adapter. The route copies the complete command
and rejects invalid values before it calls the port. Values that JSON discards
or changes fail inside the same transaction.

An empty command batch retains its origin receipt. The adapter can then advance
the process source cursor. It can also distinguish an exact retry from a
missing write.

Command message identifiers derive from the private event identifier and
command order. This rule keeps transaction retries stable. It also keeps
commands from the same decision distinct. It does not guarantee delivery
order. A process waits when one compensating action depends on another.

The private fact identifies the input in its metadata. The command identifies
that fact as its direct cause. The participant result identifies the command
message. `conversationId` follows the full business interaction.

`traceparent` and `tracestate` contain the W3C Trace Context. Business
correlation identifies the journey. Trace context connects its technical spans.

The write seam deliberately stops at transactional handoff. A database-backed
adapter or broker-native outbox owns polling, claiming, acknowledgements,
retry, and dead letters. Because delivery is at least once, the receiving
application still uses `withIdempotentCommit` with the command `messageId` and
stores the handler result before acknowledging.

The port's prose is backed by
`createCommandOutboxContractTests`. Every adapter must prove atomic batches,
stable order, exact-retry deduplication, rejection of conflicting origin reuse,
empty-receipt cursor progress, and rollback participation.

## Collection helpers practice structural sharing

`updateEntityById`, `replaceEntityById`, and `removeEntityById` preserve references when nothing changed.

That means:

- no matching entity returns the original array
- an updater that returns the same entity reference returns the original array
- replacing with the same reference returns the original array
- unchanged siblings keep their identity

This is the immutable-update method that Redux, Immer, and persistent data
structures use. It also gives an adapter-owned `PersistenceModel` a reliable
signal. A no-op does not appear as a child-table change.

The return type is `ReadonlyArray<T>` because the returned value can be the
shallow-frozen input. If a caller needs a mutable copy, it can spread the
result.

A missing child is also a silent no-op at the helper level. The helper does not know whether "missing" is a domain error. The aggregate method does:

```ts
const nextItems = updateEntityById(this.state.items, itemId, update);

if (nextItems === this.state.items) {
  throw new OrderItemNotFoundError(itemId);
}
```

The structural sharing gives the aggregate a cheap way to decide.

## Live state is protected and reads are explicit

`Entity.state` is `protected`. A generic public getter cannot safely return a
live graph. A generic copy can destroy prototypes for class-based child
entities. Concrete models expose domain queries or detached read DTOs.
Persistence adapters define state and snapshot projections outside the
aggregate.

State is still shallowly frozen on assignment. A deep copy or deep freeze adds
cost to every internal read and write. Many models do not need that guarantee.

The contract is:

- Replace state through `setState`, `setState`, or event-sourced `apply`.
- Do not widen the protected `state` accessor in a concrete entity.
- Expose domain queries or detached immutable read DTOs to consumers.
- Model deeply immutable data with `vo()` or `ValueObject`.
- If state is deeply nested, use an immutable-update library in the application.

Do not mutate nested state in place. Aggregate state changes use whole-state
replacement with shallow structural sharing. An adapter defines deeper changes
in its `PersistenceModel`.

## Version lives on the aggregate boundary, not on entities or value objects

The current domain `version` belongs to the aggregate, not to every entity and
value object. The persistence baseline captured during load belongs to the
operation-scoped `UnitOfWork`.

That follows directly from the DDD consistency boundary.

Value objects have no identity. They are values. Two value objects with the
same attributes are the same value. A version implies identity over time. If
you need that identity, use an entity.

Child entities do have identity, but they do not own persistence. They live inside the aggregate boundary. The aggregate is loaded, changed, and saved as one consistency unit, so optimistic concurrency belongs on the aggregate root.

If a child needs independent concurrent editing, it is probably not a child entity. Promote it to its own aggregate root.

| What you want | Better model |
| --- | --- |
| independently edited child state | a separate aggregate root |
| audit history for a child | domain events |
| migration of embedded state shape | event upcasting or state schema migration |
| conflict detection for one part of a large aggregate | reconsider the aggregate boundary |

A generic `version` field on `Entity` invites consumers to split one
consistency boundary. The kit omits this field deliberately.

### Persistence tracking belongs to the Unit of Work

The v3 protocol deliberately removes persistence lifecycle from tactical
aggregates. Whether an object represents a new row, which version was loaded,
and which table fields changed are not business facts. A domain method must
never ask whether an order has already been inserted or whether a menu table is
dirty.

`UnitOfWork` therefore owns an identity-bound tracked entry for every loaded or
new aggregate. The adapter contributes a `PersistenceModel` that captures an
opaque baseline and derives its own change set. The application contributes an
explicit lifecycle verb:

- `add` means that the identity is new in this operation.
- `update` means that this operation loaded the exact instance.
- `remove` means physical deletion and exists only on repositories that opt in.

This makes the mandatory write path slightly more structured than calling a
repository directly. That cost buys several guarantees that a detachable
version receipt cannot provide as safely:

- The baseline cannot pair with a different instance.
- One class and identifier map to one object for the operation.
- Insert and update do not depend on a version convention.
- Adapters derive partial or replacement writes from their own model.
- The write receipt freezes the version, change set, and exact event batch.
- The Unit of Work rejects mutation after registration.
- A rollback acknowledges no events and changes no persistence baseline.

The unit of work is consequently the public repository write context in v3.
Low-level `withCommit` remains available for infrastructure compositions that
do not present the standard aggregate repository protocol, but there is no
parallel direct-repository `save` path. Two paths create different owners for
the same OCC and event-harvest rules.

## TransactionScope stays minimal and the Unit of Work lives above it

`TransactionScope` has one job:

```ts
transactional<T>(fn: (ctx: TCtx) => Promise<T>): Promise<T>
```

It delegates to the persistence layer's native transaction and returns the callback result. It does not track dirty objects, register new aggregates, flush changes, or own an identity map.

That minimal shape supports Drizzle, Prisma, Mongo sessions, custom SQL
adapters, and in-memory tests. ORMs use different methods for row-level change
tracking. A generic transaction port does not solve that difference.

The higher-level pieces live above it:

- Repository adapters reconstitute aggregates and give loaded instances to
  `RepositoryTracking`.
- Adapter-owned `PersistenceModel`s capture baselines and derive writes.
- Application code registers explicit `add`, `update`, or `remove` intent.
- `UnitOfWork` owns the identity map, freezes receipts, flushes writes, and
  delegates transaction/outbox/post-commit orchestration to `withCommit`.

In Fowler's terms, this is a Unit of Work with explicit registration and an
Identity Map. It does not watch arbitrary objects or flush them automatically.
Domain decisions come first. One explicit persistence registration comes
last. That keeps the mechanism persistence-oriented without turning the kit
into an ORM.

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
