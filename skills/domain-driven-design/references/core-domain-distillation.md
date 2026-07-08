# Core Domain Distillation

Use core domain distillation to find the core domain, make it explicit, extract
what is not core out of its way, and protect its clarity over time. This is the
strategic process that decides where the best modeling effort is spent.

This reference has two parts. Part 1 - Principles are invariants: they always
hold, no choice involved. Part 2 - Decision procedures are forks and one sequence
resolved per core. Each names its discriminator, gives ordered options with
observable conditions, and states its hard limits. A sequence is run in full; a
fork is entered at the matching condition.

## Scope and Neighbors

- This document is the distillation process: finding the core, marking it,
  extracting generic subdomains and cohesive mechanisms, and protecting the
  core's clarity.
- The classification it acts on - which subdomain is core, supporting, or
  generic, on differentiation x complexity - lives in
  `bounded-context-design.md` (*Subdomain Classification*, *Subdomains Evolve*).
  Distillation acts on that classification; it does not re-derive it.
- An extracted generic subdomain may become its own module or bounded context.
  Relate it through `context-mapping.md`; use an ACL when the external or
  generic model would pollute the core language, and direct adoption when a
  stable Published Language or standard fits.
- The tactical modeling of the distilled core is done with
  `aggregate-design.md` and the other tactical documents. Distillation decides
  where to spend that effort.
- A cohesive mechanism factored out behind an interface is a supporting module,
  not a domain service; the distinction is drawn here and in
  `domain-service-design.md`.

## Contents

- Core rule
- Part 1 - Principles
  - The core domain justifies the investment
  - Make the core explicit
  - Distillation is an escalation
  - Extract what is not core
  - Cohesive mechanism vs generic subdomain vs domain service
- Part 2 - Decision procedures
  - Qualification
  - Inputs - expert elicitation
  - Distillation
  - Highlighted core
  - Extraction
  - Structural distillation
  - Refactoring targets
- Result notation
- Smell checks
- Expected output

## Core Rule

Distillation is the ongoing process of separating the core domain - the part
that differentiates the business and justifies the DDD investment - from
everything that merely supports it. Find the core, make it explicit so anyone
knows what is in and out, extract generic subdomains and cohesive mechanisms out
of its way, and spend the best modeling effort there. It is iterative and
proportional: use the cheapest technique that clarifies the core, and escalate
only when its value warrants.

## Part 1 - Principles

### The Core Domain Justifies the Investment

- The core domain is the part that differentiates the business: its reason to
  build rather than buy. It deserves the highest-quality modeling and is what
  justifies the cost DDD asks for.
- Justify investment in any other part by how it supports the distilled core.
  Supporting subdomains, generic subdomains, and technical mechanisms earn effort
  only through their service to the core.
- Distillation is never finished. The core clarifies as insight grows and shifts
  as the business evolves (see *Subdomains Evolve* in
  `bounded-context-design.md`).

### Make the Core Explicit

- It must be effortless for anyone to know what is in the core and what is out.
  An implicit core is an unprotected core: supporting concepts creep in and
  dilute it.
- Explicitness is cheap before it is structural. A written statement and a
  marked model come before code is moved.
- An opinionated platform-wide business policy, a product behavior every
  tenant gets identically (fair allocation of scarce capacity, anti-resale
  rules, uniform refund handling), can be the differentiation precisely
  because it is not per-tenant configurable: the promise to users holds only
  while it holds everywhere, so a per-tenant opt-out does not weaken the
  policy, it dissolves it. Domain behavior only; technical policy such as
  coding standards or security baselines is not governed here.
- Record such a policy in the distillation document with an explicit guard:
  one sentence naming the policy, stating that its uniformity is the
  differentiation, and that making it configurable is a strategy change to be
  decided by the strategy's owners, not a feature request to be scheduled.

### Distillation Is an Escalation

- The techniques form a ladder from cheap and reversible to expensive and
  structural: Domain Vision Statement -> Highlighted Core -> generic-subdomain
  and cohesive-mechanism extraction -> Segregated Core -> Abstract Core.
- Climb only as far as the core's value warrants. A one-page statement clarifies
  most cores; a Segregated Core or an Abstract Core is a large refactor reserved
  for a core whose clarity pays for it.

### Extract What Is Not Core

- Generic subdomains (needed but not differentiating) and cohesive mechanisms
  (technical algorithms the domain uses) are extracted out of the core to leave
  it smaller and clearer. Both simplify the core; they differ in kind.
- Generic does not mean reusable. A generic subdomain is generic because it does
  not differentiate you, not because it is a reusable library. Do not over-model
  it for reuse it will never have.
- Examples are context-dependent. Scheduling, allocation, pricing, or matching
  may be generic in one business and core in another. Extract only after the
  differentiation judgment is explicit.

### Cohesive Mechanism vs Generic Subdomain vs Domain Service

- A **generic subdomain** is still part of the domain: it formulates facts, rules,
  or a problem, just not the differentiating one.
- A **cohesive mechanism** is not part of the domain: it is a set of technical
  algorithms behind an intention-revealing interface, such as graph traversal, a
  constraint solver, or allocation math when that math is not differentiating.
  The domain expresses the "what"; the mechanism handles the "how".
- Neither is a **domain service**. A domain service holds a domain decision that
  spans objects (`domain-service-design.md`); a cohesive mechanism holds a
  technical computation. When a mechanism genuinely carries the core's
  differentiation, it stays in the core rather than being factored out.

## Part 2 - Decision Procedures

### Qualification - fork

Discriminator: does the core need distilling now? Any one trigger suffices.

1. **More than one subdomain is claimed core, or core status is argued from
   criticality** ("without it nothing works") -> run *Distillation*. Necessity
   is an operational property, not a classification axis; classification runs
   on differentiation (`bounded-context-design.md`, *Subdomain
   Classification*). "Everything is core" means the core is undistilled.
2. **The core is implicit**: no one can say quickly what is in it and what is
   out -> run *Distillation*.
3. **Investment drift**: the best modeling effort or the strongest people sit
   on non-differentiating parts, or generic concepts dilute the core model ->
   run *Distillation*, entering at *Extraction*.
4. **One explicit, highlighted core with matching investment** -> no
   distillation needed now. Re-run when the classification shifts
   (*Subdomains Evolve* in `bounded-context-design.md`).

Hard limit: do not accept a core claim at face value when trigger 1 fires; the
claim is the input to distillation, never its output.

### Inputs - Expert Elicitation

Not a fork: the evidence the procedures consume. The differentiation axis
belongs to product and business people; gather it with these questions, asked
of domain experts rather than answered by the modeler:

- Why do customers choose us over the alternatives? Why do suppliers or
  partners join?
- What could a competitor not copy within six months? Code rarely qualifies;
  data depth, relationships, and curation often do.
- Which parts would you never outsource, and why?
- For each candidate subdomain: is it a reason to choose us, or table stakes?
- What is deliberately NOT our core, even though we depend on it every day?
- Draft the one-sentence differentiator ("what we uniquely make possible") and
  have the experts correct it in their own words; the corrected sentence seeds
  the Domain Vision Statement.

The two-axis assessment itself, with its differentiation and complexity clues,
is owned by `bounded-context-design.md` (*Subdomain Classification*); ask those
questions in the same session.

### Distillation - sequence

Goal: find, mark, and protect the core, escalating only as its value warrants.

1. Take the subdomain classification from `bounded-context-design.md`; the core
   is the high-differentiation subdomain.
2. Write a Domain Vision Statement: one page, the core's essential concepts and
   the value they deliver, focused on what differentiates and ignoring common
   traits. Write it early; revise it as insight grows.
3. Make the core visible so it is effortless to tell what is in and out
   (*Highlighted Core*).
4. Extract what is not core out of its way (*Extraction*).
5. If the core is still entangled with supporting concepts in one model, or
   fundamental concepts recur across specialized parts, consider a structural
   refactor (*Structural Distillation*).
6. Choose refactoring targets and iterate (*Refactoring Targets*); distillation
   is ongoing.

Hard limits: do not skip the cheap steps - the statement and the highlight - and
jump to a Segregated Core. Do not distill a core the classification did not
actually identify as differentiating; that is effort in the wrong place.

### Highlighted Core - fork

Discriminator: how do people currently tell what is in the core?

1. **Distillation document** -> a short document describing the core elements and
   their interactions, kept beside the code. Use when the team reasons about the
   core in discussion and design.
2. **Flagged core** -> mark core elements directly in the repository, by naming
   convention, module, package, or annotation, so a developer sees it in the
   code. Use when the risk is code-level drift.
3. **Both** -> the document for reasoning, the flags for coding. Common for a
   core under active development.

Hard limits: whichever form, it must stay current. A stale distillation document
mis-marks the core and is worse than none; keep it short so it is cheap to
maintain.

### Extraction - fork

Discriminator: what is this non-core part?

1. **A subdomain that is needed but does not differentiate** -> generic
   subdomain: factor it into its own module or bounded context when that
   separation clarifies the core. Buy, adopt, or build it simply. Use an ACL when
   the outside model would pollute the core language; direct adoption is fine
   when a stable Published Language or standard fits (`context-mapping.md`).
2. **A complex technical computation the domain uses** -> cohesive mechanism:
   factor it behind an intention-revealing interface into a supporting module.
   The domain states the "what"; the mechanism does the "how".
3. **A concept that looks supporting but carries the differentiation** -> it is
   core. Leave it in, even if tightly coupled; separating it is the core's own
   job (*Structural Distillation*), not extraction.

Hard limits: extraction simplifies the core; it does not hollow it. Never extract
the differentiating logic. A cohesive mechanism hides a "how", not a domain
decision, which would be a domain service.

### Structural Distillation - fork

Discriminator: what is diluting the core's clarity, and is the refactor worth it?

1. **Supporting concepts are tangled into core objects in one model** ->
   Segregated Core: refactor to separate core concepts from supporting notions,
   strengthening the core's cohesion and cutting its coupling. Accept the cost:
   it is a real refactor with team decision and churn implications.
2. **Fundamental concepts recur across specialized subdomains** -> Abstract Core:
   distill the most fundamental model into an abstract core that the specialized
   parts depend on. This is the most ambitious technique; reserve it for a core
   that has stabilized.
3. **The core is already cohesive and clear** -> stop. Do not refactor for its
   own sake.

Hard limits: a Segregated Core and an Abstract Core are expensive and hard to
reverse. Do not undertake them before the cheaper techniques, and not on a core
still in flux.

### Refactoring Targets - fork

Discriminator: is this refactoring pain-driven or a deliberate all-out effort,
and what capacity is available?

1. **Pain-driven** -> find the root cause of the current pain and start there,
   wherever it is, even if it is not the core.
2. **All-out, deliberate strategic refactor** -> start by refactoring the core
   into a segregated core, generic subdomains, and cohesive mechanisms.
3. **Limited capacity** -> protect and staff the core first (see ownership in
   `bounded-context-design.md`); let the supporting parts wait.

Hard limit: refactoring effort follows the core. Do not lavish an all-out
refactor on a generic subdomain. Distillation decides where the effort goes.

## Result Notation

Use this compact notation when summarizing a distillation:

`Core | vision statement | highlight form | extracted | structural level`

Distillation table:

| Field | Decision |
| ----- | -------- |
| Core | The differentiating subdomain, from the classification |
| Vision statement | One-page core concepts and their value |
| Highlight | Distillation document, flagged core, or both |
| Extracted - generic | Generic subdomains, and how they are sourced and related |
| Extracted - mechanism | Cohesive mechanisms, and the interfaces they hide behind |
| Structural level | None, Segregated Core, or Abstract Core, with justification |
| Refactoring | Pain-driven or all-out, and the targets chosen |
| Kept in core | What was deliberately left in because it differentiates |

## Smell Checks

- The core domain is implicit: no one can say what is in it and what is out.
- Core status is argued from criticality ("nothing works without it") instead
  of differentiation; a mission-critical supporting subdomain is mislabeled
  core.
- Several subdomains claim core and no distillation has been run.
- The best modeling effort is spent on a supporting or generic subdomain, not the
  core.
- A generic subdomain is over-engineered for reuse it will never have.
- A context-dependent concept is extracted as generic without checking whether it
  differentiates this business.
- A cohesive mechanism (a technical algorithm) is modeled as domain logic, or a
  domain decision is buried inside a mechanism.
- Differentiating logic is extracted out of the core as if it were generic.
- A Segregated Core or Abstract Core is attempted before the vision statement and
  highlighted core, or on a core still in flux.
- The distillation document is stale and mis-marks the core.
- A vision statement lists common traits instead of what differentiates.
- Refactoring effort is spread evenly instead of following the core.
- "Generic" is treated as "reusable" and built as a shared library prematurely.
- A core-defining platform business policy is made per-tenant configurable,
  dissolving the differentiation it carried.

## Expected Output

When distilling the core, emit:

- The core domain, taken from the classification, and why it differentiates.
- The Domain Vision Statement, or a pointer to it: the core's essential concepts
  and their value.
- The highlight form: distillation document, flagged core, or both.
- Extracted parts: generic subdomains, how they are sourced and related via
  context mapping, and cohesive mechanisms with the interfaces they hide behind.
- The structural level reached: none, Segregated Core, or Abstract Core, with
  the justification for any structural refactor.
- The refactoring targets chosen and why: pain-driven or all-out.
- What was deliberately kept in the core because it carries the differentiation.
