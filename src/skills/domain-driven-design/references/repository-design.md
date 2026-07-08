# Repository Design

Use repository design when modeling how aggregate roots are loaded, saved,
reconstituted, and made transactionally durable without leaking persistence
mechanics into the domain model.

This reference has two parts. Part 1 - Principles are invariants: they always
hold, no choice involved. Part 2 - Decision procedures are forks and sequences
resolved per repository or persistence boundary. Each names its discriminator,
gives ordered options with observable conditions, and states its hard limits. A
sequence is run in full; a fork is entered at the matching condition.

## Scope and Neighbors

- This document designs repositories for aggregate roots on the write side.
- Use `aggregate-design.md` to decide aggregate boundaries, invariants,
  lifecycle, and reconstitution behavior.
- Use `use-case-design.md` to decide transaction scope, idempotency, side-effect
  timing, and application outcomes.
- Use `error-management-design.md` for port error protocols, stable error codes,
  safe details, and result-vs-exception decisions.
- This document uses Ports and Adapters terms for repository boundaries: the
  repository interface is a driven port, and its implementation is a driven
  adapter.
- Use `domain-event-design.md` for event persistence, outbox, publication, and
  handler timing.
- Use read models, projections, or query services for reporting, search, and
  display-only reads. A write-side repository is not a general query API.

## Contents

- Core rule
- Part 1 - Principles
  - Repository purpose
  - Driven port and adapter
  - Aggregate scope
  - Repository style
  - Interface shape
  - Public interface return contract
  - Reconstitution and mapping
  - Transaction ownership
  - Unit of work and transaction manager
  - Concurrency and locking
  - Domain events and outbox
  - Query separation
  - Deletion and lifecycle
- Part 2 - Decision procedures
  - Qualification
  - Repository scope
  - Repository style
  - Interface design
  - Return type decision
  - Transaction boundary
  - Unit of work
  - Transaction manager
  - Concurrency strategy
  - Query routing
  - Persistence mapping
  - Delete behavior
- Result notation
- Smell checks
- Expected output

## Core Rule

A repository is a collection-like abstraction for aggregate roots. It loads and
saves whole aggregates through their root, hides persistence mechanics, and
participates in the transaction chosen by the use case, unit of work, or
transaction manager. It does not own business rules, does not expose arbitrary
database queries, and does not define transaction scope by itself.

Default: one repository per aggregate root on the write side. Deviate only when
a simpler persistence boundary is explicitly chosen and does not create child
entity repositories, generic CRUD services, or hidden cross-aggregate
transactions.

## Part 1 - Principles

### Repository Purpose

- A repository gives the application layer a collection-like way to retrieve and
  persist aggregate roots.
- It expresses domain-relevant access to aggregate roots, not table access.
- It hides persistence details: SQL, ORM sessions, query builders, document
  stores, indexes, serialization, and connection handling.
- It returns aggregate roots or persistence outcomes, not ORM entities, rows, or
  transport DTOs.
- It must not contain domain decisions. The aggregate decides; the repository
  persists.

### Driven Port and Adapter

- The repository interface is a driven (secondary) port: the domain or
  application layer owns and declares it, and infrastructure implements it. This
  is dependency inversion; the port is declared where it is used, not where it
  is implemented.
- The concrete repository is a driven adapter: it holds the ORM, SQL, mapper,
  document client, event-store client, connection handling, and persistence
  mechanics behind the port.
- This settles interface ownership. The interface belongs to the domain or
  application side; the implementation belongs to infrastructure.
- A use case sits behind a driving (primary) port and depends on the repository
  port, never on the adapter. This is what lets a use case be tested against an
  in-memory fake.

### Aggregate Scope

- Repository boundaries follow aggregate roots, not entities, value objects,
  tables, or screens.
- Child entities and value objects are persisted only through their aggregate
  root.
- If a child needs independent loading, saving, or lifecycle, recheck whether it
  is actually a separate aggregate.
- Reference data, projections, and read models do not need aggregate
  repositories.
- Cross-aggregate access in one repository is a smell unless it is explicitly a
  persistence helper under a use-case transaction and not exposed as a domain
  collection.

### Repository Style

Two repository styles exist, and the choice shapes the whole interface. Choose it
by the persistence mechanism, and state it; it decides whether a `save` or
`update` method exists at all.

- **Collection-oriented**: the repository mimics an in-memory set. You `add` a
  new aggregate once; changes to an already-loaded aggregate are persisted
  transparently at commit through the store's change tracking and unit of work.
  There is no `save` or `update` method. Mutating the loaded aggregate is enough.
  This suits a relational store with an ORM identity map and change tracking.
- **Persistence-oriented**: you call `save` explicitly on every mutation because
  the store has no transparent tracking. This suits document stores, key-value
  stores, event stores, or a domain deliberately decoupled from an ORM.
- **Identity map**: within one unit of work, loading the same aggregate twice
  must return the same instance or a controlled equivalent. A
  collection-oriented repository backed by an ORM identity map gets this for
  free. A persistence-oriented repository must guard it with an application-level
  identity map or the discipline of loading each aggregate once per use case.
  Two loaded copies of one aggregate in one transaction is a lost update, or
  under optimistic versioning a self-inflicted conflict.
- **Test-double payoff**: the collection abstraction makes an in-memory fake
  repository trivial, which keeps use-case tests free of a database. A
  persistence-oriented repository is still fakeable, but the fake must reproduce
  explicit-save semantics rather than commit-time flush.

### Interface Shape

- Keep repository interfaces small and use-case driven.
- Prefer intent-revealing methods:
  `getById`, `save`, `add`, `remove`, `findByBookingNumber`,
  `existsByEmail`, `nextIdentity`. Which of `add` and `save` exist follows from
  *Repository Style*.
- Avoid generic CRUD interfaces such as `updatePartial`, `deleteWhere`,
  `findAll`, or `query` on write-side repositories.
- When a command genuinely needs flexible or variable selection criteria to
  locate an aggregate, express them as a Specification, such as
  `findSatisfying(spec)`, rather than leaking a query builder or ORM criteria
  object. The Specification keeps criteria in domain language and query
  mechanics in the adapter.
- Use `get` when absence is exceptional for the use case; use `find` when
  absence is an expected branch. This is a contract, not just naming: a `get`
  method never returns null or undefined; it returns the aggregate or fails. A
  `find` method makes absence explicit in its signature, as a nullable type,
  option, or result. A `get` that quietly returns null and a `find` that throws
  on ordinary absence both lie about their contract.
- Return domain-level absence or conflict outcomes, not persistence exceptions as
  normal control flow.
- Do not expose a query builder or ORM criteria object from the repository
  interface.

### Public Interface Return Contract

- Write-side repository load methods return aggregate roots or an explicit
  absence/result type. They do not return child entities, value objects, ORM
  entities, rows, DTOs, or projections as independent records.
- Alternate lookup methods used by commands still return the aggregate root or
  absence, not the field or child object that happened to match.
- `add`, `save`, and `remove` return `void`, a saved version, or an explicit
  persistence outcome such as saved/conflict. They should not return ORM-managed
  state or a partially updated record.
- Support methods may return simple values when they are not aggregate loads:
  `existsBy...` returns a boolean, `nextIdentity` returns a typed aggregate id,
  and conflict checks may return a domain-level outcome.
- Split failures by class. Expected outcomes the use case branches on, such as
  absence, stale-write conflict, or a uniqueness conflict from a set-invariant
  constraint, are typed in the port contract, as return values or deliberately
  mapped typed errors. Expected infrastructure failures that callers can react
  to, such as storage unavailable or timeout, are port errors. Raw driver
  exceptions stay inside the adapter and are mapped before crossing the port.
  Defects still propagate as exceptions.
- Value objects and typed ids may appear as method parameters or simple return
  values, but they are not loaded as repository roots.
- If a caller needs a child entity, load the aggregate root and ask the root for
  behavior or state through its public API. If callers repeatedly need the child
  independently, recheck whether that child is actually an aggregate root.
- Read-side query services or read-model repositories may return DTOs,
  projections, and denormalized records. Name them as read-side components, not
  write-side domain repositories.

### Reconstitution and Mapping

- Reconstitution restores persisted aggregate state. It is not business
  creation and records no new domain events.
- The repository may call an aggregate reconstitution method such as
  `reconstitute`, `fromSnapshot`, or `fromPersistence`.
- Mapping belongs in the repository implementation or persistence adapter, not
  in the aggregate behavior.
- The mapper may reject corrupted persisted state defensively.
- Do not use public business constructors or factories to load existing
  persisted aggregates when doing so would re-run creation rules or record new
  facts.
- Do not leak ORM tracking proxies into the domain model. The aggregate should
  not depend on lazy loading, open sessions, or persistence annotations to be
  valid.

### Transaction Ownership

- Default: the use case, unit of work, or transaction manager owns the
  transaction boundary.
- A repository participates in the current transaction; it should not secretly
  start, commit, or roll back a broader business transaction.
- A repository method may perform one atomic persistence operation internally,
  but it must not decide the full use-case transaction scope.
- If aggregate changes and domain events must be persisted atomically, the
  transaction owner coordinates repository save and event/outbox persistence in
  the same transaction.
- Do not let each repository commit independently inside one use case. That
  creates partial success without a named process, compensation, or repair path.

Deviation note - simple applications. For a small application where a command
always loads and saves one aggregate and has no outbox, no idempotency store, and
no multi-repository work, a repository `save` may commit its own transaction as a
deliberate simplification. Once the use case needs multiple writes, outbox,
idempotency, or reliable side effects, move transaction ownership to a unit of
work or transaction manager.

### Unit of Work and Transaction Manager

- A unit of work groups persistence changes that must commit or roll back
  together.
- A transaction manager starts, commits, and rolls back the underlying
  transaction. It usually exposes a callback or scope such as
  `transactionManager.run(work)`.
- The application use case decides when to enter the transaction scope.
- Repositories are either bound to the active transaction or receive a
  transaction context from the unit of work.
- Do not pass raw database transactions into aggregates, entities, or value
  objects.
- Keep infrastructure transaction handles out of domain APIs. If a transaction
  context must be passed, pass it through application/infrastructure boundaries,
  not through domain behavior.
- The unit of work may also coordinate idempotency records, optimistic versions,
  domain event persistence, and outbox writes.

### Concurrency and Locking

- Repositories must support the aggregate's stale-write protection strategy.
- Optimistic concurrency is the default for ordinary aggregate updates: save with
  an expected version and fail on mismatch.
- Pessimistic locking is a first-class option for hot aggregates, set-based
  allocation, or short critical sections under high contention. Lock acquisition
  belongs inside the transaction scope.
- A stale write should surface as an application conflict or stale-write outcome,
  not as an unclassified persistence failure.
- Do not hide lost updates by last-write-wins unless the business explicitly
  accepts it.
- When using ORM change tracking, still make the aggregate version or lock rule
  explicit in the repository contract or save semantics.

### Domain Events and Outbox

- Repositories may collect recorded domain events from aggregate roots, but they
  do not publish external messages directly.
- How recorded events are collected is a position, not a law: the repository may
  pull them from the root on save; the unit of work may collect them across all
  participating roots; or the aggregate may publish through an in-process
  dispatcher or mediator at save time. Pick one and apply it consistently. All
  three keep external publication after commit and out of aggregate behavior.
- Persist aggregate state and recorded events atomically when events drive
  reliable downstream work.
- Publish integration events or external messages after commit, usually via an
  outbox dispatcher.
- The outbox is an application or infrastructure concern coordinated by the unit
  of work or transaction manager, not aggregate behavior.
- Reconstituted aggregates start clean and should not expose historical events
  as newly recorded events.

### Query Separation

- Write-side repositories retrieve aggregate roots for commands and domain
  decisions.
- Reads for display, reporting, search, filtering, pagination, and dashboards
  use read models, projections, or query services; use
  `read-model-design.md` for read-shape, freshness, projection, and rebuild
  design.
- The strict split - display reads always go to read models - is the CQRS
  position, and this document defaults to it. In a non-CQRS codebase,
  domain-meaningful queries on a write-side repository, expressed as
  intent-revealing methods or Specifications, are legitimate. What stays
  forbidden in either position is leaking a query builder or growing the
  repository into reporting infrastructure. State which position the codebase
  takes.
- A repository may have lookup methods needed to locate an aggregate for a
  command, such as `findByBookingNumber`, but should not grow into reporting
  infrastructure.
- If a command needs only display data, do not load an aggregate. Use a query
  service.
- If a command uses a read model to enforce an invariant, recheck the aggregate
  boundary or use a guarded consistency mechanism.

### Deletion and Lifecycle

- Repository deletion is persistence cleanup, not automatically a business
  decision.
- Business deletion should usually be modeled as aggregate behavior and explicit
  lifecycle state: cancelled, archived, closed, deleted, revoked.
- Physical deletion, anonymization, or crypto-shredding may be required for
  retention or privacy, but it is a separate persistence concern.
- Do not allow repository `delete` to bypass aggregate lifecycle rules when the
  deletion has business meaning.

## Part 2 - Decision Procedures

### Qualification - fork

Discriminator: is this a repository concern?

1. **The code loads or saves an aggregate root for command handling** ->
   repository. Continue.
2. **The code returns display/search/reporting data** -> query service, read
   model, or projection. Not a write-side repository.
3. **The code coordinates transaction boundaries across repositories, outbox, or
   idempotency records** -> unit of work or transaction manager.
4. **The code enforces business rules** -> aggregate, entity, value object, or
   domain service.
5. **The code maps persistence rows/documents to domain objects** -> repository
   implementation or persistence mapper.

Hard limits: do not create repositories for child entities or value objects. Do
not call a generic DAO a domain repository merely because it accesses tables.

### Repository Scope - fork

Discriminator: what is the persistence collection?

1. **Aggregate root with independent lifecycle and invariants** -> repository
   candidate.
2. **Child entity inside an aggregate** -> persist through the root repository.
3. **Value object** -> persist as part of its owner; no repository.
4. **Reference data or read-only catalog** -> query service or reference-data
   port unless it is itself a modeled aggregate.
5. **Projection/read model** -> query repository or read-model accessor, not a
   domain repository.

Hard limits: one repository per table is usually a storage leak. One repository
per entity is wrong when the entity is not an aggregate root.

### Repository Style - fork

Discriminator: does the persistence mechanism track changes to loaded aggregates
transparently?

1. **ORM or session with change tracking and an identity map, one relational
   store** -> collection-oriented. Use `add` for new aggregates only; no `save`
   or `update`. Mutations to a loaded aggregate persist at commit. Loading the
   same aggregate twice returns the same instance.
2. **Document store, key-value store, event store, or ORM-decoupled domain with
   no transparent tracking** -> persistence-oriented. Use explicit `save` on
   every mutation; guard the identity map yourself, or load each aggregate once
   per use case.
3. **Mixed or migrating** -> pick per repository and state it. Do not leave
   `add`/`save` semantics implicit.

Hard limits: in collection-oriented style a `save` or `update` method is a smell
because it signals leaked persistence thinking. In persistence-oriented style, a
forgotten explicit `save` silently loses the change. Either way, resolve the
identity-map question: two loaded copies of one aggregate in one transaction is
a lost update, or under optimistic versioning a self-inflicted conflict.

### Interface Design - sequence

Goal: shape the repository API around aggregate persistence.

1. Name the repository after the aggregate root collection:
   `BookingRepository`, `SessionRepository`, `InvoiceRepository`.
2. Add identity lookup: `getById` or `findById`.
3. Add only domain-relevant alternate lookups needed by command use cases; use a
   Specification for flexible or variable criteria instead of a query builder.
4. Add write methods according to *Repository Style* and lifecycle semantics:
   - collection-oriented: `add` for new aggregates only, no `save` or `update`;
   - persistence-oriented: `save`, or `add` and `save` split when duplicate
     create vs update must be distinguished.
5. Add concurrency expectation if stale writes matter:
   expected version, loaded version, lock token, or repository-managed version.
6. Return explicit absence/conflict outcomes where they are expected.
7. For every public method, classify the return type using *Return Type
   Decision*.

Hard limits: do not expose ORM sessions, query builders, table names, or
arbitrary predicates from the write-side repository interface.

### Return Type Decision - fork

Discriminator: what does this public repository method conceptually return?

1. **Loads persisted domain state for a command** -> aggregate root or explicit
   absence/result type.
2. **Checks whether a command may proceed without loading the aggregate** ->
   boolean, typed id, or domain-level conflict/availability outcome.
3. **Allocates or supplies an aggregate identity** -> typed aggregate id.
4. **Persists an aggregate** -> `void`, saved version, or explicit
   saved/conflict outcome.
5. **Returns child entity, value object, DTO, projection, row, or ORM object** ->
   not a write-side repository return. Use aggregate API, read model/query
   service, mapper, or recheck aggregate boundaries.

Hard limits: a repository public interface must not make child entities or value
objects independently loadable. Returning a value object as `nextIdentity` or a
simple domain outcome is fine; returning value objects as queried records is a
read-model/query concern.

### Transaction Boundary - fork

Discriminator: who owns commit and rollback for the use case?

1. **One aggregate, no outbox, no idempotency store, no other writes** ->
   repository-local transaction may be acceptable as a deliberate simplification.
2. **One aggregate plus recorded events/outbox/idempotency record** -> use-case
   transaction through a unit of work or transaction manager.
3. **Multiple repositories in one bounded context** -> explicit unit of work or
   transaction manager. Recheck the aggregate boundary before accepting.
4. **Cross-bounded-context writes** -> do not use one database transaction; use
   events, context coordination, process manager, or saga.
5. **Long-running work** -> saga/process manager, not a repository transaction.

Hard limits: repositories must not each commit independently inside a business
command. A transaction manager must not be passed into domain objects.

### Unit of Work - sequence

Goal: define what commits atomically.

1. Name the use case that owns the unit of work.
2. List aggregate repositories participating in the transaction.
3. List non-aggregate persistence that must commit with them:
   idempotency record, outbox messages, audit record, process state.
4. Define whether repositories are explicitly called with a transaction context
   or resolved as transaction-bound instances.
5. Define commit behavior and rollback behavior.
6. Define how domain events are collected and persisted.
7. Define how conflicts surface to the use case.

Hard limits: a unit of work is not a place for business decisions. It coordinates
persistence, not domain rules.

### Transaction Manager - sequence

Goal: make transaction ownership explicit without leaking infrastructure inward.

1. Define the application-facing transaction API, such as
   `transactionManager.run(work)`.
2. Inside the transaction scope, provide repositories, unit of work, or
   transaction context to the application layer.
3. Keep raw connection/session/transaction objects inside infrastructure
   adapters.
4. Persist aggregate changes and outbox/event records before commit.
5. Publish external messages only after commit.
6. Map rollback, deadlock, timeout, and serialization failure to application
   outcomes or retries according to `use-case-design.md`.

Hard limits: do not start a transaction in one repository and expect another
repository to accidentally join it. Do not publish messages from inside the
transaction manager before commit.

### Concurrency Strategy - fork

Discriminator: what prevents stale writes or invalid interleavings?

1. **Low to moderate contention, ordinary aggregate update** -> optimistic
   concurrency with expected version.
2. **Hot aggregate or short critical section under high contention** ->
   pessimistic lock inside the transaction.
3. **Single stream/partition owns all writes for the aggregate** ->
   single-writer partitioning.
4. **Set-based invariant guarded by database constraint** -> repository maps
   constraint violation to domain/application conflict.
5. **No business impact from last write wins** -> document last-write-wins as an
   explicit business trade-off.

Hard limits: do not silently overwrite concurrent changes. Do not use a stale
read model as stale-write protection.

### Query Routing - fork

Discriminator: why is the data being loaded?

1. **To make a command decision on an aggregate** -> write-side repository.
2. **To display a page, list, report, or dashboard** -> read model/query service.
3. **To check existence for a uniqueness-like policy** -> prefer aggregate/set
   boundary or database constraint; map race-safe conflicts explicitly.
4. **To join across contexts** -> context coordination read composition or
   projection.
5. **To inspect persistence for operations/support** -> operational query, not
   domain repository.

Hard limits: query convenience must not enlarge aggregate boundaries or turn the
write repository into a reporting API.

### Persistence Mapping - sequence

Goal: map stored state without contaminating the model.

1. Define the persistence representation: row, document, event stream, or
   snapshot.
2. Map persistence identifiers to typed domain ids.
3. Rebuild value objects through their constructors or reconstitution paths so
   constraints still hold.
4. Rebuild entities with stable identity.
5. Reconstitute the aggregate root without recording new domain events.
6. Track version or lock token for the next save.
7. Reject corrupted persisted state or surface an operational repair path.

Hard limits: do not bypass value-object constraints during reconstitution unless
there is a separate corruption-detection path. Do not let ORM lazy loading
decide aggregate boundaries.

### Delete Behavior - fork

Discriminator: what does deletion mean?

1. **Business cancellation/closure/revocation** -> aggregate behavior and
   lifecycle state, then repository save.
2. **Physical cleanup after lifecycle end** -> repository or infrastructure job,
   governed by retention policy.
3. **Privacy erasure** -> anonymization, physical deletion, or crypto-shredding
   as a separate persistence concern.
4. **Accidental or administrative repair** -> operational process with audit,
   not ordinary domain repository behavior.

Hard limits: repository `delete` must not bypass business lifecycle decisions.
If later decisions, audit, or events depend on the fact, model the state instead
of erasing it.

## Result Notation

Use this compact notation when summarizing the design:

`RepositoryName | aggregate root | style | transaction owner | concurrency | events`

Repository table:

| Field | Decision |
| ----- | -------- |
| Aggregate root | Root name |
| Port ownership | Domain/application driven port; infrastructure adapter |
| Style | Collection-oriented or persistence-oriented; identity-map handling |
| Methods | get/find/add/save/remove, Specification lookups |
| Return contract | Aggregate roots, absence/results, versions, typed ids |
| Reconstitution | Method and mapper |
| Transaction owner | Repository, unit of work, transaction manager |
| Unit of work | Participating repositories and outbox/idempotency records |
| Concurrency | Optimistic, pessimistic, single-writer, constraint |
| Events | Collect (repository/unit of work/dispatcher), persist, outbox, publish after commit |
| Queries | Repository lookups vs read-model/query-service split; CQRS position |

## Smell Checks

- Repository exists for every table or entity instead of every aggregate root.
- Repository returns ORM entities, rows, query builders, or transport DTOs.
- Repository load methods return child entities or value objects as independent
  records instead of aggregate roots.
- Repository exposes arbitrary `findAll`, `where`, or `query` methods on the
  write side.
- A write repository leaks a query builder where a Specification would express
  the criteria.
- A `get` method returns null or undefined for absence, or a `find` method
  throws on ordinary absence.
- Child entities or value objects have their own repositories.
- A collection-oriented repository exposes a `save` or `update` method.
- A persistence-oriented repository relies on change tracking the store does not
  provide, so mutations are silently lost.
- Two copies of one aggregate are loaded in one transaction because there is no
  identity map.
- Use case uses several repositories that each commit independently.
- Transaction boundary is hidden inside repositories while the use case also
  needs outbox, idempotency, or multiple writes.
- Raw database transaction/session leaks into aggregates or entities.
- The repository interface is owned by infrastructure instead of the
  domain/application layer.
- Repository save silently overwrites concurrent changes.
- Reconstitution calls business creation and records new domain events.
- Repository publishes integration events before commit.
- Read/reporting requirements bloat the aggregate repository.
- Repository enforces business invariants that belong in the aggregate.
- Repository deletion bypasses lifecycle rules.
- ORM lazy loading determines what is inside the aggregate.

## Expected Output

When designing a repository, emit:

- Aggregate root and repository name.
- Port ownership: driven port on the domain/application side, adapter in
  infrastructure.
- Repository style: collection-oriented or persistence-oriented, and identity-map
  handling.
- Repository methods and absence/conflict behavior, including any Specification
  lookups.
- Public return contract for each method: aggregate root, absence/result,
  version, typed id, boolean, or persistence outcome.
- Reconstitution and persistence mapping strategy.
- Transaction owner: repository-local, unit of work, or transaction manager.
- Unit-of-work participants: repositories, idempotency, outbox, audit, process
  state.
- Concurrency and stale-write protection.
- Domain event/outbox handling and where events are collected.
- Query separation: repository lookups vs read models/query services, and the
  CQRS position taken.
- Delete/lifecycle behavior.
- Smell-check findings and unresolved persistence questions.
