# Getting Started

`@shirudo/ddd-kit` is a composable toolkit for tactical Domain-Driven Design in TypeScript. It models the canonical building blocks — Value Objects, Entities, Aggregate Roots, Domain Events, Repositories, and CQRS handlers — without a framework or runtime. It targets modern TypeScript runtimes including Node 18+, Cloudflare Workers, Vercel Edge, Deno, and Bun.

## Installation

```bash
pnpm add @shirudo/ddd-kit @shirudo/result
```

`@shirudo/result` is a peer dependency — the library uses it as the canonical `Result<T, E>` type at the App-Service boundary (CommandBus, QueryBus, `withCommit`).

::: tip Module format
ddd-kit is **ESM-only**. Your project must be ESM (`"type": "module"` in `package.json`) or use a bundler that handles ESM. CJS is not supported.
:::

## A Minimal Aggregate

The simplest end-to-end example: an `Order` aggregate with a single business method.

```ts
import {
  AggregateRoot,
  type DomainEvent,
  type Id,
  DomainError,
} from "@shirudo/ddd-kit";

type OrderId = Id<"OrderId">;

type OrderState = {
  customerId: string;
  status: "draft" | "confirmed" | "shipped";
};

type OrderEvent = DomainEvent<"OrderConfirmed", { orderId: OrderId }>;

class OrderAlreadyConfirmedError extends DomainError {
  constructor(public readonly orderId: OrderId) {
    super(`Order ${orderId} is already confirmed`);
  }
}

class Order extends AggregateRoot<OrderState, OrderId, OrderEvent> {
  protected readonly aggregateType = "Order";

  static draft(id: OrderId, customerId: string): Order {
    return new Order(id, { customerId, status: "draft" });
  }

  confirm(): void {
    if (this.state.status !== "draft") {
      throw new OrderAlreadyConfirmedError(this.id);
    }
    this.commit(
      { ...this.state, status: "confirmed" },
      this.recordEvent("OrderConfirmed", { orderId: this.id }),
    );
  }
}

const order = Order.draft("o-1" as OrderId, "c-42");
order.confirm();
// order.state.status === "confirmed"
// order.version       === 1
// order.pendingEvents[0].type    === "OrderConfirmed"
// order.pendingEvents[0].payload === { orderId: "o-1" }
```

What this example shows:

- **`protected readonly aggregateType = "Order"` is required on every concrete subclass.** Both `AggregateRoot` and `EventSourcedAggregate` declare it `abstract readonly`; concrete classes fail to compile until it's set. Outbox dispatchers and projection handlers route events by this string, so pick the canonical domain name.
- **`this.recordEvent(type, payload)` is the canonical path for recording events from aggregate methods.** It calls `createDomainEvent` under the hood and auto-injects `aggregateId = this.id` + `aggregateType = this.aggregateType` into the event metadata. `withCommit` validates both fields at the harvest boundary and throws if either is missing — `recordEvent` makes that impossible to forget.
- **Aggregates throw to enforce invariants.** `OrderAlreadyConfirmedError extends DomainError` — consumers can catch by `instanceof`.
- **`commit(state, events)` is the canonical record-after-mutation path.** It validates state first, only then records the event(s), and always bumps the version.
- **Domain events are typed.** The `OrderEvent` union flows through `AggregateRoot<OrderState, OrderId, OrderEvent>` so `pendingEvents` reads as `ReadonlyArray<OrderEvent>`.

## Where to next

- [Value Objects](./value-objects.md) — `vo()`, deep freezing, validation
- [Entities](./entities.md) — class-based vs functional patterns
- [Aggregate Roots](./aggregates.md) — versions, OCC, snapshots
- [Event Sourcing](./event-sourcing.md) — `EventSourcedAggregate`, `apply()`, replay
- [Result vs Throw](./result-vs-throw.md) — the kit's central architectural choice
- [CQRS & Buses](./cqrs-and-buses.md) — `CommandBus`, `QueryBus`, when to use them
- [Repository](./repository.md) — `IRepository`, `IQueryableRepository`, OCC
