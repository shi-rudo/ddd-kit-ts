# Ubiquitous Language

Use ubiquitous language work when eliciting, recording, and evolving the shared
language of one bounded context, and when keeping the code aligned with it. The
goal is one rigorous language that domain experts, developers, and the code
itself speak identically, so that a model conversation and a code review argue
about the same thing.

This reference has two parts. Part 1 - Principles are invariants: they always
hold, no choice involved. Part 2 - Decision procedures are forks and sequences
resolved per term, collision, or language change. Each names its discriminator
or goal, gives ordered options with observable conditions, and states its hard
limits. A sequence is run in full; a fork is entered at the matching condition.

## Scope and Neighbors

- This document owns the language work itself: eliciting terms, qualifying
  them, building and maintaining the glossary, resolving collisions, keeping
  code aligned, and handling language change.
- Whether a linguistic seam is a context boundary is decided in
  `bounded-context-design.md` (*Boundary Discovery*, *Boundary Sizing*). This
  document detects the seam and routes it; it does not draw the boundary.
- Naming rules for specific tactical elements live with their owners:
  aggregates and command methods in `aggregate-design.md` (*Naming*, *Mutation
  API*), entities in `entity-design.md`, value objects in
  `value-object-design.md`, events in `domain-event-design.md` (*Naming*),
  domain services in `domain-service-design.md`, bounded contexts in
  `bounded-context-design.md` (*Naming*). This document supplies the shared
  discipline they instantiate.
- Renaming a persisted or integration event is a contract change, governed by
  `domain-event-design.md` (*Versioning*), not a free refactor.
- Translation between contexts (Published Language, ACL) is decided in
  `context-mapping.md`. Inside one context there is no translation; that is
  the point.

## Contents

- Core rule
- Part 1 - Principles
  - One language, spoken and compiled
  - The model is the language's backbone
  - Scoped to one bounded context
  - Negotiated, not transcribed
  - Verbs and rules, not only nouns
  - The language evolves; renames are model changes
  - What is not ubiquitous language
- Part 2 - Decision procedures
  - Elicitation
  - Term qualification
  - Glossary building
  - Collision handling
  - Code alignment
  - Language change
  - Natural-language split
- Result notation
- Smell checks
- Expected output

## Core Rule

The ubiquitous language is one rigorous, shared language per bounded context,
structured around the domain model and used identically in conversation,
documents, and code. A term means exactly one thing; a concept has exactly one
term; the code compiles the same words the experts speak. When the language
cannot express something the business needs to say, the model is deficient and
changes; when the language changes, the code renames. There is no translation
inside a context, between people or between people and code.

## Part 1 - Principles

### One Language, Spoken and Compiled

- Experts, developers, and code use the same terms for the same concepts:
  types, methods, events, modules, and tests carry the language.
- Translation inside the context is the failure mode this discipline removes.
  When developers translate expert statements into "technical" terms, or
  experts need developer sentences translated back, two models exist and they
  drift apart silently.
- Where a code name and the spoken term differ, one of them is wrong. Fix the
  wrong one; do not keep a mapping in people's heads.

### The Model Is the Language's Backbone

- The language is not raw business jargon transcribed, and not developer
  shorthand adopted: it is structured around the domain model. Its terms are
  the model's concepts; its sentences exercise the model's relationships and
  rules.
- Test sentences against the model aloud: "an operator holds a reservation for
  a seating". If a sentence the business needs cannot be said with the model's
  terms, the model is missing a concept or a relationship; if a model term
  never appears in an expert sentence, it is suspect.
- Documents and diagrams serve the conversation; the code carries the model.
  A glossary supplements the code, it does not replace alignment with it.

### Scoped to One Bounded Context

- The language is consistent and unambiguous inside its context, and only
  there. The same word may mean something else in the neighboring context;
  that difference is a boundary, not a defect (`bounded-context-design.md`).
- Do not force one global enterprise language where the business does not have
  one; a forced shared language produces a forced shared model.

### Negotiated, Not Transcribed

- The language is created in conversation, not copied from either side.
  Experts correct sentences that misuse their terms; developers expose
  ambiguity, synonyms, and contradictions that conversation tolerates but a
  model cannot.
- Experiment aloud: propose alternative phrasings of the same rule and let the
  experts react. Awkwardness in the sentence usually locates awkwardness in
  the model.
- The experts' term wins over technical convenience. Ambiguity between
  experts, two departments using one word differently, is not resolved by the
  developers picking a side; it is surfaced as a collision (*Collision
  Handling*).

### Verbs and Rules, Not Only Nouns

- A noun-only glossary describes data, not a domain. Capture the verbs (the
  business decisions: place, hold, cancel, forfeit), the state names experts
  use in conversation, and the rules attached to each term: what makes it
  valid, when it changes, who decides.
- Events are part of the language: "what has happened when this step
  completes" yields the past-tense facts (`domain-event-design.md`).
- Prefer business verbs over technical verbs, and state names experts speak
  over invented ones. The tactical naming rules per element live with their
  owner documents (*Scope and Neighbors*).

### The Language Evolves; Renames Are Model Changes

- The language is not frozen at project start. Deeper insight replaces terms,
  splits concepts, and merges synonyms; that is progress, not churn.
- A rename in the language is a rename in the code, done promptly. Renames are
  cheapest early; a deferred rename becomes a permanent head-mapping.
- One exception has a contract: renaming persisted or integration events is a
  versioning decision (`domain-event-design.md`, *Versioning*), not a
  refactor.

### What Is Not Ubiquitous Language

- Persistence vocabulary (tables, rows, foreign keys), framework and transport
  terms (controller, DTO, endpoint), and generic technical suffixes (manager,
  helper, processor, data, info) are not domain terms unless the domain
  genuinely speaks them.
- UI labels may deliberately differ from model terms for end users; the
  presentation layer owns that mapping. Marketing language is not model
  language.
- Developer shorthand that no expert recognizes stays out of the model, or is
  proposed to the experts and only enters once they adopt it.

## Part 2 - Decision Procedures

### Elicitation - sequence

Goal: gather candidate terms, rules, and collisions from the people who speak
the language. (Boundary-level discovery questions live in
`bounded-context-design.md`; these target individual terms.)

1. Capture terms exactly as experts use them, in their sentences, not
   paraphrased. Record alternate names verbatim.
2. Ask, per concept: what do you call this? What makes it valid or invalid?
   When does it change state, and who is allowed to decide that? What has
   happened when this step completes?
3. Probe for seams: what is the difference between these two similar terms?
   Can the same real-world thing mean something else in another workflow?
4. Attach examples and counterexamples to every important term; a definition
   without a counterexample is untested.
5. Note every collision heard (same word, different meanings; different
   words, same meaning) for *Collision Handling*.

Hard limit: elicit from the people who do the work, not only from proxies; a
product manager's paraphrase is secondhand language.

### Term Qualification - fork

Discriminator: does this candidate term belong to the model language?

1. **Experts speak it for a domain concept** -> in. Record it with its rules.
2. **Two expert factions use it differently** -> collision, not rejection.
   Route to *Collision Handling*.
3. **Developer shorthand no expert recognizes** -> out of the model, or
   proposed aloud to the experts; it enters only once they adopt it.
4. **Technical or persistence vocabulary** -> out, unless the domain has
   genuinely adopted it (a "hash" in a cryptography domain is domain
   language).
5. **UI or marketing label** -> presentation concern; map it at the edge, do
   not model it.

Hard limit: frequency of use in the codebase is not evidence of domain
language; entrenched technical names are still technical names.

### Glossary Building - sequence

Goal: a short, living record of the language, kept beside the code.

1. One entry per term: term, owning bounded context, definition, the rules
   that make it valid or change it, examples and counterexamples, related
   terms and rejected synonyms.
2. Record decisions, not transcripts: the chosen term, what it beat, and why.
3. Keep it short enough to maintain; a stale glossary mis-teaches the language
   and is worse than none (the same currency rule as the distillation
   document, `core-domain-distillation.md`).
4. Store it beside the code and change it in the same review flow as the model
   it describes.

Hard limit: the glossary supplements the code; when glossary and code
disagree, that is a finding to fix, and the code is usually where the drift
happened.

### Collision Handling - fork

Discriminator: what kind of language collision is this?

1. **Same word, two meanings, two groups of speakers or workflows** ->
   candidate context boundary. Route to `bounded-context-design.md`
   (*Boundary Discovery*); do not average the meanings into one definition.
2. **Same word, two meanings, one context and one group** -> the model is
   missing a concept: split the term, qualify one or both names with the
   experts, and record both entries.
3. **Two words, one meaning** -> merge on the term the experts actually speak;
   record the loser as a rejected synonym so it stops reappearing.
4. **Same word, different meaning across an integration boundary** -> a false
   friend: translation is decided in `context-mapping.md`; record the mapping
   in both glossaries.

Hard limit: a collision is resolved with the experts, never by the modeler
alone picking the tidier option.

### Code Alignment - sequence

Goal: the code compiles the language.

1. Check types, methods, events, modules, and test names against the glossary;
   every divergence is a rename candidate or a glossary bug.
2. Apply the owner documents' naming rules per element (aggregates, entities,
   value objects, events, services; see *Scope and Neighbors*).
3. Rename code promptly when the language wins; schedule nothing that can be
   done now, except persisted or integration event renames, which go through
   `domain-event-design.md` (*Versioning*).
4. Keep tests speaking the language: a test title is a sentence an expert
   could confirm.

Hard limit: do not maintain a translation table between "code names" and
"business names" inside one context; the table is the smell.

### Language Change - sequence

Goal: adopt a language change without leaving debris.

1. Confirm the change with the experts: new term, changed meaning, or split
   concept, and update the glossary entry (including the rejected old term).
2. Rename the code (*Code Alignment*), tests included.
3. For persisted or integration events touched by the rename, walk
   `domain-event-design.md` (*Versioning*) instead of renaming in place.
4. Sweep conversation artifacts: documents and diagrams that still teach the
   old term either update or state their supersession.
5. If the change reveals a boundary (the "change" is really two contexts
   wanting different words), stop and route to `bounded-context-design.md`.

Hard limit: adopting the new term in speech while the code keeps the old one
reintroduces translation; the change is done when the code compiles the new
language.

### Natural-Language Split - fork

Discriminator: do the business and the codebase speak the same natural
language?

1. **Yes** -> the model language is that language end to end.
2. **No** (the business speaks one natural language, the code another) ->
   choose one natural language for the code and keep it total there; the
   glossary then carries the term pairs, one entry per concept with both
   terms, and the pairing is maintained like any other definition. The
   ubiquitous language is the shared conceptual vocabulary; the glossary owns
   the crossing.

Hard limits: never mix natural languages inside the code for domain terms;
ad-hoc translation at typing time produces synonym drift in both languages.
The term pair is decided once, with the experts, and recorded.

## Result Notation

Use this compact notation when summarizing language work:

`Term | context | definition | rules | collisions/synonyms | code name`

Glossary entry table:

| Field | Content |
| ----- | ------- |
| Term | As the experts speak it |
| Context | The owning bounded context |
| Definition | One or two sentences, in domain words |
| Rules | What makes it valid, when it changes, who decides |
| Examples | At least one example and one counterexample |
| Synonyms | Rejected alternates, recorded so they stop reappearing |
| Code | The type/method/event names carrying the term |
| Term pair | The other-natural-language term, when a split exists |

## Smell Checks

- Developers translate for experts, or experts need developer sentences
  translated back: two languages, two models.
- A translation table maps "code names" to "business names" inside one
  context.
- The glossary is noun-only; no verbs, no rules, no counterexamples.
- The same term carries two meanings inside one context, unflagged.
- Two names for one concept coexist in code and conversation.
- Code names diverge from spoken terms and the divergence is tolerated as
  "just naming".
- Technical suffixes (manager, helper, processor, data, info) or persistence
  and transport vocabulary appear as domain terms without the domain speaking
  them.
- UI or marketing labels leak into the model.
- The glossary is stale, or lives where no developer sees it.
- A rename is deferred indefinitely because "too many call sites"; the
  language and the code have forked.
- A persisted or integration event was renamed in place as if it were a local
  refactor.
- Domain terms appear in mixed natural languages in the code.
- An enterprise-wide language is enforced across contexts that demonstrably
  speak differently.

## Expected Output

When doing language work, emit:

- The glossary entries added or changed, in the notation above.
- Collisions found, each with its classification (boundary candidate, missing
  concept, synonym, false friend) and routing.
- The rename list for code alignment, with any event renames routed to
  versioning.
- Rejected synonyms and shorthand, recorded with the reason.
- Open language questions that need expert validation, phrased as test
  sentences the experts can confirm or correct.
