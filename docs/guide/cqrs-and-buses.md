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

## Event Handlers, Side Effects, And Cancellation

A domain event says that something meaningful has already happened.
`OrderConfirmed`, for example, records a business fact. Sending the confirmation
email is not part of that fact; it is one possible reaction to it.

An event handler defines that reaction. It may perform a **side effect**: work
that changes or communicates with something outside the handler's own
calculation. Sending an email, making an HTTP request, writing an audit record,
or updating a cache are all side effects. This work can be slow, fail, or wait
forever. The imperative shell is the part of the application that invokes the
handler and supervises the I/O it starts.

`EventBusImpl` therefore bounds the execution of every handler. For each call
to `publish`, it creates one `ExecutionContext` and passes it to every handler
for the event type, including handlers registered through `subscribeAll`. The
context gives all of those handlers the same cancellation signal and time
budget:

```ts
eventBus.subscribe("OrderConfirmed", async (event, context) => {
  await mailer.sendConfirmation(event.payload.orderId, {
    signal: context.signal,
  });
});

await eventBus.publish(events, {
  signal: request.signal,
  timeoutMs: 5_000,
});
```

In this example, the complete publication may run for at most five seconds. It
ends sooner if `request.signal` is aborted, for example because the client
disconnected or the request was cancelled. The handler passes `context.signal`
to the mailer so that the underlying I/O can stop as well.

`context.signal` is aborted when either the owner cancels the work or the
publication reaches its timeout. `context.deadlineAt` describes the same limit
as an absolute Unix epoch millisecond, which is useful when an adapter needs to
configure its own native deadline. The timeout covers the entire `publish`
call, not each handler separately. If no timeout is supplied, the default is 30
seconds.

When the owner cancels, `publish` rejects with the owner's abort reason. When
the time budget expires, it rejects with a `TimeoutError`. In either case the
caller stops waiting, even if a handler never settles. This bound cannot,
however, forcibly terminate an arbitrary JavaScript promise. A handler that
ignores `context.signal` may continue working in the background. Pass the
signal to HTTP clients, mailers, database drivers, and other adapters to avoid
that zombie work.

The domain event itself deliberately carries no `AbortSignal`.
`OrderConfirmed` remains true whether the email succeeds, times out, or is
cancelled. Cancellation describes how this application process handles the
fact; it is not part of the fact. It therefore belongs to the imperative shell,
not to the domain model.

## Commands

Commands are write-side messages. They should carry enough data for the handler
to perform one application operation.

### Decode before dispatch

A TypeScript type does not exist at runtime. Following `JSON.parse(...)` with a
command assertion therefore validates nothing; it only asks the compiler to
trust the author. An HTTP request or broker message must earn the command type
before it reaches the bus.

The driving adapter owns that work. It limits the raw body before parsing,
parses into `unknown`, allow-lists the wire fields, and converts primitives into
the types used by the application and domain. Authenticated identity comes from
the verified request or message principal, never from a customer id supplied in
the body. The kit deliberately does not choose a schema library: this decoder is
consumer code and can be replaced with ArkType, Valibot, Zod, or another
allow-list decoder.

```ts
import {
  AggregateRoot,
  type AnyDomainEvent,
  CommandBus,
  DomainError,
  type Command,
  type CommandHandler,
  type Id,
  type IdempotentCommitRequest,
  type WithIdempotentCommitDeps,
  domainErrorToResult,
  withIdempotentCommit,
} from "@shirudo/ddd-kit";
import { err, ok, type Result } from "@shirudo/result";
import { type Money, tryMoneyFromDto } from "@shirudo/ddd-kit/money";
```

<<< ../../src/app/order-placement-example.ts#order-domain{ts}

```ts
type ConfirmOrderCommand = Command & {
  readonly type: "ConfirmOrder";
  readonly orderId: OrderId;
};

type Commands = {
  PlaceOrder: OrderId;
  ConfirmOrder: void;
};
```

Here is a small framework-neutral decoder. Its limits are examples, not
universal defaults; choose them from the endpoint's real workload. Notice that
the byte ceiling runs before `JSON.parse`, and the collection ceiling runs
before mapping every item.

```ts
const MAX_COMMAND_BYTES = 64 * 1024;
const MAX_ORDER_ITEMS = 100;
const MAX_ID_LENGTH = 80;

interface AuthenticatedPrincipal {
  readonly customerId: CustomerId;
}

type BoundaryFailure = {
  readonly code: "PAYLOAD_TOO_LARGE" | "INVALID_COMMAND";
  readonly category: "VALIDATION";
  readonly retryable: false;
  readonly details: {
    readonly path: string;
    readonly reason: string;
  };
};

type TransportFailure = {
  readonly code: "INVALID_TRANSPORT_METADATA";
  readonly category: "VALIDATION";
  readonly retryable: false;
  readonly details: { readonly path: string };
};

interface PlaceOrderData {
  readonly customerId: CustomerId;
  readonly items: ReadonlyArray<PlaceOrderItem>;
}

interface PlaceOrderIntention extends PlaceOrderData {
  readonly type: "PlaceOrder";
}

function decodePlaceOrderBody(
  body: Uint8Array,
  principal: AuthenticatedPrincipal,
): Result<PlaceOrderData, BoundaryFailure> {
  if (body.byteLength > MAX_COMMAND_BYTES) {
    return err({
      code: "PAYLOAD_TOO_LARGE",
      category: "VALIDATION",
      retryable: false,
      details: { path: "$body", reason: "exceeds 64 KiB" },
    });
  }

  let input: unknown;
  try {
    input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return err(invalid("$body", "must be UTF-8 JSON"));
  }

  const rootResult = recordAt(input, "$body");
  if (rootResult.isErr()) return err(rootResult.error);
  const root = rootResult.value;

  const rootFieldError = allowOnly(root, ["type", "items"], "$body");
  if (rootFieldError !== undefined) return err(rootFieldError);
  if (root.type !== "PlaceOrder") {
    return err(invalid("$body.type", "must be PlaceOrder"));
  }
  if (!Array.isArray(root.items)) {
    return err(invalid("$body.items", "must be an array"));
  }
  if (root.items.length > MAX_ORDER_ITEMS) {
    return err(invalid("$body.items", "exceeds 100 entries"));
  }

  const items: PlaceOrderItem[] = [];
  for (const [index, value] of root.items.entries()) {
    const item = decodeItem(value, index);
    if (item.isErr()) return err(item.error);
    items.push(item.value);
  }

  return ok({
    customerId: principal.customerId,
    items,
  });
}

function decodeItem(
  value: unknown,
  index: number,
): Result<PlaceOrderItem, BoundaryFailure> {
  const path = `$body.items[${index}]`;
  const itemResult = recordAt(value, path);
  if (itemResult.isErr()) return err(itemResult.error);
  const item = itemResult.value;

  const itemFieldError = allowOnly(
    item,
    ["productId", "quantity", "price"],
    path,
  );
  if (itemFieldError !== undefined) return err(itemFieldError);

  const pricePath = `${path}.price`;
  const priceDtoResult = recordAt(item.price, pricePath);
  if (priceDtoResult.isErr()) return err(priceDtoResult.error);
  const priceDto = priceDtoResult.value;

  const priceFieldError = allowOnly(
    priceDto,
    ["amountMinor", "currency", "scale"],
    pricePath,
  );
  if (priceFieldError !== undefined) return err(priceFieldError);

  const price = tryMoneyFromDto(priceDto);
  if (price.isErr()) return err(invalid(pricePath, "must be a valid MoneyDto"));
  const productId = productIdFromWire(item.productId, `${path}.productId`);
  if (productId.isErr()) return err(productId.error);
  const quantity = quantityFromWire(item.quantity, `${path}.quantity`);
  if (quantity.isErr()) return err(quantity.error);

  return ok({
    productId: productId.value,
    quantity: quantity.value,
    price: price.value,
  });
}

function recordAt(
  value: unknown,
  path: string,
): Result<Record<string, unknown>, BoundaryFailure> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return err(invalid(path, "must be a plain object"));
  }
  return ok(value as Record<string, unknown>);
}

function allowOnly(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): BoundaryFailure | undefined {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    return invalid(path, `has unexpected fields: ${unexpected.join(", ")}`);
  }
}

function idString(
  value: unknown,
  path: string,
): Result<string, BoundaryFailure> {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_ID_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    return err(invalid(path, "is not a valid id"));
  }
  return ok(value);
}

function productIdFromWire(
  value: unknown,
  path: string,
): Result<ProductId, BoundaryFailure> {
  const id = idString(value, path);
  return id.isErr() ? err(id.error) : ok(id.value as ProductId);
}

function quantityFromWire(
  value: unknown,
  path: string,
): Result<OrderQuantity, BoundaryFailure> {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 1_000
  ) {
    return err(invalid(path, "must be an integer from 1 through 1000"));
  }
  return ok(value as OrderQuantity);
}

function transportId(
  value: unknown,
  path: string,
): Result<string, TransportFailure> {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    return err({
      code: "INVALID_TRANSPORT_METADATA",
      category: "VALIDATION",
      retryable: false,
      details: { path },
    });
  }
  return ok(value);
}

function invalid(path: string, reason: string): BoundaryFailure {
  return {
    code: "INVALID_COMMAND",
    category: "VALIDATION",
    retryable: false,
    details: { path, reason },
  };
}
```

The authentication adapter has already translated the external subject or
claims into the local `AuthenticatedPrincipal`. A subject that cannot be mapped
to `CustomerId` is therefore an authentication or identity-mapping failure; it
never becomes `INVALID_COMMAND` and never enters this payload decoder.

The casts above occur only inside constructors that have checked the runtime
value. That is what gives a brand meaning. `tryMoneyFromDto` plays the same role
for `Money`: the wire DTO is not allowed farther into the application. Payload,
transport, and authentication failures retain separate codes even when a broker
eventually routes all permanent input failures to the same dead-letter channel.
An unexpected defect still throws instead of being mislabeled as bad input.

The size ceilings are operational safety rules. They do not replace domain
invariants. For example, whether an order may be empty is a business decision
that the order model must still protect even when a trusted internal caller
bypasses this transport adapter.

`Order.place(...)` therefore receives every position needed for the decision and
either creates one complete, placed order or rejects the operation. There is no
public path that first creates a placed empty order and asks the application
layer to repair it one position at a time. An empty array is structurally valid
input—it is an array within the transport limits—but it violates the domain rule
expressed by `EmptyOrderError`.

The handler receives values that have already crossed the untrusted boundary. It
coordinates the transaction and persistence, while `domainErrorToResult`
selectively turns the one expected domain rejection into an application
outcome:

<<< ../../src/app/order-placement-example.ts#place-order-handler{ts}

The transaction stores a plain `PlaceOrderOutcome`, including a rejection, so a
duplicate idempotency key replays the same logical answer instead of running the
decision again. Only after that replay boundary does the handler expose the
usual `Result<R, E>`: the success channel carries the new id and the error
channel carries `EMPTY_ORDER`. `domainErrorToResult` lists the exact domain
error it is allowed to translate. Infrastructure failures, cancellation, and
wiring bugs remain throws rather than being mislabeled as business rejections.

Wire the bus at bootstrap:

```ts
const commandBus = new CommandBus<Commands>();
const placeOrderHandler = createPlaceOrderHandler({
  scope,
  outbox,
  idempotency,
  bus: eventBus,
  newOrderId,
  makeOrderRepository,
});

commandBus.register("PlaceOrder", placeOrderHandler);
commandBus.register("ConfirmOrder", confirmOrderHandler);

declare const commandFromDrivingAdapter: PlaceOrderCommand;
const result = await commandBus.execute(commandFromDrivingAdapter);
```

With a type map, `execute(...)` infers the result type from `command.type`. Here `result` is `Result<OrderId, string>`.

For a queue, invalid input is a poison message, not a transient failure. Reject
or dead-letter it without retrying; acknowledge a command once the application
has produced an expected success or rejection. Leave the message unacknowledged
only for failures your delivery policy classifies as retryable.

```ts
interface QueueDelivery {
  readonly body: Uint8Array;
  readonly authenticatedPrincipal: AuthenticatedPrincipal;
  readonly correlationId: string;
  readonly messageId: string;
  ack(): void;
  deadLetter(
    reason:
      | "PAYLOAD_TOO_LARGE"
      | "INVALID_COMMAND"
      | "INVALID_TRANSPORT_METADATA",
  ): void;
}

declare function recordCommandOutcome(
  deliveryKey: string,
  outcome: unknown,
): Promise<void>;
declare function stableHash(command: PlaceOrderIntention): string;

const PLACE_ORDER_CONSUMER = "orders.place-order.v1";

function scopedMessageKey(scope: string, messageId: string): string {
  return JSON.stringify([scope, messageId]);
}

async function consumePlaceOrder(delivery: QueueDelivery): Promise<void> {
  const correlationId = transportId(
    delivery.correlationId,
    "$transport.correlationId",
  );
  if (correlationId.isErr()) {
    delivery.deadLetter(correlationId.error.code);
    return;
  }

  const messageId = transportId(delivery.messageId, "$transport.messageId");
  if (messageId.isErr()) {
    delivery.deadLetter(messageId.error.code);
    return;
  }

  const decoded = decodePlaceOrderBody(
    delivery.body,
    delivery.authenticatedPrincipal,
  );
  if (decoded.isErr()) {
    delivery.deadLetter(decoded.error.code);
    return;
  }

  const intention: PlaceOrderIntention = {
    type: "PlaceOrder",
    ...decoded.value,
  };
  const deliveryKey = scopedMessageKey(PLACE_ORDER_CONSUMER, messageId.value);
  const command: PlaceOrderCommand = {
    ...intention,
    correlationId: correlationId.value,
    idempotency: {
      key: deliveryKey,
      fingerprint: stableHash(intention),
    },
  };

  const outcome = await commandBus.execute(command);
  await recordCommandOutcome(deliveryKey, outcome);
  delivery.ack();
}
```

`QueueDelivery` is deliberately an application-specific adapter type. RabbitMQ,
SQS, Kafka, and other brokers use different names and settlement rules, but the
order stays the same: bound, decode, convert, dispatch, record the outcome, then
settle. The adapter must expose a stable delivery identity within this consumer.
For Kafka that is commonly topic, partition, and offset; other brokers may
combine a queue or producer identity with their message id. `scopedMessageKey`
then separates this consumer from every other command stream that shares the
idempotency store. The fingerprint includes the command type and complete
business input, so a matching key can only replay the same intention.

With a transactional idempotency store, `withIdempotentCommit` stores the key,
fingerprint, outcome, aggregate write, and outbox entry in the application's
transaction. The separate `recordCommandOutcome` observer uses the same scoped
delivery key and must also be idempotent because an acknowledgement can fail
after that observer succeeds. A correlation id helps tracing; it does not make
an at-least-once delivery safe to repeat. See
[Idempotent Commands](./idempotency.md).

### Type Maps

The type map is small, but it buys a lot:

```ts
type Commands = {
  PlaceOrder: OrderId;
  ConfirmOrder: void;
};

const bus = new CommandBus<Commands>();
declare const placeOrder: PlaceOrderCommand;

bus.register("PlaceOrder", placeOrderHandler);

// @ts-expect-error: "Unknown" is not a command type
bus.register("Unknown", async () => ok("x"));

// @ts-expect-error: PlaceOrder must return Result<OrderId, string>
bus.register("PlaceOrder", async () => ok(42));

// @ts-expect-error: Commands owns PlaceOrder's OrderId result
bus.execute<PlaceOrderCommand, number>(placeOrder);
```

A concrete type map is the single source of truth for handler and execution results. An explicit `<Command, Result>` argument cannot select a competing result type. The default `Record<string, unknown>` map shape remains intentionally loose, including when it is written explicitly to select a custom error-channel type. That is useful in tests and prototypes. In application code, prefer a concrete map. It catches typos at bootstrap instead of at runtime.

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

As with commands, a concrete query type map owns the result of both execution styles. Explicit `<Query, Result>` arguments are available only with the default untyped map shape; they cannot override `Queries[query.type]`.

In a CQRS application, query handlers return DTOs shaped for their use case. They may read materialized projections, but a simple management or setup flow can query the authoritative write store on demand through a consumer-owned query port when a separate projection would add synchronization and rebuild cost without earning it. The query port may use the same database and tables as the write side; it still returns a detached DTO rather than a live aggregate. Load an aggregate through its repository when the application needs it for a command or domain decision, not merely to render display data. See [Read-Side Projections](./projections.md).

## `withCommit`: The Write-Side Boundary

The bus dispatches the command. The command handler owns the use case. `withCommit` owns the transaction and event harvest.

```ts
import { withCommit } from "@shirudo/ddd-kit";

const result = await withCommit(
  {
    scope,
    outbox,
    bus: eventBus,
    postCommitTimeoutMs: 5_000,
  },
  async (tx, enrollment) => {
    const orders = makeOrderRepository(tx);

    const order = await orders.getById(orderId);
    order.confirm(domainEvents.createFacts());

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

If post-commit `bus.publish(events)` fails, times out, or is aborted,
`withCommit` still returns the committed result. The database transaction
already succeeded, so rejecting the use case would encourage callers to retry
the whole command and possibly execute the write twice. Use
`onPublishError(error, events)` for logging and metrics. All asynchronous
`onPersisted(aggregate, version, context)` observers and the subsequent bus
publication share one absolute `postCommitTimeoutMs` deadline; each later
observer or bus call receives only the remaining budget and is not started after that
deadline. Observer errors go to
`onPersistError`. Durable delivery belongs to the outbox dispatcher.

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

Inside aggregate methods, prefer `this.recordEvent(..., facts)`; put correlation
metadata on the `DomainEventFacts` created by the application operation. Outside
aggregates, `createDomainEvent(...)` is the convenient primitive, while
`createDomainEventFromFacts(...)` is the deterministic one.

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
