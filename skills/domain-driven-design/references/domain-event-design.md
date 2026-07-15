# Domain Event Design

Use domain event design when modeling meaningful facts that happened in the
domain and coordinating consequences across aggregates, policies, processes, or
bounded contexts.

This reference has two parts. Part 1 - Principles are invariants: they always
hold, no choice involved. Part 2 - Decision procedures are forks resolved per
event or per handler. Each procedure names its discriminator, gives ordered
options with observable conditions, and states its hard limits.

## Contents

- Core rule
- Part 1 - Principles
  - What a domain event is
  - What is not a domain event
  - Domain events are not event sourcing
  - Naming
  - Recording and publication
  - Payload
  - Handlers
  - Domain events vs integration events
- Part 2 - Decision procedures
  - Consistency timing
  - Payload richness
  - Ordering
  - Boundary translation
  - Process shape
  - Versioning
- Smell checks
- Expected output

## Core Rule

A domain event is a business fact that already happened. Name it in past tense,
record it only after a successful domain decision, and do not use it to ask
another object to do work.

## Part 1 - Principles

### What a Domain Event Is

- A business fact that already happened, named in past tense.
- Recorded only after the aggregate accepted the command and changed state.
- Never a way to ask another object to do work; that is a command.
- The name reads sensibly as "it happened that ...". If the name describes an
  instruction, use a command instead.

### What Is Not a Domain Event

Past tense alone does not qualify a name. An event earns its place in the model
only if it records a business fact a domain expert would recognize and care
about. The recurring impostors:

- A CRUD echo. `CustomerUpdated`, `RecordSaved`, `OrderDeleted` name a
  persistence operation, not a business fact. Ask what happened in the business
  and name that: `CustomerRelocated`, `OrderCancelled`.
- A property-change notification. `StatusChanged`, `EmailChanged` report which
  field mutated. The business fact behind the mutation is the event; the field
  change is its consequence.
- A technical signal. `CacheInvalidated`, `RetryScheduled`, `RowInserted` may
  exist as infrastructure telemetry, never as domain events in the model.
- A command in disguise. If the flow is broken unless one specific subscriber
  performs one specific action, the message is a command regardless of tense.
  Renaming `SendWelcomeEmail` to `WelcomeEmailRequested` changes nothing;
  publishing `UserRegistered` is honest only if registration is complete
  whether or not anyone reacts.
- A change feed. One event per setter or per repository write means events are
  serving data synchronization, not recording business decisions. Model the
  decisions; use a projection or a replication mechanism for sync.
- An indirection to hide coupling. Publishing an event so that a dependency no
  longer appears in the dependency graph does not remove the coupling; it hides
  it from review. If the producer knows and needs its consumer, make the call
  or command explicit and let the design problem surface where it can be fixed.

The admission test for every candidate: a domain expert recognizes the name and
cares that the fact occurred, and the name states why the change happened, not
which data changed. Failing that test, record no event.

### Domain Events Are Not Event Sourcing

- Recording, persisting, and publishing domain events does not make the system
  event-sourced. In a state-stored model the aggregate state remains the source
  of truth; events are facts recorded alongside it, for the outbox, handlers,
  projections, and integration.
- An audit, history, or analytics requirement alone never selects event
  sourcing. Persisted domain events or a dedicated projection provide the audit
  trail and the analysis data while state stays authoritative. Reaching for
  event sourcing because "we need an audit log" is the classic over-selection
  trap.
- Event sourcing is a separate business-logic pattern decision, gated in
  `business-logic-pattern-selection.md`: it is justified only when full
  business history must be the SOURCE OF TRUTH, not merely recorded. Do not
  make that choice from inside event design.

### Naming

Use ubiquitous language and past-tense facts:
`OrderPlaced`, `SeatHeld`, `InvoiceCancelled`, `AccountClosed`.

Avoid command names, technical names, and transport names:
`PlaceOrder`, `UpdateRow`, `SendEmail`, `MessagePublished`.

### Recording and Publication

- Record events only after the aggregate has accepted the command and changed
  state. A failed command records no events.
- A reconstituted aggregate emits no historical events. Reconstitution loads
  past state; it records no new business facts. Under event sourcing, replay
  applies stored events to rebuild state; it never dispatches them to handlers
  and never records them as new facts.
- Persist aggregate changes and recorded domain events in the same transaction
  when events drive reliable downstream work.
- Publish external messages only after the transaction commits. Use an outbox
  when delivery reliability matters. The outbox belongs to the application or
  infrastructure layer, not to aggregate behavior.

### Payload

- Include stable identifiers and the relevant business facts.
- Include a stable `eventId` or message id when handlers need deduplication.
- Include correlation, conversation, and causation ids when a process manager,
  saga, or tracing must relate events across a flow. Like event ids and sequence
  numbers, they are metadata that is hard to retrofit later. On a public
  integration message, carry them as explicit envelope headers rather than
  payload fields or free-form custom metadata.
- Include an `occurredAt` timestamp when audit or time-based policy matters.
  `occurredAt` is not an ordering key; clock skew and ties make it unreliable
  for sequence.
- Include a monotonic per-entity version or sequence number when ordering or
  stale-event detection matters. This is the reliable ordering and staleness
  signal.
- Prefer facts over object graphs. Never serialize the aggregate, child
  collections, ORM entities, or read-model projections as payload.
- Carry enough for a subscriber to decide without guessing, but do not turn the
  event into a broad query response. Payload richness is a decision procedure.
- Avoid personal data unless the event's business meaning requires it. For
  integration events, treat payload shape and privacy as an external contract.

### Handlers

- Assume at-least-once delivery on post-commit and asynchronous paths. Handlers
  there must be idempotent and retry-safe. A same-transaction in-process handler
  shares the command's commit and needs no delivery idempotency.
- Handlers on asynchronous paths must tolerate duplicate, delayed, reordered,
  and partially failed delivery.
- A handler may update other aggregates, read models, policies, or external
  processes, but it must never be required to complete the emitting aggregate's
  own invariants.
- A handler owns a consequence the producer does not depend on: the emitting
  use case's business outcome is complete whether or not the handler runs. A
  reaction the outcome requires is an explicit step, a command, or part of a
  process owner, not a subscription.
- Record enough processed-message state, or use an idempotent write, so repeated
  handling does not duplicate side effects.

### Domain Events vs Integration Events

- A domain event is a fact inside one bounded context. It may expose internal
  model language and may evolve with the model unless it is persisted, replayed,
  or consumed as a stable internal contract.
- An integration event is a public contract between systems or bounded contexts.
  It needs a stable name, compatible schema evolution, versioning rules, and
  explicit ownership.
- Its envelope owns transport identity and relationship headers. `messageId`
  identifies this message, `correlationId` groups one operation or trace,
  `conversationId` spans a longer business interaction, and `causationId`
  identifies the immediate cause. Keep these separate from business payload and
  custom metadata, and do not invent a value when that relationship does not
  exist.
- Never publish a raw in-process domain event across a bounded-context boundary.
  Translate it at the boundary when the fact needs to leave the context. Keep
  transport concerns outside the domain model.

## Part 2 - Decision Procedures

### Consistency Timing - fork (same transaction vs post commit)

Discriminator: the side effect's atomicity requirement and whether it crosses an
aggregate or bounded-context boundary.

1. Does the consequence touch a different aggregate or bounded context, or can
   it tolerate lag? Use post-commit, eventually consistent dispatch. Keep one
   aggregate per transaction.
2. Does the consequence touch only local state that must share the originating
   command's commit, such as a local projection that must roll back with the
   command? Use same-transaction in-process dispatch.
3. Does the consequence enforce an aggregate invariant? Put that rule inside the
   mutating aggregate, a guarded set-level consistency mechanism, or a database
   constraint, not in an event handler.
4. If unsure, prefer post-commit for anything outside the aggregate boundary.
5. Either way, keep the dispatch mechanism out of aggregate behavior.

Never require immediate consistency outside an aggregate without a named
business reason. If a rule must be true immediately, model the rule at the
write-side consistency boundary instead of delegating it to an event.

### Payload Richness - fork (thin vs enriched)

Discriminator: does the subscriber's decoupling from the source outweigh payload
minimalism?

1. For an in-context subscriber that can cheaply load from the same store, use a
   thin event. The subscriber loads or projects richer data explicitly.
2. For a cross-context subscriber, or any subscriber whose runtime coupling to
   the source should be removed, consider Event-Carried State Transfer. Enrich
   the payload with the selected state the consumer needs so it need not query
   back.
3. Weigh the cost per subscriber, not globally. ECST duplicates state and forces
   the consumer to handle staleness. Thin events reintroduce a runtime query and
   coupling to the source.
4. Never dump the aggregate as a shortcut to "enriched". ECST carries selected
   facts, not ORM entities, child collections, or projections.

### Ordering - fork

Discriminator: does any handler's correctness actually depend on event
sequence?

1. If no handler breaks when events arrive reordered, do not design for
   ordering.
2. If ordering matters, ask whether the dependency is within one aggregate or
   identifier, or across different ones. It is almost always within one. Scope
   the requirement to that partition key, usually the aggregate id, and never to
   the global stream.
3. Prefer making the handler order-independent. Use a commutative handler when
   arrival order does not change the result.
4. If order independence is not possible, use stale-event rejection. Carry a
   monotonic per-entity version or sequence number and discard events that are
   not newer than the state already applied.
5. Only if neither option works, require enforced per-key ordering from the
   infrastructure. State the ordering rule and its key explicitly.
6. Never require global total ordering. If a design seems to need it, revisit
   the partition key; the real requirement is almost always per-key.
7. Across a bounded-context boundary, per-key ordering is a producer contract.
   If ordering matters, name the guarantee in the integration event contract, or
   design the consumer to need none.

This is the same discipline as idempotency: design the handler so duplicate and
out-of-order delivery are both harmless.

### Boundary Translation - fork (domain event vs integration event)

Discriminator: does the fact cross a bounded-context or system boundary?

1. Consumed only inside the emitting bounded context: keep it a domain event.
   Internal language is fine. It may evolve with the model unless persisted,
   replayed, or treated as a stable internal contract.
2. Consumed by another bounded context or external system: translate to an
   integration event at the boundary. Give it a stable name, explicit payload
   contract, owner, and versioning policy. Do not leak the in-process event.
3. Consumed both internally and externally: keep the domain event internal and
   publish a derived integration event. They are two objects, not one.
4. Keep transport and serialization in an adapter, never in the domain model.

### Process Shape - fork (single event vs process manager or saga)

Discriminator: is this one consequence, or a multi-step process spanning
several commands and events?

1. For a single reactive consequence, such as updating a read model or notifying
   one other aggregate, use a plain event plus handler.
2. For a sequence that coordinates multiple aggregates or bounded contexts and
   has its own state, timeouts, retries, or compensation, use a policy, process
   manager, or saga that owns that state. For cross-context runtime coordination,
   use `context-coordination.md`; once that document confirms the interaction is
   a saga, design its state, compensation, retry, and timeout behavior in
   `saga-design.md`.
3. Do not encode a multi-step process implicitly across a chain of handlers
   reacting to the next event. If there is process state, model the owner
   explicitly.
4. Never use events to hide a missing aggregate boundary or missing process
   owner.

### Versioning - fork (additive vs breaking)

This procedure applies to integration events, which are external contracts.
Domain events may evolve with the internal model unless they are persisted,
replayed, or consumed as a stable internal contract.

Discriminator: can all consumers migrate atomically?

1. For additive, backward-compatible changes, such as a new optional field, ship
   the change. Treat external contracts as append-only by default.
2. For a breaking change where all consumers can migrate atomically, migrate
   producer and consumers together in one step.
3. For a breaking change where consumers cannot migrate atomically, version the
   schema explicitly. Run old and new in parallel, keep old consumers working
   through rollout, and deprecate on a stated policy.
4. Never rename, remove, or redefine a field on an external contract in place
   without a migration or versioning strategy.

Define schema ownership, compatibility expectations, and deprecation policy as
part of the event design whenever an event crosses a system or bounded-context
boundary.

These versioning rules govern integration events as wire contracts. They are
adjacent to, but not identical with, event-sourcing schema evolution, which
versions stored events via upcasting. Do not conflate the two mechanisms.

## Smell Checks

- The event is named like a command or technical notification.
- The event names a data mutation (`CustomerUpdated`, `StatusChanged`) instead
  of the business fact behind it.
- Events exist for every setter or every repository write.
- A flow breaks if one specific subscriber stops listening; the event is a
  command in disguise.
- An event exists so that a dependency stops showing up in the dependency
  graph.
- Event sourcing is adopted because an audit trail was requested, where
  persisted domain events or a projection would serve and state could remain
  the source of truth.
- The event fires before the aggregate has changed state.
- The event fires when a command fails.
- The event payload is an aggregate dump or read-model projection.
- A raw domain event crosses a bounded-context boundary.
- A post-commit or asynchronous handler is not idempotent.
- A handler must run to make the emitting aggregate valid.
- External side effects are published before the transaction commits.
- Reconstitution emits new events by accident.
- Subscribers depend on hidden database state instead of explicit event facts or
  deliberate reads.
- Ordering is assumed to be global rather than scoped to a partition key.
- `occurredAt` is used as an ordering key.
- A multi-step process is encoded implicitly across a handler chain with no
  explicit process owner.

## Expected Output

When designing a domain event, define:

- Event name in ubiquitous language.
- Source bounded context and aggregate.
- Business decision that records it.
- Payload fields, event id, correlation, conversation, and causation ids if a
  process or tracing needs them, ordering or sequence field if any, and privacy
  constraints. For public messages, place relationship ids in the explicit
  envelope.
- Immediate invariants already protected before the event is recorded.
- Subscribers, handlers, policies, or processes that may react.
- Consistency timing: same transaction, post-commit, or eventual, with the
  reason.
- Payload richness: thin, enriched, or ECST, with the reason.
- Ordering: none required, per-key order-independent, stale-event rejection, or
  enforced per-key order with the key named.
- Boundary translation: internal only, or the derived integration event and its
  contract.
- Process shape: single event, or the process manager or saga that owns the
  flow.
- Versioning assumptions for any integration event.
- Delivery and idempotency assumptions.
