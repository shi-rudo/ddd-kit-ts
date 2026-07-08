# Aggregate Design

Use aggregate design when modeling write-side consistency, lifecycle, and
business behavior. The goal is to protect invariants without building large
object graphs.

This reference has two parts. Part 1 - Principles are invariants: they always
hold, no choice involved. Some principles state a standing default and name the
Part 2 procedure that governs any deviation. Part 2 - Decision procedures are
sequences or forks resolved per aggregate, command, invariant, or lifecycle
rule. Each procedure names its goal or discriminator, gives ordered options with
observable conditions, and states its hard limits.

## Contents

- Core rule
- Part 1 - Principles
  - What an aggregate is
  - Aggregate root and write model
  - Naming
  - Invariants and state
  - Set-based invariants
  - Transactions and concurrency
  - References
  - Lifecycle and construction
  - Mutation API
  - Error handling
  - Domain events
- Part 2 - Decision procedures
  - Boundary selection
  - Invariant placement
  - Size decision
  - Entity vs value object
  - Transaction scope
  - Concurrency strategy
  - Set-based invariants
  - Reference decision
  - Creation and reconstitution
  - Lifecycle, deletion, and erasure
  - Error contract
  - Reclassification and audit
- Design checklist
- Smell checks
- Expected output

## Core Rule

An aggregate is a consistency boundary. It groups the minimum state needed to
enforce business invariants in one transaction. The aggregate root is the only
object outside code should load, reference, or mutate directly.

Treat the aggregate as a write model. Use it to make decisions and protect
invariants. Use read models, projections, or composition for queries and
reporting.

## Part 1 - Principles

### What an Aggregate Is

- A cluster of objects treated as one unit for data changes.
- A write-side consistency boundary, not a screen, API response, database table,
  or object graph convenience.
- The smallest useful model that can enforce the invariants required by its
  commands.
- A lifecycle owner for the entities and value objects inside its boundary.

An aggregate is the smallest model that enforces its commands' invariants. A
candidate child entity is a separate aggregate unless a true transactional
invariant or lifecycle rule places it inside the root. Resolve size through
*Size Decision* and boundary through *Boundary Selection*.

### Aggregate Root and Write Model

- The root is the only external mutation entry point.
- Repository operations load and save aggregate roots, not arbitrary child
  entities. For detailed repository, unit-of-work, and transaction-manager
  design, see `repository-design.md`.
- Child-entity changes go through root behavior.
- Reads and reporting use read models, projections, or composition unless the
  data is needed for a write decision.
- Application-level authorization stays outside the aggregate. Domain
  permissions may belong inside when they are part of the business rule.

### Naming

- Name the aggregate after the domain concept it governs, in ubiquitous
  language, as a singular noun: `Order`, `Reservation`, `Booking`, `Account`.
  The aggregate's name is its root type's name; naming the root well is naming
  the aggregate.
- Use the term domain experts use. If the name in code and the name people speak
  differ, one of them is wrong.
- Do not name it after a database table, a DTO, an API response, a UI screen, or
  an ORM graph. The name reflects the consistency boundary's responsibility, not
  its storage or transport.
- Avoid technical or generic suffixes on the aggregate type: `Manager`, `Data`,
  `Info`, `Object`, `Impl`, `Helper`, `Service`. They signal a missing or
  misplaced domain concept.
- Avoid empty generic names: `Item`, `Record`, `Entry`, `Element`, unless the
  domain genuinely uses that term. Such names carry no invariant.
- A name that describes an activity or process rather than a thing often marks a
  process manager or saga, not an aggregate. Recheck via *Reclassification and
  Audit*.
- Command-method naming, business decisions rather than CRUD, is governed by
  *Mutation API*.

### Invariants and State

- Every command handled by an aggregate protects at least one named business
  invariant.
- Each invariant states what must be true immediately after a successful
  command.
- Edge case: a fact-recording command, such as recording a payment or adding a
  note, may protect nothing beyond well-formed input and a valid resulting
  state. Name that minimal invariant honestly; do not invent a business rule to
  satisfy this principle. An aggregate whose commands are all of this kind
  protects no decision at all; recheck it via *Reclassification and Audit*.
- An aggregate must decide with state inside its own boundary.
- Do not enforce aggregate invariants through read models, caches, projections,
  external queries, or external systems. These sources may be stale or
  unavailable.
- External facts must be captured before command handling or reacted to later
  through events, policies, or processes.
- Time-based rules receive an explicit clock or current-time input. Do not hide
  system time inside aggregate methods.

### Set-Based Invariants

A set-based invariant spans multiple instances of the same aggregate type or a
scarce shared resource: unique active membership, non-overlapping reservations,
one active allocation per account and drop, contiguity across seats.

- A set-wide rule is never enforced by a factory or constructor. Creation
  protects only local invariants; set-wide uniqueness or exclusion needs a
  set-level guard. Choose that guard through *Set-Based Invariants* in Part 2.
- When a set is modeled as an aggregate, it is bounded by a natural business
  scope: session, drop, account, or allocation window. An unbounded universe
  such as `all reservations` is never a single aggregate.
- When a set-based rule requires pessimistic concurrency, the bounded set root
  is the lock target. See *Concurrency Strategy*.

### Transactions and Concurrency

- An aggregate is loaded, changed, and saved as one transactional unit.
- Use concurrency control on aggregate updates to prevent lost updates and
  invalid interleavings.
- A command changes one aggregate instance per transaction. Deviate to multiple
  instances only through *Transaction Scope*, with an explicit business reason,
  low contention, clear rollback semantics, and a documented trade-off.
- A command should fail when it uses stale aggregate state and the business
  decision cannot be safely retried.

### References

- Persist references to other aggregates by identity, using typed IDs, not
  stored object references. What the aggregate needs from another concept -
  identity, a snapshot, a read model, or coordination - is resolved through
  *Reference Decision*.
- A referenced entity is not inside the aggregate just because only the root
  currently points to it.
- A transient read-only value may inform one decision when only this aggregate
  mutates: a snapshot, a value object, or - as double dispatch - another whole
  aggregate passed into a command method for the duration of that call. This
  transient parameter is not a stored reference and is never retained; the
  persisted relationship still stays by identity. Prefer a snapshot or value
  object over passing the whole aggregate, so the receiver depends on a value,
  not on the other aggregate's type.
- Hard invariants are enforced against state inside the mutating aggregate or a
  guarded set-level mechanism, never against the transient value; and a passed-in
  aggregate is read-only: one operation mutates one aggregate.
- Other bounded contexts do not command this aggregate to update their data.

### Lifecycle and Construction

- Aggregate creation is a business decision when creation must enforce
  invariants or record facts.
- Separate business creation from persistence reconstitution.
- Business creation enforces creation invariants, initializes lifecycle state,
  and may record domain events.
- Reconstitution restores existing state. It does not record new domain events
  or represent a new business decision, and it does not re-run creation rules
  that only apply to the original business decision. It may defensively reject
  corrupted persisted state.
- A reconstituted aggregate starts clean: it has state, but no newly recorded
  domain events.
- Keep aggregate constructors private or protected when the language allows it.
  Expose named creation and reconstitution methods instead. Use public
  constructors only when all invariants are fully enforced there, commonly for
  value objects or trivial entities.
- Name lifecycle methods for what the domain means. Avoid ambiguous names; use
  `restore` only when the domain actually means restoring something. Which
  method a call site uses is resolved through *Creation and Reconstitution*.

### Mutation API

- Expose aggregate behavior as business decisions, not state manipulation.
- Name command methods after domain decisions, such as `reserveSeat`,
  `cancelBooking`, `markNoShow`, or `closeSession`.
- Avoid generic names such as `setStatus`, `updateData`, `change`, `process`,
  or `handle` unless they are actual domain terms.
- Do not expose public setters unless the setter is itself a named domain
  decision that protects a named invariant.
- Each public command method represents one complete business decision. Callers
  should not invoke several methods in a fragile sequence to leave the aggregate
  valid.
- Do not expose mutable internal collections.

### Error Handling

- Aggregates must never enter an invalid state.
- Failed commands leave aggregate state unchanged and record no domain events.
- Validate external input before it enters aggregate behavior. Do not confuse
  input validation with aggregate invariant protection.
- Use exceptions for programmer errors, corrupted state, impossible branches,
  and bug-level invariant violations.
- How an expected business rejection is surfaced is resolved through *Error
  Contract*. For stable codes and cross-layer mapping, see
  `error-management-design.md`.

### Domain Events

For detailed event modeling, publication timing, integration-event translation,
payload design, and handler rules, see `domain-event-design.md`.

- An aggregate may record domain events only after it has accepted a command and
  changed state. A failed command records no events.
- Do not use domain events to complete the same aggregate's own invariants. The
  aggregate must already be valid before any recorded event is handled.
- When another aggregate, policy, read model, local process, or integration
  translator needs to react, record a business fact and let the application
  layer dispatch it according to `domain-event-design.md`. Do not reach across
  the boundary from inside aggregate behavior.
- Persist aggregate changes and recorded domain events atomically when reliable
  delivery matters.
- Publish integration events and external messages only after commit, usually
  through an outbox.

## Part 2 - Decision Procedures

Procedures come in two shapes, marked in each heading. A **sequence** is run in
full: execute every step in order to arrive at the result; it opens with a
*Goal*. A **fork** is a branch: evaluate the *Discriminator* and take the
matching option (or options); you do not run every branch. Read a sequence
top-to-bottom; enter a fork at the condition that matches your case.

Most procedures assume the generative direction: you start from a command and
build a boundary. To audit existing code - the inverse direction, starting from
a class already in the codebase and asking whether its classification is right -
begin at *Reclassification and Audit*, which routes into the others.

### Boundary Selection - sequence

Goal: identify which state must change together to protect one immediate
business invariant.

1. Start from one command or business decision.
2. Name the invariant that must hold immediately after the command succeeds.
3. List only the state needed to enforce that invariant.
4. Choose the root that owns the decision and lifecycle.
5. Treat every other entity as outside the aggregate unless immediate
   consistency or full lifecycle ownership proves otherwise.
6. Move display-only data to read models or composition.
7. Replace persisted object references to other aggregates with typed IDs.
8. Move cross-aggregate consequences to domain events, policies, process
   managers, sagas, or eventual consistency.
9. Re-check for size smells: large collections, unrelated state, multiple
   owners, external queries, or partial loading for writes.
10. Document any exception as an explicit trade-off.

### Invariant Placement - fork

Discriminator: where can the business rule be protected with the consistency it
requires?

1. If the rule must be true immediately and needs only one aggregate's state,
   put it inside that aggregate.
2. If the rule spans a bounded set, use a set-level guard: database constraint,
   bounded set aggregate, or race-protected application check. See *Set-Based
   Invariants*.
3. If the rule spans multiple aggregate instances but the business accepts a
   delay, use eventual consistency with events, policies, process managers, or
   sagas.
4. If the rule belongs to another bounded context, do not copy its authority
   into this aggregate. Integrate through that context's contract.
5. If the rule depends on an external system, capture the external fact before
   the command or react after the command. Do not make the external system part
   of the aggregate invariant.
6. If the rule is only for display, reporting, search, or filtering, keep it out
   of the aggregate and use a read model.

### Size Decision - fork

Discriminator: does a larger boundary protect a real immediate invariant or
full lifecycle ownership?

Small is the default for operational reasons, not taste. An aggregate is loaded
and saved whole, so every needless member costs memory and latency on every
command. And the aggregate is one concurrency scope: under optimistic locking,
unrelated changes inside a large boundary conflict with each other for no
business reason. Every widening step below trades against these costs.

1. Start with a root entity plus value objects.
2. Keep a candidate child outside when it has an independent lifecycle, can be
   modified without the root, or is needed only for display.
3. Put a child entity inside when the root controls its full lifecycle or must
   enforce an immediate invariant over it.
4. Allow a larger aggregate only when the invariant truly spans the contained
   objects and the consistency rule must be immediate.
5. Reject unbounded or ever-growing child collections unless a hard invariant
   demands them and the operational cost is acceptable.
6. If command handling usually needs only a small unrelated subset of the
   aggregate, split the boundary or use a different write model.

### Entity vs Value Object - fork

This classification is resolved in `entity-design.md` (*Entity Qualification*
and *What Qualifies as an Entity*) and mirrored in `value-object-design.md`
(*Value Object Qualification*). This document defers to them for the full
procedure and its hard limits.

In short, for quick reference: a concept with continuity of identity through
attribute change, where two equal-valued instances still must be told apart, is
an entity, confirmed by at least one corroborating condition (a tracked
lifecycle, or something referencing it by identity). A concept defined entirely
by its values, interchangeable when values are equal, is a value object. A value object is never an aggregate root; it
lives inside one, and never owns a cross-instance or set-based invariant. If it
seems to, it is a misclassified entity or the rule belongs to a set-level guard.
Recheck via *Set-Based Invariants*.

### Transaction Scope - fork

Discriminator: can the command be valid by changing one aggregate instance?

1. If one aggregate can make the decision, keep the transaction to that one
   instance.
2. If another aggregate only needs to react, record an event and handle the
   consequence after commit.
3. If multiple aggregate instances must change atomically, require an explicit
   business reason, low contention, clear rollback semantics, and a documented
   trade-off.
4. If the transaction crosses a bounded context, revisit the model. Prefer a
   process manager, saga, or integration workflow.

When a use case or specification demands changing multiple aggregate instances
in one transaction, question the specification before complying. It usually
hides one of two things: a missed invariant, which belongs inside one re-cut
boundary (*Boundary Selection*), or a consequence that should be eventually
consistent (option 2). Accept the multi-instance transaction only after both
readings have been examined and rejected.

### Concurrency Strategy - fork

Discriminator: contention, critical-section length, and whether the command
allocates from a shared set.

1. For ordinary aggregate writes with modest contention, use optimistic
   concurrency control.
2. For high contention with short critical sections, use pessimistic locking or
   database-enforced serialization.
3. For allocation from a shared set, lock or guard the bounded set root, or use
   a database constraint that is the true consistency guard. The set-level guard
   itself is chosen through *Set-Based Invariants*; this procedure only decides
   the concurrency mechanism.
4. For commands that can safely retry, surface stale-write failure and retry in
   the application layer.
5. For commands whose business decision cannot be safely retried, fail the
   command explicitly when it used stale state.

### Set-Based Invariants - fork

Discriminator: does the rule span multiple instances of the same aggregate type
or a scarce shared resource?

Examples include unique active membership, non-overlapping reservations, one
active allocation per account and drop, or contiguity across seats. The
always-true constraints on set-based rules - no factory-enforced uniqueness,
natural bounding, lock target - live in Part 1, *Set-Based Invariants*.

1. Use a database constraint or exclusion constraint when the database is the
   true consistency guard.
2. Make the set the aggregate when one root can own the allocation or membership
   decision, bounded by a natural business scope.
3. Use an application-level check with explicit race protection when neither
   option fits.
4. When pessimistic concurrency is required for the chosen guard, take the
   concurrency mechanism from *Concurrency Strategy* and lock the bounded set
   root.

### Reference Decision - fork

Discriminator: what does the aggregate need from another concept to decide?

1. If it only needs to remember another aggregate, store a typed identity.
2. If it needs display data, keep that data in a read model or composition, not
   in the aggregate boundary.
3. If it needs a read-only fact from another aggregate for one decision, pass a
   transient value into the command method: a snapshot or value object by
   preference, or the whole other aggregate as double dispatch when the decision
   is naturally this aggregate's. Read-only; use it to inform the decision, not
   to enforce a hard invariant that may be stale, and do not retain it. Whether
   such a case is double dispatch here or a domain service is resolved in
   `domain-service-design.md`.
4. If the invariant needs another aggregate's mutable state immediately, revisit
   the boundary or model a set-level guard.
5. If coordination spans aggregates over time, use a domain service
   (`domain-service-design.md`), policy, process manager, or saga. Do not move
   aggregate invariants into the service.

### Creation and Reconstitution - fork

Discriminator: is this a new business decision or loading persisted state?

1. For a new decision, use named business creation, such as `create`,
   `register`, `schedule`, `open`, or a domain-specific verb. It enforces
   creation invariants, initializes lifecycle state, and may record domain
   events.
2. For persistence loading, use a separate reconstitution method, such as
   `reconstitute`, `fromSnapshot`, or `fromPersistence`. It restores state,
   records no new events, and does not re-run creation rules.

The construction invariants - private/protected constructors, public
constructors only when they fully enforce invariants, naming discipline - live
in Part 1, *Lifecycle and Construction*.

### Lifecycle, Deletion, and Erasure - fork

Discriminator: is the change a business lifecycle fact, or a legal/privacy data
removal concern?

1. Use explicit lifecycle states such as `Archived`, `Cancelled`, `Closed`, or
   `Deleted` when later decisions, audits, or events depend on that fact.
2. Use physical deletion only when the domain no longer needs the fact and
   later decisions cannot depend on it.
3. Treat privacy erasure separately from business lifecycle. Delete, anonymize,
   or cryptographically shred personal data when required by law.
4. Prefer isolating personal data in a separately erasable component so business
   lifecycle facts can remain without retaining unnecessary personal data.

### Error Contract - fork

Discriminator: is the failure an expected business rejection or a defect?

1. For expected business rejections, use explicit domain results by default. A
   command that can reasonably fail because of current domain state should make
   that failure explicit in its public contract.
2. In exception-oriented languages, a deliberate domain exception may be
   acceptable when it is part of the application's standard error mapping.
3. Do not use exceptions as hidden control flow for ordinary user-correctable
   outcomes.
4. Use exceptions for programmer errors, corrupted state, impossible branches,
   and invariant violations that indicate a bug.
5. A failed command leaves aggregate state and recorded events unchanged.
6. Use `error-management-design.md` when the rejection needs stable codes,
   layer placement, transport mapping, or cross-context translation.

### Reclassification and Audit - fork

This is the inverse of *Boundary Selection*. Start from a class already in the
codebase and ask whether its current classification as aggregate, entity, value
object, or reference data is justified. If it is not, decide what it should
become. Judge from the class's actual write behavior in the code, not from its
storage shape.

Discriminator: can you name at least one immediate business invariant that a
command on this class protects using only state inside the class?

1. No nameable invariant: it is not an aggregate. Go to the demotion options.
   A missing or unnameable immediate invariant is decisive.
2. Nameable invariant, but the class is only ever mutated inside another
   aggregate's transaction: it is not a separate consistency boundary. Merge it
   or make it a child entity of that aggregate.
3. Nameable invariant, mutated independently with its own concurrency control:
   it is a genuine aggregate. Check that outside code touches it only through
   the root and by identity. If callers load or mutate internals directly, fix
   the API leak rather than changing the classification.
4. If it passes as an aggregate, confirm size through *Size Decision* and any
   set rule through *Set-Based Invariants*, then stop.

Demotion and merge outputs, when it is not a justified aggregate:

5. Demote to value object when it has no identity that must survive attribute
   changes and no lifecycle; it is defined by its values. Confirm through
   *Entity vs Value Object*.
6. Merge into another aggregate when it cannot be validly mutated without that
   aggregate's state, or its only invariants are really that aggregate's. Pull
   it in as a child entity and move its commands onto the root. Confirm through
   *Size Decision*.
7. Demote to reference data or a read model when it is immutable master data or
   exists only for display, lookup, or filtering: no protected writes. Replace
   stored object references with typed IDs through *Reference Decision* and move
   display needs to a read model.

Hard limits:

- Storage shape is not classification evidence. A table, a primary key, a
  foreign-key graph, or an ORM entity does not make something an aggregate.
  Re-derive from write behavior.
- Widely referenced is not the same as aggregate. Immutable, widely referenced
  data is usually reference data or a value object, not a root.
- A value object is never promoted to an aggregate to give it an ID. If it needs
  identity and a lifecycle, it was a misclassified entity.

Code-inspection limit: when commands are generic, such as `updateStatus` or
`save`, and invariants are implicit, this audit can flag the smell but may not
by itself distinguish "anemic, no invariant" from "invariant exists but
undocumented". Inspect the command's actual effects and the business rules it
enforces. If no immediate invariant can be named after that inspection, treat it
as absent and proceed to demotion.

## Design Checklist

This restates Part 1 and Part 2 as a post-design review pass, to run once a
boundary is drafted. It is a mirror, not the source of truth: on any conflict,
Part 1 and Part 2 govern. Each item checks a property of the finished design,
not a rule to memorize.

- Named after a domain concept in ubiquitous language, as a singular noun, not a
  table, endpoint, UI screen, or a name with a technical suffix.
- The root owns a clear lifecycle and is the only external mutation entry point.
- Used as a write model; reads and reporting use read models, projections, or
  composition.
- Commands are named after business decisions, not CRUD operations.
- Every command protects at least one named invariant, each stating what must be
  true immediately after the command succeeds; for a fact-recording command that
  minimum is well-formed input and a valid resulting state, named as such rather
  than dressed up as an invented rule.
- Invalid external input is rejected before it enters aggregate behavior.
- Failed commands leave aggregate state and recorded events unchanged.
- Expected business rejections are explicit in the command contract; exceptions
  are reserved for defects or deliberately mapped domain exceptions.
- A command usually changes one aggregate instance transactionally; multiple
  instances require explicit justification.
- Concurrency control matches contention, critical-section length, and
  shared-set allocation needs.
- The aggregate holds only the state its invariants require, and can decide a
  command's validity without querying outside its own state.
- Entities inside cannot be meaningfully modified without the root.
- Candidate child entities are separate aggregates by default unless the root
  enforces an immediate invariant over them or fully owns their lifecycle; large
  or unbounded child collections need a hard invariant reason.
- Value objects are used for constrained values instead of raw primitives.
- Persisted references to other aggregates use identity, not object references;
  hard invariants are not enforced against stale snapshots.
- Set-based invariants are protected by a database constraint, bounded set
  aggregate, or race-protected application check.
- Cross-aggregate rules use events, policies, sagas, or process managers unless
  immediate consistency is truly required.
- Domain events are recorded after state changes; integration events and
  external messages publish only after commit (see `domain-event-design.md`).
- Repositories load and save aggregate roots, not arbitrary child entities.
- Application-level authorization stays outside the aggregate; domain
  permissions may belong inside.
- Time-based rules receive an explicit clock or current-time input.
- External systems, caches, projections, and read models do not participate in
  aggregate invariants.
- Business creation and persistence reconstitution use separate methods;
  reconstitution records no new events and represents no new decision.
- Constructors are private or protected unless they fully enforce all
  invariants.
- Public command methods leave the aggregate valid after one call.
- Mutable internal collections are not exposed.
- Business lifecycle states are separated from legal/privacy erasure concerns.
- A domain service coordinates domain concepts (`domain-service-design.md`); it
  does not hold aggregate invariants.
- Any deviation from small aggregates, identity references, or eventual
  consistency is recorded as an explicit trade-off.

## Smell Checks

- The aggregate mirrors a screen, API response, database table, or ORM graph.
- The aggregate type carries a technical or generic suffix such as `Manager`,
  `Data`, `Info`, or `Service` that hides a missing domain concept.
- The aggregate groups data that does not change together and is not governed by
  the same business policy.
- The aggregate has multiple business owners.
- Another bounded context commands this aggregate to update its data.
- Data needed only for display enlarges the aggregate.
- Command handling needs only a small unrelated subset of the aggregate.
- The aggregate requires external queries to validate a command.
- The aggregate loads large child collections for ordinary commands.
- The aggregate exposes setters or mutable collections.
- The repository exists for every entity instead of every aggregate root.
- Cross-aggregate transaction is used where an event or process would fit.
- A domain service contains rules that should live on an aggregate.
- Integration events or external messages are published before commit.
- Domain events are exposed directly as cross-context integration contracts.
- Factory creation is expected to enforce uniqueness outside one aggregate
  instance.
- The same constructor path is used for business creation and persistence
  reconstitution.
- Reconstitution records new domain events.
- Idempotency keys or command deduplication are hidden inside the aggregate
  root.
- Privacy erasure is modeled only as a business lifecycle state.
- Expected business rejection is hidden as a control-flow exception without an
  application error contract.
- Failed commands partially mutate state or record events.
- Input validation is treated as a substitute for aggregate invariant
  protection.
- A class is classified as an aggregate but no command on it protects a nameable
  immediate invariant.
- Classification as aggregate, entity, or value object is inferred from table or
  ORM shape rather than from write behavior.

## Expected Output

When designing an aggregate, define:

- Aggregate root.
- Entities inside the boundary.
- Value objects inside the boundary.
- Commands or business decisions handled by the aggregate.
- Protected invariants and where each one is enforced.
- Boundary decision and why excluded concepts stay outside.
- Size decision and any accepted large-aggregate trade-off.
- Transaction scope and concurrency strategy.
- Set-based invariant guard, if any.
- Reference strategy for other aggregates.
- Creation, reconstitution, lifecycle, and deletion rules.
- Error contract for expected business rejections.
- Domain events recorded after accepted decisions.
- Rules intentionally left eventually consistent.
- Deviations from the defaults and their business reason.

When auditing an existing class instead of designing one, define:

- The class and its current classification: aggregate, entity, value object, or
  reference data.
- The immediate invariant it protects, if any can be named, and the command that
  protects it.
- The verdict: keep, or reclassify.
- If reclassified, the target: merge into which aggregate, demote to child
  entity, value object, reference data, or read model, and the observed reason.
- The evidence used: write behavior and transaction scope, not storage shape.
