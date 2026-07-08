# Use Case Design

Use use case design when modeling an application-level actor goal: a command,
query, or workflow entry point that coordinates the domain model, persistence,
authorization, transactions, and side effects inside one bounded context.

This reference has two parts. Part 1 - Principles are invariants: they always
hold, no choice involved. Part 2 - Decision procedures are forks and sequences
resolved per use case. Each names its discriminator, gives ordered options with
observable conditions, and states its hard limits. A sequence is run in full; a
fork is entered at the matching condition.

## Scope and Neighbors

- This document designs a use case or application service: the application-layer
  unit that executes an actor intention.
- Use `aggregate-design.md` for immediate business invariants and transaction
  boundaries inside the model.
- Use `repository-design.md` for aggregate persistence, unit of work, and
  transaction-manager design.
- Use `error-management-design.md` for stable error codes, result-vs-exception
  policy, transport mapping, and cross-context error translation.
- This document uses Ports and Adapters terms for use-case boundaries: the use
  case sits behind a driving port (the application-boundary interface), and its
  collaborators are driven ports.
- Use `domain-event-design.md` for recorded facts, handler timing, payload,
  delivery, and versioning.
- Use `context-coordination.md` when the interaction spans bounded contexts at
  runtime. Use `saga-design.md` when it becomes durable and compensating.
- Use `context-mapping.md` for static upstream/downstream relationships.
- Use-case design is not controller design, UI design, ORM design, or framework
  routing.

## Contents

- Core rule
- Part 1 - Principles
  - Actor intention
  - Application-layer responsibility
  - Driving port and driven ports
  - Command vs query
  - Input and output contracts
  - Authorization and identity
  - Validation and invariants
  - Transaction and consistency
  - Idempotency and concurrency
  - Side effects and events
  - Error handling and outcomes
  - Observability and testing
- Part 2 - Decision procedures
  - Qualification
  - Use case kind
  - Boundary and naming
  - Orchestration shape
  - Transaction scope
  - Authorization and validation
  - Error contract
  - Side-effect timing
  - Idempotency and concurrency
  - Output contract
- Result notation
- Smell checks
- Expected output

## Core Rule

A use case coordinates one actor intention at the application boundary. It
accepts an application request, authorizes it, validates external input, loads
the needed model, invokes domain behavior, persists the result, coordinates
events or side effects, and returns an application outcome. It does not own
business invariants, does not expose persistence details, and does not become a
generic service layer.

Default: one use case per named business intention, command, or query. Deviate
only when combining intentions reduces accidental ceremony without hiding
different policies, transactions, permissions, or outcomes.

## Part 1 - Principles

### Actor Intention

- A use case starts from an actor goal, not a screen, endpoint, database table,
  or CRUD operation.
- Name write use cases after business decisions: `PlaceOrder`, `CancelBooking`,
  `ApproveInvoice`, `HoldSeat`.
- Name read use cases after information needs: `GetBookingDetails`,
  `ListAvailableSeats`, `FindCustomerInvoices`.
- A use case has a primary actor, trigger, preconditions, a main success
  scenario, and alternate flows.
- The term fuses two lineages: Jacobson's and Cockburn's use case - an
  interaction specification with a main success scenario and numbered extensions
  (the alternate flows) - and the Clean Architecture interactor, one application
  operation behind a boundary. This document keeps Cockburn's
  actor/trigger/precondition framing and the extensions, together with the
  interactor's one-intention-per-use-case rule. Where the two lineages differ,
  name it rather than silently picking one.
- Do not collapse distinct actor intentions just because they share an endpoint
  shape or UI form.

### Application-Layer Responsibility

- A use case orchestrates. It does not decide domain rules that belong inside an
  aggregate, entity, value object, or domain service.
- It may coordinate repositories, unit of work, clocks, identity, authorization,
  domain services, ports, event publication, and transaction boundaries.
- It is allowed to contain application policy: authorization, idempotency,
  deduplication, transaction timing, retries around infrastructure, and mapping
  domain outcomes to application responses.
- It must not become a business rule engine. If the branch is a domain decision,
  move it into the domain model.
- Keep framework concerns at the edge. Controllers, handlers, or resolvers adapt
  transport input into a use-case request and map the response back.

### Driving Port and Driven Ports

- A use case sits behind a driving (primary) port in Ports and Adapters terms:
  the port is the application-boundary interface that driving adapters such as
  controllers, message handlers, or schedulers call; the use case is the
  implementation behind it.
- Its collaborators are driven (secondary) ports: repository, unit of work,
  clock, identity, authorization, event publisher, and external-system gateways.
  The use case depends on these ports, never on concrete adapters.
- The use-case body is orchestration expressed against ports; adapters supply the
  implementations. This is what makes a use case testable without HTTP, queues,
  or a database.
- A driving adapter adapts transport input into a use-case request and maps the
  response back. It holds no application logic; the use case holds no transport
  concern.

### Command vs Query

- A command use case changes state. It should call write-side domain behavior
  and usually runs inside a transaction.
- A query use case reads state. It should not mutate aggregates or emit domain
  events.
- A query use case is often much thinner than a command, and in strict CQRS a
  read may skip the use-case layer entirely: a thin query handler goes straight
  to the read model. Do not impose command-shaped ceremony (transactions, events,
  aggregate loading) on a read; add only the application concerns the read
  actually needs, typically authorization and partial-failure handling.
- Default: keep commands and queries separate. Deviate only for a small,
  explicit read-after-write response that reports the command outcome.
- Queries can use read models, projections, or query services. They do not need
  to load aggregate roots unless the read itself is a domain decision. Use
  `read-model-design.md` for read-model freshness, lag, and rebuild rules.
- A command should not query read models to enforce aggregate invariants; read
  models may be stale.

### Input and Output Contracts

- Use use-case request and response types at the application boundary. Do not
  expose controllers, ORM entities, aggregate internals, or transport-specific
  objects.
- Input DTOs carry raw external data. Convert raw primitives into value objects
  before calling domain behavior when the domain concept has constraints or
  meaning.
- Output contracts report application outcomes: success data, rejection reason,
  conflict, not found, forbidden, or accepted-for-processing.
- Do not return live aggregate instances to adapters. Return response models,
  ids, domain results, or read models.
- Avoid leaking internal domain errors or exception types as public API
  contracts unless the application has a deliberate mapping.

### Authorization and Identity

- Application-level authorization stays in the use case or an application
  policy. The domain model should not know about HTTP sessions, JWT claims,
  roles, or framework principals.
- Domain permissions may belong in the domain when the permission is itself a
  business rule expressed in ubiquitous language.
- The use case supplies actor identity, tenant, and time explicitly to the
  domain when those facts affect a business decision.
- Do not hide current user, tenant, or clock access behind global state inside
  aggregates.

### Validation and Invariants

- Validate external input before it enters the domain model: shape, required
  fields, parsing, length, format, and type.
- Protect domain invariants inside aggregates, entities, value objects, or domain
  services. Use-case validation does not replace invariant protection.
- Converting raw input into value objects at the boundary is the legitimate place
  where domain validation is pulled forward to the application edge: the value
  object enforces its own invariants at construction (parse, don't validate).
  This does not blur the input-vs-invariant rule. It is the domain model
  validating its own concepts, invoked early, not the use case reimplementing
  invariants.
- A use case may reject a request before loading the domain model when the input
  is malformed or the actor is unauthorized.
- A domain rejection after loading state is a normal business outcome, not an
  infrastructure failure.
- A failed command must not leave the aggregate in an invalid state. See
  `aggregate-design.md`.

### Transaction and Consistency

- Default: one command use case changes one aggregate instance in one
  transaction.
- Deviate to multiple aggregate instances only when `aggregate-design.md`
  permits it through transaction-scope reasoning and the immediate invariant
  truly spans those instances.
- If coordination crosses bounded contexts, prefer events, a process manager, or
  a saga instead of one transaction.
- Do not call external systems inside the database transaction. Capture external
  facts before the command runs, and publish external effects after commit;
  same-transaction handling is reserved for local state that must roll back with
  the command. External systems do not participate in aggregate invariants.
- Persist aggregate changes and recorded domain events atomically when events
  drive reliable downstream work. Publish external messages after commit.
- Where transaction control lives is a position, not a law. This document's
  default treats transaction timing as application policy the use case owns. A
  common alternative moves it to a decorator or middleware around the use case -
  a unit-of-work wrapper - so the use-case body stays pure orchestration with no
  explicit begin/commit. Both are valid; pick one per codebase and apply it
  consistently. Either way the use case is the natural unit-of-work boundary; see
  `repository-design.md` for the mechanism.

### Idempotency and Concurrency

- Idempotency is an application concern. The use case should accept or derive an
  idempotency key when clients, messages, or retries can duplicate commands.
- Duplicate command handling must return the previous outcome or a deliberate
  conflict, not run the domain decision twice.
- Use optimistic concurrency, pessimistic locking, single-writer partitioning, or
  an equivalent stale-write protection according to the aggregate and workload.
- A stale command should fail when the business decision cannot be safely
  retried against current state.
- Idempotency keys do not belong inside aggregates unless the key itself is part
  of the domain language.

### Side Effects and Events

- Record domain events only after the domain model accepts the command and
  changes state.
- Keep immediate, same-transaction local side effects explicit. Use them only
  when they must share the command's atomicity.
- Publish integration events, emails, webhooks, jobs, and external messages after
  commit. Use an outbox when reliable delivery matters.
- A use case may call an application port, but the port must not smuggle
  external side effects into aggregate behavior.
- If a side effect becomes a multi-step process with durable state, use
  `context-coordination.md` or `saga-design.md`.

### Error Handling and Outcomes

- Expected business rejections should be explicit application outcomes:
  `Rejected`, `NotFound`, `Forbidden`, `Conflict`, `AlreadyProcessed`,
  `Accepted`, or `Succeeded`.
- Expected infrastructure failures that callers can react to should be mapped to
  stable application or port errors. Use exceptions for programmer errors,
  corrupted state, impossible branches, or invariant violations that indicate a
  bug.
- Use deliberate mapped domain exceptions only when that is the application's
  standard error contract.
- For code placement, retryability, safe details, and transport mapping, use
  `error-management-design.md`.
- Do not collapse all failures into `500`, `false`, or `null`.
- The use case owns mapping domain outcomes to application responses. The domain
  should not know HTTP status codes, GraphQL errors, queue nack behavior, or UI
  messages.

### Observability and Testing

- Log or trace at the use-case boundary with request id, actor id, tenant,
  correlation id, outcome, duration, and relevant business ids.
- Do not log secrets, PII beyond policy, or full domain objects by default.
- Command use cases should be testable without HTTP, queues, or controllers.
- Test expected success, business rejection, authorization failure, stale write,
  idempotent duplicate, and side-effect timing for risky use cases.
- A use-case test should verify orchestration and outcome mapping. Domain rules
  still need domain tests at the aggregate/value-object/domain-service level.

## Part 2 - Decision Procedures

### Qualification - fork

Discriminator: is this a use case, a domain behavior, or a coordination process?

1. **A domain object can decide the rule from its own state** -> aggregate,
   entity, value object, or domain service. Not a use-case rule.
2. **An actor or adapter asks the system to do one application task** -> use
   case. Continue.
3. **The interaction is only transport mapping** -> controller/resolver/handler,
   not a use case.
4. **The interaction is a long-running or cross-context process with durable
   state, retries, timeouts, or compensation** -> context coordination, process
   manager, or saga.
5. **The interaction is a read over reporting/search data** -> query use case or
   read-model query service.

Hard limits: do not put domain invariants in a use case merely because the use
case has access to repositories. Do not introduce a use case that only forwards
one method call and adds no application boundary value unless consistency in the
architecture requires that boundary.

### Use Case Kind - fork

Discriminator: does the intention change state?

1. **Changes domain state** -> command use case. Design transaction,
   concurrency, idempotency, domain events, and side effects.
2. **Reads data only** -> query use case. Design freshness, read model,
   authorization, filtering, and partial failure behavior. Keep it thin; skip
   command ceremony it does not need.
3. **Starts work that completes later** -> command use case returning
   accepted-for-processing, or a process manager/saga if durable process state is
   required.
4. **Mixes write and read** -> keep the write decision primary; return only the
   command outcome or an explicit read-after-write response.

Hard limits: a query does not mutate aggregates or emit domain events. A command
does not use a stale read model to enforce an invariant.

### Boundary and Naming - sequence

Goal: name the use case and define its boundary.

1. Name the primary actor.
2. Name the actor intention in ubiquitous language.
3. Name the trigger: API request, UI action, message, schedule, import, or
   operator action.
4. Name the use case after the intention, not after a technical operation.
5. Define the request DTO and response/outcome type.
6. State the preconditions and the main success scenario.
7. Enumerate the alternate flows (Cockburn extensions): for each point where the
   scenario can deviate, name the condition and the alternate outcome - business
   rejection, not found, conflict, forbidden, or an alternate success path. The
   extensions are the substance of the use case; a use case that lists only
   "success plus failure" has under-modeled its behavior.

Hard limits: if two paths have different permissions, transactions, invariants,
or outcomes, they are probably different use cases even if one UI form submits
both.

### Orchestration Shape - sequence

Goal: define the application workflow without stealing domain behavior.

1. Validate external input shape.
2. Resolve actor identity, tenant, correlation id, idempotency key, and clock.
3. Authorize the application action.
4. Convert input into value objects or domain command parameters, so malformed
   input rejects before any model is loaded. A conversion that needs loaded
   state is the rare exception and runs after step 5.
5. Load the required aggregate or read model.
6. Invoke aggregate, entity, domain service, or query service behavior.
7. Persist state and domain events in the chosen transaction. If the codebase
   uses a unit-of-work decorator around the use case, the begin/commit is not in
   this body - see *Transaction and Consistency*.
8. Publish or schedule side effects according to the side-effect timing decision.
9. Map the outcome to the response contract.

Hard limits: if a branch explains whether the business action is allowed by
current domain state, prefer moving that branch into the domain model. If the use
case starts calling multiple bounded contexts in sequence, revisit
`context-coordination.md`.

### Transaction Scope - fork

Discriminator: what must be immediately consistent?

1. **No mutation** -> no write transaction; use read model or query service.
2. **One aggregate decides and changes** -> one transaction around that aggregate
   and its recorded events.
3. **Several objects inside one aggregate boundary change together** -> one
   transaction through the aggregate root.
4. **Several aggregate instances in one bounded context must change
   immediately** -> first challenge the invariant and boundary using
   `aggregate-design.md`; accept only with an explicit business reason and
   stale-write protection.
5. **Several bounded contexts must change** -> do not use one transaction; use
   domain events, context coordination, process manager, or saga.

Hard limits: a use-case transaction is not a license to bypass aggregate roots.
Do not enforce an invariant through external queries, projections, or caches.
The use case specification itself is a modeling input, not a fixed requirement:
rewriting or splitting the use case is a legitimate resolution, often the
correct one, before accepting a multi-instance transaction (see *Transaction
Scope* in `aggregate-design.md`).

### Authorization and Validation - sequence

Goal: separate external input checks, application permission, and domain rules.

1. Validate transport-independent request shape.
2. Authenticate actor identity outside the domain model.
3. Authorize the application action using actor, tenant, and target ids.
4. Load the domain model only after cheap rejection when possible.
5. Let the domain model decide domain permissions and state-dependent rules.
6. Map validation, forbidden, not found, conflict, and domain rejection
   separately.

The order of shape validation and authorization is a security trade-off, not a
fixed rule. Validating input shape before authorizing reveals contract details to
an unauthorized actor; authorizing first hides them but spends work on malformed
requests. Likewise, returning not-found before forbidden reveals whether a
resource exists. Choose both orders deliberately, by how sensitive the contract
shape and the existence of the resource are, and apply the choice consistently.

Hard limits: application authorization must not depend on mutable domain state
that only the aggregate can interpret. Domain permissions must not depend on
framework principals or hidden global user state.

### Error Contract - fork

Discriminator: what kind of failure is it?

1. **Malformed external input** -> validation outcome.
2. **Unauthenticated or unauthorized actor** -> authentication or authorization
   outcome.
3. **Missing target** -> not found outcome unless hiding existence is required.
4. **Stale version or concurrent modification** -> conflict or stale-write
   outcome.
5. **Expected business rejection** -> typed domain/application rejection.
6. **Duplicate idempotency key** -> previous outcome or deliberate conflict.
7. **Infrastructure unavailable** -> technical failure, retry, or unavailable
   outcome.
8. **Programmer error, impossible branch, invariant violation** -> exception and
   bug signal.

Hard limits: do not use control-flow exceptions for ordinary business rejection
unless mapped domain exceptions are the application's standard error contract.
Do not expose internal exception names as external API semantics. For stable
codes and transport mapping, use `error-management-design.md`.

### Side-Effect Timing - fork

Discriminator: when must the side effect be observed relative to the command?

1. **Must be atomic with the command and local to the bounded context** ->
   same-transaction in-process handling is allowed, outside aggregate behavior.
2. **Can lag or crosses aggregate/context/system boundary** -> post-commit
   handling, usually through domain/integration events.
3. **Must be delivered reliably after commit** -> outbox and dispatcher.
4. **Requires multiple steps, retries, timeouts, or compensation** -> process
   manager or saga.

Hard limits: do not send external messages before the command commits. Do not
use an event handler to complete the same aggregate's own invariants.

### Idempotency and Concurrency - sequence

Goal: prevent duplicate execution and stale writes.

1. Decide whether the caller, message, or scheduler can retry or duplicate the
   request.
2. If yes, require an idempotency key or derive one from the message id and
   actor/intention.
3. Store the key, command fingerprint, outcome, and status in the application
   layer.
4. On duplicate:
   - return the previous completed outcome;
   - return in-progress when the first execution is still running;
   - reject when the same key carries a different command fingerprint.
5. Load the aggregate with its version or lock token when stale writes matter.
6. On stale write, return conflict unless the use case defines a safe retry.

Hard limits: idempotency is not a domain invariant unless the business names it.
Do not rerun non-idempotent domain decisions for a duplicate command.

### Output Contract - sequence

Goal: return the right amount of information without leaking internals.

1. Choose the response style:
   - command outcome only;
   - command outcome plus identifiers;
   - accepted-for-processing with status id;
   - read-after-write view;
   - query result.
2. Map domain results to application outcomes.
3. Include ids and versions when the caller needs follow-up or concurrency
   control.
4. Keep transport-specific status codes outside the use case unless the
   application deliberately uses transport-shaped responses.
5. Avoid returning aggregate internals, ORM entities, or event payloads as the
   response.

Hard limits: output convenience must not enlarge aggregate boundaries or force
write models to serve display-only data. Use read models or composition for
display needs.

## Result Notation

Use this compact notation when summarizing the design:

`UseCaseName | kind | actor | transaction | consistency | outcome contract`

Command table:

| Field | Decision |
| ----- | -------- |
| Actor | User, operator, system, message |
| Trigger | API, UI, message, schedule |
| Request | DTO name and required ids |
| Authorization | Application policy and domain permission |
| Domain call | Aggregate/domain service method |
| Transaction | None, one aggregate, multi-aggregate exception |
| Idempotency | Key, fingerprint, duplicate behavior |
| Events | Recorded, same-transaction, post-commit, outbox |
| Alternate flows | Extensions and their outcomes |
| Outcomes | Success, rejection, conflict, not found, forbidden |

Query table:

| Field | Decision |
| ----- | -------- |
| Actor | User, operator, system |
| Freshness | Read-time fresh or eventually consistent |
| Source | Aggregate, read model, projection, external contract |
| Authorization | Application policy |
| Partial failure | Fail, degrade, omit, retry |
| Response | Query result contract |

## Smell Checks

- The use case is named after CRUD or transport instead of a business intention.
- One use case handles several intentions with different permissions,
  transactions, or outcomes.
- A controller contains the real use-case logic.
- The use case contains domain rules that should be aggregate behavior.
- The aggregate contains application authorization, idempotency, transport, or
  persistence concerns.
- A command use case reads from projections or caches to enforce an invariant.
- A query use case mutates state or emits domain events.
- A query use case carries command-shaped ceremony (transactions, events,
  aggregate loading) it does not need.
- The use case depends on concrete adapters instead of driven ports, and cannot
  be tested without HTTP, queues, or a database.
- External messages are sent before the transaction commits.
- Idempotency is missing for retryable commands or at-least-once messages.
- Duplicate commands rerun non-idempotent domain decisions.
- Multi-aggregate transaction is used without explicit boundary reasoning.
- Cross-context workflow is hidden inside a synchronous use case instead of
  modeled as coordination or a saga.
- The use case lists only success and failure, with the alternate flows
  (extensions) left unmodeled.
- The response returns ORM entities, aggregate internals, or display-only data
  from the write model.
- All failures collapse into a boolean, `null`, or generic exception.
- The use case is so thin it adds no boundary, or so large it has become a
  process manager, domain service, and controller at once.

## Expected Output

When designing a use case, emit:

- Use case name and actor intention.
- Kind: command, query, accepted async command, or handoff to coordination/saga.
- Trigger and request contract.
- Main success scenario and its alternate flows (extensions).
- Authorization policy and identity/tenant inputs, and the chosen order of
  validation vs authorization where it is security-sensitive.
- Validation split: external input checks vs domain invariants.
- Domain objects or services invoked.
- Transaction scope and consistency decision, and where transaction control lives
  (in the use case or a unit-of-work decorator).
- Idempotency and concurrency strategy.
- Events and side-effect timing.
- Error/outcome contract.
- Response contract.
- Smell-check findings and unresolved modeling questions.
