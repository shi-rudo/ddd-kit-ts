# Context Coordination Patterns

Use this to choose how an interaction that crosses bounded-context boundaries is
coordinated at runtime. It is an internal decision thread for the agent, not a
user-facing script: gather the interaction's shape and constraints, then walk the
procedure.

Coordination splits by direction, and that split is the first decision.
**Write-side** coordination drives a cross-context workflow that changes state -
its concerns are order, consistency, compensation, and durability.
**Read-side** coordination assembles a cross-context view - its concerns are
freshness, latency, and partial failure. They are different problem classes with
different patterns and different axes.

This reference has two parts. Part 1 - Principles are invariants: they always
hold, no choice involved. They are grouped into shared principles and then
write-side and read-side principles. Part 2 - Decision procedures are forks and
sequences, gated first by direction, then specialized per side. Each names its
discriminator, gives ordered options with observable conditions, and states its
hard limits. A sequence is run in full; a fork is entered at the matching
condition.

## Scope and Neighbors

- This document chooses the runtime coordination of an interaction spanning
  multiple bounded contexts, on the write side (a workflow) or the read side (a
  view).
- The static relationship between the contexts - who is upstream, ACL vs
  Conformist, OHS/PL - is a separate concern; see `context-mapping.md`.
- Whether a consequence is a single event or a multi-step process is gated in
  `domain-event-design.md` (Process shape); this document is the deeper
  treatment once a multi-step cross-context interaction is confirmed.
- If this document chooses a saga, use `saga-design.md` to design the saga state
  machine, step classifications, compensation, retries, timeouts, and repair.
- If read composition lands on a materialized projection, use
  `read-model-design.md` to design the read model itself: shape, feeding,
  consistency handling, and rebuild.
- Event mechanics - payload, delivery, idempotency, ordering - live in
  `domain-event-design.md`.
- Business invariants stay inside aggregates (`aggregate-design.md`);
  coordination calls them, it never holds them.

## Contents

- Core rule
- Part 1 - Principles
  - Shared principles
  - Write-side principles
  - Read-side principles
- Part 2 - Decision procedures
  - Direction
  - Write-side: write coordination
  - Write-side: coordination style
  - Write-side: orchestration locus
  - Write-side: durability and compensation
  - Write-side: saga style
  - Read-side: read composition
- Result notation
- Pattern reference
  - Write-side patterns
  - Read-side patterns
- Smell checks
- Expected output

## Core Rule

Context coordination splits by direction. Write-side coordination drives a
cross-context workflow that changes state; its concerns are order, consistency,
compensation, and durability, and it is chosen along three axes: style, locus,
and guarantees. Read-side coordination assembles a cross-context view; its
concern is freshness against coupling, and it is chosen along one axis:
read-time composition vs a materialized projection. Decide the direction first.
A coordinator on either side holds only its own coordination state, never the
business invariants of any context, and speaks contracts, not shared domain
models.

## Part 1 - Principles

### Shared Principles

Apply to both write-side and read-side coordination.

- **What coordination decides.** Coordination drives an interaction that crosses
  bounded-context boundaries at runtime. It is not the static relationship
  between the contexts.
- **No business invariants in the coordinator.** Whether it is a saga or an API
  composer, a coordinator calls contexts through their contracts and never
  reimplements their rules. A coordinator that decides business rules is a rule
  engine, not a coordinator.
- **Contracts, not shared models.** Coordination speaks DTOs and a Published
  Language across the boundary, never shared domain types. Shared models couple
  contexts like a shared database and block autonomous evolution.
- **Correlation and observability.** Every multi-step or multi-context
  interaction carries a correlation id, propagated to every call, so the flow can
  be traced and reconstructed from logs. On the write side this id also anchors
  idempotency.
- **Coordination does not open context boundaries.** It composes context APIs and
  never imports internal domain objects or reaches past a facade into internals;
  it establishes no shared state between contexts or micro-frontends.
- **Topology is a correlate, not a driver.** Microservices vs modulith changes
  the mechanics - network vs in-process, HTTP vs facade - not the pattern. The
  drivers are context separation, team autonomy, and consistency or freshness
  needs. Never infer the pattern from the deployment topology.

### Write-Side Principles

- **The three write choices.** A write workflow is chosen along three independent
  axes: style (orchestration vs choreography), locus (client, BFF, application
  service, or workflow service), and guarantees (ephemeral vs durable, with vs
  without compensation). A recommendation is a tuple `style | locus | guarantees`.
- **The coordinator holds process state, not domain state.** Which step, what is
  pending, the correlation id - process state. Domain state stays in the
  contexts; the client in particular keeps only process and UI state.
- **Idempotency of mutations is mandatory where delivery can duplicate.**
  Network retries, at-least-once messaging. Each step carries an idempotency key;
  retry only technical failures; treat a business rejection as a controlled
  transition, never as a retry. See `domain-event-design.md`.
- **Durable coordination of partial success is a saga**: durable process state
  plus compensation, or plus forward recovery of partial success as a
  first-class concern (`saga-design.md`). A saga is never run in the client.
  The browser is not a reliable environment for side effects that must complete:
  a closed tab, a refresh, or a dropped network ends the process.

### Read-Side Principles

- **The read axis is freshness against coupling.** A read is chosen mainly by how
  fresh it must be: read-time composition (fresh, but coupled to the sources at
  query time and paying fan-out latency) vs a materialized projection (fast and
  decoupled, but eventually consistent). This axis, not style/locus/guarantees,
  governs reads.
- **Reads hold no business rules.** A read coordinator joins contract responses;
  it does not enforce invariants and does not reshape another context's model
  into a shared one.
- **Name the consistency.** An event-fed read model is eventually consistent by
  construction; a composed read is fresh but pays fan-out latency and
  partial-failure cost. State which, and never use a materialized projection
  where the whole view must be fresh at read time. The one exception is
  read-your-own-writes freshness for a single actor, achievable on a projection
  with wait-for-version (`read-model-design.md`, *Consistency Handling*).
- **No sagas, no compensation, no durable process state on the read side.** Those
  are write-side concerns. If a "read" needs them, it is really a write workflow
  - return to Direction.

## Part 2 - Decision Procedures

### Direction - fork

The primary gate. Discriminator: does the interaction change state across
contexts, assemble a view, or need no coordination at all?

1. **One context, one call** -> direct request/response. No coordination pattern.
   Stop.
2. **One decision with one downstream consequence** -> likely a single domain
   event, not a coordinator. Resolve in `domain-event-design.md` (Process
   shape). Stop.
3. **A multi-step workflow with side effects across contexts** -> the write-side
   track. Continue at Write Coordination.
4. **A view assembled from several contexts** -> the read-side track. Continue
   at Read Composition.

Hard limits: do not introduce a coordinator for a one-call or single-event
interaction - it invents a process where none exists. Do not solve a read with a
write workflow, or a write with a read aggregator.

### Write-Side: Write Coordination - sequence

Goal: produce `style | locus | guarantees` for one cross-context write workflow.

1. Choose the style (Coordination Style).
2. If orchestration, choose the locus (Orchestration Locus).
3. Determine the guarantees (Durability and Compensation); this may escalate to
   a saga.
4. If it is a saga, choose the saga style (Saga Style), then design it with
   `saga-design.md`.
5. Add correlation and per-step idempotency.
6. Emit the tuple `style | locus | guarantees` and the saga verdict.

### Write-Side: Coordination Style - fork

Discriminator: does the workflow need one place that knows and controls the
order, or can each context react independently to events?

1. **Strict order, an explicit process view (states and transitions), one owner
   of the flow, a need to see and debug the whole journey** -> orchestration.
2. **Loose coupling valued over deterministic control, autonomous participants,
   reactions extensible without touching a central place, independent teams** ->
   choreography.
3. **Complexity as a tiebreaker**: as participants and branching grow, a
   choreographed flow becomes hard to see and reason about - central
   orchestration re-simplifies. Few steps with high autonomy favor choreography.
4. **Orchestration over a fixed, linear route with no runtime branching** ->
   the lightweight variant is a routing slip: the itinerary is decided up front
   and travels with the message instead of a central runtime coordinator
   holding per-call state (*Routing slip* in the pattern reference). Escalate
   to a process manager when the route needs decisions or state.

Hard limits: a choreographed flow must be documented somewhere, because no
central place shows it; an orchestrator must not absorb business rules; never
choose the style by deployment topology. Keep choreography events stateless
facts - a shared queue or store that holds cross-participant "workflow state"
for every participant to read edges back toward shared state and re-couples the
participants; if participants need shared journey state, that is a signal for
orchestration, not choreography.

### Write-Side: Orchestration Locus - fork

Discriminator: trust, reuse across clients, security, and durability needs.

1. **Client (browser)** -> a client-orchestrator: an ephemeral journey, a single
   client, UX sequencing, no sensitive rules, no durable or compensation need.
2. **Server edge / BFF** -> when the client would make too many downstream
   calls, when security or token handling should stay server-side, or when
   aggregation or caching is needed. One UI's composition, moved off the client.
3. **In-process application service (modulith)** -> coordinate module facades
   server-side when multiple clients (web, mobile, API) share the journey, or the
   rules are sensitive. In a modulith the orchestrator calls facades only.
4. **Dedicated workflow / orchestration service** -> durable, long-running,
   compensating, cross-team coordination.

Hard limits: sensitive rules and multi-client reuse push the locus off the
client; the client is never the locus for durable or compensating coordination;
in a modulith the orchestrator uses facades only, never a module's internal
entities or repositories.

### Write-Side: Durability and Compensation - fork

Discriminator: must the process survive crashes, and must partial effects be
undone on failure?

1. **Ephemeral, abort-on-failure, UI or caller decides recovery** -> plain
   orchestration (client or server). Not a saga.
2. **Durable process state but no partial-success coordination - the process
   resumes after a crash, nothing to undo or drive forward step by step** -> a
   process manager without compensation. Server-side.
3. **A distributed business transaction across contexts, with durable state,
   partial success coordinated through compensating actions or first-class
   forward recovery, timeouts and recovery as first-class, and async
   triggers** -> a Saga. Server-side.

Hard limits: durable plus compensation is a Saga, never in the client; a saga's
compensation is a business action in the owning context, not undo logic in the
coordinator; the coordinator holds saga state, never the contexts' invariants; a
coordinator that quietly grows durable state and compensation is a mislabeled
saga - rename and move it server-side.

### Write-Side: Saga Style - fork

Discriminator: once it is a saga, does a central saga-orchestrator drive it, or
do events chain the steps?

1. **Central saga orchestrator** -> the flow is visible in one place,
   compensation order is easier to reason about; prefer for complex branching or
   many participants.
2. **Choreographed saga** -> events chain steps with no central coordinator;
   prefer for few steps and high participant autonomy; accept that the flow is
   harder to trace.

Hard limit: a choreographed saga still needs its compensation paths documented,
because no central place shows them.

### Read-Side: Read Composition - fork

Discriminator: how fresh must the cross-context read be, and how many contexts
does it touch?

1. **A single context, or one call is enough** -> direct request/response.
2. **A view assembled from a few known contexts, freshness required at read
   time** -> API composition: the caller (a composer or BFF) fans out to a fixed
   set, then joins in memory. Weigh the latency and partial-failure cost.
3. **A query broadcast to many or dynamic responders, best-effort gather within
   a time budget** -> scatter-gather: fan out to all, aggregate whatever returns
   in the window, tolerate missing responses. Use when the responder set is open
   or partial results are acceptable; not when every context must answer.
4. **A frequently read view over many contexts, some staleness tolerable** -> an
   event-fed read model (CQRS-style projection) maintained from the contexts'
   events. Design the projection itself in `read-model-design.md`; see
   `domain-event-design.md` for the event mechanics.

Hard limits: a read coordinator holds no business rules and joins contracts, not
internal models; an event-fed read model is eventually consistent by
construction - do not use it where the whole view must be fresh at read time
(read-your-own-writes for one actor is the wait-for-version exception, see
`read-model-design.md`); a read aggregator is not a workflow coordinator; if the
"read" needs durable state or compensation, it is a write workflow - return to
Direction.

## Result Notation

A write-side recommendation is `style | locus | guarantees`. A read-side
recommendation is a single composition choice. The common named combinations:

**Write-side:**

| Style         | Locus                 | Guarantees             | Named pattern             | Meaning                                         |
| ------------- | --------------------- | ---------------------- | ------------------------- | ----------------------------------------------- |
| Orchestration | Client                | Ephemeral              | Client-orchestrator       | UI journey sequenced in the browser             |
| Orchestration | BFF / server edge     | Ephemeral              | BFF orchestration         | Composition moved server-side (calls, security) |
| Orchestration | In-process service    | Ephemeral or durable   | Application-service orch. | Modulith journey over module facades            |
| Orchestration | In-process or workflow service | Durable, no compensation | Process manager   | Resumes after a crash, does not undo            |
| Orchestration | Itinerary on the message | Ephemeral           | Routing slip              | Fixed linear route travels with the request     |
| Orchestration | Workflow service      | Durable + compensation | Orchestrated saga         | Central saga coordinator, server-side           |
| Choreography  | Distributed (events)  | Ephemeral              | Choreography              | Contexts react to events, no central control    |
| Choreography  | Distributed (events)  | Durable + compensation | Choreographed saga        | Event-chained distributed transaction           |

Any durable coordination is off-client, with or without compensation. Durable
plus compensation in the browser is the worst case: a saga in the browser.

**Read-side:**

| Composition         | Freshness             | Named pattern        | Meaning                                 |
| ------------------- | --------------------- | -------------------- | --------------------------------------- |
| Single call         | Fresh                 | Direct request       | One-context read                        |
| Fan-out, fixed set  | Fresh                 | API composition      | Fan-out read, in-memory join            |
| Broadcast, open set | Fresh, best-effort    | Scatter-gather       | Gather partial results in a time budget |
| Materialized view   | Eventually consistent | Event-fed projection | Cross-context read model from events    |

## Pattern Reference

Each named pattern: what it is, its mechanics, its key trade-off, and the
boundary at which it escalates into the next. The forks decide which one; this
section characterizes each; project-specific pattern documents may add deeper
mechanics or diagrams when they exist.

### Write-Side Patterns

**Direct request/response.** One context calls another and waits. No process, no
coordinator. Mechanics: a single synchronous call over a contract. Trade-off:
simplest possible, but tight temporal coupling - the caller waits and fails if
the callee is down. Escalates when a second dependent call appears: two or more
ordered cross-context calls is a workflow, not a request.

**Client-orchestrator.** A browser-side coordinator that sequences a UI journey
across context APIs, holding journey state in the client. Mechanics: creates a
`processId` before the first step, calls contexts in order via contracts, keeps
only process/UI state, closes the process explicitly. Trade-off: excellent UX
control and clear context boundaries, but the browser is untrusted and
ephemeral. Escalates to BFF orchestration when calls, security, or aggregation
grow; to a saga the moment durable state or compensation appears.

**BFF orchestration.** The same orchestration moved to a server edge dedicated to
one experience. Mechanics: a Backend-for-Frontend composes downstream calls,
handles tokens, aggregates and caches. Trade-off: removes the browser's trust and
call-count limits, at the cost of a server component per experience. Escalates
to a workflow service when the process must be durable or cross-team.

**Application-service orchestration.** Server-side orchestration inside a
modulith, coordinating module facades. Mechanics: an application service above
the facades sequences calls in-process; idempotency optional for synchronous
calls. Trade-off: keeps module boundaries while allowing multi-client reuse and
sensitive rules server-side; risks accidental coupling if it bypasses facades.
Escalates to a saga when in-process calls become async or need compensation.

**Process manager.** A stateful coordinator that maintains the sequence state and
determines the next step (Hohpe/Woolf, EIP). Mechanics: durable process state,
explicit steps and transitions, one place that knows the flow. Trade-off:
resilient and inspectable, but a central component to own and operate. It is the
parent of the orchestrated saga; it becomes one when it adds compensation or
first-class forward recovery of partial success.

**Routing slip.** A lightweight orchestration where the route is predetermined
and travels with the request, each step forwarding to the next (Hohpe/Woolf,
EIP). Mechanics: no central runtime coordinator holds per-call state; the
itinerary is attached to the message. Trade-off: simpler than a process manager
for a fixed linear route, but poor for branching or dynamic flows. Escalates to a
process manager when the route needs decisions or state.

**Orchestrated saga.** A process manager specialized for a distributed
transaction with compensation. Mechanics: durable state, a central coordinator
issuing commands, compensating actions per completed step on failure, timeouts
and recovery. Not every step needs a compensation: steps past the point of no
return (the pivot) are retried forward to completion rather than compensated.
Trade-off: consistency across contexts without 2PC, at the cost of
compensation complexity concentrated in one coordinator. Server-side only; never
in the client. Use `saga-design.md` for the detailed design.

**Choreography.** Decentralized coordination: contexts publish events and others
react, with no central control. Mechanics: publish and consume stateless event
facts; each participant owns its own reaction. Trade-off: maximal decoupling and
extensibility, but the overall flow is emergent and hard to see or debug.
Escalates to a choreographed saga when compensation and durability are needed; a
signal to switch to orchestration is when participants start needing shared
journey state.

**Choreographed saga.** A distributed transaction driven by events rather than a
central coordinator, with compensation. Mechanics: events chain forward steps,
and failure events trigger compensating actions in each participant. Trade-off:
no central bottleneck, but compensation logic is spread across participants and
the flow is the hardest to trace. Document the compensation paths, since no
central place shows them. Use `saga-design.md` for the detailed design.

### Read-Side Patterns

**Direct request/response (read).** A single-context read over a contract. The
baseline; becomes a composition the moment a second context must contribute to
the view.

**API composition.** A composer fans out to a fixed set of contexts and joins
their contract responses in memory (Richardson). Mechanics: parallel or
sequential reads, in-memory join, no persistence. Trade-off: fresh reads without
a maintained projection, but fan-out latency and partial-failure handling grow
with the number of contexts. Escalates to an event-fed read model when the same
view is read often and staleness is acceptable.

**Scatter-gather.** A read broadcast to many or dynamic responders, aggregating
whatever returns within a time budget (Hohpe/Woolf, EIP). Mechanics: fan out to
an open set, collect responses in a window, tolerate missing ones. Trade-off:
works with an open responder set and partial results, but the result is
best-effort by design. Not for reads where every context must answer.

**Event-fed read model (projection).** A materialized cross-context view kept up
to date from the contexts' events (CQRS-style). Mechanics: subscribers project
events into a query-optimized store; design the projection mechanics in
`read-model-design.md`. Trade-off: fast, resilient reads decoupled from the
sources, but eventually consistent by construction. Never use where the whole
view must be fresh at read time; read-your-own-writes for one actor is the
wait-for-version exception.

## Smell Checks

Shared:

- A coordinator (write or read) decides business rules instead of calling the
  contexts - an orchestrator or aggregator as a business rule engine.
- The coordinator unifies context models into a shared "domain" - a shadow
  domain that breaks bounded contexts.
- Shared state or shared domain models between micro-frontends or contexts.
- The pattern chosen from deployment topology rather than from consistency,
  freshness, or autonomy needs.
- The correlation id created after the first step, or missing entirely.

Write-side:

- A durable, compensating saga run in the browser.
- The orchestrator reaches into a module's internal entities or repositories
  instead of its facade.
- In-process coordination with no explicit contracts - creeping coupling because
  "it is all one process".
- A choreographed flow with no documentation of the emergent process.
- A coordinator that holds durable process state and compensation but is still
  called a client-orchestrator - a mislabeled saga.
- Business (domain) state kept in the client instead of only process and UI
  state.

Read-side:

- A materialized projection used where the whole view must be fresh at read
  time, with no wait-for-version or write-side fallback for the reads that need
  it.
- A read aggregator that holds business rules or reshapes a source's model.
- A "read" that has grown durable state or compensation - it is a write workflow
  in disguise.
- A scatter-gather used where every context must answer - best-effort results
  where completeness is required.

## Expected Output

When recommending a coordination pattern, emit:

- The direction: write workflow, read view, or no coordination (direct call or
  single event).

For a write workflow:

- Style: orchestration or choreography, and why.
- Locus, if orchestration: client, BFF, application service, or workflow service,
  and why.
- Guarantees: ephemeral or durable, with or without compensation, and the saga
  verdict.
- Saga style, if it is a saga: orchestrated or choreographed.
- Correlation and per-step idempotency strategy.

For a read view:

- Composition: direct, API composition, scatter-gather, or event-fed projection,
  and why.
- The consistency named: fresh (with its fan-out/partial-failure cost) or
  eventually consistent.

For both:

- The contracts used, confirming no shared domain models cross the boundary.
- A note that topology was recorded as a correlate only, not as a reason.
