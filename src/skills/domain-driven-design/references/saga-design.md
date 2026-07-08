# Saga Design

Use saga design when a cross-context write workflow has durable process state
and must recover from partial failure through compensation or forward retry. Use
`context-coordination.md` first to decide whether the interaction is a saga and
whether it is orchestrated or choreographed; use this reference to design the
saga itself.

This reference has two parts. Part 1 - Principles are invariants: they always
hold, no choice involved. Part 2 - Decision procedures are forks and sequences
resolved per saga. Each names its discriminator, gives ordered options with
observable conditions, and states its hard limits. A sequence is run in full; a
fork is entered at the matching condition.

## Scope and Neighbors

- This document designs a saga: a durable, long-running write-side coordination
  process with local transactions, retries, timeouts, and compensating business
  actions.
- Use `context-coordination.md` before this document to decide whether the
  interaction is a saga, a process manager without compensation, choreography, a
  client-orchestrator, or a read-side composition.
- Use `domain-event-design.md` for event naming, payload, ordering,
  idempotency, boundary translation, and versioning.
- Use `aggregate-design.md` for immediate consistency and business invariants
  inside one aggregate. A saga calls aggregates through commands; it never owns
  their invariants.
- Use `context-mapping.md` for the static upstream/downstream relationship
  between participating bounded contexts.

## Contents

- Core rule
- Part 1 - Principles
  - What a saga is
  - Ownership and boundaries
  - Local transactions and consistency
  - Isolation and countermeasures
  - Saga state
  - Commands, events, and contracts
  - Compensation
  - Idempotency and concurrency
  - Retries, timeouts, and failure taxonomy
  - Observability and repair
- Part 2 - Decision procedures
  - Qualification
  - Saga style
  - Ownership and boundary
  - Step classification
  - Isolation countermeasure
  - State machine
  - Messaging contracts
  - Retry and timeout policy
  - Compensation plan
  - Visibility and operations
- Result notation
- Smell checks
- Expected output

## Core Rule

A saga coordinates a distributed business process through durable process state
and a sequence of local transactions. Each participant protects its own
invariants. The saga records progress, sends commands, reacts to facts, retries
technical failure, and compensates completed compensatable steps when the
business process cannot continue. It is not a distributed ACID transaction, not
an aggregate, and not a place to centralize participant business rules.

## Part 1 - Principles

### What a Saga Is

- A saga is a write-side coordination pattern for a long-running process that
  spans aggregates, bounded contexts, services, or teams.
- It exists because one database transaction cannot or should not cover all
  participants.
- It owns process state: current step, completed steps, pending commands,
  attempts, deadlines, correlation id, and terminal outcome.
- It does not own domain state from the participants. Participant state belongs
  to participant aggregates and contexts.
- A process manager becomes a saga when it coordinates partial success and has
  compensation or forward recovery as a first-class concern. This
  process-manager-versus-saga line is a house distinction for this family of
  documents; in the literature the two overlap heavily: Hohpe and Woolf's
  Process Manager and Richardson's orchestration-based saga describe much the
  same machinery, and the saga label emphasizes compensation and the distributed
  transaction.
- Do not call a one-call interaction, a single event handler, or an ephemeral UI
  sequence a saga.

### Ownership and Boundaries

- Every orchestrated saga has one explicit process owner. The owner is
  responsible for the state machine, timeouts, retries, compensation order,
  observability, and repair procedures.
- A choreographed saga may have no central runtime owner, but the process still
  needs an explicit design owner who documents the flow, compensation paths, and
  event contracts.
- Participants are addressed through contracts: commands, APIs, and integration
  events. The saga never imports internal domain objects, repositories, or
  aggregate child entities from a participant.
- A saga may decide process transitions. It must not reimplement participant
  business rules. If it needs to know whether a participant command is valid, it
  asks the participant to decide.
- Do not use a saga to hide a bad aggregate boundary. Immediate invariants stay
  inside an aggregate or guarded set-level mechanism.

### Local Transactions and Consistency

- Each saga step is a local transaction owned by one participant.
- The overall process is eventually consistent. Between steps, the system may
  expose pending, reserved, cancelled, compensating, or failed states.
- Avoid two-phase commit across bounded contexts. If the process needs global
  ACID semantics, revisit the boundary, the invariant, or the business process.
- Classify steps as compensatable, pivot, or retryable:
  - A compensatable step can be semantically undone by a later business action.
  - The pivot step is the point after which the saga must complete forward.
  - A retryable step after the pivot is retried until it succeeds or is moved to
    manual repair.
- Not every step needs compensation. Steps after the pivot are completed by
  retry, not undone.

### Isolation and Countermeasures

- A saga is ACD, not ACID: it has no isolation. Between steps, and across
  concurrent sagas or ordinary transactions, other work can observe or act on a
  saga's intermediate state.
- Name the anomalies a saga can produce:
  - **Lost update**: a saga overwrites a change made by a concurrent transaction
    it did not see.
  - **Dirty read**: another transaction reads state a saga has written but not
    yet settled to a business outcome - reserved or pending state that a later
    step may compensate.
  - **Fuzzy or non-repeatable read**: a saga reads the same data at two steps and
    a concurrent change makes the two reads disagree.
- Isolation is not free in a saga. Buy it back with explicit application-level
  countermeasures, chosen per step by the anomaly and its business cost:
  - **Semantic lock**: a compensatable step sets an application lock, such as a
    `pending`, `reserved`, or `*_IN_PROGRESS` marker, that a later step commits
    or a compensation releases. Readers must handle the in-progress state
    instead of treating it as final. The `pending`, `reserved`, and
    `compensating` states in this design are semantic locks; name them as such.
  - **Commutative updates**: design updates so order does not matter, such as
    add and subtract rather than set, so a lost update cannot occur.
  - **Pessimistic view**: order steps so the reads most damaged by a dirty read
    happen after the data has settled, minimizing the business impact of the
    isolation gap.
  - **Reread value (optimistic offline lock)**: before a dependent write, reread
    the record and verify it has not changed since it was read; abort or retry
    on conflict.
  - **Version file**: record operations as a log so out-of-order operations can
    be reordered or reconciled, turning non-commutative operations into
    commutative ones.
  - **By value**: choose the mechanism by the business risk of the request.
    High-risk requests get sagas with countermeasures; low-risk requests may
    take a simpler path. This inverts Richardson's original by-value
    countermeasure, which routes high-risk requests to distributed
    transactions; this document's stance avoids two-phase commit across
    contexts, so high-risk requests get stronger saga countermeasures instead.
- Every semantic lock needs a defined release on every terminal path:
  completion, compensation, and timeout. A lock with no release on compensation
  or timeout leaks and blocks unrelated work.

### Saga State

- Persist saga state durably before dispatching work that depends on that state.
- Store only process state: saga id, correlation id, current state, completed
  steps, pending command ids, attempts, deadlines, participant references,
  version, and terminal outcome.
- Keep participant snapshots out of saga state unless they are immutable facts
  needed for compensation, audit, or idempotency. A stale snapshot may inform a
  command but must not become a copied invariant.
- Model terminal states explicitly: completed, rejected, compensated, failed,
  expired, or manual repair. A saga without terminal states is an unbounded
  workflow.
- Reconstitution of saga state must not emit new messages. It reloads process
  state; decisions happen only when a new command, event, or timeout is handled.

### Commands, Events, and Contracts

- The saga sends commands or calls participant APIs to request work.
- The saga reacts to facts: accepted, rejected, completed, failed, timed out, or
  compensated events.
- Use events to report facts, not to smuggle commands. `PaymentCaptured` is a
  fact; `CapturePayment` is a command.
- Every outgoing command carries a correlation id and an idempotency key. Use a
  causation id when reconstructing why a command was emitted.
- Cross-context events are integration events with stable contracts. Do not
  leak internal domain events across a bounded-context boundary.
- Persist saga state and outgoing messages atomically when reliability matters.
  Use an outbox for outgoing messages and an inbox or deduplication table for
  incoming messages.

### Compensation

- Compensation is a business action, not a technical rollback. It is modeled in
  the participant's language: release reservation, refund payment, cancel
  shipment, revoke entitlement.
- A compensating command must be idempotent. It may be delivered more than once.
- Compensation has its own failure modes and may require retry, timeout, or
  manual repair.
- Run compensations in the order required by the business. Reverse order is a
  common default, but not a law.
- Do not compensate after the pivot unless the business explicitly provides a
  new corrective action. After the pivot, the usual rule is forward recovery.
- If a step has no meaningful compensation and cannot be retried forward, move
  the pivot before it or redesign the process.
- In a choreographed saga, compensation is a backward-running cascade of events
  with no central place to order it: each participant must know which failure
  events to emit and which to react to. This is harder to get right than forward
  flow and is the main reason branching or many-participant sagas prefer
  orchestration.

### Idempotency and Concurrency

- Incoming events and timeout signals may be duplicated. Handling the same input
  twice must not advance the saga twice.
- Outgoing commands may be retried. Participants must treat duplicate command
  ids or idempotency keys as the same request.
- Protect the saga instance from concurrent transitions with optimistic
  concurrency, a per-instance lock, single-consumer partitioning, or an
  equivalent stale-write protection.
- A stale or unexpected event should be ignored, rejected as an invalid
  transition, or recorded for audit according to the state machine. It must not
  corrupt saga state.
- Business rejections are not retryable technical failures. They are controlled
  transitions.

### Retries, Timeouts, and Failure Taxonomy

Classify every failure before choosing the reaction.

- **Technical transient failure**: retry with bounded backoff and a maximum
  attempt policy.
- **Business rejection**: transition to rejection, compensation, or an alternate
  path. Do not retry unchanged.
- **Timeout**: treat as a saga input. Decide whether to retry, query status,
  compensate, expire, or move to repair.
- **Duplicate or stale message**: deduplicate or ignore without changing the
  outcome.
- **Poison message or corrupted state**: stop automatic progress and move to
  manual repair.
- **Compensation failure**: retry or repair; do not pretend the saga is
  compensated.

Retries need ownership, limits, and observability. Infinite silent retry is not a
recovery strategy.
Use `error-management-design.md` when these failures cross a port or bounded
context as stable error codes rather than remaining internal saga state.

### Observability and Repair

- Every saga instance needs a correlation id that appears in logs, messages,
  metrics, and support tools.
- Record state transitions, emitted commands, received events, retries,
  compensations, timeouts, and terminal outcomes.
- Expose a status view for users or operators when the process can remain
  pending beyond one request.
- Define manual repair before production: what can be retried, skipped,
  compensated, marked failed, or completed by an operator.
- Repair commands must preserve invariants by calling participant contracts.
  Manual repair is not permission to edit participant databases directly.

## Part 2 - Decision Procedures

### Qualification - fork

Discriminator: is this actually a saga?

1. **One aggregate or one guarded set can protect the invariant in one
   transaction** -> not a saga. Use `aggregate-design.md`.
2. **One cross-context consequence with no process state** -> not a saga. Use a
   domain or integration event and handler.
3. **Multiple steps but no durable state and no compensation** -> not a saga.
   Use plain orchestration or choreography from `context-coordination.md`.
4. **Durable process state, crash recovery, but no compensation** -> process
   manager without compensation. This document may still help with state,
   idempotency, and timeouts, but do not call it a saga.
5. **Multiple local transactions with durable state and compensation or forward
   recovery after partial success** -> saga. Continue.

Hard limits: do not introduce a saga to avoid modeling an aggregate invariant.
Do not run a saga in the browser. Do not label a simple event chain as a saga
unless it owns process state or compensation.

### Saga Style - fork

Discriminator: where is the process state and decision logic?

1. **One owner must see the whole flow, enforce order, handle branching, manage
   compensation order, or support operators** -> orchestrated saga.
2. **Few steps, autonomous participants, low branching, and high value in adding
   reactions without changing one coordinator** -> choreographed saga.
3. **Participants need shared journey state or the flow is hard to reconstruct**
   -> prefer orchestration.

Hard limits: an orchestrator must not absorb participant business rules. A
choreographed saga still needs a documented flow, event contracts, compensation
paths, and a way to trace an instance. In a choreographed saga, compensation is a
backward-running cascade of events with no central place to order it, so each
participant must know which failure events to emit and react to. Watch for cyclic
event subscriptions between participants: two services subscribing to each
other's events is a structural smell that makes the flow impossible to follow;
branching or many-participant compensation is a signal to switch to
orchestration.

### Ownership and Boundary - sequence

Goal: name the saga boundary and owner.

1. Name the business process in ubiquitous language.
2. Identify the trigger: command, event, schedule, or operator action.
3. List participating contexts and the contracts used to reach each one.
4. Choose the process owner:
   - for orchestration, the owner is the saga/process component;
   - for choreography, name the design owner and each participant's local
     responsibility.
5. Name the saga id and correlation id strategy.
6. List terminal outcomes and who observes them.

Hard limits: if no one owns the process, it is not designed. If ownership is
split, state who owns each transition and compensation path.

### Step Classification - sequence

Goal: identify local transactions, compensation, pivot, and retry-forward work.

For each step, record:

- Participant context
- Command/API call
- Success fact
- Business rejection fact
- Technical failure signal
- Local transaction boundary
- Idempotency key
- Compensation command, if any
- Retry policy, if any

Then classify each step:

1. Put reversible steps before the pivot where possible.
2. Mark each pre-pivot step as compensatable or redesign it.
3. Select the pivot: the step after which the process must complete forward.
4. Mark post-pivot steps as retryable or manual-repairable.
5. If a non-compensatable step appears before the pivot, either move the pivot
   earlier, introduce reservation/escrow, or change the business process.

Hard limits: a compensation must be a real business action provided by the
owning context. A database rollback, deletion of rows, or mutation of another
context's internals is not compensation.

### Isolation Countermeasure - fork

Discriminator: for a given step's data, which anomaly is possible and how costly
is it to the business?

1. **Concurrent writers can lose updates** -> commutative updates where possible
   (add/subtract rather than set); otherwise a semantic lock on the record.
2. **Other transactions can read reserved or pending state that a later step may
   compensate** -> a semantic lock with an in-progress marker that readers must
   respect; add pessimistic-view step ordering to shrink the window a dirty read
   can affect.
3. **The saga reads the same data at two steps and a concurrent change would
   break the decision** -> reread the value and verify before the dependent
   write; abort or retry on conflict.
4. **The anomaly is possible but rare and low-cost, and countermeasures are
   expensive** -> by value: apply countermeasures only to high-risk requests and
   accept the gap for low-risk ones, as an explicit, documented decision.

Hard limits: a semantic lock without a release on every terminal path
(completion, compensation, timeout) is a lock leak; countermeasures are
application-level saga design, never a reason to reach for two-phase commit. Do
not pretend a saga has ACID isolation: name the anomaly and its countermeasure,
or accept the gap explicitly.

### State Machine - sequence

Goal: make legal saga progress explicit.

1. Define states in business language, not handler names:
   `Started`, `ReservationPlaced`, `PaymentCaptured`, `Compensating`,
   `Completed`, `Rejected`, `Compensated`, `Failed`, `ManualRepair`.
2. For each state, list accepted inputs: command, event, timeout, or operator
   action.
3. For each input, define:
   - guard condition;
   - state transition;
   - state persisted;
   - outgoing command or event;
   - idempotent duplicate behavior.
4. Define invalid input behavior: ignore, reject, audit, or repair.
5. Define terminal states and verify no automatic transition leaves them.

Hard limits: do not infer state from scattered handler side effects. If a saga
has process state, it has a state machine even when the code hides it.

### Messaging Contracts - sequence

Goal: make message flow reliable and explicit.

1. Name the command emitted for each participant action.
2. Name the event or response that confirms success, rejection, or failure.
3. Add correlation id, causation id, message id, and idempotency key.
4. Define the partition or ordering key when ordering matters; prefer the saga
   id or participant aggregate id, not global ordering.
5. Define outbox/inbox or equivalent atomic persistence and deduplication.
6. Define versioning policy for integration events.

Hard limits: never rely on exactly-once delivery. Never use event order as a
hidden state machine unless the ordering key and stale-message behavior are
explicit.

### Retry and Timeout Policy - sequence

Goal: decide how progress resumes.

1. For every outgoing command, define retryable technical failures.
2. Set backoff, maximum attempts, and escalation target.
3. For every wait state, define timeout duration and timeout handling.
4. On timeout, choose one:
   - query participant status;
   - retry the command;
   - compensate;
   - expire/reject;
   - move to manual repair.
5. Treat business rejection as a process transition, not a retry.
6. Record attempts and timeout decisions in saga state or audit.

Hard limits: a timeout is not proof that the participant did nothing. Before
compensating or retrying in a way that could duplicate effects, use idempotency,
status query, or participant-side deduplication.

### Compensation Plan - sequence

Goal: define how partial success is resolved.

1. List all completed compensatable steps.
2. For each business rejection or unrecoverable failure before the pivot, choose
   the compensation sequence.
3. For each compensation command, define success, rejection, retry, timeout, and
   repair behavior.
4. Define the terminal state after all compensations succeed.
5. Define the terminal or repair state if a compensation cannot complete.
6. Verify that compensations call participant contracts and preserve participant
   invariants.

Hard limits: do not declare the saga compensated until compensations are
confirmed or the process reaches an explicitly accepted repair state. Do not
invent compensation in the coordinator for a participant that has no such
business operation.

### Visibility and Operations - sequence

Goal: make the saga operable.

1. Define the user-visible or operator-visible status for pending, completed,
   rejected, compensating, failed, and repaired outcomes.
2. Define metrics: started, completed, rejected, compensated, failed, timeout
   count, retry count, repair count, and age of oldest pending instance.
3. Define logs and traces keyed by correlation id.
4. Define safe operator actions: retry, compensate, mark failed, resume, or
   acknowledge repair.
5. Define audit retention for state transitions and messages.

Hard limits: a long-running saga without status, metrics, and repair operations
is not production-ready.

## Result Notation

Use this compact notation when summarizing the design:

`SagaName | style | owner | trigger | pivot | terminal outcomes`

Step table:

| Step | Participant | Command | Success fact | Rejection fact | Class | Compensation | Isolation |
| ---- | ----------- | ------- | ------------ | -------------- | ----- | ------------ | --------- |
| 1    | Context A   | Command | Event        | Event          | Compensatable | Command | Semantic lock |
| 2    | Context B   | Command | Event        | Event          | Pivot | None | Commutative |
| 3    | Context C   | Command | Event        | Event          | Retryable | None (retry, then manual repair) | None |

State table:

| State | Input | Transition | Persisted before emit | Outgoing action | Duplicate behavior |
| ----- | ----- | ---------- | --------------------- | --------------- | ------------------ |
| State | Event | NextState  | Yes                   | Command         | Ignore/no-op       |

## Smell Checks

- A saga is introduced for a one-call interaction or single event consequence.
- The saga runs in the browser or depends on browser state for completion.
- The saga enforces participant business rules instead of asking participants to
  decide.
- The saga stores copied participant domain state and treats it as authoritative.
- A compensating action is implemented as a database rollback or direct mutation
  of another context's internals.
- A non-compensatable step appears before the pivot with no redesign.
- Business rejection is retried unchanged.
- Technical failure causes immediate compensation without checking whether the
  participant may still complete.
- No idempotency key on outgoing commands.
- Incoming events can advance the saga twice.
- No explicit terminal states.
- No timeout policy for wait states.
- No manual repair path for poison messages, corrupted state, or compensation
  failure.
- Intermediate saga state, such as reserved or pending, is readable as final,
  with no semantic lock or in-progress marker for other transactions.
- A semantic lock has no defined release on every terminal path: completion,
  compensation, and timeout. Locks leak.
- Concurrent sagas lose updates because updates are set-based where a
  commutative update would be safe.
- Isolation anomalies are ignored because the saga is treated as if it had ACID
  isolation.
- A choreographed saga has no documented flow or compensation paths.
- In a choreographed saga, participants subscribe to each other's events
  cyclically, making the flow impossible to trace.
- An orchestrated saga has become a central business rule engine.
- The design assumes exactly-once delivery, global ordering, or synchronous
  availability of every participant.

## Expected Output

When designing a saga, emit:

- Saga name and business purpose.
- Style: orchestrated or choreographed, with the discriminator used.
- Owner: runtime owner for orchestration, design owner and participant
  responsibilities for choreography.
- Trigger, saga id, correlation id, and causation/idempotency strategy.
- Participating contexts and contracts.
- Step table with local transaction boundaries, success facts, rejection facts,
  classifications, compensations, and per-step isolation countermeasures.
- Pivot point and forward-retry strategy after the pivot.
- Isolation countermeasures per step (semantic lock, commutative update, reread,
  pessimistic-view ordering) and the release path for every semantic lock.
- State machine with terminal states and duplicate/invalid input behavior.
- Retry, timeout, and manual repair policy.
- Outbox/inbox or equivalent reliability mechanism.
- Visibility, metrics, audit, and operator actions.
- Smell-check findings and unresolved business questions.
