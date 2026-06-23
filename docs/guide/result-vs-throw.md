# Result vs Throw

The kit makes a sharp architectural choice about where `Result` lives. This page explains it because adopting the library means adopting this rule.

## The rule

| Layer | Convention |
|---|---|
| **Domain** (Aggregates, Entities, ValueObject constructors, `validateEvent`) | **Throw `DomainError`-derived exceptions** |
| **Infrastructure boundary with recoverable failure** (`loadFromHistory`, `restoreFromSnapshotWithEvents`) | **Return `Result<void, DomainError>`** |
| **App-Service boundary** (`CommandBus.execute`, `QueryBus.execute`, `CommandHandler`, `QueryHandler`, `withCommit`) | **Return `Result<T, E>`** |

## Why throw in the domain

Aggregate invariants are *programming-level guarantees about valid state*. When `order.confirm()` is called on an already-confirmed order, that's not "expected failure to handle gracefully"; that's "the calling Use Case had a bug, or it's racing with itself". Exceptions carry stack traces and class hierarchies (`instanceof OrderAlreadyConfirmedError`) that are exactly the right shape for catching at the App boundary.

Vernon (IDDD §10), Evans (Blue Book), and Khononov (*Learning DDD*) all model aggregate invariants as exceptions. The wider TS ecosystem (Effect, fp-ts) often uses Result-style; this kit deliberately doesn't: `Result<T, string>` for "order is already confirmed" loses the typed catch and the stack trace, and the App-Service handler ends up calling `.unwrap()` or `if (result.isErr()) throw new Error(result.error)` anyway.

## Why Result at the App boundary

`CommandBus.execute` returns a `Result` because the App-Service is exactly where you need to map "this Use Case failed" to an HTTP status code, a queue ack/nack, or a log entry. The caller of `execute` is wiring transports; it doesn't want a try/catch.

```ts
const result = await commandBus.execute({ type: "ConfirmOrder", orderId });

if (result.isOk()) {
  return new Response(JSON.stringify({ orderId: result.value }), { status: 200 });
} else {
  // result.error is a string by default; map it to a status code
  return new Response(result.error, { status: 400 });
}
```

### The error channel: `string` by default, widen it when you want typed failures

`CommandBus`, `QueryBus`, and `CommandHandler` are generic over the error type `E`, which **defaults to `string`**: with no configuration, `execute` returns `Result<T, string>` and a thrown value is rendered to a string (via the internal `describeThrown`). That keeps the no-config path simple.

To carry typed failures across the bus, widen `E` and supply an `errorMapper` that turns a thrown value into `E` (base-error's `toStructuredError` fits this slot directly). The mapper is then mandatory at construction, so a typed channel can never silently fall back to strings:

```ts
import { toStructuredError, type StructuredError } from "@shirudo/base-error";

const commandBus = new CommandBus<Commands, StructuredError>({
  errorMapper: toStructuredError,
});

const result = await commandBus.execute({ type: "ConfirmOrder", orderId });
if (result.isErr()) {
  // result.error is StructuredError: narrow on result.error.code, map to a status
}
```

A handler may also return `err(typedError)` directly; that value passes through unchanged. Note this is orthogonal to the throw axis: the bus catches a thrown `DomainError` and routes it through `errorMapper`, so if you want the raw typed exception at the boundary, catch it yourself rather than going through the bus.

## Error hierarchy

The kit ships two abstract bases plus a small set of concrete library-internal errors, all built on [`@shirudo/base-error`](https://www.npmjs.com/package/@shirudo/base-error). The abstract bases give the App-Service the discriminators it needs to map errors to HTTP responses without conflating categories; `BaseError<Name>` gives every error timestamps, cause chains, retryable hints, and `toJSON()` for structured logging out of the box. Client-safe, localized messages are a separate boundary concern: project errors through the opt-in `@shirudo/base-error/presentation` subpath.

```ts
import { BaseError } from "@shirudo/base-error";

abstract class DomainError<Name>         extends BaseError<Name> {}   // business-rule violations
abstract class InfrastructureError<Name> extends BaseError<Name> {}   // persistence + concurrency

class AggregateNotFoundError    extends InfrastructureError<"AggregateNotFoundError"> {}    // Repository.getByIdOrFail()
class ConcurrencyConflictError  extends InfrastructureError<"ConcurrencyConflictError"> {}  // Repository.save() on version mismatch; retryable: true
class DuplicateAggregateError   extends InfrastructureError<"DuplicateAggregateError"> {}   // Repository.save() INSERT hit an existing id; NOT retryable
class MissingHandlerError       extends BaseError<"MissingHandlerError"> {}                 // programming bug: NOT a DomainError
```

(The Unit of Work adds `CommitError` / `RollbackError` (also `InfrastructureError` subclasses) and the BaseError-direct programming-bug classes `AggregateDeletedError`, `NestedUnitOfWorkError`, `TransactionClosedError`, `EventHarvestError`, `UnenrolledChangesError`; see the [Unit of Work guide](./unit-of-work.md#error-taxonomy).)

| Catch | Map to | Reason |
|---|---|---|
| `instanceof DomainError` | HTTP 400 / business rule | The Use Case violated an invariant; the caller did something the domain forbids. |
| `instanceof InfrastructureError` | HTTP 404 / 409 (with retry hint) | The persistence layer raced or the row is missing; the domain itself didn't fail. |
| `instanceof MissingHandlerError` | re-throw → HTTP 500 / alert | The aggregate's subclass forgot to register an event handler. Programming bug: crash loud. |
| `isBaseError(e)` (else) | HTTP 500 / log | Any other structured error from the kit or another `BaseError`-using library. Treated as expected-but-uncategorised. |
| anything else | HTTP 500 | Unexpected runtime exception. |

`MissingHandlerError` deliberately sits directly on `BaseError`, **not** on `DomainError` or `InfrastructureError`: a generic "catch domain errors → 400" handler must not mask a forgotten event handler. The replay methods (`loadFromHistory`, `restoreFromSnapshotWithEvents`) also propagate it as an uncaught throw rather than wrapping it in their `Result<void, DomainError>` return: programming bugs should fail loud, not look like a recoverable infrastructure failure.

Use the [`isBaseError`](https://www.npmjs.com/package/@shirudo/base-error) predicate from the peer dep to detect "any structured error" without depending on the concrete library hierarchy.

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
import { isBaseError, someChainRetryable } from "@shirudo/base-error";

try {
  order.confirm();
  await repo.save(order);
  return ok(order.id);
} catch (e) {
  // Walk the whole cause chain for retry hints; ConcurrencyConflictError
  // sets retryable: true; an OCC-aware Use Case retries instead of bubbling
  // up. someChainRetryable matches the loose `retryable === true` predicate
  // anywhere in the chain, so it works whether the conflict is the thrown
  // error or wrapped inside an infrastructure error.
  if (someChainRetryable(e)) {
    if (isBaseError(e)) {
      logger.info({ err: e.toJSON() }, "retrying use case");
    }
    return retry();
  }

  if (e instanceof OrderAlreadyConfirmedError) return err("ALREADY_CONFIRMED");      // domain → 400
  if (e instanceof ConcurrencyConflictError)   return err("CONFLICT");                // infra → 409 (retry in a fresh unit of work)
  if (e instanceof DuplicateAggregateError)    return err("ALREADY_EXISTS");          // infra → 409 (never retry the same INSERT)
  if (e instanceof AggregateNotFoundError)     return err("NOT_FOUND");               // infra → 404
  if (e instanceof InfrastructureError)        return err("INFRASTRUCTURE_ERROR");
  if (e instanceof DomainError)                return err("DOMAIN_ERROR");
  throw e; // includes MissingHandlerError, a programming bug; let it crash
}
```

### What `BaseError` gives you

Because every library error extends `BaseError<Name>`:

- **`error.toJSON()` / `error.toLogObject()`**: structured **log** entry with name, message, timestamp, stack, cause chain. Log-only: never return it to a client. For client-safe, localized output, project the error through the opt-in `@shirudo/base-error/presentation` subpath (`PublicErrorPresenter`) at the boundary; the technical core carries no user-facing message.
- **`error.timestamp` / `error.timestampIso`**: epoch + ISO, useful for sorting / correlating log entries across distributed systems.
- **`error.name`**: typed literal (`"ConcurrencyConflictError"`, not just `string`), so you get exhaustiveness checking in `switch` on `error.name`.
- **`error.cause` + traversal helpers** (`getRootCause`, `findInCauseChain`, `filterCauseChain`): for wrapping infrastructure errors in domain errors and still finding the root cause for retry decisions.
- **`isRetryable(error)`**: single-level retry predicate. `ConcurrencyConflictError.retryable === true`; consumer-derived errors that need the same hint set `readonly retryable = true as const`.
- **`someChainRetryable(error)`**: whole-chain retry predicate. Walks the cause chain with the same loose `retryable === true` check as `isRetryable`, so it matches ddd-kit errors that extend `BaseError` directly. Prefer this over `isChainRetryable`, which filters strictly on the full `StructuredError` shape (`code` + `category` + `retryable`) and returns `false` for ddd-kit errors. The kit's [`RetryingTransactionScope`](./concurrency.md#retrying-conflicts-retryingtransactionscope) uses `someChainRetryable` as its default retry classifier.

::: warning Which `@shirudo/base-error` helpers work with ddd-kit errors
ddd-kit's `DomainError`, `InfrastructureError`, `AggregateNotFoundError`, `ConcurrencyConflictError`, and `DuplicateAggregateError` extend `BaseError<Name>` directly; they do NOT carry `code` and `category` (the kit discriminates by class, Vernon-canonical DDD, not RFC 9457). Helpers that filter on the full `StructuredError` shape return `false` / `undefined` for ddd-kit errors:

- **Works** (loose / class-based): `isBaseError`, `isRetryable`, `someChainRetryable`, `someCauseChain`, `findInCauseChain`, `filterCauseChain`, `everyCauseChain`, `getRootCause`, `instanceof` checks.
- **Returns false / undefined for ddd-kit errors** (strict `StructuredError` filter): `isStructuredError`, `isRetryableStructuredError`, `isChainRetryable`, `getRootCauseRetryable`, `getFirstRetryableCause`.

If you also throw `StructuredError`-shaped errors from your own code, those keep working with the strict helpers; only the ddd-kit-supplied errors fall through the strict filter.
:::

## What `Result` is (and isn't)

The kit uses [`@shirudo/result`](https://www.npmjs.com/package/@shirudo/result) as a peer dependency. It's a tagged union (`{ _tag: "Ok", value: T }` | `{ _tag: "Err", error: E }`) with methods (`isOk`, `isErr`, `map`, `flatMap`, `match`, …) plus pipe-style operators. Refer to its documentation for the full operator set.

The kit does **not** re-export Result. Import from `@shirudo/result` directly:

```ts
import { ok, err, type Result } from "@shirudo/result";
```

This keeps the kit out of "in-house framework" territory and avoids re-export bloat. If you prefer `effect`, `neverthrow`, or fp-ts `Either`, you can use those at your App boundary instead. `CommandHandler<C, R>` stays portable; only your `commandBus.execute` adapter changes.

## `voWithValidation` is the App-boundary parser

The fail-fast Result-returning helper on the value-object side (see [`voValidated`](#vovalidated-collects-every-violation) below when you need *all* violations at once). Use it for parsing untrusted input *at the App boundary*; for Domain construction prefer the `ValueObject` base class which throws on invalid input.

```ts
// At the App boundary: parsing user input
const result = voWithValidation(body, isValid, "BAD_REQUEST");
if (result.isErr()) return new Response(result.error, { status: 400 });

// In the Domain: constructor throws
new Money({ amount: -1, currency: "EUR" }); // throws DomainError
```

## `voValidated` collects every violation

`voWithValidation` fails fast with a single string. A form parser usually wants the opposite: report *all* the broken fields at once ("email invalid **and** age negative"). `voValidated` runs your checks, collects each violation, and returns a populated `ValidationError` only if any fired; otherwise a frozen value object.

```ts
import { voValidated } from "@shirudo/ddd-kit";

const result = voValidated(
  { email, age },
  (issues, m) => {
    if (!isEmail(m.email))
      issues.addIssue({ message: "must be a valid email", path: ["email"] });
    if (m.age < 0)
      issues.addIssue({ message: "must not be negative", path: ["age"] });
  },
  "Registration is invalid",
);

if (result.isErr()) {
  // result.error.publicIssues() → both violations, in order
}
```

### Two error styles, one axis

This is where the kit's error model has **two deliberate styles**, and the rule that keeps them straight is *how you consume them*, not a single class hierarchy:

| Style | Type | You… | When |
|---|---|---|---|
| **Throw / catch** | `DomainError` (and subclasses) | `catch (e instanceof DomainError)` at the boundary | Aggregate invariant violated: a bug or a race |
| **Result / destructure** | `ValidationError` | `if (result.isErr())` then read `result.error` | Untrusted input failed field-level validation |

`voValidated` returns a `ValidationError` as a **value**: you never `throw` it, so you never `catch` it. That is why it does **not** sit on the `DomainError` throw/catch hierarchy, and why a generic `catch (e instanceof DomainError)` handler is *correct* to ignore it: validation lives on the Result axis. This is a kit, not a framework; it hands you the value and stays out of your boundary.

`ValidationError` comes from [`@shirudo/base-error`](https://www.npmjs.com/package/@shirudo/base-error) (import it from there, like `Result`). Unlike the kit's class-discriminated errors, it *is* a `StructuredError` carrying `code` / `category` and ingesting [Standard Schema](https://standardschema.dev) output, deliberately, because field validation is exactly the case that serializes to RFC 9457 with structured per-field output.

### Rendering RFC 9457 at the boundary

`@shirudo/base-error` is **safe by default**: a `ValidationError` does not expose its issues on its own; they only cross to a client through the `publicIssues()` whitelist. The opt-in `@shirudo/ddd-kit/http` entry point wires that projection for you (and defaults to `422` / `"Validation Failed"`), so the core kit stays transport-free. It returns base-error's own `ProblemDetails` type (from `@shirudo/base-error/problem-details`), so the RFC 9457 shape stays a single source of truth:

```ts
import { toProblemDetails } from "@shirudo/ddd-kit/http";

if (result.isErr()) {
  return Response.json(toProblemDetails(result.error), { status: 422 });
}
// → { type: "about:blank", title: "Validation Failed", status: 422,
//     errors: [{ message: "must be a valid email", path: ["email"], pointer: "email" }] }
```

For the general error-to-Problem-Details mapping (a public-code catalog with per-code `type` / `status` over a `PublicErrorView`), reach for base-error's `defineProblemDetailsAdapter` directly; `toProblemDetails` is the narrow validation shortcut.
