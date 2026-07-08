# Business Logic Pattern Selection

Use business logic pattern selection to decide, before tactical modeling, whether
a subdomain even warrants a domain model, and which implementation,
architecture, and testing style follow from that. This operationalizes Vlad
Khononov's decision tree from *Learning Domain-Driven Design* so an agent can
walk it node by node.

This reference has two parts. Part 1 - Principles are invariants: they always
hold, no choice involved. Part 2 - Decision procedures are the decision tree plus
a reference for its outcomes. The tree names each gate with its question and
routes to a terminal; the reference explains what each terminal means and its
hard limits. Walk the tree in order; a gate is a branch, not a rewordable
heuristic.

## Scope and Neighbors

- This document selects the business-logic implementation pattern, the
  architecture pattern, and the testing strategy for one subdomain.
- The subdomain type that feeds the first gate comes from
  `bounded-context-design.md` (core, supporting, generic).
- If several candidates look core, or the core is diluted by generic subdomains
  or mechanisms, use `core-domain-distillation.md` before selecting the tactical
  implementation pattern.
- If the tree lands on Domain Model or Event-Sourced Domain Model, continue with
  `aggregate-design.md`, `entity-design.md`, `value-object-design.md`, and
  `domain-event-design.md`.
- If the tree lands on Transaction Script or Active Record, aggregate, entity,
  value-object, and domain-event modeling usually do not apply. The model is
  scripts, records, and services instead.
- `use-case-design.md`, `repository-design.md`, and `error-management-design.md`
  apply across all patterns, but their weight differs by pattern.
- Ports and Adapters mechanics are implementation-specific. The CQRS read side
  draws on `repository-design.md` for read models and `context-coordination.md`
  for read composition.
- This is the answer to "do I even need aggregates here?". Do not reach for the
  tactical documents until the tree says Domain Model.

## Contents

- Core rule
- Part 1 - Principles
  - The pattern follows the subdomain
  - Rich model is not always the goal
  - Invariant substance, not the label, justifies a domain model
  - Data complexity vs logic complexity
  - Architecture and testing follow the pattern
  - The mapping is a default, not a prohibition
  - The choice can evolve
- Part 2 - Decision procedures
  - Selection
  - Pattern reference
- Result notation
- Smell checks
- Expected output

## Core Rule

Not every subdomain deserves a rich domain model. The implementation pattern
follows the subdomain's type and the shape of its data and logic: a simple
supporting or generic subdomain is well served by a transaction script or active
record; a core subdomain earns a domain model, or an event-sourced one when full
business history must be the source of truth. The architecture and testing
strategy follow from that choice. Over-engineering a simple subdomain with a
domain model is as wrong as under-engineering a core one with a transaction
script.

## Part 1 - Principles

### The Pattern Follows the Subdomain

- The business-logic pattern is a consequence of the subdomain type and its
  complexity, not a house style applied everywhere.
- A core subdomain warrants a domain model; a supporting or generic subdomain
  usually does not.
- Match the tool to the job in both directions: do not gold-plate a simple
  subdomain, and do not starve a complex one.

### Rich Model Is Not Always the Goal

- A behavior-rich domain model is the right tool only when the subdomain has
  genuine invariants and complex logic to protect. There, an anemic model is a
  smell (see `aggregate-design.md`, `entity-design.md`).
- In a transaction-script or active-record subdomain, "anemic" data structures
  are correct, not lazy: the logic legitimately lives in scripts or services
  because there is little invariant to protect. This resolves the apparent
  contradiction with the tactical documents: anemic is a smell inside the
  domain-model path and expected outside it.
- Choose the path first; only then does the anemic-versus-rich judgment apply.

### Invariant Substance, Not the Label, Justifies a Domain Model

- The tree's gates are a correlation, not a law. Subdomain type and
  data-structure complexity are proxies for logic complexity, and the proxy is
  imperfect. "Supporting" is a strategic classification - not differentiating -
  not a statement that the logic is simple. A supporting subdomain can hold
  genuine invariants.
- The real discriminator is invariant substance: can you name an immediate
  invariant the model would protect? This is the same test as reclassification in
  `aggregate-design.md`. If yes, a domain model is justified regardless of the
  subdomain type; the anti-anemic rule applies there too.
- Modeling a supporting subdomain as a domain model is legitimate, not a smell,
  in three cases: it has real invariants; a deliberate monorepo-wide consistency
  choice is worth the cost; or it is drifting toward core and the investment is a
  declared trajectory bet. Practicing or learning is also fine when named as
  such.
- The smell is not "a domain model for a supporting subdomain". It is
  domain-model form with no domain-model substance: aggregates and value objects
  wrapping data that has no invariant to protect. Such a model becomes anemic by
  construction and trips the anemic smell in `entity-design.md`. If you cannot
  name the invariant, choose active record or transaction script, or accept the
  consistency override with eyes open.

### Data Complexity vs Logic Complexity

- Two axes explain why the gates map as they do: how complex the data structures
  are, and how complex the business logic and invariants are.
- Simple data and simple logic suit a transaction script. Complex data with
  simple logic suit an active record. Complex logic with invariants suits a
  domain model.
- These are the rationale behind the tree's gates, not extra gates. The
  executable discriminators are the gate questions in *Selection*: subdomain
  type, complex data structures, the history need, and multiple persistent
  models.

### Architecture and Testing Follow the Pattern

- The architecture pattern - layered, ports and adapters, CQRS - follows the
  business-logic pattern and the multiple-models gate, not the reverse.
- The testing strategy follows the architecture: a thin layered stack is best
  covered by integration and end-to-end tests; a rich model behind ports and
  adapters is best covered by fast unit tests.
- Choosing an architecture or a test shape that fights the pattern is wasted
  effort.

### The Mapping Is a Default, Not a Prohibition

- The tree gives the proportionate default for each subdomain, not a universal
  rule. The benefit of an architecture scales with what it protects: ports and
  adapters earn their cost by isolating a rich model, so they are the default for
  a domain model and overkill - not forbidden - for a transaction script.
  Deviating for a concrete reason, such as swapping infrastructure or testing
  without HTTP, is legitimate.
- One deviation is different in kind. Choosing ports and adapters for an active
  record does not merely add ceremony; it contradicts the pattern. Active record
  couples the object to persistence by definition: the object is the row and
  knows how to save itself. Ports and adapters invert that dependency and hide
  persistence behind a driven port. An active record behind a repository port is
  no longer an active record; it is a data mapper plus a domain model.
- Cockburn's hexagonal architecture is broader than the domain-model cell. Its
  original aim was isolating the application from external agencies - UI,
  database, other systems - not specifically protecting a rich model. Driven
  ports at the edges, such as a payment gateway testable without a real call, can
  help even a thin application. The tree decides the inner architectural style
  and is coarse there; it does not forbid driven ports at the edges of a
  transaction-script or active-record subdomain.
- Proportionality versus consistency is a real trade-off, sharpest in a
  monorepo. The tree says match the architecture to the subdomain; a uniform
  hexagonal codebase often says the opposite - one architectural form across
  every context so the codebase stays consistent. That override is a legitimate
  choice, not a violation. Weigh it by cost: for a transaction script the
  override is cheap; for an active record it is expensive because you fight the
  pattern, or abandon it for a data mapper and a domain model.

### The Choice Can Evolve

- A subdomain's pattern can change as the subdomain evolves (see *Subdomains
  Evolve* in `bounded-context-design.md`). A supporting subdomain drifting toward
  core may need to migrate from active record to a domain model.
- Migration between patterns is a real cost. Choose with the trajectory in mind,
  but do not pre-build a domain model for a subdomain that is not core yet.

## Part 2 - Decision Procedures

### Selection - decision tree

Walk the gates in order. Each gate routes to the next gate or to a terminal. Use
the gate questions as discriminators rather than paraphrasing them into a softer
heuristic.

**Gate 1 - Subdomain type** (from `bounded-context-design.md`).

- Supporting or generic -> Gate 2.
- Core -> Gate 3.

**Gate 2 - Complex data structures?** (supporting / generic branch)

- No -> **Transaction Script** -> Gate 4.
- Yes -> **Active Record** -> Gate 4.

**Gate 3 - Full business history as source of truth?** (core branch)

- No -> **Domain Model** -> Gate 4.
- Yes -> **Event-Sourced Domain Model** -> architecture is **CQRS** by
  construction -> **testing pyramid**. Terminal.

Note: not every audit-log need justifies event sourcing. The discriminator is
that full business history must be the source of truth, not merely recorded for
compliance, debugging, or diagnostics. This tightens Khononov's original gate,
which asks whether the subdomain needs an audit log, money tracking, or
analysis of behavior; those needs alone over-select event sourcing, because an
audit or analytics requirement is often served by recorded domain events or a
projection while state remains the source of truth. The tightened gate is a
deliberate deviation from the source, not a paraphrase.

**Gate 4 - Multiple persistent models?** (separate persistent representations
for reads and writes, not merely DTOs or response shapes)

- Yes -> **CQRS** -> **testing pyramid**. Terminal.
- No -> the pattern's default architecture:
  - Transaction Script -> **Layered architecture, 3 layers** -> **reversed
    testing pyramid**. Terminal.
  - Active Record -> **Layered architecture, 4 layers** -> **testing diamond**.
    Terminal.
  - Domain Model -> **Ports and Adapters** -> **testing pyramid**. Terminal.

Testing follows the architecture band: Layered 3 -> reversed pyramid; Layered 4
-> diamond; Ports and Adapters and CQRS -> pyramid.

Handoff: Domain Model and Event-Sourced Domain Model continue to the tactical
documents (`aggregate-design.md`, `entity-design.md`, `value-object-design.md`,
`domain-event-design.md`). Transaction Script and Active Record usually do not:
their model is scripts, records, and services.

Hard limits: the gate questions are the discriminators. Do not substitute
"complex logic?" for the core branch; a core subdomain routes to a domain model
unless the full-history gate routes it to event sourcing. Do not skip the
data-structures gate on the supporting branch. A Transaction Script or Active
Record that reaches Gate 4 with multiple persistent models does land on CQRS,
but that is an uncommon terminal; recheck whether the subdomain is really core
before accepting it.

Override on the supporting branch: the gates route by data structures, but the
true justification for a domain model is a nameable invariant. If a supporting
subdomain has genuine invariants, the invariant-substance principle overrides
Gate 2 and routes it to a domain model. The label does not forbid it.

### Pattern Reference

Each business-logic pattern: what it is, its data/logic fit, its architecture
and testing terminal, and its hard limit.

**Transaction Script.** Procedural operations over simple data; each operation is
a self-contained script. Fit: supporting or generic subdomain, simple data,
simple logic. Architecture: layered, 3 layers (or CQRS if multiple persistent
models). Testing: reversed pyramid - the logic is thin and spread across
procedures and I/O, so integration and end-to-end tests carry the weight. Hard
limit: do not carry a core subdomain's complex rules in scripts; the logic
sprawls and rots.

**Active Record.** Objects mirror database rows; logic is thin CRUD over complex
data. Fit: supporting or generic subdomain, complex data structures, simple
logic. Architecture: layered, 4 layers, a service layer over the records (or
CQRS if multiple persistent models). Testing: diamond - integration tests over
records and services are heaviest. Hard limit: an active record is not a domain
model; once real invariants appear, migrate rather than bolt logic onto the
records. Do not wrap an active record in ports and adapters; inverting
persistence out of the object leaves the pattern behind and turns it into a data
mapper plus a domain model.

**Domain Model.** Behavior-rich aggregates, entities, and value objects protect
the invariants. Fit: core subdomain with complex business logic and invariants,
or a supporting subdomain with a nameable invariant that justifies the override.
Architecture: ports and adapters (or CQRS if multiple persistent models).
Testing: pyramid - the isolated model is fast to unit-test, so most tests are
unit tests. Hard limit: do not build it for a subdomain with no real invariants;
that is over-engineering. Inside this path an anemic model is a smell.

**Event-Sourced Domain Model.** A domain model whose source of truth is a log of
business events; state is derived from them. Fit: core subdomain where full
business history must be the source of truth. Architecture: CQRS by construction
(the event store is the write model; projections serve reads). Testing: pyramid.
Hard limit: event sourcing is justified by a genuine history-as-source-of-truth
requirement, not by fashion. Not every audit-log need justifies Event Sourcing:
full business history must be the source of truth, not merely recorded for
compliance/debugging. The read side is eventually consistent by construction.

## Result Notation

Use this compact notation when summarizing the selection:

`Subdomain | type | logic pattern | architecture | testing | tactical handoff`

Selection table:

| Field | Decision |
| ----- | -------- |
| Subdomain | Name |
| Gate 1 - type | Core, or supporting/generic (from bounded-context-design) |
| Gate 2/3 | Complex data structures? (supporting) or full-history source of truth? (core) |
| Logic pattern | Transaction script, active record, domain model, event-sourced |
| Gate 4 - multiple models | Yes -> CQRS; No -> pattern default |
| Architecture | Layered (3 or 4), ports and adapters, or CQRS |
| Testing | Reversed pyramid, diamond, or pyramid (from the architecture) |
| Anemic stance | Correct (script/record) or a smell (domain model) |
| Tactical handoff | Domain-model path -> aggregate/entity/VO/event; else scripts/services |
| Trajectory | Evolution that could force a migration |

## Smell Checks

- A domain model is built for a subdomain with no real invariants
  (over-engineering).
- A domain model is chosen from the subdomain label rather than from a nameable
  invariant, producing domain-model form without substance.
- A transaction script carries a core subdomain's complex rules
  (under-engineering; the logic sprawls and rots).
- "Anemic" is flagged as a smell in a transaction-script or active-record
  subdomain, where it is correct.
- Rich aggregates are anemic in a subdomain that chose the domain-model path.
- The core branch is gated on "complex logic?" instead of the full-history need,
  or the supporting branch skips the data-structures gate.
- CQRS is adopted without a need for multiple persistent read/write models.
- Event sourcing is chosen for fashion, or for audit records that are merely
  compliance/debugging logs rather than the source of truth.
- A rich domain model sits behind a data-access layer that leaks persistence into
  it.
- The architecture mapping is read as a prohibition: a transaction script is
  barred from a driven port at its edges where one would genuinely help.
- Ports and adapters is imposed on an active record, quietly turning it into a
  data mapper without acknowledging that the pattern has changed.
- A per-subdomain architecture is forced where a deliberate monorepo-wide
  consistency choice was the better call, or the reverse: a uniform architecture
  is imposed on an active record at high cost with no acknowledgement.
- A unit-heavy pyramid is imposed on a thin layered stack, or an
  end-to-end-heavy suite on a rich model.
- The pattern is a fixed house style applied to every subdomain regardless of
  type.
- The subdomain has drifted toward core but still runs on active record with no
  migration plan.

## Expected Output

When selecting a business-logic pattern, emit:

- The subdomain and its type, from `bounded-context-design.md`.
- The gate answers walked: subdomain type, complex data structures or
  full-history source-of-truth need, and multiple persistent models.
- The business-logic pattern: transaction script, active record, domain model, or
  event-sourced domain model.
- For a domain model, the nameable invariant that justifies it; if the subdomain
  is supporting, whether it is justified by real invariants, a consistency
  override, or a declared trajectory bet.
- The architecture pattern: layered (three or four), ports and adapters, or CQRS,
  and whether the multiple-models gate drove CQRS.
- Any deliberate deviation from the tree's default architecture, for example a
  uniform hexagonal codebase across contexts, and its cost (cheap for a
  transaction script, expensive and pattern-changing for an active record).
- The testing strategy: reversed pyramid, diamond, or pyramid.
- The anemic-versus-rich stance implied by the chosen pattern.
- Tactical handoff: for domain-model paths, the pointer to
  aggregate/entity/value-object/event design; otherwise the script or service
  structure.
- The trajectory that could force a pattern migration later.
