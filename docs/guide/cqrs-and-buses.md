# CQRS & Buses

The kit ships an in-memory `CommandBus` and `QueryBus` plus marker types (`Command`, `Query`, `CommandHandler<C, R>`, `QueryHandler<Q, R>`) that stay portable across transports.

## Scope: in-process only

The bundled buses are **zero-config in-process dispatchers**. They fit:

- **Edge runtimes** (Cloudflare Workers, Vercel Edge, Deno Deploy, Bun): each worker invocation handles one command in-process; external brokers would defeat edge latency
- **Modular monoliths:** single Node process, multiple bounded contexts; the bus routes between modules
- **Tests and local development:** stand-in for production buses without infrastructure
- **Small CLIs and scripts**

For **cross-process messaging** (RabbitMQ, NATS, Kafka, AWS SQS), don't use the in-memory bus. Keep the `CommandHandler<C, R>` / `QueryHandler<Q, R>` types as the contract and wire them to your transport. The handlers stay portable; only the dispatcher changes.

The included buses intentionally have **no middleware/pipeline machinery**: wrap handlers with decorator functions when you need logging, auth, metrics. Anything more elaborate is in-house framework territory and lives outside the kit.

## Commands

```ts
import {
  CommandBus,
  type Command,
  type CommandHandler,
} from "@shirudo/ddd-kit";
import { ok, err, type Result } from "@shirudo/result";

// Define commands as discriminated unions on `type`
type CreateOrderCommand = Command & {
  type: "CreateOrder";
  customerId: string;
  items: Array<{ productId: string; quantity: number; priceCents: number }>;
};

type ConfirmOrderCommand = Command & {
  type: "ConfirmOrder";
  orderId: string;
};

// Map of command type → handler return type for end-to-end typing
type Commands = {
  CreateOrder:  string;  // returns the new orderId
  ConfirmOrder: void;
};

// Define handlers
const createOrderHandler: CommandHandler<CreateOrderCommand, string> = async (cmd) => {
  if (cmd.items.length === 0) return err("EMPTY_ORDER");
  // ... business logic ...
  return ok(orderId);
};

// Wire up the bus
const bus = new CommandBus<Commands>();
bus.register("CreateOrder", createOrderHandler);

// Execute: return type is Result<string, string>
const result = await bus.execute({
  type: "CreateOrder",
  customerId: "c-1",
  items: [{ productId: "p-1", quantity: 2, priceCents: 999 }],
});
```

### Strict typing through `TMap`

When you supply the type map, `register()` constraints kick in:

```ts
// @ts-expect-error: "Unknown" is not a key of Commands
bus.register("Unknown", async () => ok("x"));

// @ts-expect-error: handler must return Promise<Result<string, string>>
bus.register("CreateOrder", async () => ok(42));
```

Without a `TMap` the registration is loose (any key, any return type); the no-config path keeps working for tests and prototypes.

## Queries

```ts
import {
  QueryBus,
  type Query,
  type QueryHandler,
} from "@shirudo/ddd-kit";

type GetOrderQuery = Query & {
  type: "GetOrder";
  orderId: string;
};

type Queries = {
  GetOrder: Order | null;
};

const getOrderHandler: QueryHandler<GetOrderQuery, Order | null> = async (q) => {
  return await orderRepository.getById(q.orderId as OrderId);
};

const queryBus = new QueryBus<Queries>();
queryBus.register("GetOrder", getOrderHandler);

// Safe variant: returns Result<Order | null, string>
const safe = await queryBus.execute({ type: "GetOrder", orderId: "o-1" });

// Throw-on-failure variant: returns Order | null directly
const order = await queryBus.executeUnsafe({ type: "GetOrder", orderId: "o-1" });
```

Queries return data directly (`QueryHandler` is `(q: Q) => Promise<R>`), not a `Result`: read operations don't usually have business-level errors. Only `execute` adds the Result wrapper for "no handler registered" / unexpected throws; `executeUnsafe` skips it.

## `withCommit`: transactional Use Cases

The canonical write-side wrapper:

```ts
import { withCommit } from "@shirudo/ddd-kit";

const result = await withCommit(
  { outbox, bus, scope },
  async () => {
    const order = await repo.getByIdOrFail(orderId);
    order.confirm();
    await repo.save(order);
    return { result: order.id, aggregates: [order] };
  },
);
```

Order of operations:

1. `scope.transactional(fn)`: `fn` runs inside the persistence layer's native transaction
2. Inside the transaction: state mutations + `outbox.add(events)`, so events persist **atomically** with the state change
3. Transaction commits
4. **After** the commit, `bus.publish(events)` fires for in-process subscribers

Publishing *after* commit defeats the classic publish-before-commit footgun: subscribers can never react to events from a rolled-back transaction. If `bus.publish` itself throws, `withCommit` does **not** reject: the transaction has committed, so the caller always receives the committed `result` (a rejection here would invite a double-executing retry). The error is reported to the optional `onPublishError(error, events)` dep (wire it to your logger/metrics); delivery is still guaranteed because the outbox dispatcher picks the events up (eventual consistency).

See [Outbox & Transactions](./outbox.md) for the full outbox/dispatcher contract, and [Read-Side Projections](./projections.md) for the canonical CQRS read-side flow (dispatcher → projection handlers → read-model tables → `QueryBus`).

## Correlation IDs (and other cross-cutting concerns)

The bus is a transport-free, in-process dispatcher: it has no concept of an HTTP header, so it does not read, generate, or inject a correlation ID. That stays a boundary concern, which keeps the kit headless and edge-safe. The headless pattern has three steps.

**1. Capture the id at the transport boundary and carry it on the command.** Your HTTP adapter (not the kit) reads `x-correlation-id`, generating one if absent, and puts it on the command. Generation lives where the request does, so you control the id scheme (ULID, UUID, vendor trace id):

```ts
// HTTP handler (your code, at the edge)
const correlationId =
  request.headers.get("x-correlation-id") ?? crypto.randomUUID();

const result = await commandBus.execute({
  type: "ConfirmOrder",
  orderId,
  correlationId, // a plain field on your Command
});
```

**2. Propagate it into event metadata.** `EventMetadata` already carries `correlationId`, `causationId`, `userId`, and `source`. Stamp it when the aggregate records the event, then chain causation with `copyMetadata`:

```ts
import { createDomainEventWithMetadata, copyMetadata } from "@shirudo/ddd-kit";

const placed = createDomainEventWithMetadata(
  "OrderConfirmed",
  { orderId },
  { correlationId: cmd.correlationId, source: "orders" },
);

// a downstream event caused by `placed` inherits the correlation, adds causation:
const shipped = createDomainEventWithMetadata(
  "ShipmentRequested",
  { orderId },
  copyMetadata(placed, { causationId: placed.eventId }),
);
```

**3. Auto-propagate by wrapping the handler, not the bus.** The buses ship no middleware on purpose (see [Scope](#scope-in-process-only)); the endorsed extension point is a handler decorator. A thin wrapper can pull the id off the command and make it ambient for logging without touching the bus API:

```ts
const withCorrelation =
  <C extends { correlationId?: string }, R>(handler: CommandHandler<C, R>): CommandHandler<C, R> =>
  (cmd) =>
    logger.runWith({ correlationId: cmd.correlationId }, () => handler(cmd));

commandBus.register("ConfirmOrder", withCorrelation(confirmOrderHandler));
```

For ambient propagation across `await` boundaries, use `AsyncLocalStorage` (Node) in your application layer, not in the library: the kit stays free of Node globals so it runs unchanged on edge runtimes. See [Edge Runtimes](./edge-runtimes.md).

## Process Managers / Sagas

For multi-step workflows that span aggregates (order → payment → shipping → confirmation, with compensating actions on failure), the kit ships no abstraction, but the building blocks compose into the canonical pattern. The Process Manager is itself an `AggregateRoot` whose `EventBus.subscribe` reflexes transition its state and dispatch the next `CommandBus` command. See [`examples/saga/`](https://github.com/shi-rudo/ddd-kit-ts/tree/main/examples/saga) for a worked example with happy-path + two compensation flows.
