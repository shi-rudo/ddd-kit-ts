---
layout: home

hero:
  name: ddd-kit
  text: Tactical DDD for TypeScript
  tagline: A composable toolkit for Domain-Driven Design. Aggregates, entities, value objects, domain events, repositories, and CQRS. Edge-runtime first, no framework lock-in.
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
    details: "Aggregates enforce invariants with typed DomainErrors. Buses use domainErrorToResult for expected Application outcomes. Unknown failures still throw."
  - icon: 📜
    title: Event sourcing without the framework
    details: 'EventSourcedAggregate records an event only after state changes. If a handler throws, the state and event queue stay unchanged.'
  - icon: ⚡
    title: Edge-runtime first
    details: Zero Node-isms. Works on Cloudflare Workers, Vercel Edge, Deno, Bun. crypto.randomUUID() defaults with override hooks for ULID/KSUID or deterministic tests.
  - icon: 🔌
    title: Bring your own persistence
    details: "A tracked Unit of Work supplies explicit add, update, and remove operations. Adapter-owned persistence models keep storage logic outside the domain."
  - icon: 📦
    title: Tiny, tree-shakable, ESM-only
    details: ~80KB of types, ~30KB of code, sideEffects false. Use only what you need. Result type comes from the @shirudo/result peer dep.
---
