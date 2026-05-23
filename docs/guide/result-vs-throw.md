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

## DomainError hierarchy

The kit ships an abstract base and two library-internal subclasses:

```ts
abstract class DomainError extends Error {}

class MissingHandlerError extends DomainError {}      // EventSourcedAggregate.apply()
class AggregateNotFoundError extends DomainError {}   // Repository.getByIdOrFail()
class ConcurrencyConflictError extends DomainError {} // Repository.save() on version mismatch
```

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
try {
  order.confirm();
  await repo.save(order);
  return ok(order.id);
} catch (err) {
  if (err instanceof OrderAlreadyConfirmedError) return err("ALREADY_CONFIRMED");
  if (err instanceof ConcurrencyConflictError)   return err("CONFLICT");
  if (err instanceof DomainError)                return err(err.message);
  throw err; // unexpected; let the runtime crash
}
```

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
