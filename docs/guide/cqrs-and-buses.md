# CQRS & Buses

CQRS separates write intentions from read questions.

A **command** asks the system to do something: place an order, confirm a shipment, cancel a subscription. A **query** asks for data: get an order, list open invoices, show a dashboard.

The kit ships small in-process buses for those two flows:

- `CommandBus` dispatches commands to `CommandHandler`s.
- `QueryBus` dispatches queries to `QueryHandler`s.
- `EventBusImpl` dispatches domain events to in-process subscribers.

The important boundary: these buses are dispatchers, not brokers. They do not replace RabbitMQ, Kafka, SQS, NATS, or a workflow engine. They give your application a typed handler contract and a simple in-process dispatcher. If you later move a handler behind a queue, keep the handler type and replace the transport.

<a id="scope-in-process-only"></a>

## Scope: In-Process Only

The bundled buses fit code that runs inside one process or one request:

- edge functions where adding a broker would defeat the latency model
- modular monoliths where bounded contexts live in one deployable
- tests that should exercise real dispatch without infrastructure
- CLIs, scripts, and local development tools

They deliberately do not include middleware pipelines, retries, dead-letter queues, backpressure, scheduling, or cross-process delivery.

That restraint is a design choice. A bus with middleware, retry policy, transport adapters, metrics, authorization, and tracing quickly becomes an application framework. The kit stops at the handler contract. You can still add cross-cutting behavior with small handler decorators, and you can still adapt the handler types to a production message broker.

## Commands

Commands are write-side messages. They should carry enough data for the handler to perform one application operation.

```ts
import {
  CommandBus,
  type Command,
  type CommandHandler,
  type Id,
  withCommit,
} from "@shirudo/ddd-kit";
import { err, ok } from "@shirudo/result";
import {
  type MoneyDto,
  moneyFromDto,
} from "@shirudo/ddd-kit/money";

type OrderId = Id<"OrderId">;

type PlaceOrderCommand = Command & {
  type: "PlaceOrder";
  customerId: string;
  correlationId?: string;
  items: Array<{
    productId: string;
    quantity: number;
    price: MoneyDto;
  }>;
};

type ConfirmOrderCommand = Command & {
  type: "ConfirmOrder";
  orderId: OrderId;
};

type Commands = {
  PlaceOrder: OrderId;
  ConfirmOrder: void;
};
```

The command shape is close to the transport boundary. `MoneyDto` is the right shape here because commands often come from JSON. Convert it to domain `Money` before it reaches aggregate state:

```ts
const placeOrderHandler: CommandHandler<
  PlaceOrderCommand,
  OrderId
> = async (cmd) => {
  if (cmd.items.length === 0) {
    return err("EMPTY_ORDER");
  }

  const result = await withCommit(
    { scope, outbox, bus: eventBus },
    async (tx, enrollment) => {
      const orders = makeOrderRepository(tx);
      const order = Order.place(newOrderId(), cmd.customerId);

      for (const item of cmd.items) {
        order.addItem({
          productId: item.productId,
          quantity: item.quantity,
          price: moneyFromDto(item.price),
        });
      }

      await orders.save(order);

      return {
        result: order.id,
        commits: [enrollment.enrollSaved(order)],
      };
    },
  );

  return ok(result);
};
```

A command handler returns `Result<R, E>`. Use the success channel for the useful result, such as a new id. Use the error channel for expected application failures you want the caller to handle as values. Infrastructure failures and wiring bugs can still throw.

Wire the bus at bootstrap:

```ts
const commandBus = new CommandBus<Commands>();

commandBus.register("PlaceOrder", placeOrderHandler);
commandBus.register("ConfirmOrder", confirmOrderHandler);

const result = await commandBus.execute({
  type: "PlaceOrder",
  customerId: "c-1",
  items: [
    {
      productId: "p-1",
      quantity: 2,
      price: { amountMinor: "999", currency: "EUR", scale: 2 },
    },
  ],
});
```

With a type map, `execute(...)` infers the result type from `command.type`. Here `result` is `Result<OrderId, string>`.

### Type Maps

The type map is small, but it buys a lot:

```ts
type Commands = {
  PlaceOrder: OrderId;
  ConfirmOrder: void;
};

const bus = new CommandBus<Commands>();

bus.register("PlaceOrder", placeOrderHandler);

// @ts-expect-error: "Unknown" is not a command type
bus.register("Unknown", async () => ok("x"));

// @ts-expect-error: PlaceOrder must return Result<OrderId, string>
bus.register("PlaceOrder", async () => ok(42));
```

Without a type map, registration is intentionally loose. That is useful in tests and prototypes. In application code, prefer the map. It catches typos at bootstrap instead of at runtime.

### Unregistered Commands

Dispatching a command type with no registered handler throws `UnregisteredHandlerError`.

That is a wiring bug, not a domain failure. The command bus does not put it on the `Result` error channel and does not pass it through `mapExpectedError`. A missing registration means the application was bootstrapped incorrectly, so it should fail loudly at the boundary that turns programming bugs into 500s.

A registered handler's throw is not automatically an expected failure either. With no error policy, `CommandBus.execute` rethrows the exact value. Prefer returning `err(...)` for failures already expressed by a command handler. If an exception-first dependency needs translation, configure `mapExpectedError` as a selective boundary: return `{ error }` for a recognized expected failure and `undefined` for everything else. Unknown programmer errors, cancellation, and infrastructure failures then retain their type, cause chain, and cancellation behavior.

## Queries

Queries are read-side messages. They should not mutate domain state.

```ts
import {
  QueryBus,
  type Query,
  type QueryHandler,
} from "@shirudo/ddd-kit";

type GetOrderQuery = Query & {
  type: "GetOrder";
  orderId: OrderId;
};

type Queries = {
  GetOrder: OrderReadModel | null;
};

const getOrderHandler: QueryHandler<
  GetOrderQuery,
  OrderReadModel | null
> = async (query) => {
  return orderReadModel.findById(query.orderId);
};

const queryBus = new QueryBus<Queries>();
queryBus.register("GetOrder", getOrderHandler);

const safe = await queryBus.execute({
  type: "GetOrder",
  orderId,
});

const unsafe = await queryBus.executeUnsafe({
  type: "GetOrder",
  orderId,
});
```

`QueryHandler` returns data directly, not `Result`. Reads usually do not have domain-level failures; "not found" is normally part of the returned data shape, such as `OrderReadModel | null`.

The bus gives you two execution styles:

- `execute(...)` returns `Result<R, E>` and applies the optional selective `mapExpectedError` policy; unclassified handler failures throw.
- `executeUnsafe(...)` returns `R` directly and lets handler failures throw.

Both variants throw `UnregisteredHandlerError` for missing handlers. Missing query registration is still a wiring bug.

In a CQRS application, query handlers usually read from projection tables or read models, not from aggregates. Aggregates are write-side consistency boundaries. Read models are shaped for screens and API responses. See [Read-Side Projections](./projections.md).

## `withCommit`: The Write-Side Boundary

The bus dispatches the command. The command handler owns the use case. `withCommit` owns the transaction and event harvest.

```ts
import { withCommit } from "@shirudo/ddd-kit";

const result = await withCommit(
  { scope, outbox, bus: eventBus },
  async (tx, enrollment) => {
    const orders = makeOrderRepository(tx);

    const order = await orders.getById(orderId);
    order.confirm();

    await orders.save(order);

    return {
      result: order.id,
      commits: [enrollment.enrollSaved(order)],
    };
  },
);
```

The order matters:

1. Open the persistence transaction through `scope`.
2. Load and mutate aggregates inside the transaction.
3. Persist aggregates through transaction-bound repositories.
4. Validate the invocation-scoped commit tokens and harvest their pending
   events.
5. Write those events to the outbox in the same transaction.
6. Commit.
7. Mark aggregates persisted.
8. Publish to the optional in-process `bus` after commit.

Publishing after commit is important. Subscribers should never observe an event for a transaction that later rolls back.

If post-commit `bus.publish(events)` fails, `withCommit` still returns the committed result. The database transaction already succeeded, so rejecting the use case would encourage callers to retry the whole command and possibly execute the write twice. Use `onPublishError(error, events)` for logging and metrics. Durable delivery belongs to the outbox dispatcher.

See [Outbox & Transactions](./outbox.md) for the full outbox lifecycle.

## Correlation IDs

The in-process buses do not know about HTTP headers, trace vendors, or request contexts. Correlation is a boundary concern.

A practical pattern has three steps.

### Capture at the Transport Boundary

Your HTTP adapter reads or creates the correlation id and puts it on the command:

```ts
const correlationId =
  request.headers.get("x-correlation-id") ?? crypto.randomUUID();

const result = await commandBus.execute({
  type: "ConfirmOrder",
  orderId,
  correlationId,
});
```

The kit does not generate this id because different applications use different schemes: UUIDs, ULIDs, platform trace ids, or gateway-provided ids.

### Propagate into Event Metadata

`EventMetadata` already has fields for `correlationId`, `causationId`, `userId`, and `source`.

```ts
import { copyMetadata, createDomainEvent } from "@shirudo/ddd-kit";

const confirmed = createDomainEvent(
  "OrderConfirmed",
  { orderId },
  {
    metadata: {
      correlationId: cmd.correlationId,
      source: "orders",
    },
  },
);

const shipmentRequested = createDomainEvent(
  "ShipmentRequested",
  { orderId },
  {
    metadata: copyMetadata(confirmed, {
      causationId: confirmed.eventId,
    }),
  },
);
```

Inside aggregate methods, prefer `this.recordEvent(...)`; pass metadata through its options when the event should carry correlation. Outside aggregates, `createDomainEvent(...)` is the right primitive.

### Wrap Handlers for Ambient Context

The buses have no middleware pipeline. If you want logging context, wrap the handler:

```ts
const withCorrelation =
  <C extends Command & { correlationId?: string }, R>(
    handler: CommandHandler<C, R>,
  ): CommandHandler<C, R> =>
  (cmd) =>
    logger.runWith(
      { correlationId: cmd.correlationId },
      () => handler(cmd),
    );

commandBus.register("ConfirmOrder", withCorrelation(confirmOrderHandler));
```

On Node, your application layer can use `AsyncLocalStorage` inside that wrapper. The kit itself avoids Node globals so the same handlers work on edge runtimes. See [Edge Runtimes](./edge-runtimes.md).

## Process Managers / Sagas

A process manager coordinates a workflow that spans aggregates.

Examples:

- order confirmed -> request payment
- payment captured -> request shipment
- shipment failed -> refund payment and cancel order

Do not force those rules into one aggregate unless they must be immediately consistent in one transaction. If the workflow can proceed through events and compensating commands, keep the aggregate boundaries smaller and model the coordination explicitly.

The kit does not ship a saga framework. The building blocks are already here:

- `EventBus` or an outbox dispatcher receives domain events.
- A process-manager handler loads or creates workflow state.
- That state can be an `AggregateRoot` when it needs identity, versioning, and persistence.
- The handler dispatches the next command through `CommandBus`.
- Idempotency and outbox dispatch protect retries and delivery.

That shape keeps the workflow in application code instead of hiding it in bus middleware. See [examples/saga](https://github.com/shi-rudo/ddd-kit-ts/tree/main/examples/saga) for a worked example with a happy path and compensation flows.

## How to Choose

Use this as the default split:

| Need | Use |
| --- | --- |
| Run one write use case in-process | `CommandBus` + `CommandHandler` |
| Read data for a screen or API response | `QueryBus` + read model |
| Persist aggregate changes and events atomically | `withCommit` or `UnitOfWork` |
| Notify in-process subscribers after commit | `EventBusImpl` passed to `withCommit` |
| Deliver events across processes | `Outbox` + dispatcher |
| Coordinate long-running cross-aggregate workflows | Process manager / saga built from events and commands |

The buses should make control flow explicit. They should not become a place to hide transactions, authorization, retries, or workflow state. Put those responsibilities at the boundary that owns them.
