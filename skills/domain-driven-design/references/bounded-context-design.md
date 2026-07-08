# Bounded Context Design

Use bounded context design when finding, sizing, naming, and owning the strategic
boundary that a domain model and its ubiquitous language live within: the
container every tactical pattern sits inside.

This reference has two parts. Part 1 - Principles are invariants: they always
hold, no choice involved. Part 2 - Decision procedures are forks and sequences
resolved per context or boundary, closed by a handoff note. Each procedure names
its discriminator, gives ordered options with observable conditions, and states
its hard limits. A sequence is run in full; a fork is entered at the matching
condition.

## Scope and Neighbors

- This document designs the bounded context itself: discovering its boundary,
  classifying its subdomain, sizing it, naming it, and assigning ownership.
- Use `core-domain-distillation.md` after subdomain classification when the core
  domain must be made explicit, protected, or separated from generic subdomains
  and cohesive mechanisms.
- Everything tactical inside a context - aggregates, entities, value objects,
  domain events, use cases, repositories - is designed with the respective
  family documents. This document draws the boundary they live inside.
- The static relationship between two contexts (upstream/downstream, ACL, OHS,
  Conformist, Partnership) is decided in `context-mapping.md`.
- Runtime coordination of a workflow across contexts is decided in
  `context-coordination.md`.
- Deployment topology - a module in a modulith or a separately deployed service
  - is a correlate of the boundary, not the boundary itself.

## Contents

- Core rule
- Part 1 - Principles
  - What a bounded context is
  - A bounded context is not a subdomain
  - Subdomains evolve
  - Language defines the boundary
  - The context owns its data
  - Boundaries align with teams
  - Topology is a correlate, not the boundary
  - Autonomy
- Part 2 - Decision procedures
  - Boundary discovery
  - Subdomain classification
  - Context-subdomain alignment
  - Boundary sizing
  - Ownership and team
  - Naming
  - Split or merge
  - Relating contexts
- Result notation
- Smell checks
- Expected output

## Core Rule

A bounded context is an explicit boundary within which one domain model and one
ubiquitous language are consistent and unambiguous. Inside it, a term means
exactly one thing. The context owns its model, its data, and its write-side
invariants, and integrates with other contexts only through contracts. The
boundary is chosen by language, business capability, and consistency needs, not
by technology, table, or convenience, and it should align with a single team.

## Part 1 - Principles

### What a Bounded Context Is

- An explicit boundary around one consistent domain model and its ubiquitous
  language.
- Inside it every term is unambiguous: one word, one meaning. The same word may
  mean different things in different contexts; that difference is a boundary, not
  a defect.
- It owns its model, its data, and its write-side invariants. No other context
  reaches into its model or its database.
- It is the unit of strategic design. Tactical patterns - aggregates, entities,
  value objects, events - live inside one context, never across two.

### A Bounded Context Is Not a Subdomain

- A subdomain is problem space: a part of the business domain, classified Core,
  Supporting, or Generic. A bounded context is solution space: a boundary drawn
  around a model. Conflating the two is the most common strategic-design
  mistake.
- The clean case is one context per subdomain, but they diverge: a legacy context
  may span several subdomains, and a large subdomain may be realized by several
  contexts.
- Classify the subdomain to decide investment; draw the context to decide the
  model boundary. They answer different questions.
- The distinction is a thinking tool, not a rigid taxonomy. Subdomain is a
  relative term - a subdomain is itself a domain, and the mapping to contexts is
  fuzzy: one-to-one is the ideal, several contexts per subdomain is legitimate.
  Keep the problem-space/solution-space split to reason clearly, without forcing
  a crisp line where the domain is genuinely fuzzy.

### Subdomains Evolve

- A subdomain's classification is a snapshot with a trajectory, not a permanent
  label. Domains move over time - genesis, custom-built, product, commodity -
  and a core domain can drift toward commodity as competitors catch up, while a
  supporting or generic one can become core.
- Record the direction of travel, not only the current position. A core domain
  being commoditized by a competitor's innovation is a strategic signal, not a
  stable state.
- Re-run the classification periodically. An investment decision made against a
  stale snapshot puts the best people in the wrong place.

### Language Defines the Boundary

- The ubiquitous language is scoped to the context. The primary boundary test is
  linguistic: if a term needs two definitions, there are two contexts; if two
  terms mean the same thing, there may be one.
- Model, code, and spoken language agree inside the context. Where a code name
  and the domain term differ, one of them is wrong.
- Capturing and maintaining the language itself, terms, definitions, and their
  evolution, is the subject of `ubiquitous-language.md`.
- Structure is not language. Who authors a concept, in which workflow it is
  created, where it is persisted, and what it appears next to in a user
  interface are workflow and persistence facts; they do not decide ownership.
  The language domain experts actually speak decides.
- A recorded boundary decision (ADR) is a testable hypothesis with its
  rationale attached, not evidence about the domain. Gather it as input,
  extract its premises, and test them against the living expert language and
  the discriminators here, the same way every other claim is tested. A
  confirmed ADR saves the walk; a refuted one is a finding that recommends
  revising the ADR, which is what ADRs are made for (superseding). Never let
  an ADR settle a question these procedures would answer differently, and
  never override one silently: a deliberate decision is challenged
  explicitly, with the evidence that broke its premises.
- Consumption is not ownership. Display, filtering, and search are read-side
  demand, served through contracts and read models from whichever context
  owns the concept (`read-model-design.md`); a concept does not belong to a
  context because that context shows it.

### The Context Owns Its Data

- Default to each context owning its persistence, including the authority to
  write and interpret its data. No shared tables, no foreign keys reaching into
  another context's model, and no reads against another context's private data.
- A shared physical database can be a topology or migration constraint, but it
  does not weaken ownership. Use clearly owned schemas or tables, expose
  contracts for cross-context access, and prevent foreign writes or queries
  against private data.
- Other contexts hold references by identity and integrate through contracts,
  never through internals.

### Boundaries Align With Teams

- A bounded context should be owned by one team. One team may own several
  contexts; a context split across teams loses its single language and model.
- This is Conway's law used deliberately: the boundary and the org chart shape
  each other, so align them on purpose.

### Topology Is a Correlate, Not the Boundary

- Whether a context is a module in a modulith or a separately deployed service is
  a deployment decision. The boundary is the model and the language; the topology
  follows the drivers - team autonomy, independent release, scaling - not the
  reverse.
- A modulith with clean context boundaries has the same strategic design as
  microservices, minus the network.

### Autonomy

- A context should be independently understandable and changeable: a reader
  grasps it without loading every other context, and a change inside it does not
  ripple through the others.
- Autonomy is bought with contracts and owned data, not with a shared model.

## Part 2 - Decision Procedures

### Boundary Discovery - sequence

Goal: find where a bounded-context boundary belongs.

1. Gather the domain language from the people who speak it: EventStorming,
   Domain Storytelling, or interviews. Record the terms and the pivotal events.
   Useful opening questions: what business capability is being improved; which
   part of the domain differentiates the organization; where do experts
   disagree about terms or rules; which rules change together and which
   independently; which decisions must stay locally consistent; who owns the
   language and lifecycle of each concept; and which boundary decisions are
   already recorded (ADRs, decision logs). Recorded decisions are gathered as
   input and audited with the same discriminators as everything else, never
   inherited untested.
2. Look for linguistic seams: the same term used with two meanings, or two terms
   for one concept. Each ambiguity is a candidate boundary.
3. Group by business capability: the distinct jobs the business does.
4. Overlay the subdomains from *Subdomain Classification*.
5. Check consistency: state that must change together in one transaction stays in
   one context.
6. Check rate of change and ownership: parts that change together and are owned
   by one team belong together.
7. Draw candidate boundaries where language, capability, consistency, and team
   align. Where they disagree, prefer the linguistic seam unless it would split a
   hard invariant that must be transactionally protected.
8. Name each context (*Naming*) and record its ubiquitous language
   (`ubiquitous-language.md`).

Hard limits: do not draw boundaries from database tables, layers, or entities.
The boundary is linguistic and capability-driven. A boundary that splits a single
invariant across two contexts is wrong; that invariant needs one context (see
`aggregate-design.md`).

### Subdomain Classification - fork

Discriminator: place the subdomain on two axes - business differentiation
(competitive advantage, expected ROI) and model complexity - rather than picking
one flat label. The classic Core, Supporting, and Generic buckets are positions
on that plane. The value is the cross-discipline conversation: engineers gauge
complexity, product and business people gauge differentiation.

Assess each axis with concrete clues before placing it:

- Differentiation: how hard would it be for a competitor to match this? How much
  advantage do you derive now, and potentially? Is it visible to customers as a
  reason to choose you?
- Complexity: is the hard part essential domain complexity, accidental technical
  complexity, or operational complexity? Does it need specialist talent that is
  scarce or expensive? How long does a newcomer take to become productive? Which
  Cynefin space - clear, complicated, or complex?

Then place and decide:

1. **High differentiation, whatever the complexity** -> Core. Build it in-house
   with the best people and the most modeling care; this is where tactical DDD
   earns its cost. Invest most where high differentiation meets high essential
   complexity.
2. **Low differentiation, business-specific, moderate complexity** -> Supporting.
   Build it simply, or outsource; do not over-invest. The label does not decide
   the implementation pattern: a supporting subdomain with genuine invariants
   may still earn a domain model; that judgment is made by invariant substance
   in `business-logic-pattern-selection.md`, not from the classification.
3. **Low differentiation, a solved problem every business needs** (auth,
   payments, email) -> Generic. Buy or adopt off-the-shelf when suitable, keep
   the local model thin, and protect the local language when the external model
   would leak into the domain.

Watch the two mismatch diagonals the flat labels hide:

- **High complexity, low differentiation** -> you are over-investing in something
  that does not set you apart, often accidental complexity in a supporting
  subdomain. Simplify or buy it; do not mistake the complexity for importance.
- **High differentiation, low complexity** -> your advantage is easily copied.
  Protect it and watch for commoditization (*Subdomains Evolve*).

Hard limits: do not spend core-level modeling on a generic subdomain; do not buy
a generic solution for your core, because that is buying away your advantage.
High accidental complexity is a signal to simplify, not evidence of a core
domain. Criticality is not differentiation: "we cannot operate without it"
marks a mission-critical supporting subdomain, not a core one; necessity is an
operational property. When more than one subdomain is claimed core, or the
claim rests on criticality, run the distillation gate
(`core-domain-distillation.md`, *Qualification*).

### Context-Subdomain Alignment - fork

Discriminator: how do the model boundary and the problem-space subdomain line up?

1. **One context per subdomain** -> the clean default; keep them aligned.
2. **One subdomain, several contexts** -> acceptable when the subdomain is large
   and has internal linguistic seams; each context keeps one language.
3. **One context spanning several subdomains** -> avoid as the default. Accept it
   only when one language, one model, and one owning team remain genuinely
   cohesive, or as an explicit legacy/migration state with a recorded extraction
   path.
4. **A concept needed today whose recorded future owner is a planned, not yet
   built context** -> an existing context may host it as declared custodian:
   record the owner and the extraction path, and name the concept in the
   owner's language. Custody adds no machinery: the model is shaped no further
   than the tactical rules already demand today (value objects for constrained
   values, enforced invariants); published schemas, version negotiation, or
   adapters for the future owner are speculation and wait until that owner
   exists. Done this way, extraction stays a data migration, not a remodel.
   Custody is not ownership; the host gains no authority over the concept's
   rules. A concept nothing needs today is not hosted anywhere; it is not
   built.

Hard limit: a context spanning subdomains is not a goal by itself. Name the
reason, the owner, and the cost of keeping it.

### Boundary Sizing - fork

Discriminator: is the boundary carrying one language and model, or straining?

1. **Two ubiquitous languages, or a term with two meanings, inside one context**
   -> too big; split along the linguistic seam unless doing so would split a
   hard invariant.
2. **Constant chatty integration, shared invariants across the boundary, or a
   change that always touches both sides** -> too small or mis-cut; merge or move
   the seam.
3. **One language, a cohesive capability, integration through a few stable
   contracts** -> right-sized.

Hard limits: do not split so far that a single invariant or a single transaction
spans contexts; do not merge until two languages share one model. Size by
language cohesion, not by line count.

### Ownership and Team - sequence

Goal: assign the context to a team without fracturing its language.

1. Assign each context to exactly one owning team.
2. Allow one team to own several contexts when their languages are distinct and
   the team's capacity fits.
3. Reject a context owned by two teams: either split it into two contexts with a
   mapped relationship, or give it to one team.
4. Record the team as the design owner of the language and the contracts.
5. Staff by classification: put the strongest people on the core contexts. A
   generic or supporting context does not need the elite team, and staffing it as
   if it did starves the core.
6. Choose the team interaction mode (Team Topologies), not only ownership. Two
   contexts with heavy back-and-forth may need collaboration now, but a maturing
   core capability often moves to an as-a-service relationship once its focus is
   clear, cutting coordination cost. Revisit the mode as the subdomain evolves.

Hard limit: a context with two owning teams has two languages waiting to diverge;
resolve it before it does. Team design is part of the investment decision, not a
downstream consequence of it.

### Naming - sequence

Goal: name the context in its own language.

1. Name the context after the business capability and its language: `Ordering`,
   `Billing`, `Catalog`, `Identity`.
2. Do not name it after a technology, a layer, a database, or a team.
3. Ensure the name is a term from the context's ubiquitous language, meaningful
   to domain experts.

Hard limit: a context named after a technology or a table has already lost its
language.

### Split or Merge - fork

The inverse audit direction: start from an existing context and decide whether to
keep, split, or merge it.

Discriminator: does the existing context hold exactly one ubiquitous language and
one cohesive model?

1. **Two languages, or a term with two meanings, inside it** -> split along the
   linguistic seam into two contexts with a mapped relationship
   (`context-mapping.md`), unless doing so would split a hard invariant.
2. **It cannot be understood or changed without another context, integration is
   constant and chatty, and one change always touches both** -> merge, or move
   the boundary so the coupled parts share a context.
3. **It spans a Core and a Generic subdomain** -> usually carve the generic part
   out to a bought or adopted solution behind an adapter or ACL. Direct adoption
   is acceptable when a stable external Published Language fits and does not
   pollute the local model.
4. **One language, cohesive model, stable contracts** -> keep.

Hard limits: split and merge change contracts and data ownership. Treat them as
migrations, not refactors; never split a single invariant across the new
boundary.

### Relating Contexts - handoff

Not a decision procedure: once boundaries are drawn, this document stops. The static relationship between
two contexts - upstream/downstream, ACL, OHS, Conformist, Partnership, Separate
Ways - is decided in `context-mapping.md`. The runtime coordination of a
workflow across contexts is decided in `context-coordination.md`. This document
draws the boundary; those decide how boundaries relate and interact.

## Result Notation

Use this compact notation when summarizing a context:

`ContextName | subdomain type | owning team | capability | key language terms`

Context table:

| Field | Decision |
| ----- | -------- |
| Name | In the context's ubiquitous language |
| Subdomain | Differentiation x complexity position, its Core/Supporting/Generic bucket, and the build/buy decision |
| Trajectory | Direction of travel, toward or away from core |
| Capability | The business job it covers |
| Owns | Model, data, write-side invariants |
| Language | The terms it defines, and any that collide with other contexts |
| Team | The single owning team, and its interaction mode with neighbors |
| Topology | Module or service, recorded as a correlate |
| Relationships | Contexts it integrates with, resolved in context mapping |

## Smell Checks

- The same term means two things inside one context.
- Two contexts share a database, tables, or foreign keys into each other's model.
- A shared physical database is used as permission for shared ownership,
  cross-context queries, or foreign writes.
- A context is named after a technology, a layer, a database, or a team.
- A context is owned by two teams.
- A single invariant or transaction spans two contexts.
- Core-level modeling is spent on a generic subdomain, or a generic solution is
  bought for the core.
- High complexity is mistaken for importance: a low-differentiation subdomain is
  treated as core because it is hard.
- Subdomain classification is treated as a fixed label instead of a snapshot with
  a trajectory, so a commoditizing core keeps the best team.
- The elite team is staffed onto a supporting or generic context, starving the
  core.
- Boundaries are drawn from tables, layers, or entities instead of language and
  capability.
- A context cannot be understood or changed without loading several others.
- Subdomain (problem space) and bounded context (solution space) are conflated.
- Deployment topology (service vs module) is treated as the boundary.
- A context spans several subdomains without a named reason, owner, and cost.

## Expected Output

When designing a bounded context, emit:

- The context name, in its ubiquitous language.
- Subdomain position on differentiation x complexity, its Core/Supporting/Generic
  bucket, its trajectory, and the investment decision it implies.
- The boundary: the ubiquitous language it owns and the capability it covers.
- What it owns: model, data, write-side invariants.
- The single owning team, its staffing relative to the classification, and its
  interaction mode with neighboring contexts.
- Alignment with its subdomain, and any noted tension.
- Integrations: which other contexts it relates to, with the relationship itself
  resolved in `context-mapping.md`.
- Topology note: module or service, recorded as a correlate only.
- For an audit: a keep, split, or merge verdict with the linguistic evidence.
