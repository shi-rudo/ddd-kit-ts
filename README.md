# @shirudo/ddd-kit

Composable TypeScript toolkit for tactical Domain-Driven Design. Ships the canonical building blocks (Value Objects, Entities, Aggregate Roots, Domain Events, Repositories, and CQRS handlers) without a framework or runtime lock-in. ESM-only; runs on Node 18+, Cloudflare Workers, Vercel Edge, Deno, and Bun.

> **Stable: 2.1**
>
> The public API is stable and follows [Semantic Versioning](https://semver.org/). Breaking changes bump the major and ship with a migration path in the [CHANGELOG](https://github.com/shi-rudo/ddd-kit-ts/blob/main/CHANGELOG.md).

![npm version](https://img.shields.io/npm/v/@shirudo/ddd-kit)
![license](https://img.shields.io/npm/l/@shirudo/ddd-kit)

## Features

- **Value Objects:** deep-frozen, by-attribute equality (`vo`, `ValueObject`, `voEquals`).
- **Entities:** identity + lifecycle, with collection helpers branded by `Id<Tag>`.
- **Aggregate Roots:** state-stored (`AggregateRoot`) and event-sourced (`EventSourcedAggregate`), with optimistic-concurrency versioning.
- **Domain Events:** typed, deeply frozen, carry metadata for traceability and schema evolution.
- **Domain State Machine:** finite, named domain states with typed context, guards, reducers, terminal states, and value outputs for aggregate lifecycles and process managers.
- **Repositories:** technology-agnostic persistence ports with an Identity-Map contract and OCC.
- **CQRS:** zero-config in-memory `CommandBus` / `QueryBus`, plus `CommandHandler` / `QueryHandler` types for external brokers.
- **Unit of Work:** opt-in `UnitOfWork` facade with tx-bound repositories, repository-side enrollment, a per-operation Identity Map, and aggregate-level dirty tracking (`changedKeys` / `hasChanges`) for partial writes. Honestly speaking: a transaction coordinator with registration and Identity Map; writes stay explicit by design (no auto-flush).
- **Outbox:** `withCommit` harvests pending events inside the transaction, stamps them with the aggregate's commit version, and publishes them atomically.
- **Repository contract tests:** `@shirudo/ddd-kit/testing` ships the suite every adapter must pass: OCC is a testable contract, not a documented pattern.
- **Result-first boundary:** a typed error hierarchy on [`@shirudo/base-error`](https://www.npmjs.com/package/@shirudo/base-error) and `Result` from [`@shirudo/result`](https://www.npmjs.com/package/@shirudo/result); `voValidated` collects field violations and renders RFC 9457 via the opt-in `@shirudo/ddd-kit/http` entry.

## Installation

```bash
pnpm add @shirudo/ddd-kit @shirudo/result @shirudo/base-error
```

`@shirudo/result` and `@shirudo/base-error` are peer dependencies; install them once in the consuming app.

## Quick start

```typescript
import { vo, type VO } from "@shirudo/ddd-kit";

type EmailAddress = VO<{ value: string }>;

function createEmail(value: string): EmailAddress {
  if (!value.includes("@")) throw new Error("Invalid email address");
  return vo({ value }); // deeply frozen, immutable
}

const email = createEmail("user@example.com");
```

For a complete walkthrough (a minimal `Order` aggregate with typed events, `commit()`, and the App-Service boundary), see [Getting Started](https://github.com/shi-rudo/ddd-kit-ts/blob/main/docs/guide/getting-started.md).

## Core concepts

Each building block has a dedicated guide. Start with [Design Decisions](https://github.com/shi-rudo/ddd-kit-ts/blob/main/docs/guide/design-decisions.md) for the non-obvious calls (Result at the App boundary, no Specification pattern, the TransactionScope/Unit-of-Work layering, class-based aggregates).

| Concept | Guide |
|---|---|
| Value Objects (`vo`, `ValueObject`, `voWithValidation`, `voValidated`) | [Value Objects](https://github.com/shi-rudo/ddd-kit-ts/blob/main/docs/guide/value-objects.md) |
| Entities and identity | [Entities](https://github.com/shi-rudo/ddd-kit-ts/blob/main/docs/guide/entities.md) |
| Aggregate Roots, factories, reconstitution | [Aggregate Roots](https://github.com/shi-rudo/ddd-kit-ts/blob/main/docs/guide/aggregates.md) |
| Event sourcing (`apply`, replay, snapshots) | [Event Sourcing](https://github.com/shi-rudo/ddd-kit-ts/blob/main/docs/guide/event-sourcing.md) |
| Domain Events (`createDomainEvent`, metadata) | [Domain Events](https://github.com/shi-rudo/ddd-kit-ts/blob/main/docs/guide/domain-events.md) |
| Domain State Machine (`DomainStateMachine`, `transitionDomainState`) | [Domain State Machine](https://github.com/shi-rudo/ddd-kit-ts/blob/main/docs/guide/domain-state-machine.md) |
| Errors: throw vs Result, `ValidationError`, RFC 9457 | [Result vs Throw](https://github.com/shi-rudo/ddd-kit-ts/blob/main/docs/guide/result-vs-throw.md) |
| Commands, queries, buses | [CQRS & Buses](https://github.com/shi-rudo/ddd-kit-ts/blob/main/docs/guide/cqrs-and-buses.md) |
| Repositories, Identity Map, OCC | [Repository](https://github.com/shi-rudo/ddd-kit-ts/blob/main/docs/guide/repository.md) |
| Unit of Work, enrollment, contract test suite | [Unit of Work](https://github.com/shi-rudo/ddd-kit-ts/blob/main/docs/guide/unit-of-work.md) |
| Outbox, `withCommit`, transactions | [Outbox & Transactions](https://github.com/shi-rudo/ddd-kit-ts/blob/main/docs/guide/outbox.md) |
| Read-side projections | [Projections](https://github.com/shi-rudo/ddd-kit-ts/blob/main/docs/guide/projections.md) |
| Concurrency & operation-scoped aggregates | [Concurrency](https://github.com/shi-rudo/ddd-kit-ts/blob/main/docs/guide/concurrency.md) |
| Edge runtimes (Workers, Deno, Bun) | [Edge Runtimes](https://github.com/shi-rudo/ddd-kit-ts/blob/main/docs/guide/edge-runtimes.md) |

## Documentation

- **[LLM.md](https://github.com/shi-rudo/ddd-kit-ts/blob/main/LLM.md):** hand-curated, high-signal guide for LLM coding tools and a fast human skim of the whole surface.
- **[Common Mistakes](https://github.com/shi-rudo/ddd-kit-ts/blob/main/docs/guide/common-mistakes.md):** the footgun catalogue; read it before writing consumer code.
- **API reference:** full type definitions ship with the package (`node_modules/@shirudo/ddd-kit/dist/index.d.ts`); the `@shirudo/ddd-kit/http` subpath exports the RFC 9457 presenter.
- **[CHANGELOG](https://github.com/shi-rudo/ddd-kit-ts/blob/main/CHANGELOG.md):** release history with a migration path for every breaking change.

## TypeScript support

Requires TypeScript 5.9+. The kit leans on branded, conditional, and mapped types for a type-safe DDD experience; all APIs are fully typed.

## Contributing

Contributions are welcome. For bugs and feature requests, use the [issue tracker](https://github.com/shi-rudo/ddd-kit-ts/issues); open a pull request against `main`.

## License

MIT.

## Author

**Shirudo:** [@shi-rudo](https://github.com/shi-rudo) · [npm](https://www.npmjs.com/package/@shirudo/ddd-kit) · [repo](https://github.com/shi-rudo/ddd-kit-ts)
