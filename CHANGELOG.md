# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### BREAKING CHANGES — Repository + persistence API

- **`ISpecification<T>` removed.** The phantom branded interface had no methods (no `isSatisfiedBy`, no `and`/`or`/`not` combinators) and was therefore impossible to use generically — `IRepository.find(spec)` could never do anything sound with it.
- **`IRepository.find` / `findOne` removed from the base interface.** Read-only access by id (`getById`, `getByIdOrFail`) is the DDD-canonical Repository contract; querying is a separate concern.
- **`IQueryableRepository<TAgg, TId, TFilter>` added.** Extends `IRepository` with `find(filter)` and `findOne(filter)`, parameterized over the persistence layer's native filter shape — Drizzle `SQL` expressions, Prisma `WhereInput`, Mongo filter documents, in-memory predicates, etc. The library no longer prescribes a query DSL.
- **`IRepository.exists(id)` added.** Collection-style existence check; cheaper than `getById !== null` when the storage supports `EXISTS`-style queries.
- **`UnitOfWork` renamed to `TransactionScope`** (`src/repo/uow.ts` → `src/repo/scope.ts`). The original implementation was a transaction-scope helper (`(fn) => fn()`), not Fowler's full UoW (no change tracking, no registerDirty/registerNew/registerDeleted). The new name is honest. Consumers update `import { TransactionScope } from "@shirudo/ddd-kit"` and rename the dependency key in `withCommit({ scope, … })`.
- **`RepoProvider<R>` removed.** Dead export, never used.
- **`AggregateRoot.markPersisted(version)` / `EventSourcedAggregate.markPersisted(version)` added.** Post-save hook called by a `Repository.save()` implementation to push the persisted version back into the aggregate and clear domain/pending events. Lets `save()` keep its `Promise<void>` return type while still propagating the new version.
- **`ConcurrencyConflictError extends DomainError` added.** The canonical signal a `Repository.save()` implementation throws on optimistic-lock mismatch — carries `aggregateType`, `aggregateId`, `expectedVersion`, `actualVersion`. Documented in the `IRepository.save` contract.

### BREAKING CHANGES — DDD compliance

- **Domain layer now throws, no longer returns Result.** Per Evans/Vernon convention, domain methods enforce invariants by throwing typed domain exceptions. Result is reserved for the App-Service boundary (Buses, Handlers, `withCommit`) and the Infrastructure boundary where stream corruption is recoverable (`loadFromHistory`, `restoreFromSnapshotWithEvents`).
- **`EventSourcedAggregate.apply()`** is now `protected apply(event, isNew?): void`. It throws `DomainError`-derived exceptions on validation failure and `MissingHandlerError` when no handler is registered. State, pending events, and version are committed atomically — if the handler or `validateEvent` throws, no mutation occurs.
- **`EventSourcedAggregate.applyUnsafe()` removed.** `apply()` already throws.
- **`validateEvent(event)`** is now `protected validateEvent(event): void` (was `Result<true, string>`). Subclasses override to throw a concrete `DomainError` subclass.
- **`loadFromHistory()` / `restoreFromSnapshotWithEvents()`** now return `Result<void, DomainError>` (was `Result<void, string>`). They catch `DomainError` thrown by `apply()` during replay; non-domain throws propagate.
- **`guard()` removed.** Use inline `if (!cond) throw new YourDomainError(...)`. No replacement helper.
- **`voWithValidationUnsafe()` removed.** Redundant with the `ValueObject` base class constructor which already throws via `validate()`.
- **New `DomainError` base + library-internal subclasses.** `abstract class DomainError extends Error` is the consumer extension point; `MissingHandlerError` and `AggregateNotFoundError` are the library's own concrete subclasses.
- **`IRepository.getByIdOrFail(id)` added.** Throws `AggregateNotFoundError` when the aggregate does not exist. Use `getById` when null is a valid outcome.

### BREAKING CHANGES — Result migration

- **Result type extracted to `@shirudo/result`** — the internal `Result<T, E>` and the class-based `Outcome` / `Success` / `Erroneous` API have been removed. Add `@shirudo/result` as a dependency in your app (now declared as a `peerDependency`) and import `ok`, `err`, `Result`, `isOk`, `isErr`, etc. from there. The shape changed: the discriminator is now `_tag: 'Ok' | 'Err'` instead of `ok: boolean`, and type guards are methods (`result.isOk()`, `result.isErr()`) — pure-function variants `isOk(result)` and `isErr(result)` are also available. `andThen` was renamed to `flatMap` and is curried for pipe-style composition.
- **`@shirudo/ddd-kit/result` subpath export removed** — there is nothing to re-export. Import Result directly from `@shirudo/result`.
- **`Outcome` / `Success` / `Erroneous` removed without a deprecation window** — these were RC-only and never reached a stable release.
- **`tanstack-server-fn` examples removed** — they demonstrated the now-removed `Outcome` API.

### Migration

```diff
- import { ok, err, type Result } from "@shirudo/ddd-kit/result";
+ import { ok, err, type Result } from "@shirudo/result";

- if (result.ok) { /* ... */ }
+ if (result.isOk()) { /* ... */ }

- if (!result.ok) { /* ... */ }
+ if (result.isErr()) { /* ... */ }
```

`result.value` and `result.error` field access stays the same (both fields always exist on the new shape; the inactive variant is `undefined`).

## [1.0.0-rc.1] - 2026-03-16

First Release Candidate. The API is considered stable.

### Added

- **Value Objects** — `vo()`, `voEquals()`, `voEqualsExcept()`, `voWithValidation()`, `deepFreeze()` for functional immutable value objects
- **Value Objects (class-based)** — `ValueObject<T>` base class with `equals()`, `clone()`, `toJSON()`
- **Entities** — `Entity<TState, TId>` base class, `Identifiable<TId>` interface, and collection helpers (`findEntityById`, `removeEntityById`, `updateEntityById`, `replaceEntityById`, `entityIds`)
- **Aggregate Roots** — `AggregateRoot<TState, TId, TEvent>` with version management, domain events, and snapshot support
- **Event-Sourced Aggregates** — `EventSourcedAggregate<TState, TEvent, TId>` with event handlers, history replay, snapshot+events restore, and event validation
- **Functional Aggregates** — `aggregate()`, `bump()` for lightweight state+version patterns without classes
- **Domain Events** — `DomainEvent<T, P>` with versioning and `EventMetadata` (correlationId, causationId, userId, source). Helpers: `createDomainEvent()`, `createDomainEventWithMetadata()`, `copyMetadata()`, `mergeMetadata()`
- **Event Bus** — `EventBusImpl<Evt>` with pub/sub, `subscribe()` (returns unsubscribe fn), `once()`, and `AggregateError` on multiple handler failures
- **Command Bus** — `CommandBus<TMap>` with type-safe dispatch, `Result`-based error handling, and optional `TMap` for return type inference
- **Query Bus** — `QueryBus<TMap>` with `execute()` (returns `Result`) and `executeUnsafe()` (throws), optional `TMap` for return type inference
- **CQRS Types** — `Command`, `CommandHandler<C, R>`, `Query`, `QueryHandler<Q, R>` marker interfaces for use with any bus implementation
- **Transaction Helper** — `withCommit()` for executing commands within a `UnitOfWork` transaction with outbox and optional event bus publishing
- **Repository** — `IRepository<TAgg, TId>` interface with `getById`, `findOne`, `find`, `save`, `delete`
- **Specification** — `ISpecification<T>` branded marker interface for query specifications
- **Unit of Work** — `UnitOfWork` interface and `RepoProvider<R>` type
- **Result Type** — Functional API: `ok()`, `err()`, `isOk()`, `isErr()`, `andThen()`, `map()`, `mapErr()`, `match()`, `matchAsync()`, `matchResult()`, `pipe()`, `tryCatch()`, `tryCatchAsync()`, `unwrapOr()`, `unwrapOrElse()`
- **Result Type (class-based)** — `Outcome<T, E>`, `Success<T>`, `Erroneous<E>` with method chaining (`map`, `andThen`, `mapErr`, `unwrap`, `match`)
- **Guard** — `guard(cond, error)` for concise precondition checks returning `Result`
- **ID** — Branded `Id<Tag>` type and `IdGenerator` interface
- **Utilities** — Deep equality (`deepEqual`), deep equality with exclusions (`deepEqualExcept`), deep omit (`deepOmit`)
- **Sub-path exports** — `@shirudo/ddd-kit/result`, `@shirudo/ddd-kit/utils`, `@shirudo/ddd-kit/utils/array`

### Changed (since 0.x beta)

- **EventBus type safety** — `subscribe()` and `once()` now require `Evt["type"]` instead of `string`, preventing typos in event type names
- **CommandBus/QueryBus type inference** — Both buses accept an optional `TMap` generic for automatic return type inference from command/query type
- **ISpecification** — Replaced phantom `_type: T` field with a branded symbol. Implementors no longer need to add a dummy field
- **Entity hierarchy** — Unified to single `Entity<TState, TId>` base class. `AggregateRoot` extends `Entity`
- **`Aggregate` → `AggregateState`** — Renamed to clarify it's a state projection, not a full aggregate with identity
- **`AggregateRoot.version`** — Now encapsulated (`private` + `get version()`). External code can read but not set the version
- **`DomainEvent.version`** — Now required (`number` instead of `number?`). Essential for schema evolution in event sourcing
- **`sameAggregate()` → `sameVersion()`** — Renamed to reflect actual semantics (concurrency check, not identity check)
- **`IRepository`** — Simplified from `<TState, TEvent, TAgg, TId>` to `<TAgg, TId>`. Works with both `AggregateRoot` and `EventSourcedAggregate`
- **`createSnapshot()`** — Now uses `structuredClone()` for deep copy. Snapshots are fully isolated from the aggregate
- **`AggregateEventSourced` → `EventSourcedAggregate`** — Renamed to match Vernon's IDDD terminology. Now extends `Entity` directly (not `AggregateRoot`), so `setState()` and `addDomainEvent()` are not available — state changes can only happen through event handlers
- **Functional API** — `AggregateState` is now state+version only (no `pendingEvents`). Event sourcing is exclusively class-based via `EventSourcedAggregate`

### Removed (since 0.x beta)

- **`AggregateBase`** — Removed dead code (`entity/aggregate-base.ts`). Use `AggregateRoot` instead
- **`Clock` interface** — Removed unused interface from `ports.ts`
- **`withEvent()`** — Removed from functional API. It appended events without applying state changes, which is not event sourcing. Use `EventSourcedAggregate` for proper ES
- **`sameAggregate()`** — Replaced by `sameVersion()` with correct semantics
- **Minified output** — Library now ships unminified for better debugging and consumer bundler compatibility

## [0.9.0 – 0.16.0] - Beta

Beta development phase with rapid iteration. Key milestones:

- 0.9.0 — Initial public API: aggregates, entities, value objects, events, repository, Result type
- 0.9.1 — Aggregate Root / child entity distinction, improved docs
- 0.9.3 — `matchAsync`, object syntax for `match`
- 0.9.5 — `pipe`, `tryCatch`, `tryCatchAsync`, dedicated `/result` export path
- 0.9.6 — `/utils` and `/utils/array` export paths
- 0.9.7 — `voEqualsExcept` for partial VO comparison
- 0.16.0 — `EventBus.once()`, `withCommit` handler, hardened event handling, `TEvent` generic on `AggregateRoot`
