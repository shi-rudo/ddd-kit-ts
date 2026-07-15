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
| `domainErrorToResult` | `Ok<T>` | listed `DomainError` subclass becomes `Err`; everything else throws |
| Value object class constructor | instance | throws `DomainError` subclass |
| `voWithValidation` | `Result<VO<T>, string>` | `Err<string>` |
| `voValidated` | `Result<VO<T>, ValidationError>` | `Err<ValidationError>` |
| `CommandHandler<C, R, E>` | `Ok<R>` | `Err<E>` or throw |
| `CommandBus.execute` | `Result<R, E>` | passes through `Err<E>`; selectively maps a recognized throw, otherwise rethrows |
| `QueryHandler<Q, R>` | `R` | throws |
| `QueryBus.execute` | `Result<R, E>` | selectively maps a recognized throw, otherwise rethrows |
| `QueryBus.executeUnsafe` | `R` | throws |
| `withCommit` | `R` | throws |
| `UnitOfWork.run` | `R` | throws |
| `loadFromHistory` / snapshot replay | `Result<void, DomainError>` | `Err<DomainError>` for domain-nameable corruption; wiring and infrastructure corruption still throws (`ForeignEventError`, `SnapshotSchemaMismatchError`) |

The old mental shortcut "app-service boundary returns Result" is too broad.
Bus results carry explicit expected failures, but unclassified exceptions still
throw. The transaction helper returns whatever you put in its `result` field.

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

## Optional DomainError-to-Result Boundary

When one Application boundary prefers a typed Result, wrap the operation rather
than changing the aggregate API:

```ts
import { domainErrorToResult } from "@shirudo/ddd-kit";

const result = await domainErrorToResult(
  () => order.confirm(),
  [OrderAlreadyConfirmedError],
);
// Result<void, OrderAlreadyConfirmedError>
```

The required class list is a positive decision about the failures this caller
can handle. A listed error becomes `Err` with the exact original instance. An
unlisted `DomainError`, an `InfrastructureError`, cancellation, a programming
error, or any other thrown value propagates unchanged. The helper accepts sync
and async operations and always returns a Promise.

Do not replace the list with a catch-all base class. A newly introduced domain
rejection may require a different caller reaction and must not silently join an
existing public error contract. If the use case exposes smaller transport- or
application-owned error values, map the selected `Err` afterward; the helper
does not decide that public contract for you.

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
    const orderId = await withCommit(
      { scope, outbox, bus },
      async (tx, enrollment) => {
        const orders = makeOrderRepository(tx);
        const order = await orders.getById(command.orderId);

        order.confirm();
        await orders.save(order);

        return {
          result: order.id,
          commits: [enrollment.enrollSaved(order)],
        };
      },
    );

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
return withCommit({ scope, outbox }, async (tx, enrollment) => {
  const orders = makeOrderRepository(tx);
  const order = await orders.getById(command.orderId);

  order.confirm();
  await orders.save(order);

  return {
    result: ok(order.id),
    commits: [enrollment.enrollSaved(order)],
  };
});
```

That is useful when you want the transaction helper to return the exact
handler result. It does not change `withCommit`; it still returns the `result`
value you supplied.

## Buses Map Only Expected Throws

`CommandBus.execute` returns `Result<R, E>` when the handler returns normally.
It does not assume that every thrown value belongs in `E`.

If a command handler returns `err(...)`, that error passes through. With no
error policy, a handler throw propagates unchanged.

The default error-channel type is still `string`, so handlers can return
string errors without configuration:

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

For typed error channels, widen `E`. No mapper is required when handlers
return `err(typedError)` directly:

```ts
const commandBus = new CommandBus<CommandResults, ConfirmOrderError>();
```

When an exception-first dependency exposes a known expected failure, classify
and map only that type:

```ts
const commandBus = new CommandBus<CommandResults, ConfirmOrderError>({
  mapExpectedError: (thrown) =>
    thrown instanceof OrderAlreadyConfirmedError
      ? {
          error: {
            code: "ORDER_ALREADY_CONFIRMED",
            orderId: thrown.orderId,
          },
        }
      : undefined,
});
```

Returning `{ error }` is the positive classification decision. Returning
`undefined` rethrows the exact original value. The wrapper also leaves
`undefined` available as an intentional error-channel value:

```ts
mapExpectedError: (thrown) =>
  thrown instanceof ExpectedEmptyFailure ? { error: undefined } : undefined;
```

An unregistered command or query type always throws
`UnregisteredHandlerError`. A nested bus wiring error and a failure thrown by
`mapExpectedError` also stay crash-loud. Do not use a total conversion such as
`(thrown) => ({ error: toStructuredError(thrown) })`: that would explicitly
classify programming errors, cancellation, and unknown infrastructure failures
as ordinary business outcomes.

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

If the handler throws, `execute` uses the same selective `mapExpectedError`
policy as the command bus. With no policy, or when the policy returns
`undefined`, the exact thrown value propagates.

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
const orderId = await withCommit({ scope, outbox }, async (tx, enrollment) => {
  const orders = makeOrderRepository(tx);
  const order = await orders.getById(id);

  order.confirm();
  await orders.save(order);

  return {
    result: order.id,
    commits: [enrollment.enrollSaved(order)],
  };
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
