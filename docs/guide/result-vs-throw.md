# Result Vs Throw

The kit uses both exceptions and `Result`, but not interchangeably. The rule is
about boundaries:

- Domain code throws typed errors when an invariant is violated.
- Command handlers return `Result` because commands are application outcomes.
- Query handlers return data directly; `QueryBus.execute` wraps them in
  `Result`.
- Transaction helpers such as `withCommit` and `UnitOfWork.run` return the
  callback result directly and throw when the transaction fails.
- Validation helpers return `Result` because they parse untrusted input at the
  edge.

## API Map

| API | Success | Failure |
| --- | --- | --- |
| Aggregate method | returns `void` or data | throws `DomainError` subclass |
| Value object class constructor | instance | throws `DomainError` subclass |
| `voWithValidation` | `Result<VO<T>, string>` | `Err<string>` |
| `voValidated` | `Result<VO<T>, ValidationError>` | `Err<ValidationError>` |
| `CommandHandler<C, R, E>` | `Ok<R>` | `Err<E>` or throw for the bus mapper |
| `CommandBus.execute` | `Result<R, E>` | catches handler throws into `Err<E>` |
| `QueryHandler<Q, R>` | `R` | throws |
| `QueryBus.execute` | `Result<R, E>` | catches handler throws into `Err<E>` |
| `QueryBus.executeUnsafe` | `R` | throws |
| `withCommit` | `R` | throws |
| `UnitOfWork.run` | `R` | throws |
| `loadFromHistory` / snapshot replay | `Result<void, DomainError>` | `Err<DomainError>` for recoverable replay failures |

The old mental shortcut "app-service boundary returns Result" is too broad.
The bus boundary returns `Result`; the transaction helper returns whatever you
put in its `result` field.

## Domain Code Throws

Aggregate invariants are not field-level validation. If code asks the domain
to do something illegal, the domain should stop the operation loudly with a
typed error.

```ts
import { AggregateRoot, DomainError } from "@shirudo/ddd-kit";

class OrderAlreadyConfirmedError
  extends DomainError<"ORDER_ALREADY_CONFIRMED"> {
  constructor(orderId: string) {
    super({
      code: "ORDER_ALREADY_CONFIRMED",
      message: `Order ${orderId} is already confirmed`,
    });
  }
}

class Order extends AggregateRoot<OrderState, OrderId, OrderEvent> {
  protected readonly aggregateType = "Order";

  confirm(): void {
    if (this.state.status === "confirmed") {
      throw new OrderAlreadyConfirmedError(this.id);
    }

    this.commit(
      { ...this.state, status: "confirmed" },
      this.recordEvent("OrderConfirmed", { orderId: this.id }),
    );
  }
}
```

This gives callers a stack trace and a real type to catch. A `Result` return
from every aggregate method would push invariant handling into every call site
and make illegal state transitions look like normal branching.

## Command Handlers Return Result

A command handler is an application boundary. It should turn domain and
infrastructure failures into the error channel your transport understands.

```ts
import {
  AggregateNotFoundError,
  ConcurrencyConflictError,
  type Command,
  type CommandHandler,
  withCommit,
} from "@shirudo/ddd-kit";
import { err, ok } from "@shirudo/result";

type ConfirmOrder = Command & {
  type: "ConfirmOrder";
  orderId: OrderId;
};

type ConfirmOrderError =
  | "ORDER_NOT_FOUND"
  | "ORDER_ALREADY_CONFIRMED"
  | "CONFLICT";

const confirmOrder: CommandHandler<
  ConfirmOrder,
  OrderId,
  ConfirmOrderError
> = async (command) => {
  try {
    const orderId = await withCommit({ scope, outbox, bus }, async (tx) => {
      const orders = makeOrderRepository(tx);
      const order = await orders.getById(command.orderId);

      order.confirm();
      await orders.save(order);

      return { result: order.id, aggregates: [order] };
    });

    return ok(orderId);
  } catch (error) {
    if (error instanceof AggregateNotFoundError) {
      return err("ORDER_NOT_FOUND");
    }
    if (error instanceof OrderAlreadyConfirmedError) {
      return err("ORDER_ALREADY_CONFIRMED");
    }
    if (error instanceof ConcurrencyConflictError) {
      return err("CONFLICT");
    }

    throw error;
  }
};
```

Notice the shape: `withCommit` returns `order.id` directly. The command
handler wraps that value in `ok(...)`.

You can also put a `Result` inside `withCommit`'s `result` field:

```ts
return withCommit({ scope, outbox }, async (tx) => {
  const orders = makeOrderRepository(tx);
  const order = await orders.getById(command.orderId);

  order.confirm();
  await orders.save(order);

  return { result: ok(order.id), aggregates: [order] };
});
```

That is useful when you want the transaction helper to return the exact
handler result. It does not change `withCommit`; it still returns the `result`
value you supplied.

## Buses Map Throws

`CommandBus.execute` always returns `Result<R, E>`.

If a command handler returns `err(...)`, that error passes through. If the
handler throws, the bus catches the thrown value and maps it into `E`.

By default, `E` is `string`:

```ts
const commandBus = new CommandBus<CommandResults>();

const result = await commandBus.execute({
  type: "ConfirmOrder",
  orderId,
});

if (result.isErr()) {
  return Response.json({ error: result.error }, { status: 400 });
}
```

For typed error channels, widen `E` and provide an `errorMapper`:

```ts
import {
  toStructuredError,
  type StructuredError,
} from "@shirudo/base-error";

const commandBus = new CommandBus<CommandResults, StructuredError>({
  errorMapper: toStructuredError,
});
```

The mapper is required when the bus error type is not the default `string`.
That prevents a typed channel from silently falling back to string errors.

An unregistered command or query type is not mapped into the error channel. It
throws `UnregisteredHandlerError`, because it is a wiring bug.

## Queries Return Data

Queries are different from commands. A `QueryHandler` returns data directly:

```ts
import type { Query, QueryHandler } from "@shirudo/ddd-kit";

type GetOrder = Query & {
  type: "GetOrder";
  orderId: OrderId;
};

const getOrder: QueryHandler<GetOrder, OrderView | null> = async (query) => {
  return orderViews.findById(query.orderId);
};
```

`QueryBus.execute` wraps that direct value in `Ok`:

```ts
const result = await queryBus.execute({
  type: "GetOrder",
  orderId,
});

if (result.isOk()) {
  return Response.json(result.value);
}
```

If the handler throws, `execute` maps the thrown value into `Err<E>` using the
same default/string or configured `errorMapper` behavior as the command bus.

`executeUnsafe` skips the `Result` wrapper:

```ts
const view = await queryBus.executeUnsafe({
  type: "GetOrder",
  orderId,
});
```

Use it when the caller already wants try/catch semantics.

## Transaction Helpers Return Directly

`withCommit` is not a command bus. It is a transaction orchestrator.

```ts
const orderId = await withCommit({ scope, outbox }, async (tx) => {
  const orders = makeOrderRepository(tx);
  const order = await orders.getById(id);

  order.confirm();
  await orders.save(order);

  return { result: order.id, aggregates: [order] };
});
```

The resolved value is `OrderId`, not `Result<OrderId, E>`.

If your command handler returns `Result`, wrap it there. If your HTTP handler
calls `withCommit` directly, catch and map errors there.

`UnitOfWork.run` follows the same direct-return rule:

```ts
const orderId = await uow.run(async ({ repositories }) => {
  const order = await repositories.orders.getById(id);
  order.confirm();
  await repositories.orders.save(order);
  return order.id;
});
```

## Error Classes

Kit errors are structured errors from `@shirudo/base-error`. Each has one
stable identifier: `error.code`, and `error.name === error.code`.

The important bases are:

```ts
abstract class DomainError<Code>
abstract class InfrastructureError<Code>
```

Use them like this:

| Error kind | Examples | Boundary mapping |
| --- | --- | --- |
| `DomainError` | business invariant failed | 400-shaped domain response |
| `InfrastructureError` | not found, duplicate id, OCC conflict | 404 or 409-shaped response |
| Wiring errors | missing handler, closed transaction, deleted aggregate reused | rethrow, alert, 500 |

Common repository errors:

- `AggregateNotFoundError`: `getById` could not find the aggregate.
- `ConcurrencyConflictError`: optimistic concurrency failed; retry in a fresh
  unit of work or return conflict.
- `DuplicateAggregateError`: insert collided with an existing id; do not retry
  the same insert.

For retry classification, use the cause-chain helpers from
`@shirudo/base-error`:

```ts
import { someChainRetryable } from "@shirudo/base-error";

if (someChainRetryable(error)) {
  return retryInFreshUnitOfWork();
}
```

`ConcurrencyConflictError` sets `retryable: true`, so it participates in that
check even when wrapped.

For logging, use `toJSON()` or `toLogObject()` on structured errors. Do not
return technical messages or stack traces to clients.

## Public Error Views

Client-safe messages are a presentation concern. Use the opt-in presentation
entry point:

```ts
import { toPublicErrorView } from "@shirudo/ddd-kit/presentation";
import { toProblem } from "@shirudo/base-error/public-error";

const view = toPublicErrorView(error);
const problem = toProblem({ status: 500 }, view);

return Response.json(problem.body, { status: problem.status });
```

`toPublicErrorView` maps known kit errors to stable public codes and safe
messages. Extend the catalog with your own domain error codes when you need
localized client text.

For validation errors specifically, use the HTTP shortcut:

```ts
import { toProblemDetails } from "@shirudo/ddd-kit/http";

if (result.isErr()) {
  const problem = toProblemDetails(result.error);
  return Response.json(problem.body, {
    status: problem.status,
    headers: problem.headers,
  });
}
```

## Result Is A Peer Dependency

The kit uses `@shirudo/result` but does not re-export it:

```ts
import { err, ok, type Result } from "@shirudo/result";
```

This keeps the kit from becoming a full application framework. If your
application uses another result type at its outer boundary, adapt there.

## Validation Helpers

Use validation helpers for untrusted input at the application edge.

`voWithValidation` is fail-fast and returns a string error:

```ts
import { voWithValidation } from "@shirudo/ddd-kit";

const parsed = voWithValidation(
  body,
  (value) => isEmail(value.email),
  "Email is invalid",
);

if (parsed.isErr()) {
  return Response.json({ error: parsed.error }, { status: 400 });
}
```

`voValidated` collects all field issues into a `ValidationError`:

```ts
import { voValidated } from "@shirudo/ddd-kit";

const parsed = voValidated(
  { email, age },
  (issues, value) => {
    if (!isEmail(value.email)) {
      issues.addIssue({
        path: ["email"],
        message: "must be a valid email",
      });
    }

    if (value.age < 0) {
      issues.addIssue({
        path: ["age"],
        message: "must not be negative",
      });
    }
  },
  "Registration is invalid",
);
```

`ValidationError` is returned as a value. You do not throw it and you do not
catch it with `DomainError`. That separation is intentional: field validation
is a Result flow; domain invariants are a throw/catch flow.

Inside the domain, prefer value-object constructors or aggregate methods that
throw typed domain errors. At the application edge, parse and collect input
problems with `Result`.
