# Result vs Throw

The kit makes a sharp architectural choice about where `Result` lives. This page explains it because adopting the library means adopting this rule.

## The rule

| Layer | Convention |
|---|---|
| **Domain** (Aggregates, Entities, ValueObject constructors, `validateEvent`) | **Throw `DomainError`-derived exceptions** |
| **Infrastructure boundary with recoverable failure** (`loadFromHistory`, `restoreFromSnapshotWithEvents`) | **Return `Result<void, DomainError>`** |
| **App-Service boundary** (`CommandBus.execute`, `QueryBus.execute`, `CommandHandler`, `QueryHandler`, `withCommit`) | **Return `Result<T, E>`** |

## Why throw in the domain

Aggregate invariants are *programming-level guarantees about valid state*. When `order.confirm()` is called on an already-confirmed order, that's not "expected failure to handle gracefully" — that's "the calling Use Case had a bug, or it's racing with itself". Exceptions carry stack traces and class hierarchies (`instanceof OrderAlreadyConfirmedError`) that are exactly the right shape for catching at the App boundary.

Vernon (IDDD §10), Evans (Blue Book), and Khononov (*Learning DDD*) all model aggregate invariants as exceptions. The wider TS ecosystem (Effect, fp-ts) often uses Result-style; this kit deliberately doesn't — `Result<T, string>` for "order is already confirmed" loses the typed catch and the stack trace, and the App-Service handler ends up calling `.unwrap()` or `if (result.isErr()) throw new Error(result.error)` anyway.

## Why Result at the App boundary

`CommandBus.execute` returns a `Result` because the App-Service is exactly where you need to map "this Use Case failed" to an HTTP status code, a queue ack/nack, or a log entry. The caller of `execute` is wiring transports; it doesn't want a try/catch.

```ts
const result = await commandBus.execute({ type: "ConfirmOrder", orderId });

if (result.isOk()) {
  return new Response(JSON.stringify({ orderId: result.value }), { status: 200 });
} else {
  // result.error is typed; map domain errors to status codes
  return new Response(result.error, { status: 400 });
}
```

## Error hierarchy

The kit ships a three-tier hierarchy on top of [`@shirudo/base-error`](https://www.npmjs.com/package/@shirudo/base-error), so the App-Service can map errors to HTTP responses without conflating categories — and library errors come with timestamps, cause chains, user-safe messages, retryable hints, and `toJSON()` for structured logging out of the box.

```ts
import { BaseError } from "@shirudo/base-error";

abstract class KitError<Name>          extends BaseError<Name> {}   // marker: "an expected library error"
abstract class DomainError<Name>       extends KitError<Name> {}     // business-rule violations
abstract class InfrastructureError<Name> extends KitError<Name> {}   // persistence + concurrency

class AggregateNotFoundError    extends InfrastructureError<"AggregateNotFoundError"> {}    // Repository.getByIdOrFail()
class ConcurrencyConflictError  extends InfrastructureError<"ConcurrencyConflictError"> {}  // Repository.save() on version mismatch; retryable: true
class MissingHandlerError       extends KitError<"MissingHandlerError"> {}                  // programming bug — NOT a DomainError
```

| Catch | Map to | Reason |
|---|---|---|
| `instanceof DomainError` | HTTP 400 / business rule | The Use Case violated an invariant; the caller did something the domain forbids. |
| `instanceof InfrastructureError` | HTTP 404 / 409 (with retry hint) | The persistence layer raced or the row is missing; the domain itself didn't fail. |
| `instanceof KitError` (else) | HTTP 500 / log + alert | A library-internal error the App didn't categorise. Currently only `MissingHandlerError`, which means a subclass forgot to register an event handler — should crash loud. |
| anything else | HTTP 500 | Programmer error / unexpected runtime exception. |

`MissingHandlerError` deliberately sits on `KitError` rather than `DomainError`: a generic "catch domain errors → 400" handler must not mask a forgotten event handler. The replay methods (`loadFromHistory`, `restoreFromSnapshotWithEvents`) also propagate it as an uncaught throw rather than wrapping it in their `Result<void, DomainError>` return — programming bugs should fail loud, not look like a recoverable infrastructure failure.

Consumers derive their own concrete errors for invariant violations:

```ts
import { DomainError } from "@shirudo/ddd-kit";

class OrderAlreadyConfirmedError extends DomainError {
  constructor(public readonly orderId: string) {
    super(`Order ${orderId} is already confirmed`);
  }
}

class CreditLimitExceededError extends DomainError {
  constructor(
    public readonly customerId: string,
    public readonly limit: number,
    public readonly attempted: number,
  ) {
    super(`Credit limit ${limit} exceeded by customer ${customerId} (attempted ${attempted})`);
  }
}
```

Catching by class lets the App-Service map errors to responses:

```ts
import { isRetryable, getRootCause } from "@shirudo/base-error";

try {
  order.confirm();
  await repo.save(order);
  return ok(order.id);
} catch (e) {
  // Walk the cause chain for retry hints — ConcurrencyConflictError sets
  // retryable: true; an OCC-aware Use Case retries instead of bubbling up.
  const root = getRootCause(e);
  if (isRetryable(root)) {
    logger.info({ err: (e as KitError).toJSON() }, "retrying use case");
    return retry();
  }

  if (e instanceof OrderAlreadyConfirmedError) return err("ALREADY_CONFIRMED");      // domain → 400
  if (e instanceof ConcurrencyConflictError)   return err("CONFLICT");                // infra → 409
  if (e instanceof AggregateNotFoundError) {
    // Use the user-safe message instead of the technical one
    return err(e.getUserMessage() ?? e.message);                                      // infra → 404
  }
  if (e instanceof InfrastructureError)        return err(e.getUserMessage() ?? e.message);
  if (e instanceof DomainError)                return err(e.getUserMessage() ?? e.message);
  throw e; // includes MissingHandlerError — programming bug, let it crash
}
```

### What `BaseError` gives you

Because every library error extends `BaseError<Name>`:

- **`error.toJSON()`** — structured log entry: name, message, timestamp, stack, cause chain.
- **`error.getUserMessage({ preferredLang?, fallbackLang? })`** — i18n-aware end-user message, separate from the technical `error.message`. `AggregateNotFoundError` and `ConcurrencyConflictError` ship with default English user messages; consumers can override per language with `addLocalizedMessage`.
- **`error.timestamp` / `error.timestampIso`** — epoch + ISO, useful for sorting / correlating log entries across distributed systems.
- **`error.name`** — typed literal (`"ConcurrencyConflictError"`, not just `string`), so you get exhaustiveness checking in `switch` on `error.name`.
- **`error.cause` + traversal helpers** (`getRootCause`, `findInCauseChain`, `filterCauseChain`) — for wrapping infrastructure errors in domain errors and still finding the root cause for retry decisions.
- **`isRetryable(error)`** — the canonical retry predicate. `ConcurrencyConflictError.retryable === true`; consumer-derived errors that need the same hint set `readonly retryable = true as const`.

## What `Result` is (and isn't)

The kit uses [`@shirudo/result`](https://www.npmjs.com/package/@shirudo/result) as a peer dependency. It's a tagged union (`{ _tag: "Ok", value: T }` | `{ _tag: "Err", error: E }`) with methods (`isOk`, `isErr`, `map`, `flatMap`, `match`, …) plus pipe-style operators. Refer to its documentation for the full operator set.

The kit does **not** re-export Result. Import from `@shirudo/result` directly:

```ts
import { ok, err, type Result } from "@shirudo/result";
```

This keeps the kit out of "in-house framework" territory and avoids re-export bloat. If you prefer `effect`, `neverthrow`, or fp-ts `Either`, you can use those at your App boundary instead — `CommandHandler<C, R>` stays portable; only your `commandBus.execute` adapter changes.

## `voWithValidation` is the App-boundary parser

The one Result-returning helper on the value-object side. Use it for parsing untrusted input *at the App boundary*; for Domain construction prefer the `ValueObject` base class which throws on invalid input.

```ts
// At the App boundary — parsing user input
const result = voWithValidation(body, isValid, "BAD_REQUEST");
if (result.isErr()) return new Response(result.error, { status: 400 });

// In the Domain — constructor throws
new Money({ amount: -1, currency: "EUR" }); // throws DomainError
```
