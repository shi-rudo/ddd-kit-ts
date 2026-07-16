# Domain Service Design

Use domain service design when a piece of stateless domain logic is a business
decision but belongs to no single entity or value object, often because it needs
several domain objects to decide. A domain service is a last resort, reached only
after an aggregate, entity, value object, or specification cannot own the logic.

This reference has two parts. Part 1 - Principles are invariants: they always
hold, no choice involved. Part 2 - Decision procedures are forks and sequences
resolved per candidate service. Each names its discriminator, gives ordered
options with observable conditions, and states its hard limits. A sequence is run
in full; a fork is entered at the matching condition.

## Scope and Neighbors

- This document designs a domain service: stateless domain logic in the domain
  layer that no single entity or value object naturally owns.
- Use this only on the domain-model path from
  `business-logic-pattern-selection.md`. A transaction-script subdomain uses
  services differently and is not the subject here.
- Try the richer options first. `aggregate-design.md`, `entity-design.md`, and
  `value-object-design.md` own most logic; a domain service is what remains when
  they genuinely cannot.
- Distinguish it from the use case (application service) in
  `use-case-design.md`: the use case orchestrates, manages transactions and
  authorization, maps DTOs, and holds no business rule; the domain service holds
  a business decision and no orchestration.
- Use `error-management-design.md` for how a domain service surfaces expected
  business rejections and defects.

## Contents

- Core rule
- Part 1 - Principles
  - What a domain service is
  - A domain service is a last resort
  - Domain logic, not orchestration
  - Works with domain objects
  - Cross-aggregate limits
  - Dependencies and staleness
  - Isolation
- Part 2 - Decision procedures
  - Qualification
  - Boundary and naming
  - Dependencies
  - Placement
- Result notation
- Smell checks
- Expected output

## Core Rule

A domain service holds a stateless domain decision that belongs to the domain
model but not to one aggregate, entity, value object, or specification. It is
named in ubiquitous language, works with domain objects rather than DTOs, lives
in the domain layer, and holds no state, transactions, I/O orchestration,
application authorization, or mapping concern. Prefer richer domain objects
first; a domain service is what is left when none of them fit.

## Part 1 - Principles

### What a Domain Service Is

Evans' three criteria, all required:

- The operation relates to a domain concept that is not a natural responsibility
  of a single entity or value object.
- Its interface is defined in terms of domain-model elements: it takes and
  returns entities, value objects, and domain results, not DTOs or primitive
  bags.
- It is stateless. Each call stands alone; the service holds no per-instance
  state between calls.

The service and operation are named in ubiquitous language. They are terms domain
experts can discuss, not technical verbs.

### A Domain Service Is a Last Resort

- Domain services are the most overused tactical building block. Reaching for one
  by default strips entities and value objects of their behavior and produces an
  anemic domain model.
- Attribute as much logic as possible to the aggregate, entity, or value object
  that owns the state. Extract a service only when the logic genuinely belongs to
  no single object.
- A codebase heavy with domain services and thin on aggregate behavior is a
  smell, not an architecture.
- The same restraint governs every extracted object: do not mint a policy,
  strategy, or specification for a single small condition. A rule that is
  local, small, and stable stays a private method on the aggregate or entity
  that owns it; the extraction gate lives in `tactical-patterns.md`,
  *Specification*.

### Domain Logic, Not Orchestration

- A domain service holds a business decision: what is allowed, what results, or
  what the rule computes. It does not orchestrate a use case, manage
  transactions, check application authorization, map DTOs, publish messages, or
  perform persistence.
- Keep side effects out. A domain service decides; the use case performs the
  persistence, messaging, and I/O that follow.
- The domain layer holds decisions; the application layer holds orchestration. A
  service that crosses into orchestration is a use case wearing a domain name.

### Works With Domain Objects

- A domain service takes and returns entities, value objects, and domain results.
  It never takes or returns DTOs; translation is the use case's job.
- The presentation layer does not call a domain service directly. The usual
  caller is a use case. Other domain services may call it when the decision stays
  inside the domain model.
- Domain objects should not grow hidden service dependencies. If an aggregate or
  entity needs a policy/service for one decision, pass it deliberately as a
  transient argument and keep the call explicit.
- A domain service reaches other aggregates only through their public behavior,
  never into their internals.
- Passing one aggregate into another aggregate's method, or into a domain
  service, as a transient argument is not the same as holding a reference to it.
  Persisted relationships between aggregates stay by typed identity, per
  `aggregate-design.md`.
- Prefer passing a snapshot or value object over a whole aggregate when that
  expresses what the decision actually needs.

### Cross-Aggregate Limits

- A domain service may make a domain decision using several aggregates, but it
  does not mutate several aggregates as one hidden transaction.
- A domain service is not a saga, process manager, or cross-context coordinator.
  If the work spans time, retries, compensation, or several bounded contexts, use
  `context-coordination.md` and `saga-design.md`.
- Do not move aggregate invariants into a service. If an invariant must be
  protected immediately, it belongs inside the mutating aggregate boundary or a
  guarded set-level consistency mechanism, not in a free-floating service.

### Dependencies and Staleness

- Default to no dependencies. The use case loads the required domain objects,
  values, snapshots, or policies and passes them in.
- A domain service may depend on a domain-expressed read-only port only when the
  lookup is part of the domain language, such as a rate table, risk policy, or
  eligibility policy. The port must be stated in domain terms and injected by the
  application.
- Treat such ports as policy providers, not persistence shortcuts. A domain
  service that loads aggregates from repositories, calls another context, or
  performs remote I/O is usually a use case in disguise.
- A transient snapshot may inform a decision, but hard invariants are enforced
  against state inside the mutating aggregate or a guarded set-level mechanism,
  never against a stale snapshot or external read model.
- If the decision cannot tolerate stale data from an external source, change the
  boundary, add a guarded consistency mechanism, or move the orchestration to a
  use case/process. Do not hide the risk inside the domain service.

### Isolation

- A second reason to extract a domain service, beyond "no single owner", is to
  keep domain logic inside the domain boundary rather than letting it leak into
  the use case.
- Moving a decision out of the use case and into a domain service makes it more
  testable and keeps the domain's knowledge in one place. Keep the extracted
  service minimal: give it only what the decision needs.
- The *Qualification* gate still applies to the rescued logic: if an aggregate,
  entity, or value object can own it, it goes there; the domain service takes
  only the remainder. Isolation justifies moving the decision into the domain
  layer, not skipping the richer owners.

## Part 2 - Decision Procedures

### Qualification - fork

The last-resort gate. Discriminator: can the logic live somewhere richer than a
service?

1. **One aggregate or entity can decide it from its own state** -> put it on that
   aggregate or entity. Not a domain service.
2. **A value object can express the rule or computation** (money, date range,
   percentage, pricing policy) -> model it as a value object with behavior. Not a
   domain service.
3. **The logic selects or matches against criteria** -> use a specification
   (see *Specification* in `tactical-patterns.md`; `repository-design.md` covers
   specifications as repository lookup criteria). Not a service by default.
4. **One aggregate needs another's data to decide, and the decision is naturally
   that one aggregate's** -> pass the other aggregate, or preferably a snapshot
   or value object derived from it, transiently into the deciding aggregate's
   method, read-only. This is a parameter, not a stored reference. Not a domain
   service.
5. **The decision belongs to no single aggregate, or to several equally** -> use
   a domain service that takes the needed domain objects, snapshots, or value
   objects and decides. Continue.
6. **The logic orchestrates, manages transactions, maps DTOs, performs I/O, or
   mutates several aggregates as one workflow** -> application service, process
   manager, or saga, not a domain service.

Options 4 and 5 are a spectrum, not a hard line. The more the decision has a
natural owner among the aggregates, the more it belongs on that owner. The more
it belongs to none of them or to all of them equally, the more it is a domain
service. In either case prefer passing a snapshot or value object over a whole
aggregate, so the collaborator depends on a value, not another aggregate's type.

Hard limits: do not create a domain service to hold logic an aggregate could own;
that is the anemic-model trap. Do not create one to orchestrate a use case. When
an aggregate or service receives another aggregate to decide, that aggregate is a
transient read-only parameter; it must not be stored as a reference or mutated.
A technical computation with no domain decision, such as graph traversal, a
constraint solver, or allocation math, is a cohesive mechanism behind an
intention-revealing interface (see `core-domain-distillation.md`), not a domain
service: the service holds a domain decision, the mechanism holds a "how".

### Boundary and Naming - sequence

Goal: name the service and fix its boundary.

1. Name the decision in ubiquitous language. The service and operation are domain
   terms, such as `PricingPolicy.priceFor`, `EligibilityPolicy.canEnroll`, or
   `RiskAssessment.assess`.
2. Define the operation signature in domain objects: which entities and value
   objects go in, which entity, value object, or domain result comes out.
3. State the domain rule it decides and the invariant or policy it enforces.
4. Name the aggregates it touches, and confirm none could own the decision alone.
   If one could, return to *Qualification*.
5. Confirm it is stateless and holds no application concern.

Hard limit: a service named with a bare technical word such as `Manager`,
`Helper`, `Processor`, or a `Calculator` with no domain meaning has probably not
found its domain concept; keep looking for the ubiquitous-language name.

### Dependencies - fork

Discriminator: what does the service need in order to decide?

1. **Only the domain objects passed in** -> take them as parameters; no
   dependencies. This is the cleanest and most testable path.
2. **A domain-expressed policy lookup** -> prefer that the use case loads the
   value, snapshot, or policy and passes it in. If the lookup itself is part of
   the domain language, depend on a read-only port stated in domain terms.
3. **Persistence, messaging, transactions, another context's API, or remote I/O**
   -> this is orchestration. Move it to the use case or a process coordinator.

Hard limits: a domain service that loads aggregates from a repository to decide
is usually a use case in disguise. A domain service never performs the side
effects that follow its decision. A hard invariant must not depend on a stale
read model, cache, snapshot, or external query.

### Placement - fork

Discriminator: whose responsibility is this - a domain object, the domain layer,
or the application layer?

1. **Decidable from one object's own state** -> aggregate, entity, or value-object
   behavior.
2. **A stateless domain decision across objects, no I/O** -> domain service, in
   the domain layer.
3. **Orchestration, transactions, authorization, DTO mapping, side-effect timing,
   or cross-context coordination** -> application service, process manager, or
   saga.

Hard limits: the domain layer holds decisions, the application layer holds
orchestration. A domain service that creeps into orchestration, or a use case
that creeps into domain decisions, has crossed the line; move it back.

## Result Notation

Use this compact notation when summarizing a domain service:

`ServiceName.operation | aggregates spanned | in -> out | dependencies | stateless`

Service table:

| Field | Decision |
| ----- | -------- |
| Name | Service and operation in ubiquitous language |
| Decision | The business rule or computation it owns |
| Signature | Domain objects in, domain object or result out |
| Aggregates | Which it spans, and why none owns it alone |
| Dependencies | None, passed-in value/snapshot/policy, or domain-expressed read-only port |
| Staleness | Whether inputs can be stale, and why that is acceptable |
| Stateless | Confirmed; no per-call state retained |
| Not this | Orchestration, transactions, authz, DTO mapping, I/O, cross-context coordination |

## Smell Checks

- A domain service holds logic an aggregate or entity could own.
- Entities and value objects are data containers while services hold all the
  behavior.
- A domain service is named `Manager`, `Helper`, or `Processor` with no domain
  meaning.
- A value object or specification would express the rule, but a service was used.
- A policy, strategy, or specification object exists for a single small, stable
  condition that a private method on its owner could express.
- A cohesive mechanism (a technical computation) is dressed up as a domain
  service, or a domain decision is buried inside a mechanism
  (`core-domain-distillation.md`).
- A domain service takes or returns DTOs instead of domain objects.
- A domain service holds state between calls.
- A domain service loads aggregates from a repository and performs the side
  effects itself.
- A domain service manages transactions, checks application authorization, maps
  DTOs, publishes messages, or performs I/O.
- The presentation layer calls a domain service directly.
- A "domain service" is actually a use case wearing a domain name: it
  orchestrates rather than decides.
- A domain service reaches into another aggregate's internals instead of its
  public behavior.
- An aggregate passed into another method to decide is stored as a reference or
  mutated, instead of used read-only and transiently.
- A whole aggregate is passed where a snapshot or value object would express what
  the decision actually needs.
- A hard invariant is enforced against a stale snapshot, read model, cache, or
  external query.
- A domain service mutates several aggregates as one hidden transaction.
- A domain service is used where a saga, process manager, or context
  coordination pattern is needed.

## Expected Output

When designing a domain service, emit:

- The domain decision it holds, in ubiquitous language.
- The last-resort justification: why no single aggregate, entity, value object,
  or specification can own it, and why the deciding aggregate cannot receive a
  read-only value/snapshot instead.
- The operation signature in domain objects: what goes in, what comes out.
- The aggregates it uses, and whether they are read-only inputs.
- Its dependencies, if any, as passed-in values/snapshots/policies or
  domain-expressed read-only ports.
- Any staleness assumptions, and confirmation that hard invariants are not
  enforced against stale data.
- Confirmation that it is stateless and free of orchestration, transactions,
  authorization, DTO mapping, I/O, event publication, and cross-context
  coordination.
- The boundary split: what stays in the use case (orchestration and side effects)
  versus the service (the decision).
