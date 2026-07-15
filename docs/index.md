---
layout: home

hero:
  name: ddd-kit
  text: Tactical DDD for TypeScript
  tagline: A composable toolkit for Domain-Driven Design, covering aggregates, entities, value objects, domain events, repositories, and CQRS. Edge-runtime first, no framework lock-in.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: API Reference
      link: /api/
    - theme: alt
      text: View on GitHub
      link: https://github.com/shi-rudo/ddd-kit-ts

features:
  - icon: 🧱
    title: DDD-faithful building blocks
    details: Value Objects, Entities, Aggregate Roots, Domain Events, Repositories, modelled after Evans and Vernon, not after a framework.
  - icon: 🔒
    title: Domain throws, App boundary returns Result
    details: "Aggregates enforce invariants by throwing typed DomainErrors. Buses and the selective domainErrorToResult helper make expected Application outcomes explicit; unknown failures still throw."
  - icon: 📜
    title: Event sourcing without the framework
    details: 'EventSourcedAggregate enforces "record-after-mutation" structurally. apply() is atomic: handler throws? state and events stay in sync. loadFromHistory and snapshot+replay just work.'
  - icon: ⚡
    title: Edge-runtime first
    details: Zero Node-isms. Works on Cloudflare Workers, Vercel Edge, Deno, Bun. crypto.randomUUID() defaults with override hooks for ULID/KSUID or deterministic tests.
  - icon: 🔌
    title: Bring your own persistence
    details: "IRepository for id-canonical aggregate lifecycle. Consumer applications own intent-revealing query ports, so SQL, ORM filters, bounds, ordering, and cursor semantics stay at the right boundary."
  - icon: 📦
    title: Tiny, tree-shakable, ESM-only
    details: ~80KB of types, ~30KB of code, sideEffects false. Use only what you need. Result type comes from the @shirudo/result peer dep.
---
