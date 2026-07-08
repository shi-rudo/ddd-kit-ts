# Read Model Design

Use read model design when serving queries from a denormalized, precomputed view
separated from the write model: its read shape, how it is kept current, how its
freshness and eventual-consistency lag are handled, and how it is rebuilt.

This reference has two parts. Part 1 - Principles are invariants: they always
hold, no choice involved. Part 2 - Decision procedures are forks and sequences
resolved per read model. Each names its discriminator, gives ordered options with
observable conditions, and states its hard limits. A sequence is run in full; a
fork is entered at the matching condition.

## Scope and Neighbors

- This document designs the read side: read models, projections, their feeding
  strategy, consistency handling, rebuild, privacy handling, and read-side query
  rules.
- Whether to separate reads from writes at all is gated upstream:
  `business-logic-pattern-selection.md` routes to CQRS when multiple persistent
  models are needed, and `repository-design.md` (*Query Separation*) splits
  write-repository lookups from read models.
- Whether a cross-context read is a direct call, API composition, scatter-gather,
  or a materialized projection is decided in `context-coordination.md` (*Read
  Composition*). This document designs the projection once that choice lands on
  a read model.
- The events that feed a projection - payload, ordering, idempotency, delivery -
  are designed in `domain-event-design.md`.
- Query use cases that serve read models are thin; see `use-case-design.md`.
- The write side - aggregates, invariants, state transitions - is designed in
  `aggregate-design.md`, `entity-design.md`, `value-object-design.md`, and
  `repository-design.md`. The read side holds none of it.

## Contents

- Core rule
- Part 1 - Principles
  - The read side does not go through the domain model
  - A read model is per read shape
  - Separate from the write model
  - Eventual consistency is designed, not eliminated
  - Projection lag is a first-class operational concern
  - Projections are idempotent and side-effect-free
  - Rebuildable by construction
  - Privacy and erasure are part of the read model
- Part 2 - Decision procedures
  - Qualification
  - Read model shape
  - Feeding strategy
  - Consistency handling
  - Event source and contract
  - Projection mechanics
  - Rebuild strategy
- Result notation
- Smell checks
- Expected output

## Core Rule

A read model is a denormalized, precomputed view built and optimized for one
query, read shape, or screen. It holds no business invariants, no aggregates, and
no state transitions; the read side does not go through the domain model. It is
eventually consistent with the write side by default. That lag is a designed
property: named, bounded, visible where needed, and absorbed in the UX or guarded
by a freshness path. One read model per read shape is the default; do not reuse
the write model for reads.

## Part 1 - Principles

### The Read Side Does Not Go Through the Domain Model

- The read model holds no business invariants, no aggregates, and no state
  transitions. It reads precomputed data and returns DTOs or projections.
- It carries no write-side validation stack. The command side enforces rules; the
  read side reports.
- Read-side rules that do belong: authorization, tenant separation, privacy
  filtering, and display visibility are query-side concerns. "No business logic"
  does not mean "no access control".

### A Read Model Is Per Read Shape

- Default to a separate read model per screen, API, or query shape: a
  denormalized, precomputed view. Order list, order detail, and dashboard are
  separate models.
- Sharing one read model is acceptable only when shape, access pattern, freshness
  SLA, authorization rules, privacy treatment, and owner are genuinely identical.
- Do not build one generic table and join it differently per screen; that
  reintroduces the coupling and query cost CQRS removed.
- Design the read model from the query it serves backward, not from the write
  model forward.

### Separate From the Write Model

- The read model is a distinct model, not the write model reused. If a query
  handler uses the write aggregate, it is not the CQRS read side; it is a
  write-side lookup or indirection.
- CQRS is logical first: distinct read and write models may share one database.
  Physically separating stores is an escalation for scale, resilience, search, or
  ownership, not the definition of the pattern.
- CQRS and event sourcing are independent. A read model can be fed from
  state-based writes, an outbox, or an event store.

### Eventual Consistency Is Designed, Not Eliminated

- When the read model is fed asynchronously, it lags the write side. This lag is
  inherent to the pattern, not a bug.
- Do not pretend technology removes lag. Absorb it in the UX with optimistic
  updates, version numbers, processing status, keeping the user on the page,
  long-polling, or push.
- Where a read genuinely needs read-after-write freshness, choose a strategy that
  provides it: synchronous local update, wait-for-version, or a write-side
  fallback for that actor's own recent result.
- Name, per read, whether it tolerates lag or requires freshness. That answer
  drives the feeding and consistency choices.

### Projection Lag Is a First-Class Operational Concern

- Measure and document maximum projection lag: the distance between the latest
  authoritative write and the latest event, version, or cursor the projection has
  processed. Alert when it breaches the freshness SLA.
- Expose staleness to callers where it matters through a version, cursor, or
  as-of timestamp.
- Reconcile periodically: compare write-side counts, checksums, or sampled facts
  to read-side state and repair drift.
- For reads that must be fresh, define the compensating action: retry, wait for a
  version, return a processing state, or fall back to the write side.

### Projections Are Idempotent and Side-Effect-Free

- A projection handler must be idempotent: applying the same event twice must not
  double-count. Track a checkpoint, handled event ids, or source versions.
- The projection update and its checkpoint must commit atomically. If the update
  commits without the checkpoint, replay duplicates work; if the checkpoint
  commits without the update, events are lost.
- A projection handler produces no external side effects: no notifications, no
  external calls, no workflow triggers. Those fire again on rebuild. Side effects
  belong to the write side or a separate process, never a projection.
- Projection handlers must handle creates, updates, deletes, cancellations,
  corrections, and tombstones explicitly. Upsert-only handlers silently retain
  stale data.

### Rebuildable By Construction

- A read model is disposable and rebuildable: it can be dropped and reconstructed
  from its source (events, outbox, or write store). A projection bug is fixed by a
  rebuild, not by making the read model authoritative.
- Rebuild depends on idempotent, side-effect-free projection handlers and a clear
  source of truth.
- Rebuild is not privacy-neutral. Replaying old facts must still honor current
  erasure, retention, and anonymization rules.

### Privacy and Erasure Are Part of the Read Model

- Read models often duplicate PII. Classify copied fields, retention needs, and
  erasure/anonymization behavior at design time.
- A read model must be updated or rebuilt when PII is erased, anonymized, or
  crypto-shredded on the authoritative side.
- Do not rely on "it is only a projection" as a privacy exception. Projections
  are data stores and need the same access, retention, and deletion discipline.

## Part 2 - Decision Procedures

### Qualification - fork

Discriminator: does a separate read model earn its complexity?

1. **Simple CRUD or forms over data, with straightforward queries** -> no
   separate read model; query the write store directly. CQRS is overkill and you
   pay the sync cost with no benefit.
2. **The write repository can answer the query with an intent-revealing method
   needed for a command or domain decision** -> a write-side lookup, not a read
   model (`repository-design.md`, *Query Separation*).
3. **Read shapes differ sharply from the write model** - aggregations, search,
   denormalized views - or read/write asymmetry is high, or reads contend with
   writes on the store -> a read model.
4. **The read spans several bounded contexts** -> decide composition first in
   `context-coordination.md` (*Read Composition*). A materialized projection is
   one possible outcome and is designed here.

Hard limits: do not build a read model for simple CRUD. Do not reuse the write
aggregate as the read model; that is indirection, not CQRS.

### Read Model Shape - sequence

Goal: design the read model from the query backward.

1. Name the read shape: the screen, API, report, or query it serves.
2. List exactly the fields that shape needs: denormalized, prejoined,
   preaggregated, and already filtered where appropriate.
3. Design the store for that access pattern: table, document, search index,
   key-value view, cache, or materialized view.
4. Add read-side rules: authorization, tenant boundaries, visibility filters,
   privacy classification, and field-level redaction.
5. Keep one model per shape by default; share only when shape, access pattern,
   freshness SLA, authorization, privacy, and owner match.
6. Confirm it holds no invariant, no aggregate, and no state transition.

Hard limit: if the read model starts enforcing a business rule or holding write
state, it has crossed into the write side. Move that logic back.

### Feeding Strategy - fork

Discriminator: the freshness the read needs, the coupling you accept, and the
operational cost you can carry.

1. **On-demand from the authoritative write source** -> compute the view when
   queried. Fresh when computed directly from the write source, simple to start,
   but pays the cost per read.
2. **On-demand from a cache** -> low ceremony and fast reads, but freshness
   depends on explicit TTL, invalidation, or versioning. State the policy.
3. **Synchronous local projection** -> update the read model in the same
   transaction as the write. Use only inside one bounded context, with the same
   local store/transaction, and no external calls. Strong consistency, no lag,
   but tighter coupling and less CQRS independence.
4. **Asynchronous via outbox or events** -> a projection consumes events after
   commit and updates the read model. Eventually consistent, decoupled, scalable;
   the default at scale. Requires outbox/reliable delivery and idempotent
   projections (`domain-event-design.md`).

If unsure, consider in the order on-demand -> synchronous local -> asynchronous:
start simple, escalate when the need is proven.

Hard limits: do not reach for asynchronous projections before read volume, shape,
scale, autonomy, or cross-context needs justify them. Do not use synchronous
projection to make a hidden cross-context transaction or external call.

### Consistency Handling - fork

Per read that faces a user, API consumer, or agent. Discriminator: can this read
tolerate staleness?

1. **Tolerates lag** -> eventual consistency; absorb it in UX/API semantics with
   optimistic update, processing status, as-of timestamp, push, long-poll, or
   documented stale result behavior.
2. **Needs read-after-write for the actor's own action** -> provide a strong path
   for that read: synchronous local projection, wait-for-version, or read the
   actor's own recent result from the write side while broader views stay
   eventual.
3. **A machine, agent, or workflow acts on the read immediately** -> define a
   bounded freshness SLA appropriate to the decision and expose source version or
   as-of time. If wrong action is expensive, do not decide from the read model;
   recheck through the write side or command side.

Wait-for-version requires the command result to expose the source version,
position, or cursor and the query path to wait until the projection has processed
at least that version, or to time out with a clear pending result.

Hard limits: do not serve a stale read where acting on it causes a wrong decision
such as double-spend, oversell, unsafe access, or false fraud action without a
freshness guarantee or write-side fallback.

### Event Source and Contract - fork

Discriminator: where does the projection get facts from?

1. **Inside one bounded context** -> domain events, outbox records, or write-store
   change records may feed a local projection, depending on local architecture.
2. **Across bounded-context boundaries** -> consume versioned integration events
   or a Published Language. Do not project another context's internal domain
   events directly.
3. **No event stream exists and volume is low** -> build on-demand from the write
   store or schedule periodic refresh until event-fed projection is justified.

Hard limits: a cross-context projection is a contract consumer. Version the
incoming event contract, handle unknown fields and old versions, and do not bind
the read model to another context's internal aggregate shape.

### Projection Mechanics - sequence

Goal: make projection updates reliable and rebuild-safe.

1. Define the source ordering key: global position, per-aggregate version, a
   store-assigned monotonic timestamp plus tie-breaker, or source cursor. A
   producer-stamped `occurredAt` is never the ordering key; clock skew and ties
   make it unreliable for sequence (`domain-event-design.md`).
2. Define idempotency: handled event ids, source version checks, or commutative
   updates.
3. Apply the read-model change and checkpoint in one atomic commit.
4. Handle create, update, delete, cancellation, correction, and tombstone facts.
5. Record projection lag and expose source version/as-of metadata where needed.
6. Keep handlers side-effect-free so replay and rebuild are safe.

Hard limits: do not checkpoint before the read-model update is durable. Do not
produce external side effects from a projection handler.

### Rebuild Strategy - fork

Discriminator: can you afford downtime to rebuild?

1. **Downtime acceptable** -> truncate the read model and reapply all events, or
   reproject from the write store.
2. **No downtime** -> blue-green rebuild: build the new read model in a parallel
   store, catch it up, switch queries to it, then retire the old one.
3. **Long event history** -> snapshot periodically so a rebuild starts from a
   snapshot plus recent events, not from the beginning of time.
4. **PII or erasure rules apply** -> rebuild from the permitted source view, not
   from stale historical data that resurrects erased fields.

Hard limits: rebuild replays every fact, so projection handlers must already be
idempotent and side-effect-free. A rebuild can saturate the store; schedule and
throttle it away from peak read traffic. A rebuild must not resurrect deleted,
erased, or anonymized data.

## Result Notation

Use this compact notation when summarizing a read model:

`ReadModelName | read shape | feeding | consistency | rebuild`

Read model table:

| Field | Decision |
| ----- | -------- |
| Name | The read shape it serves |
| Fields | Denormalized, prejoined, preaggregated for the query |
| Store | Table, document, search index, cache, or materialized view |
| Feeding | On-demand, cache, synchronous local, or asynchronous outbox/events |
| Consistency | Tolerates lag or requires freshness; wait-for-version/write fallback if needed |
| Source contract | Domain event, outbox, write store, or integration event / Published Language |
| Idempotency | Checkpoint/handled ids/source version; atomically committed with update |
| Deletes | Delete, cancellation, correction, tombstone handling |
| Rebuild | Truncate-reapply, blue-green, snapshot-based, with privacy/erasure rules |
| Read-side rules | Authorization, tenant, visibility, privacy, retention |
| Operations | Lag SLA, monitoring, reconciliation |

## Smell Checks

- A read model is built for simple CRUD where the write store would serve the
  query.
- The query handler uses the write aggregate: indirection labeled CQRS.
- One generic read table is joined differently per screen instead of a model per
  shape.
- Read models are shared despite different shape, access pattern, freshness SLA,
  authorization, privacy, or owner.
- The read model holds a business invariant, an aggregate, or a state transition.
- Eventual-consistency lag is ignored where a read needs freshness.
- Projection lag is never measured, capped, or exposed to callers.
- Wait-for-version is claimed but the command result exposes no source version or
  cursor.
- A projection handler is not idempotent, so a rebuild double-counts.
- The projection update and checkpoint are not committed atomically.
- A projection handler sends notifications or calls external systems: side
  effects that refire on replay.
- Deletes, cancellations, corrections, or tombstones are not handled explicitly.
- The read model has no rebuild path; a projection bug requires treating the read
  model as authoritative.
- A stale read is served where acting on it causes a wrong decision, with no
  freshness guarantee or write-side fallback.
- Read-side authorization, tenant separation, visibility, privacy, or retention
  rules are missing because "the read model has no logic".
- Internal domain events from another bounded context are projected directly
  instead of versioned integration events or a Published Language.
- Read models duplicate PII without erasure, anonymization, or retention rules.
- A rebuild can resurrect erased, deleted, or anonymized data.
- Stores are physically separated before the logical separation and a scale,
  autonomy, search, or resilience need justify it.

## Expected Output

When designing a read model, emit:

- The read shape it serves: screen, API, report, or query.
- Whether a separate read model is justified, or the write store/repository/query
  service serves it.
- The denormalized fields, store, and keying for the access pattern.
- Feeding strategy: on-demand, cache, synchronous local, or asynchronous
  outbox/events, and why.
- Consistency stance per read: tolerates lag or requires freshness; include UX
  absorption, wait-for-version, or write-side fallback where needed.
- Source contract: local domain event/outbox/write store, or cross-context
  integration event/Published Language.
- Projection mechanics: ordering, idempotency, atomic checkpoint, deletes and
  tombstones, no side effects.
- Rebuild strategy: truncate-reapply, blue-green, or snapshot-based, including
  privacy/erasure behavior.
- Operational plan: lag monitoring, freshness SLA, reconciliation.
- Read-side rules: authorization, tenant, visibility, privacy, retention.
