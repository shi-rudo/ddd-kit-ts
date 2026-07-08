---
name: ddd-kit
description: Build tactical DDD in TypeScript with @shirudo/ddd-kit. Use when modeling aggregates, entities, value objects, domain events, repositories, or use cases, or when wiring the toolkit into an application layer.
version: 0.1.0
---

# Domain-Driven Design with @shirudo/ddd-kit

Guides tactical DDD modeling with the `@shirudo/ddd-kit` toolkit: aggregates,
entities, value objects, domain events, repositories, and the use-case boundary.

<!-- TODO: one-paragraph summary of what this skill decides for the user and
     when it should fire. Keep it concrete. -->

## When to use

<!-- TODO: list the concrete triggers, e.g.
- Modeling a new aggregate root and its invariants
- Wrapping a primitive in a value object at the boundary
- Emitting and harvesting domain events with `withCommit`
- Defining a repository contract and running the testing suite against it
-->

## Workflow

<!-- TODO: the step-by-step the agent should follow. Sketch:
1. Identify the aggregate boundary and the invariant it protects.
2. Model value objects for every constrained primitive.
3. Define domain events; keep outcomes frozen.
4. Wire the repository contract; verify with `@shirudo/ddd-kit/testing`.
5. Compose the use case at the application boundary.
-->

## References

<!-- TODO: point to the deeper material as the skill grows:
- [Aggregate rules](references/aggregates.md)
- [Value object patterns](references/value-objects.md)
- [Domain events](references/events.md)
-->

## Entry points

- `@shirudo/ddd-kit` main surface (see `src/index.ts`)
- `@shirudo/ddd-kit/http` RFC 9457 Problem Details presenters
- `@shirudo/ddd-kit/presentation` presentation-layer mapping
- `@shirudo/ddd-kit/testing` repository contract suites
- `@shirudo/ddd-kit/money` money contract and boundary module
- `@shirudo/ddd-kit/utils` array and object utilities

## Related

- `domain-driven-design`: the framework-agnostic methodology skill; use it for
  strategic questions (bounded contexts, pattern selection, context mapping)
  before reaching for toolkit specifics.
