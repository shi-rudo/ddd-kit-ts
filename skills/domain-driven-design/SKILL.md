---
name: domain-driven-design
version: 1.1.0
description: Apply Domain-Driven Design to understand and model a business domain. Use when discovering subdomains, designing bounded contexts, distilling the core domain, selecting business-logic implementation patterns, deciding whether a domain model is warranted, defining ubiquitous language, identifying aggregates and invariants, designing use cases and application services, designing domain services, designing repositories, unit of work, transaction managers, designing read models and CQRS read sides, designing error contracts and error management, designing domain events, choosing tactical DDD patterns, mapping context relationships, choosing cross-context coordination patterns, designing sagas or process managers, or reviewing whether a model expresses the domain clearly.
---

# Domain-Driven Design

Use this skill to model a problem domain before choosing framework or
implementation details. Prefer business language, explicit invariants, and clear
boundaries over technical layering discussions.

This skill is methodology first and framework-agnostic. For the TypeScript
toolkit that implements tactical patterns, use the sibling `ddd-kit` skill.

## When to Use

Use this skill when the user asks to:

- Discover subdomains or design bounded contexts
- Distill the core domain, make it explicit, and separate generic subdomains or
  cohesive mechanisms out of its way
- Select whether a subdomain needs transaction script, active record, domain
  model, event-sourced domain model, CQRS, or ports and adapters
- Define or refine a ubiquitous language
- Decide aggregate boundaries and invariants
- Design use cases, application services, commands, queries, and application
  outcomes
- Design domain services and distinguish them from aggregate behavior,
  specifications, use cases, process managers, and sagas
- Design repositories, unit of work, transaction managers, and aggregate
  persistence boundaries
- Design read models, projections, query services, CQRS read sides, freshness,
  rebuild, and projection lag handling
- Design error contracts, failure mapping, retryability, and cross-context error
  translation
- Choose between entity, value object, aggregate, domain service, repository, or
  domain event
- Map relationships between teams, systems, or contexts
- Choose runtime coordination for cross-context workflows or views
- Design sagas, process managers, compensation, retries, and timeouts
- Review whether a domain model follows DDD principles
- Translate business rules into an implementation-neutral domain model

Do not use this skill for toolkit-specific implementation details. Use `ddd-kit`
when the user wants TypeScript code with `@shirudo/ddd-kit`.

## Operating Principles

- Start from business capabilities and language, not database tables,
  controllers, or package names.
- Treat bounded contexts as language and model boundaries, not just folders.
- Design aggregates around invariants that must be transactionally protected.
- Keep one transaction scoped to one aggregate unless the domain proves
  otherwise.
- Prefer value objects for constrained concepts without identity.
- Use domain events for meaningful business facts that already happened.
- Keep repositories focused on aggregate persistence, not arbitrary reads.
- Separate domain decisions from application orchestration and infrastructure.

## Workflow

1. Clarify the domain goal, actors, business process, and success/failure cases.
2. Identify subdomains: core, supporting, and generic. If more than one
   subdomain claims core, or core status is argued from criticality rather
   than differentiation, run the distillation gate
   (`references/core-domain-distillation.md`, *Qualification*) and elicit the
   differentiation evidence from domain experts with its question set.
3. Propose bounded contexts and name the language used inside each one.
4. Select the business-logic implementation pattern before detailed tactical
   modeling. An audit or history requirement alone never selects event
   sourcing; that gate demands full business history as the source of truth.
5. Describe the context map and integration relationships; if an interaction
   spans contexts at runtime, choose the coordination pattern separately.
6. Identify aggregates by asking which invariants need transactional
   protection.
7. Model use cases, entities, value objects, domain services, repositories, and
   domain events only where they clarify the business model.
8. Check the model against common DDD failure modes.
9. Produce implementation-neutral guidance, then hand off to a
   technology-specific skill if needed.

## Reference Routing

For broad design tasks, walk the references in order instead of jumping straight
to tactical patterns:

- New design: `bounded-context-design.md` with `ubiquitous-language.md` for
  capturing each context's language, then `core-domain-distillation.md`
  when strategic focus or core clarity matters, then
  `business-logic-pattern-selection.md`, then tactical model references
  (`aggregate-design.md`, `entity-design.md`, `value-object-design.md`,
  `domain-event-design.md`, `domain-service-design.md`) only if the subdomain
  warrants a domain model.
- Application and persistence: `use-case-design.md`, `repository-design.md`, and
  `read-model-design.md`; use `error-management-design.md` throughout.
- Between contexts: `context-mapping.md` for the static relationship,
  `context-coordination.md` for runtime interaction, and `saga-design.md` only
  for durable write workflows with retries, compensation, or repair.
- Audits: start from the suspected shape. Use `aggregate-design.md`,
  `entity-design.md`, and `value-object-design.md` for tactical
  reclassification; `bounded-context-design.md` for split/merge; and
  `domain-service-design.md` for service-vs-use-case placement.

Respect canonical ownership. Aggregate boundaries and transaction scope live in
`aggregate-design.md`; entity/value-object classification lives in
`entity-design.md` and `value-object-design.md`; event timing, payload, ordering,
and versioning live in `domain-event-design.md`; read-model mechanics live in
`read-model-design.md`; failure contracts live in
`error-management-design.md`. Neighboring documents should point to the owner,
not restate the decision.

## Output Shape

For modeling tasks, return the relevant subset of:

- Bounded contexts
- Ubiquitous language terms
- Aggregates and invariants
- Key entities and value objects
- Use cases, domain services, repositories, domain events, and coordination
  patterns
- Open modeling questions
- Risks or alternative boundaries

For reviews, lead with findings ordered by severity, then list open questions and
a short summary.

## References

Read only the relevant reference file:

- Bounded context design: `references/bounded-context-design.md`
- Core domain distillation: `references/core-domain-distillation.md`
- Business logic pattern selection: `references/business-logic-pattern-selection.md`
- Context mapping: `references/context-mapping.md`
- Context coordination: `references/context-coordination.md`
- Saga design: `references/saga-design.md`
- Use case design: `references/use-case-design.md`
- Repository design: `references/repository-design.md`
- Read model design: `references/read-model-design.md`
- Error management: `references/error-management-design.md`
- Ubiquitous language: `references/ubiquitous-language.md`
- Aggregate design: `references/aggregate-design.md`
- Entity design: `references/entity-design.md`
- Value object design: `references/value-object-design.md`
- Domain service design: `references/domain-service-design.md`
- Domain event design: `references/domain-event-design.md`
- Tactical pattern router: `references/tactical-patterns.md`
- Review checklist: `references/review-checklist.md`

## Related

- `ddd-kit`: TypeScript implementation guidance with `@shirudo/ddd-kit`
