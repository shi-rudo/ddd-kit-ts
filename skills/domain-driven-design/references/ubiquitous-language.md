# Ubiquitous Language

Use ubiquitous language work whenever names, concepts, or rules are unclear. The
goal is to make the model speak the same language as domain experts inside a
bounded context.

## How to Build It

- Capture domain terms exactly as experts use them.
- Record alternate names and decide which one belongs in the model.
- Attach rules, examples, and counterexamples to important terms.
- Keep language scoped to a bounded context; do not force global consistency
  where the business does not have it.
- Rename model elements when the business language changes.

## Questions for Domain Experts

- What do you call this concept?
- What makes it valid or invalid?
- When does it change state?
- Who is allowed to make that decision?
- What is the difference between these two similar terms?
- Can the same real-world thing mean something else in another workflow?
- What event has happened when this step completes?

## Naming Heuristics

- Prefer business verbs over technical verbs.
- Prefer state names domain experts use in conversation.
- Prefer event names that describe facts in past tense.
- Avoid names such as manager, helper, processor, handler, data, record, and
  info unless they are domain terms.
- Avoid leaking UI labels, table names, or API resources into the domain model.

## Glossary Shape

For each important term, record:

- Term
- Bounded context
- Definition
- Important rules
- Examples and counterexamples
- Related terms or rejected synonyms

## Expected Output

Return a glossary plus naming recommendations. Highlight ambiguous or overloaded
terms that need domain expert validation.
