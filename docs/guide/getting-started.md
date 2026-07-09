# Getting Started

`@shirudo/ddd-kit` is a small TypeScript toolkit for tactical Domain-Driven
Design. It gives you the building blocks: Value Objects, Entities, Aggregate
Roots, Domain Events, repositories, CQRS handler types, in-process buses, Unit
of Work helpers, and outbox ports.

It is not an application framework. It does not own your HTTP server, database
driver, ORM, queue, logger, or dependency-injection container. The kit keeps the
domain and application contracts explicit so your adapters can stay yours.

## Installation

```bash
pnpm add @shirudo/ddd-kit @shirudo/result @shirudo/base-error
```

`@shirudo/result` and `@shirudo/base-error` are peer dependencies. Install them
once in the consuming app:

- `@shirudo/result` is the `Result<T, E>` type used by command/query boundaries.
- `@shirudo/base-error` is the structured-error foundation used by kit errors
  and validation helpers.

::: tip Module format
The package is ESM-only. Node consumers need `"type": "module"` in
`package.json` or a bundler that handles ESM. The package declares Node `>=22`
for Node projects and also targets modern edge runtimes.
:::

## The first mental model

Most write-side code follows this shape:

1. Load or create an aggregate root.
2. Call a domain method on it.
3. The aggregate validates the move, changes state, and records events.
4. The application service saves the aggregate.
5. `withCommit` harvests events into the outbox and marks the aggregate
   persisted after the transaction commits.

The aggregate is the consistency boundary. Application code should ask it to do
domain work; it should not mutate child state or event lists from the outside.

## A minimal aggregate

```ts
import {
  AggregateRoot,
  DomainError,
  type DomainEvent,
  type Id,
} from "@shirudo/ddd-kit";

type OrderId = Id<"OrderId">;

type OrderState = {
  customerId: string;
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

  static draft(id: OrderId, customerId: string): Order {
    return new Order(id, {
      customerId,
      status: "draft",
    });
  }

  confirm(): void {
    if (this.state.status === "confirmed") {
      throw new OrderAlreadyConfirmedError(this.id);
    }

    this.commit(
      {
        ...this.state,
        status: "confirmed",
      },
      this.recordEvent("OrderConfirmed", {
        orderId: this.id,
      }),
    );
  }
}

const order = Order.draft("order-1" as OrderId, "customer-1");

order.confirm();

order.state.status; // "confirmed"
order.version; // 1
order.pendingEvents[0]?.type; // "OrderConfirmed"
```

This example shows the core conventions:

- `aggregateType` is required on every concrete aggregate. It is written onto
  events so outbox dispatchers and projections know where the event came from.
- `recordEvent(...)` is the safe way to create aggregate events. It fills
  `aggregateId` and `aggregateType` automatically.
- `commit(newState, events)` changes state first, records events after the
  state is valid, and bumps the aggregate version once.
- Domain rules throw `DomainError` subclasses. Application boundaries decide
  whether to turn those errors into `Result`, HTTP responses, or logs.
- `pendingEvents` are not historical events yet. They are the aggregate's
  unflushed event queue until the transaction/outbox boundary harvests them.

At this point nothing has been persisted. Persistence is an adapter concern.
The aggregate has done domain work; a repository and `withCommit` still need to
store the state and events.

## What to read next

Start with the guide that matches what you are building:

| If you need to... | Read |
| --- | --- |
| model immutable values | [Value Objects](./value-objects.md) |
| model child identity inside an aggregate | [Entities](./entities.md) |
| build state-stored aggregates | [Aggregate Roots](./aggregates.md) |
| persist aggregates safely | [Repository](./repository.md), then [Unit of Work](./unit-of-work.md) |
| publish events reliably | [Outbox & Transactions](./outbox.md) |
| decide throw vs `Result` | [Result vs Throw](./result-vs-throw.md) |
| dispatch commands and queries | [CQRS & Buses](./cqrs-and-buses.md) |
| rebuild read models | [Projections](./projections.md) |
| use event sourcing | [Event Sourcing](./event-sourcing.md) |
| run on Workers, Vercel Edge, Deno, or Bun | [Edge Runtimes](./edge-runtimes.md) |

Before writing a repository adapter, read [Common Mistakes](./common-mistakes.md).
It covers the failure modes that compile cleanly but break event delivery,
optimistic concurrency, or transaction boundaries.
