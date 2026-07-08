# Context Mapping

Use this to choose the integration pattern between two bounded contexts. It is
an internal decision thread for the agent, not a user-facing script: the agent
gathers the listed inputs, interactively only where they are missing, and
applies the procedure. Emit a recommendation only once the applicable axes are
resolved.

This reference has two parts. Part 1 - Principles are invariants: they always
hold, no choice involved. Part 2 - Decision procedures are forks and one
sequence resolved per directed pair of contexts. Each names its discriminator,
gives ordered options with observable conditions, and states its hard limits. A
sequence is run in full; a fork is entered at the matching condition.

## Scope and Neighbors

- This document chooses the static integration and relationship pattern between
  two bounded contexts: the governance relationship, the upstream exposure, and
  the downstream ingestion.
- If the boundary itself is still in question, use
  `bounded-context-design.md` before mapping the relationship.
- Runtime coordination, such as orchestration vs choreography and read
  composition, is a separate concern. See `context-coordination.md`; use
  `domain-event-design.md` for event mechanics.
- Shared Kernel and Separate Ways are named here as governance outcomes but not
  developed in depth; this thread is scoped to upstream/downstream integration
  plus the governance decision that precedes it.

## Contents

- Core rule
- Part 1 - Principles
  - The three axes
  - Conformist is a political pattern
  - No Open Host Service is the absence of a pattern
  - Architecture is a correlate, not a driver
  - Bounded contexts are modeling tools
  - The downstream owns its protection
- Part 2 - Decision procedures
  - Pattern selection
  - Inputs
  - Governance
  - Upstream exposure
  - Downstream ingestion
  - Legacy shortcut
- Result notation
- Warnings and smell checks
- Expected output

## Core Rule

Context mapping picks patterns along three independent axes: governance, meaning
who has power and who coordinates; upstream exposure, meaning how the supplier
publishes; and downstream ingestion, meaning how the consumer takes it in. A
full recommendation names one choice per applicable axis. The classic named
patterns are combinations of these axes, not competitors on a single list.

## Part 1 - Principles

### The Three Axes

- **Governance / relationship**: the power and coordination between the two
  contexts. Values: Partnership, Shared Kernel, Customer/Supplier,
  Upstream-dominated, Separate Ways. This axis decides whether the downstream
  has a voice; it does not decide how the downstream ingests data.
- **Upstream exposure**: supplier side, how the upstream publishes its model.
  Values: Open Host Service, optionally with a Published Language; or no OHS.
- **Downstream ingestion**: consumer side, how the downstream takes the upstream
  in. Values: Anticorruption Layer, meaning translate, or adopt without
  translation.

Within an upstream/downstream relationship, meaning governance resolved to
Customer/Supplier or Upstream-dominated, the axes are independent: either
governance value can combine with any exposure and any ingestion. Partnership,
Shared Kernel, and Separate Ways are not upstream/downstream integrations; they
stop the other two axes (*Pattern Selection*). A recommendation is a tuple, such
as `Customer/Supplier | OHS+PL | ACL`. Customer/Supplier is a governance value
alongside Partnership, not a modifier on the ingestion axis.

These three axes are a decision-oriented operationalization of the canonical
catalog, not a verbatim taxonomy. Evans, the DDD Reference, and the `ddd-crew`
context-mapping catalog present three team relationships: mutually dependent,
upstream-downstream, free; plus nine patterns viewed through several
perspectives at once. The axes map onto that cleanly, but they impose more
orthogonality than the source. Conformist in particular is dual-natured: a
downstream role and, at the same time, bound to an upstream that sits in the
driver's seat. Treat the axes as a way to walk the decision, not as a claim that
the patterns are fully independent.

### Conformist Is a Political Pattern

- Conformist has a precise meaning: the downstream adopts the upstream model
  with no translation because the upstream will not serve the downstream's needs
  and an ACL is judged too costly. It is a resigned choice under upstream
  domination.
- Adopting the upstream language without translation is not automatically
  Conformist. When the downstream has a voice, such as Customer/Supplier, or
  controls both sides, and the language fits, that is a deliberate, healthy
  choice. Call it direct adoption, and do not attach the Conformist warning to
  it.
- The mechanical act is identical in both cases: no translation layer. The
  governance axis is what makes it Conformist. Reserve the name, and the
  warning, for adopt-without-translation under upstream domination.
- One adopt-under-domination case is deliberate rather than resigned: adopting a
  public, stable Published Language, such as an industry standard with its own
  governance and versioning. The standard's stability guarantees substitute for
  the voice the downstream lacks, so treat it as direct adoption, not
  Conformist. The exception requires real stability guarantees; a
  non-negotiating or drifting upstream (see *Governance*) never qualifies.

### No Open Host Service Is the Absence of a Pattern

- "Direct integration" is not an upstream pattern. It is the absence of an OHS:
  the downstream integrates against the upstream's internal model, with the
  coupling that implies.
- Treat missing OHS as a coupling-risk signal on the exposure axis, weighed
  explicitly, not as a peer of OHS or PL.

### Architecture Is a Correlate, Not a Driver

- Deployment topology, such as monolith, modulith, or microservices, does not
  cause a pattern. The real drivers are team autonomy, independent release
  cycles, and whether the two models must stay separable.
- Topology only correlates with those drivers: microservices usually imply
  independent releases and separate teams, which is why OHS and ACL trend with
  them. Read through to the driver; never infer the pattern from topology.
- A solo developer with a clean modulith may rightly choose direct adoption,
  because control over both sides is the deciding signal. The modulith does not
  force OHS or ACL.

### Bounded Contexts Are Modeling Tools

- The value of ACL and OHS is not only runtime decoupling; they make the model
  boundary explicit. This holds even for a solo developer and even in a
  monolith.
- Weigh the cost of adding a boundary later against adding it now. Retrofitting
  an ACL is more expensive than building it up front.

### The Downstream Owns Its Protection

- Whether to translate is the downstream's decision and lives on the downstream
  side. The upstream's OHS or PL choice does not remove the downstream's need to
  decide ACL vs adoption.

## Part 2 - Decision Procedures

### Pattern Selection - sequence

Goal: produce a full pattern tuple, governance, upstream exposure, downstream
ingestion, for one directed pair of bounded contexts.

1. Gather inputs (*Inputs*).
2. Resolve governance (*Governance*). If it returns Partnership, Shared Kernel,
   or Separate Ways, stop the upstream/downstream axes; those patterns are not
   upstream/downstream integrations.
3. If governance is Customer/Supplier or Upstream-dominated, resolve upstream
   exposure (*Upstream Exposure*).
4. Resolve downstream ingestion (*Downstream Ingestion*), carrying the
   governance value so Conformist-proper is detected.
5. Apply the *Legacy Shortcut* the moment a Big Ball of Mud is evident; it
   forces ACL and overrides the ingestion fork.
6. Emit the tuple and any triggered warnings (*Expected Output*).

### Inputs

Not a fork: the evidence the forks consume. Gather these, interactively only
where missing:

- Names and responsibility of each context, and which one supplies the other.
- Data-flow direction, and whether it is one-way or bidirectional.
- Consumer count now and foreseeable, and whether consumers have differing
  needs.
- Team split: solo, one team on both contexts, or separate teams; coordination
  cadence; clarity of ownership.
- Release coordination: can supplier and consumer deploy together, or must they
  deploy independently.
- Model fit: differences in terminology, invariants, aggregate boundaries, and
  process or state between the two contexts.
- Upstream stability and provenance: internal, external, industry standard, or
  legacy / Big Ball of Mud.
- Deployment topology, recorded only as a correlate of the drivers above, never
  as the deciding reason.

### Governance - fork

Discriminator: where does power sit, and who coordinates the interface?

1. Both sides actively co-develop the interface, with mutual dependency and
   bilateral planning: Partnership. Not upstream/downstream; stop the exposure
   and ingestion axes. Flag that Partnership needs sustained coordination to
   remain viable.
2. The two contexts share and jointly own a subset of the model: Shared Kernel.
   Not upstream/downstream; the shared part is co-owned and changes are
   bilateral. Closely related to Partnership.
3. Clear one-way flow, and the upstream serves the downstream's needs; the
   downstream can request changes and they are considered: Customer/Supplier.
   The downstream has a voice.
4. Clear one-way flow, but the upstream does not serve the downstream: external
   API, politically dominant team, frozen legacy, industry standard:
   Upstream-dominated. The downstream has no voice.
5. The upstream cannot be negotiated with and may drift silently: a frozen
   legacy system with no owner, or an AI-generated or AI-maintained context that
   changes without a roadmap or a person to hold a contract stable:
   Upstream-dominated, for a structural reason rather than a political one. No
   counterpart exists to request stability from, and change arrives
   unannounced. This raises the value of an ACL and makes direct adoption and
   Conformist riskier than usual.
6. No integration is actually needed; the cost of integrating exceeds its value:
   Separate Ways. Cut the link.

Hard limits: a solo developer controlling both sides is Customer/Supplier by
default; you can always serve your own downstream. Do not record
Upstream-dominated because the upstream code is messy; a messy model forces ACL
on the ingestion axis, it does not remove the downstream's voice. Keep "no
voice" (governance) distinct from "bad model" (ingestion). A non-negotiating or
drifting actor is "no voice" for a structural reason; treat it as
Upstream-dominated even when no team politics are involved.

### Upstream Exposure - fork

Discriminator: does the upstream publish a stable, consumer-agnostic contract?

1. Multiple consumers now or foreseeable, or independent deploys, or the
   upstream wants to avoid coupling to any single consumer: Open Host Service.
2. An OHS plus an explicit documented interchange schema, or an industry
   standard used as the contract: OHS + Published Language. Prefer when
   consumers migrate at different speeds or a schema is the agreed contract.
3. Exactly one consumer, coordinated releases, and no separability goal: no OHS.
   The consumer integrates against the upstream's internal model. Record this as
   a coupling risk, not as a chosen pattern.

Hard limits: a Published Language can exist without an OHS, such as adopting an
external standard's schema, and an OHS can exist without a PL, such as a stable
API with undocumented semantics, rarely worth it. "No OHS" is the absence of
exposure; weigh its coupling cost explicitly. One consumer today is not one
consumer forever; test the foreseeable case before choosing no OHS. An OHS
chosen under a Customer/Supplier relationship where one downstream negotiates
specific fields is suspect; see the caveat under *Result Notation*.

### Downstream Ingestion - fork

Discriminator: does the downstream translate the upstream model into its own, or
take it as-is?

1. Any model mismatch, such as different terminology, different invariants,
   different aggregate boundaries, different process or state, or a need to stay
   stable against upstream change: Anticorruption Layer. The downstream
   translates at the boundary. Default on mismatch; only option 3's costly-ACL
   branch can override it.
2. No mismatch, the upstream language fits, and the downstream has a voice,
   meaning Customer/Supplier, controls both sides, or adopts a public, stable
   Published Language whose governance substitutes for a voice (Part 1,
   *Conformist Is a Political Pattern*): direct adoption. Take the upstream
   language without a translation layer. A deliberate, healthy choice, not
   Conformist.
3. Adopt-without-translation under upstream domination, in either form, is
   Conformist: a mismatch exists but an ACL is judged too costly, so the
   downstream bends its own model to the upstream's and swallows the mismatch;
   or the language fits today but nothing obliges the upstream to keep it
   fitting. Both are the resigned pattern; attach the Conformist warning. The
   costly-ACL form is the only case where a mismatch does not produce an ACL,
   and the cost judgment must be argued, not assumed.

Hard limits: adopt-without-translation under upstream domination is Conformist
and carries the warning, except for the stable-Published-Language case; the same
act under Customer/Supplier or self-control does not. A legacy or Big Ball of Mud upstream always forces ACL regardless of
this fork (*Legacy Shortcut*). "The terms mostly fit" is not "no mismatch";
require a concrete mismatch example before ruling one in or out. When the
upstream is non-negotiating or drifting, prefer ACL even when the language
currently fits: nothing holds the contract stable, so a fit today is not a fit
tomorrow, and Conformist against such an upstream imports silent drift.

### Legacy Shortcut - fork

Discriminator: is the upstream a grown system with no clear domain model, a Big
Ball of Mud?

1. Yes: no clear structure, historically grown schema, ambiguous or inconsistent
   fields, missing or stale docs: ACL is mandatory. Skip the ingestion fork;
   ingestion is ACL. The only remaining exposure question is whether any OHS
   exists, unlikely, or the downstream works against the raw legacy interface.

Hard limit: never Conformist against a Big Ball of Mud; it imports the chaos
into the downstream model.

## Result Notation

A recommendation is a tuple: `Governance | Upstream exposure | Downstream
ingestion`. Common named combinations:

| Governance          | Upstream exposure | Downstream ingestion | Notation          | Meaning                                            |
| ------------------- | ----------------- | -------------------- | ----------------- | -------------------------------------------------- |
| Customer/Supplier   | OHS + PL          | ACL                  | OHS/PL <-> ACL    | Maximum decoupling, cooperative                    |
| Customer/Supplier   | OHS + PL          | direct adoption      | OHS/PL -> adopt   | Stable API, fitting language, adopted by choice    |
| Customer/Supplier   | OHS               | ACL                  | OHS -> ACL        | Stable API, consumer translates                    |
| Upstream-dominated  | OHS + PL          | ACL                  | OHS/PL <-> ACL    | Maximum decoupling from a supplier you do not steer |
| Upstream-dominated  | PL (standard)     | ACL                  | PL -> ACL         | Standard translated into own model                 |
| Upstream-dominated  | PL (standard)     | direct adoption      | PL -> adopt       | Standard fits, adopted directly                    |
| Upstream-dominated  | no OHS            | ACL                  | -> ACL            | Consumer self-protects                             |
| Upstream-dominated  | no OHS            | Conformist           | -> CF (risk)      | No protection and no voice                         |
| C/S or self-control | no OHS            | direct adoption      | -> adopt          | Tight coupling, coordinated releases, by choice    |

The Conformist row is the only inherently risky one. The `-> adopt` rows are
mechanically "no translation" like Conformist, but under a voice, self-control,
or a public, stable Published Language they are deliberate, not resigned (Part
1, *Conformist Is a Political Pattern*). Do not mark them as risk.

The `Customer/Supplier | OHS` rows carry a caveat some experts (Ploed) treat as
an anti-pattern: an Open Host Service is a generic, consumer-agnostic contract
for many consumers, while Customer/Supplier is a negotiated relationship serving
one downstream's specific needs. The two pull in opposite directions. OHS within
C/S is defensible, with OHS as mechanism and C/S as relationship, but if a
single downstream is negotiating specific fields into a supposedly generic OHS,
the relationship is really Customer/Supplier without an OHS. Recheck rather than
label it OHS.

## Warnings and Smell Checks

- Conformist recommended under upstream domination without an explicit,
  documented justification. Warn: the downstream is exposed to upstream breaking
  changes; require "ACL too costly" to be argued, not assumed.
- Architecture used as the reason for a pattern, such as "microservices,
  therefore OHS". Re-derive from team autonomy, release independence, and
  separability.
- "Direct integration" treated as a chosen upstream pattern rather than a
  missing OHS.
- A single consumer assumed permanent without testing the foreseeable case.
- Conformist against a legacy or Big Ball of Mud upstream.
- Governance "Upstream-dominated" inferred from a messy model rather than from a
  real loss of voice.
- A solo developer pushed toward OHS or ACL purely by topology, ignoring that
  control over both sides is the deciding signal.
- An Open Host Service recommended inside a Customer/Supplier relationship where
  a single downstream negotiates specific fields. Some experts treat "customer
  against an OHS" as an anti-pattern; the relationship is likely
  Customer/Supplier without an OHS. A "vetoing customer" who can block the
  upstream is the mirror anti-pattern.
- A mismatch ruled in or out without a concrete example.
- When two patterns genuinely both fit, present both with their trade-offs
  rather than forcing one.

## Expected Output

When recommending an integration pattern, emit:

- The directed pair: which context is upstream (supplier) and which is
  downstream (consumer).
- Governance value and why: voice, no voice, co-development, or no integration.
- Upstream exposure value and why: consumer count, release independence,
  separability.
- Downstream ingestion value and why: the mismatch points found, or their
  absence, and any stability need.
- The tuple and its common notation.
- Any triggered warning, especially Conformist-under-domination, with the
  justification the warning demands.
- The inputs relied on, flagging any that were assumed rather than confirmed.
- A note that topology was recorded as a correlate only, not as a reason.
