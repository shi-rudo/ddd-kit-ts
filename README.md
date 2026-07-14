# @shirudo/ddd-kit

Tactical Domain-Driven Design building blocks for TypeScript.

`@shirudo/ddd-kit` gives you the pieces you need to model a real domain:
value objects, entities, aggregates, domain events, repositories, command and
query handlers, an outbox, a Unit of Work facade, event-store ports,
projections, and adapter contract tests.

It is not an application framework. You keep your HTTP layer, database, queue,
ORM, and runtime choices. The kit gives your domain model a strong center and
clear boundaries around persistence and side effects.

> **Release candidate: 3.0** (`3.0.0-rc`, npm dist-tag `next`); latest stable
> release is 2.2.
>
> The public API follows [Semantic Versioning](https://semver.org/). Breaking
> changes bump the major version and are documented with migration notes in the
> [CHANGELOG](./CHANGELOG.md).

![npm version](https://img.shields.io/npm/v/@shirudo/ddd-kit)
![license](https://img.shields.io/npm/l/@shirudo/ddd-kit)

## When This Helps

Use this kit when your TypeScript code has domain rules that deserve more than
DTOs and service functions:

- an order can only be confirmed once
- a booking must stay inside an allowed date range
- money must never lose precision at a JSON boundary
- optimistic concurrency conflicts must be handled deliberately
- domain events must be persisted and dispatched reliably
- repository adapters must prove they enforce the same contract

The library is intentionally boring at the edges. It does not ship an ORM, a
message broker, decorators, a dependency-injection container, or a web
framework. Those choices belong to the application.

## Installation

```bash
pnpm add @shirudo/ddd-kit @shirudo/result @shirudo/base-error
```

`@shirudo/result` and `@shirudo/base-error` are peer dependencies. Install them
once in the consuming app.

The package is ESM-only, requires TypeScript 5.9+, and supports Node 22+,
Cloudflare Workers, Vercel Edge, Deno, and Bun.

## A Small Aggregate

```ts
import {
  AggregateRoot,
  DomainError,
  type DomainEvent,
  type Id,
} from "@shirudo/ddd-kit";

type OrderId = Id<"OrderId">;

type OrderState = {
  status: "draft" | "confirmed";
};

type OrderConfirmed = DomainEvent<
  "OrderConfirmed",
  { orderId: OrderId }
>;

type OrderEvent = OrderConfirmed;

class OrderAlreadyConfirmedError extends DomainError<
  "ORDER_ALREADY_CONFIRMED"
> {
  constructor(orderId: OrderId) {
    super({
      code: "ORDER_ALREADY_CONFIRMED",
      message: `Order ${orderId} is already confirmed.`,
    });
  }
}

class Order extends AggregateRoot<OrderState, OrderId, OrderEvent> {
  protected readonly aggregateType = "Order";

  private constructor(id: OrderId, state: OrderState) {
    super(id, state);
  }

  static draft(id: OrderId): Order {
    return new Order(id, { status: "draft" });
  }

  get status(): OrderState["status"] {
    return this.state.status;
  }

  confirm(): void {
    if (this.state.status === "confirmed") {
      throw new OrderAlreadyConfirmedError(this.id);
    }

    this.commit(
      { status: "confirmed" },
      this.recordEvent("OrderConfirmed", { orderId: this.id }),
    );
  }
}

const order = Order.draft("order-1" as OrderId);

order.confirm();

order.status; // "confirmed"
order.version; // 1
order.pendingEvents[0]?.type; // "OrderConfirmed"
```

That example is deliberately small, but it shows the core shape:

- the aggregate owns the rule
- the domain throws when an invariant is broken
- `commit(...)` changes state and records the event together
- `recordEvent(...)` stamps aggregate identity onto the event
- persistence is still outside the aggregate

In production, a repository and `withCommit` or `UnitOfWork` persist the state,
write the events to an outbox inside the same transaction, and mark the
aggregate as persisted after the transaction commits.

## What You Get

**Domain modeling**

- value objects via `vo()` and `ValueObject<T>`
- exact Money helpers in `@shirudo/ddd-kit/money`
- child entities with branded identity
- state-stored and event-sourced aggregate roots
- domain events with metadata, schema version, and commit stamps
- a domain state machine for named lifecycle states

**Application boundaries**

- `CommandHandler` and `QueryHandler` types
- in-process `CommandBus` and `QueryBus` for modular apps, tests, and edge
  runtimes
- a clear error split: domain code throws, command/query boundaries return
  `Result`
- `voValidated` for collecting field-level validation issues
- optional HTTP/RFC 9457 presentation helpers

**Persistence and delivery**

- repository interfaces for id-based and filtered access
- a per-operation Identity Map contract
- optimistic concurrency errors and duplicate-insert errors
- `withCommit` for transaction, outbox, event harvest, and post-commit cleanup
- `UnitOfWork` for repository registration and enrollment
- outbox dispatcher, projection, event-store, and snapshot ports
- contract tests for repository and outbox adapters

## What It Does Not Do

The kit does not decide your architecture for you. It gives you hard boundaries
where the domain model needs them and stays out of the rest.

- No ORM adapter is bundled.
- No queue or broker is required.
- No global application container is introduced.
- No query DSL or expression trees: `Specification` evaluates in memory and is translated explicitly by adapters, never reverse-engineered into SQL.
- No money rounding, allocation, or FX policy is hidden in the library.
- No cross-process command bus is pretended to be in-process code.

Those are application decisions. The guides show the recommended seams.

## Guide Map

Start with [Getting Started](./docs/guide/getting-started.md) if you want the
short walkthrough. Read [Design Decisions](./docs/guide/design-decisions.md) if
you want to understand why the kit is shaped this way. Keep
[Common Mistakes](./docs/guide/common-mistakes.md) nearby when writing your
first adapter or aggregate.

| Topic | Guide |
| --- | --- |
| Value objects and validation helpers | [Value Objects](./docs/guide/value-objects.md) |
| Exact money values | [Money](./docs/guide/money.md) |
| Child entities and identity | [Entities](./docs/guide/entities.md) |
| State-stored aggregates | [Aggregate Roots](./docs/guide/aggregates.md) |
| Event-sourced aggregates and snapshots | [Event Sourcing](./docs/guide/event-sourcing.md) |
| Domain event shape and factories | [Domain Events](./docs/guide/domain-events.md) |
| Named lifecycle states | [Domain State Machine](./docs/guide/domain-state-machine.md) |
| Throwing in the domain, returning `Result` at the boundary | [Result vs Throw](./docs/guide/result-vs-throw.md) |
| Commands, queries, and in-process buses | [CQRS & Buses](./docs/guide/cqrs-and-buses.md) |
| Repository contracts and Identity Map | [Repository](./docs/guide/repository.md) |
| Transaction-scoped repositories | [Unit of Work](./docs/guide/unit-of-work.md) |
| Duplicate-safe commands and inbox handling | [Command Idempotency](./docs/guide/idempotency.md) |
| Reliable event harvest and delivery | [Outbox & Transactions](./docs/guide/outbox.md) |
| Read models and projectors | [Projections](./docs/guide/projections.md) |
| Event schema changes | [Event Upcasting](./docs/guide/event-upcasting.md) |
| Optimistic concurrency | [Concurrency](./docs/guide/concurrency.md) |
| Workers, Deno, Bun, and other edge runtimes | [Edge Runtimes](./docs/guide/edge-runtimes.md) |

The generated API reference lives in [docs/api](./docs/api/).

## Examples

- [examples/order](./examples/order): a minimal state-stored aggregate
- [examples/order-with-entity-items](./examples/order-with-entity-items): an
  aggregate with child entities
- [examples/rugby](./examples/rugby): an event-sourced aggregate
- [examples/saga](./examples/saga): a process manager / saga workflow

## Contributing

Bug reports, questions, and pull requests are welcome on
[GitHub](https://github.com/shi-rudo/ddd-kit-ts). Please open pull requests
against `main`.

## License

MIT.

## Author

**Shirudo**:
[@shi-rudo](https://github.com/shi-rudo) |
[npm](https://www.npmjs.com/package/@shirudo/ddd-kit) |
[repository](https://github.com/shi-rudo/ddd-kit-ts)
