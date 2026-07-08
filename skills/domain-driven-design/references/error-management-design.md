# Error Management Design

Use error management design when deciding how failures cross layers and bounded
contexts: whether a failure is an error value or a thrown defect, what code it
carries, which layer owns that code, how it maps at the transport edge, and how
it translates across bounded-context boundaries.

This reference has two parts. Part 1 - Principles are invariants: they always
hold, no choice involved. Part 2 - Decision procedures are forks and sequences
resolved per error, port, or boundary. Each names its discriminator, gives
ordered options with observable conditions, and states its hard limits. A
sequence is run in full; a fork is entered at the matching condition.

## Scope and Neighbors

- This document decides the architecture of errors: the error protocol of a
  port, the code contract, layer placement, transport mapping, and cross-context
  translation.
- Detailed, technology-specific rules, shared error packages, folder standards,
  normative implementation rules, and reference implementations are the
  implementation layer behind this guide; this document is the decision layer.
- Use `use-case-design.md` for the use-case error contract and outcome mapping.
- Use `aggregate-design.md` for whether a domain rejection is a value or an
  exception at the model level.
- Use `repository-design.md` for how adapters surface persistence failures as
  port errors.
- Use `saga-design.md` for failure taxonomy, retries, timeouts, and compensation
  in a long-running process.
- Use `context-mapping.md` for the upstream/downstream relationship that governs
  cross-context error translation.
- Use `domain-event-design.md` for failures reported as events rather than
  returned to a caller.

## Contents

- Core rule
- Part 1 - Principles
  - Errors are part of the port protocol
  - Machine-readable, not user-facing
  - Expected errors are values, bugs are exceptions
  - Codes are stable contracts describing semantics
  - Errors belong to their layer
  - Public contracts stay small and reactable
  - Details are safe
  - Retryability is a property, not permission
- Part 2 - Decision procedures
  - Error qualification
  - Result vs exception
  - Code granularity
  - Code placement
  - Use-case error contract
  - Multiple-error aggregation
  - Cross-context error strategy
  - Transport mapping
- Result notation
- Smell checks
- Expected output

## Core Rule

An error is a structured, machine-readable value carrying a stable code, a
category, a retryable flag, and safe details. Expected failures are returned as
error values, never thrown. A port declares its full error protocol; adapters map
technology-specific failures onto port codes. Callers react to a small, stable
set of errors; everything else is mapped down. User-facing text is produced at
the edge from the code, never carried in the error across the boundary.

## Part 1 - Principles

### Errors Are Part of the Port Protocol

- A port defines the protocol of a conversation, and failures are part of that
  protocol. A port that exposes only the success case declares an incomplete
  protocol.
- The port's error codes are technology-agnostic. Adapters map
  technology-specific failures such as connection refused, timeout, or
  constraint violation onto the port's codes.
- Because the protocol is stable, swapping the adapter technology does not
  change the port's error contract or the use case. That stability is the point.

### Machine-Readable, Not User-Facing

- An error carries a stable code, a category, a retryable flag, and safe details.
  Any server-side message is diagnostic only, for logging.
- User-facing text is produced in the frontend from the code (i18n), never
  carried in the error response. One declared exception: a server function
  whose client and server deploy as one unit may localize server-side and
  include an optional localized message (*Transport Mapping*, option 2); no
  external contract is created because both sides ship together.
- Responses across a boundary never carry the diagnostic message, stack, or
  cause. Those are logged server-side and stripped from the payload.

### Expected Errors Are Values, Bugs Are Exceptions

- Expected failures - validation, not found, conflict, unauthorized, business
  rule, infrastructure unavailable - are returned as error values, never thrown.
- Exceptions are reserved for defects: broken invariants, impossible branches,
  misconfiguration, and non-exhaustive switches. A defect must not be caught and
  handled as ordinary flow.
- A generic unexpected category exists only in the outermost driving adapter as
  the last-resort handler for an uncaught bug. Bounded-context code never
  produces it.

### Codes Are Stable Contracts Describing Semantics

- An error code is an API contract. Renaming, removing, or repurposing it is a
  breaking change.
- A code names the business or protocol meaning, never a technology, provider,
  or implementation detail. Use `STORAGE_UNAVAILABLE`, not `POSTGRES_TIMEOUT`.
- The code schema is stable and structured, with no class or file names.
  Default: SCREAMING_SNAKE identifiers (`CONCURRENCY_CONFLICT`,
  `STORAGE_UNAVAILABLE`). A dotted lowercase schema
  (`<context>.<area>.<reason>`, such as `booking.storage.unavailable`) is a
  deliberate alternative when codes must carry context and area namespacing
  on the wire. Pick exactly one schema per codebase; mixing both is
  forbidden.

### Errors Belong to Their Layer

- Domain codes (business rules, invariants) live in the domain, in ubiquitous
  language.
- Port codes (not found, storage unavailable) are co-located with the driven
  port and are technology-agnostic.
- Use-case codes (orchestration outcomes) are co-located with the use case.
- Adapters export no codes of their own. They use port-defined codes and keep
  any internal mapping tables private. There is no central infrastructure-code
  module.
- Errors are co-located with the abstraction they describe.

### Public Contracts Stay Small and Reactable

- A public error contract - a driving port, a use-case result crossing a
  boundary, a cross-bounded-context contract - exports only errors a caller can
  react to: branch, choose a retry or alternate route, or surface a specific
  ubiquitous-language outcome.
- Everything else is mapped to a few stable codes. A use case does not mirror
  its ports' error unions.
- The granularity of codes is governed by caller reaction, not by how many
  distinct failures exist underneath.

### Details Are Safe

- `details` carries operation, resource id, constraint key, provider, timeout,
  retry-after, and similar metadata a caller or operator can use.
- `details` never carries raw exception text, SQL, stack traces, secrets,
  tokens, or provider payloads.

### Retryability Is a Property, Not Permission

- The retryable flag states whether re-issuing the same request could succeed.
  It is a property of the failure, not permission to retry blindly.
- Acting on it is safe only when the operation is idempotent. A retryable failure
  on a non-idempotent command still needs an idempotency key or a status query
  before retry. See `use-case-design.md` and `saga-design.md`.

## Part 2 - Decision Procedures

### Error Qualification - fork

Discriminator: is the failure an expected outcome a caller can react to, or a
defect?

1. **Expected** - validation, not found, conflict, unauthorized, business rule,
   infrastructure unavailable -> an explicit error value (a result), never
   thrown.
2. **Defect** - broken invariant, impossible branch, misconfiguration,
   non-exhaustive switch -> an exception; it must propagate, not be handled as
   normal flow.
3. **Uncaught defect at the outermost driving adapter** -> a single generic
   unexpected fallback, only there; log the full error server-side.

Hard limits: never throw an expected error; never model a defect as a reactable
error; bounded-context code never produces the unexpected category. That lives
only in the deployable's last-resort handler.

### Result vs Exception - fork

Discriminator: can the language express the error contract at compile time, and
is the failure expected?

1. **Expected failure, language without checked exceptions** (TypeScript, and
   most) -> a typed result value; the port declares the full error protocol;
   adapters map technology failures to port errors. This is the default because
   an untyped throw is a hidden contract the compiler cannot see.
2. **Expected failure, language with checked exceptions** (Java) -> a declared
   exception in the signature is a valid equivalent; it is still an explicit,
   compiler-enforced contract.
3. **Defect, any language** -> exception or panic.

Position note: this guide defaults to result values because this family targets
a language without checked exceptions, where results are the only way to make the
error contract visible in the type system. The exceptions-for-domain-errors
tradition is valid where the contract is checked; it is not equivalent where a
throw is invisible to the compiler.

Library boundary note: a shipped library or kit legitimately throws typed,
structured errors (stable code, category, retryable flag, closed code union)
as its declared standard contract, the mapped-exceptions escape above. A
result-first library would force its result type onto every consumer; thrown
structured errors are the ecosystem's common denominator, and a consumer that
prefers result values wraps the library's calls at its own port with a small
try/catch adapter. The declared standard must be real: structured error
classes and a closed code union, not ad-hoc throws.

Hard limits: do not adopt exception-based expected-error flow where the type
system cannot express the contract; forgotten handling becomes an invisible bug.
A domain rejection is not an exception unless mapped exceptions are the
codebase's standard, explicit error contract.

### Code Granularity - fork

Discriminator: does the caller react differently to this failure than to an
existing code?

1. **Same caller reaction as an existing code** -> reuse the code; add context
   through `details`, not a new code.
2. **Different caller reaction** - branching, a different UI flow, a distinct
   retry strategy, an alternate route - or the failure is ubiquitous-language ->
   a specific code.
3. **Same infrastructure failure across several ports, uniform caller reaction**
   -> a shared code at the context level, not one per port.
4. **Only an observability or alerting distinction** -> `details` (port,
   operation, provider), never a new code.

Hard limits: a new code purely for logs or metrics is code explosion and is
forbidden. A code never names a technology or provider. Shared infrastructure
codes live in the application shared layer, never in the domain.

### Code Placement - fork

Discriminator: what does the code describe?

1. **A business rule or invariant in ubiquitous language** -> a domain code, in
   the domain layer.
2. **A port-contract failure** (not found, storage unavailable, timeout) -> a
   port code, co-located with the driven port, technology-agnostic.
3. **A use-case orchestration outcome the caller reacts to** -> a use-case code,
   co-located with the use case.
4. **A shared infrastructure failure across ports** -> a shared code in the
   application shared layer.

Hard limits: the domain never uses port codes because it knows no ports;
adapters never export their own codes; there is no central infrastructure-code
module; infrastructure detail stays inside adapters as private mapping.

### Use-Case Error Contract - sequence

Goal: keep the public error contract small and reactable.

1. List the failures the caller can actually react to.
2. Map port and dependency errors down to a few use-case codes; map
   infrastructure failures to a single temporarily-unavailable code, retryable.
3. Pass a domain rule through as a domain code only when the caller reacts to it
   specifically.
4. Attach the original error as the cause internally and add safe details.
5. Keep the union small; do not mirror the ports' unions.

Hard limits: a use-case union that mirrors all port and dependency errors
without added reactability is forbidden; internal-only callers may accept
passed-through port errors as deliberate coupling, but a public contract stays
small and stable.

### Multiple-Error Aggregation - fork

Discriminator: does the caller need every failure at once, or is the first
enough to stop?

1. **Sequential dependent steps where the first failure aborts** -> short-circuit
   on the first error (railway style). The later steps could not run anyway.
2. **Independent validations the caller should correct together** - a form, a
   batch, a multi-field request -> collect all errors and return them as a set,
   not just the first (applicative validation).

Hard limits: do not short-circuit independent input validation into a single
first error when the caller must fix the fields together; collect and return the
set. Aggregated errors still each carry their own code and safe details.

### Cross-Context Error Strategy - fork

Discriminator: what is the downstream's relationship to the upstream? See
`context-mapping.md`.

1. **ACL, legacy, or unstable upstream** -> map upstream errors into the
   consumer's own language. Mandatory.
2. **Customer/Supplier with separate teams** -> map, by default.
3. **Conformist (full)** -> propagate the upstream error in the upstream's
   language; document it and link the upstream contract.
4. **The error is healable** -> handle it and return success; no error crosses
   outward.

Hard limits: never fake an upstream code inside your own namespace; never
type-cast an upstream error through your boundary; propagation without
Conformist documentation is forbidden.

### Transport Mapping - fork

Discriminator: what is the driving adapter?

1. **HTTP (REST, GraphQL)** -> a problem payload: code, status derived from
   category, category, retryable, safe details, optional trace id. No message,
   stack, or cause.
2. **Server function (RPC, actions)** -> a client-error payload: code, category,
   retryable, safe details, optional localized message. No status, no stack, no
   cause.
3. **Uncaught** -> the outermost handler maps to a generic unexpected response
   and logs the full error server-side.

Hard limits: responses never carry the diagnostic message, stack, or cause;
HTTP status comes from the category, never a code substring; user-facing text is
produced at the frontend from the code, with the single declared exception of
the server-function localized message in option 2.

## Result Notation

Use this compact notation when summarizing an error's design:

`code | category | retryable | layer | caller reaction`

Error table:

| Field | Decision |
| ----- | -------- |
| Code | Stable; SCREAMING_SNAKE (default) or `<context>.<area>.<reason>`, one schema per codebase |
| Category | VALIDATION, NOT_FOUND, CONFLICT, UNAUTHORIZED, FORBIDDEN, BUSINESS_RULE, INFRASTRUCTURE, SECURITY |
| Retryable | Yes/no; safe to act on only if the operation is idempotent |
| Kind | Expected value or thrown defect |
| Layer | Domain, port, use-case, shared |
| Granularity | Own code (distinct caller reaction) or shared code + details |
| Caller reaction | Branch, retry, alternate route, ubiquitous-language outcome |
| Cross-context | Map, propagate (Conformist), or heal |
| Transport | Problem payload, client-error payload, or unexpected fallback |

## Smell Checks

- An expected error is thrown instead of returned.
- A defect is modeled as a reactable error value.
- Bounded-context code produces the unexpected category.
- A code names a technology or provider, such as `POSTGRES_TIMEOUT` or
  `REDIS_DOWN`.
- Both code schemas (SCREAMING_SNAKE and dotted lowercase) appear in one
  codebase.
- A new code exists only for logging, metrics, or alerting.
- A code is duplicated per port where a shared code would fit and the caller
  reacts uniformly.
- The domain uses port codes, or an adapter exports its own codes.
- A central infrastructure-code module exists.
- A use-case error union mirrors all port and dependency errors without added
  reactability.
- A response carries a diagnostic message, stack, or cause.
- User-facing text is produced server-side outside the declared server-function
  exception.
- HTTP status is derived from a code substring instead of the category.
- `details` carries raw exception text, SQL, secrets, or provider payloads.
- Independent field validations short-circuit into a single first error.
- A retryable failure is retried on a non-idempotent operation with no
  idempotency key or status query.
- An upstream error is faked in the consumer's namespace or cast through the
  boundary.
- A cross-context error is propagated without Conformist documentation.

## Expected Output

When designing an error, emit:

- Code, category, and retryable flag.
- Kind: expected value or thrown defect.
- Layer that owns the code: domain, port, use-case, or shared.
- Granularity decision: own code (distinct caller reaction) or shared code plus
  details.
- Caller reaction the code enables.
- Use-case mapping, if the error is mapped down to a public contract.
- Aggregation behavior for multi-error inputs: short-circuit or collected set.
- Cross-context strategy, if it crosses a boundary: map, propagate, or heal.
- Transport payload shape and, for HTTP, the status from the category.
- Retryability and its idempotency precondition.
- Safe details carried, and what is deliberately excluded.
