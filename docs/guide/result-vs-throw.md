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

The kit ships two abstract bases plus a small set of concrete library-internal errors, all structured errors built on [`@shirudo/base-error`](https://www.npmjs.com/package/@shirudo/base-error). Every kit error carries exactly ONE identifier: a stable SCREAMING_SNAKE `code`, and `error.name === error.code` by design. `category` follows the hierarchy mechanically (`"DOMAIN"`, `"INFRASTRUCTURE"`, or `"WIRING"` for the crash-loud programming-bug family) and `retryable` is a plain boolean field. Timestamps, cause chains, and `toJSON()` come along for structured logging. Client-safe, localized messages are a separate boundary concern: project errors through the opt-in `@shirudo/base-error/public-error` subpath.

```ts
abstract class DomainError<Code>         // business-rule violations; category "DOMAIN"
abstract class InfrastructureError<Code> // persistence + concurrency; category "INFRASTRUCTURE"

class AggregateNotFoundError   // code AGGREGATE_NOT_FOUND;   Repository.getById()
class ConcurrencyConflictError // code CONCURRENCY_CONFLICT;  Repository.save() on version mismatch; retryable: true
class DuplicateAggregateError  // code DUPLICATE_AGGREGATE;   Repository.save() INSERT hit an existing id; NOT retryable
class MissingHandlerError      // code MISSING_HANDLER;       category "WIRING": programming bug, NOT a DomainError
```

(The Unit of Work adds `CommitError` / `RollbackError` (`InfrastructureError` subclasses, codes `COMMIT_FAILED` / `ROLLBACK_FAILED`) and the `WIRING`-category programming-bug classes `AggregateDeletedError`, `NestedUnitOfWorkError`, `TransactionClosedError`, `EventHarvestError`, `UnenrolledChangesError`; see the [Unit of Work guide](./unit-of-work.md#error-taxonomy).)

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

class OrderAlreadyConfirmedError extends DomainError<"ORDER_ALREADY_CONFIRMED"> {
  constructor(public readonly orderId: string) {
    super({
      code: "ORDER_ALREADY_CONFIRMED",
      message: `Order ${orderId} is already confirmed`,
    });
  }
}

class CreditLimitExceededError extends DomainError<"CREDIT_LIMIT_EXCEEDED"> {
  constructor(
    public readonly customerId: string,
    public readonly limit: number,
    public readonly attempted: number,
  ) {
    super({
      code: "CREDIT_LIMIT_EXCEEDED",
      message: `Credit limit ${limit} exceeded by customer ${customerId} (attempted ${attempted})`,
    });
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

- **`error.toJSON()` / `error.toLogObject()`**: structured **log** entry with name, message, timestamp, stack, cause chain. Log-only: never return it to a client. For client-safe, localized output, project the error through the opt-in `@shirudo/base-error/public-error` subpath (`the public-error projection pipeline`) at the boundary; the technical core carries no user-facing message.
- **`error.timestamp` / `error.timestampIso`**: epoch + ISO, useful for sorting / correlating log entries across distributed systems.
- **`error.code`**: typed literal (`"CONCURRENCY_CONFLICT"`, not just `string`), the ONE stable identifier (`error.name === error.code` by design), so you get exhaustiveness checking in a plain `switch` on `error.code`, no base-error import required.
- **`error.cause` + traversal helpers** (`getRootCause`, `findInCauseChain`, `filterCauseChain`): for wrapping infrastructure errors in domain errors and still finding the root cause for retry decisions.
- **`isRetryable(error)`**: single-level retry predicate. `ConcurrencyConflictError.retryable === true`; consumer-derived errors that need the same hint pass `retryable: true` in the options-object `super` call.
- **`someChainRetryable(error)`**: whole-chain retry predicate. Walks the cause chain with the same loose `retryable === true` check as `isRetryable`, so it also matches plain objects and errors from other libraries that only carry the marker. Since v3 kit errors are full `StructuredError`s, so the strict `isChainRetryable` works on them too; `someChainRetryable` stays the more tolerant default. The kit's [`RetryingTransactionScope`](./concurrency.md#retrying-conflicts-retryingtransactionscope) uses `someChainRetryable` as its default retry classifier.

::: tip Every `@shirudo/base-error` helper works with ddd-kit errors
Since v3 every kit error IS a `StructuredError` (`code` + `category` + `retryable`), so both the loose helpers (`isBaseError`, `isRetryable`, `someChainRetryable`, the cause-chain traversals) and the strict ones (`isStructuredError`, `isRetryableStructuredError`, `isChainRetryable`, `getRootCauseRetryable`, `getFirstRetryableCause`) and exhaustive `matchError` on the codes all see them. None of this is required: a plain `switch (error.code)` and the kit-exported `instanceof` bases cover the same ground without importing base-error.
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

`@shirudo/base-error` is **safe by default**: a `ValidationError` does not expose its issues on its own; they only cross to a client through the `publicIssues()` whitelist. The opt-in `@shirudo/ddd-kit/http` entry point wires that projection for you (and defaults to `422` / `"Validation Failed"`), so the core kit stays transport-free. It returns base-error's own `ProblemDetails` type (from `@shirudo/base-error/public-error`), so the RFC 9457 shape stays a single source of truth:

```ts
import { toProblemDetails } from "@shirudo/ddd-kit/http";

if (result.isErr()) {
  const problem = toProblemDetails(result.error);
  return Response.json(problem.body, {
    status: problem.status,
    headers: problem.headers,
  });
}
// body → { type: "about:blank", title: "Validation Failed", status: 422,
//          code: "VALIDATION_FAILED",
//          details: { issues: [{ message: "must be a valid email", path: ["email"], pointer: "email" }] } }
```

For the general error-to-Problem-Details mapping (a public-code catalog with per-code `type` / `status` over a projected `PublicError`), reach for base-error's `toProblem` directly; `toProblemDetails` is the narrow validation shortcut.
