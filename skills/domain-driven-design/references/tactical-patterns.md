# Tactical Pattern Router

Use this as a routing table, not as a detailed pattern guide. It decides which
DDD reference to load next when the modeling question is tactical. Do not use it
to bypass `business-logic-pattern-selection.md`: first decide whether the
subdomain warrants a domain model at all.

## Routing Order

1. If the subdomain implementation pattern is not chosen, read
   `business-logic-pattern-selection.md`.
2. If the language, subdomain, core focus, or context boundary is unclear, read
   `bounded-context-design.md`, `core-domain-distillation.md`, or
   `ubiquitous-language.md` first.
3. If the question is about command-side consistency, start with
   `aggregate-design.md`.
4. If the question is about application orchestration, start with
   `use-case-design.md`.
5. If the question is about reads, reporting, search, dashboards, or CQRS read
   sides, start with `read-model-design.md`.
6. If the question crosses bounded contexts at runtime, start with
   `context-coordination.md`; then route to `saga-design.md`,
   `read-model-design.md`, or `domain-event-design.md` as needed.

## Pattern Routes

- **Aggregate** -> `aggregate-design.md` when a transactional consistency
  boundary, lifecycle, command behavior, concurrency, or invariant must be
  protected.
- **Entity** -> `entity-design.md` when identity matters across time and state
  changes, and equality is not value-based.
- **Value Object** -> `value-object-design.md` when the concept is defined by
  its attributes, constraints, equality by value, or immutable policy/value
  semantics.
- **Domain Service** -> `domain-service-design.md` when a stateless domain
  decision belongs to no single aggregate, entity, value object, or
  specification.
- **Use Case / Application Service** -> `use-case-design.md` when an actor
  intention needs orchestration, authorization, validation, transaction timing,
  idempotency, side-effect timing, or response mapping.
- **Repository** -> `repository-design.md` when an aggregate root must be loaded,
  saved, reconstituted, protected by stale-write handling, or persisted through a
  unit of work / transaction manager.
- **Read Model / Query Service** -> `read-model-design.md` when the need is
  display, search, reporting, pagination, dashboard data, denormalized read
  shape, projection, freshness, or rebuild.
- **Domain Event** -> `domain-event-design.md` when a meaningful business fact
  happened and subscribers, payload, delivery, ordering, versioning, or
  integration-event translation must be designed.
- **Saga / Process Manager** -> `saga-design.md` when a durable multi-step write
  workflow spans aggregates, contexts, services, teams, retries, timeouts, or
  compensation.
- **Context Mapping** -> `context-mapping.md` when the question is the static
  relationship between bounded contexts: governance, upstream exposure, and
  downstream ingestion.
- **Context Coordination** -> `context-coordination.md` when the question is how
  an interaction across contexts is coordinated at runtime on the write or read
  side.
- **Error Management** -> `error-management-design.md` when the question is the
  error contract, expected business rejections, exceptions, retryability,
  transport mapping, or cross-context error translation.

## Local Patterns Without Separate References

- **Factory**: use when creating a valid aggregate or value object requires a
  named business creation step or multi-step rule. Then apply the construction
  rules in `aggregate-design.md` or `value-object-design.md`.
- **Specification**: use when a reusable business predicate must be named,
  composed, shared, or passed into a decision. Do not use it to avoid naming
  aggregate behavior or to smuggle infrastructure queries into the domain. As
  flexible repository lookup criteria, a Specification is also the alternative
  to leaking a query builder (`repository-design.md`, *Interface Shape*).
- **Gateway**: use when the core needs something from an external system (a
  payment provider, a rate source, another context's API). The port is a driven
  port the core declares, and its signature speaks the core's types: it returns
  value objects or domain outcomes the core owns, never the provider's response
  DTO under a new name. The adapter is the Anticorruption Layer that folds the
  provider shape into the core's type (`context-mapping.md` for the ACL
  judgment, `value-object-design.md` for the returned type). The same
  signature rule holds for every driven port: repositories return aggregate
  roots (`repository-design.md`, *Public Interface Return Contract*), and only
  read-side query services return DTOs (`read-model-design.md`).

## Output

When routing, emit:

- The selected pattern or patterns.
- The reference file or files to read next.
- The one-sentence reason for the route.
- Any adjacent pattern that was rejected and why.
