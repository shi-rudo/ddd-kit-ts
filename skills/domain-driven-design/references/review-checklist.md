# Review Checklist

Use this checklist when reviewing a domain model, architecture proposal, or code
for DDD quality. Lead with concrete findings and evidence. Each section names
the reference document that owns its rules; on any doubt, the owner governs.
The sections after "Layering and Boundaries" apply only when the reviewed
design uses that path; skip them otherwise.

## Pattern Fit (gate, check first)

`business-logic-pattern-selection.md`

- Does the subdomain warrant a domain model at all, or is a transaction script
  or active record the proportionate pattern? Not every subdomain deserves a
  rich model.
- Is "anemic" judged path-aware? Anemic is a smell only on the domain-model
  path; data structures with logic in scripts or services are correct outside
  it.
- If event sourcing is used: is full business history genuinely the source of
  truth? An audit or history requirement alone never selects event sourcing.

## Strategic Fit

`bounded-context-design.md`, `core-domain-distillation.md`

- Are bounded contexts based on language and business capability, not tables,
  layers, or deployment topology?
- Are core, supporting, and generic subdomains distinguished, with the best
  effort spent on the core?
- Is the core explicit (vision statement, highlighted core), and protected from
  generic or legacy models?
- Is ownership of each context clear, one team per context?
- Are context relationships explicit (`context-mapping.md`)?
- Is concept ownership derived from expert language and validated recorded
  decisions, rather than from authoring workflow, persistence shape, or
  consumers?

## Language

`ubiquitous-language.md`

- Do type, method, event, and module names match domain language?
- Are overloaded terms scoped to their bounded contexts?
- Are technical names leaking into the domain model?
- Are important terms defined with rules and examples?

## Aggregates

`aggregate-design.md`

- Does each command protect a named invariant? A fact-recording command may
  honestly name only well-formed input and a valid resulting state; do not
  demand an invented rule, but an aggregate whose commands are all
  fact-recording needs reclassification.
- Is the aggregate root the only external mutation entry point?
- Does a transaction change one aggregate instance? Where several must change
  atomically, was the specification itself challenged first (missed invariant
  vs eventual consistency)?
- Are persisted references to other aggregates by identity? A whole aggregate
  passed transiently, read-only, into a decision is legitimate and not a
  violation.
- Are set-based invariants guarded by a database constraint, a bounded set
  aggregate, or a race-protected check, never by a factory or constructor?
- Are business creation and persistence reconstitution separate paths, with
  reconstitution recording no events and re-running no creation rules?
- Is there stale-write protection matched to contention (optimistic version,
  lock, single writer)?
- Are large or unbounded child collections avoided unless a hard invariant
  demands them?

## Tactical Patterns

`entity-design.md`, `value-object-design.md`, `domain-service-design.md`

- Are value objects used for constrained values, immutable and structurally
  compared, validating at construction?
- Are entities used only where identity and continuity matter, compared by
  identity only?
- Do domain services hold only decisions that no aggregate, entity, value
  object, or specification can own, stateless and free of orchestration? Is a
  technical computation kept as a cohesive mechanism rather than dressed up as
  a domain service?

## Domain Events

`domain-event-design.md`

- Are events named as business facts in past tense?
- Are events recorded only after the aggregate accepted the command and changed
  state, and never on a failed command?
- Are integration events and external messages published only after commit,
  through an outbox where delivery matters, and never raw domain events across
  a context boundary?
- Are post-commit and asynchronous handlers idempotent, and is ordering keyed
  per entity (never `occurredAt`, never global)?

## Application and Persistence

`use-case-design.md`, `repository-design.md`

- Do use cases orchestrate without owning domain rules, behind a driving port,
  depending on driven ports?
- Does the use case, unit of work, or transaction manager own the transaction,
  with no repository committing independently and no external calls inside the
  transaction?
- Do repositories load and save whole aggregate roots, with `get*` never
  returning null and `find*` making absence explicit in the signature?
- Are retryable commands idempotent (key plus fingerprint; duplicates replay
  the previous outcome or reject on mismatch)?

## Layering and Boundaries

`context-mapping.md`

- Is domain logic independent of UI, HTTP, database, and messaging details?
- Are infrastructure concerns adapted at the boundary?
- Do driven-port signatures speak the core's types: aggregates from
  repositories, core-owned value objects from gateways, with provider DTOs and
  rows translated inside the adapter, and DTOs returned only by read-side query
  services?
- Is the downstream's ingestion a justified choice: an ACL where models
  mismatch or the upstream drifts, deliberate direct adoption where the
  language fits and the downstream has a voice or a stable Published Language,
  and Conformist only as a documented, resigned decision?
- Is deployment topology treated as a correlate, never as the boundary or the
  reason for a pattern?

## If the Design Uses CQRS / Read Models

`read-model-design.md`

- Is a separate read model justified (not simple CRUD), one model per read
  shape, holding no invariants?
- Are projections idempotent and side-effect-free, with update and checkpoint
  committed atomically, and deletes/tombstones handled?
- Is eventual consistency designed (lag named, absorbed, or guarded with
  wait-for-version or a write-side fallback where a read needs freshness)?

## If the Design Uses Sagas / Cross-Context Workflows

`context-coordination.md`, `saga-design.md`

- Is the coordination pattern chosen by direction and need (never a saga for a
  one-call interaction, never durable coordination in the client)?
- Are steps classified compensatable, pivot, or retryable, with compensation as
  a business action and steps after the pivot retried forward, not compensated?
- Are isolation anomalies named and countered (semantic lock with a release on
  every terminal path, commutative updates, reread), and is there a manual
  repair path?

## Error Contracts

`error-management-design.md`

- Are expected failures typed values (or a declared mapped-exception standard),
  with defects thrown, stable codes in one schema, and no diagnostic
  message/stack/cause crossing a boundary?

## Findings Format

For each issue, report:

- Severity
- Evidence
- Why it matters for the domain model
- Suggested correction

If the model is sound, say that clearly and list any remaining uncertainty or
domain questions.
