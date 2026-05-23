# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0-rc.2] - 2026-05-23

A consolidation release. Closed 60+ audit items across the entire surface, restructured the kit around DDD-canonical conventions (domain throws, App boundary returns Result), and shipped a documentation site at <https://shi-rudo.github.io/ddd-kit-ts>. Many breaking changes — the kit is in RC explicitly so these can land before the API freezes.

### Migration cheatsheet

```diff
// Result moved to a peer dependency
- import { ok, err, type Result } from "@shirudo/ddd-kit/result";
+ import { ok, err, type Result } from "@shirudo/result";

// Type-guards: properties became methods (functions still exported too)
- if (result.ok) { ... }
+ if (result.isOk()) { ... }
- if (!result.ok) { ... }
+ if (result.isErr()) { ... }

// Unit of Work → Transaction Scope
- import { UnitOfWork } from "@shirudo/ddd-kit";
+ import { TransactionScope } from "@shirudo/ddd-kit";
- withCommit({ uow, outbox, bus }, fn);
+ withCommit({ scope, outbox, bus }, fn);

// guard() removed
- const r = guard(items.length > 0, "EMPTY");
- if (r.isErr()) return err(r.error);
+ if (items.length === 0) throw new EmptyOrderError();

// EventSourcedAggregate.apply() now void, throws on invariant violation
- const r = this.apply(event); if (r.isErr()) throw new Error(r.error);
+ this.apply(event); // throws DomainError-derived

// IRepository.find / findOne moved to IQueryableRepository extension
- interface OrderRepo extends IRepository<Order, OrderId> { /* find(spec) */ }
+ interface OrderRepo extends IQueryableRepository<Order, OrderId, OrderFilter> {}

// Functional aggregate dropped — extend the class
- const order = aggregate<OrderState>(initialState);
- const next  = bump(order);
+ class Order extends AggregateRoot<OrderState, OrderId> { ... }
```

`result.value` / `result.error` field access is unchanged (both fields exist on the new shape; the inactive variant is `undefined`).

### BREAKING — Result moved to `@shirudo/result`

- Internal `Result<T, E>` and the class-based `Outcome` / `Success` / `Erroneous` API removed. Add `@shirudo/result` as a dependency in your app (now declared as a `peerDependency`).
- Shape changed: discriminator is now `_tag: 'Ok' | 'Err'` (was `ok: boolean`); type guards are methods (`result.isOk()` / `result.isErr()`) — pure-function variants `isOk(result)` / `isErr(result)` are also exported. `andThen` is now `flatMap` (curried, pipe-style).
- `@shirudo/ddd-kit/result` subpath export removed — import directly from `@shirudo/result`.
- `tanstack-server-fn` examples removed (they demonstrated the now-gone `Outcome` API).

### BREAKING — Domain layer throws, App boundary returns Result

- Domain methods (Aggregates, ValueObject constructors, `validateEvent`) **throw** `DomainError`-derived exceptions. Result is reserved for the App-Service boundary (`CommandBus.execute`, `QueryBus.execute`, `withCommit`) and the Infrastructure boundary where stream corruption is recoverable (`loadFromHistory`, `restoreFromSnapshotWithEvents`).
- `EventSourcedAggregate.apply()` is now `void` (was `Result<void, string>`). Throws `DomainError` on validation failure and `MissingHandlerError` when no handler is registered. State, pending events, and version commit atomically — if the handler or `validateEvent` throws, no mutation occurs.
- `EventSourcedAggregate.applyUnsafe()` removed — `apply()` already throws.
- `validateEvent(event)` is now `void` (was `Result<true, string>`). Subclasses override to throw a concrete `DomainError` subclass.
- `loadFromHistory()` and `restoreFromSnapshotWithEvents()` now return `Result<void, DomainError>` (was `Result<void, string>`). They catch `DomainError` thrown by `apply()` during replay; non-domain throws propagate.
- `guard()` removed. Use inline `if (!cond) throw new YourDomainError(...)`. No replacement helper — the indirection wasn't earning its keep.
- `voWithValidationUnsafe()` removed (redundant with the `ValueObject` base class, whose constructor throws via `validate()`).
- New `DomainError` abstract base in `src/core/errors.ts`. Concrete library-internal subclasses: `MissingHandlerError`, `AggregateNotFoundError`, `ConcurrencyConflictError`.
- `IRepository.getByIdOrFail(id)` added — throws `AggregateNotFoundError` when the aggregate does not exist. Use `getById` when `null` is a valid outcome.

### BREAKING — Aggregate API consolidation

- **Functional aggregate API removed.** `aggregate(state, version)`, `bump(agg)`, and `AggregateState<S>` are gone. Class-based `AggregateRoot` / `EventSourcedAggregate` is the canonical model and pairs with the rest of the kit (Entity, IAggregateRoot, Repository).
- `AggregateRoot<TState, TId, TEvent>` — `TEvent` defaults to `never` (was `unknown`). Forces an explicit event union whenever the subclass actually records events; the no-events path (`setState` only) still works.
- `AggregateRoot.commit(newState, events)` added — the opt-in record-after-mutation helper. Calls `setState(newState, true)` first (which throws on `validateState` failure), then appends the event(s). Always bumps the version (no `bumpVersion` parameter — recording an event implies a version-worthy change). Use `setState(newState, false)` directly for state-only mutations.
- `AggregateRoot.markPersisted(version)` and `EventSourcedAggregate.markPersisted(version)` added. The post-save hook a `Repository.save()` implementation calls to push the persisted version back into the in-memory aggregate and clear recorded events. Lets `save()` keep its `Promise<void>` return type.
- `EventSourcedAggregate.apply()` is now generic in the event tag (`K extends TEvent["type"]`) — concrete callers narrow the dispatched handler at compile time without an `as` cast.
- `loadFromHistory()` advances version **additively** (`startVersion + history.length`) — was previously stomped to `history.length`, breaking continuity for aggregates loaded mid-life.
- `restoreFromSnapshotWithEvents()` is now **all-or-nothing** — a mid-replay `DomainError` rolls back to the pre-call state and version. Partial restoration is never observable.
- `autoVersionBump` defaults documented as pattern-specific: `false` on `AggregateRoot` (because `setState` already takes an explicit `bumpVersion` argument), `true` on `EventSourcedAggregate` (one event = one version bump, canonical ES).

### BREAKING — Interfaces and identity

- `IAggregateRoot.markPersisted(version)` required by the interface (previously only on the abstract classes). Repository implementations can now code against the interface alone.
- `Identifiable<TId extends Id<string>>` constrained — `Identifiable<string>` no longer compiles. Aligns with `IAggregateRoot<TId extends Id<string>>` and `IEntity<TId extends Id<string>, TState>`. The brand discipline of `Id<Tag>` is now uniform across the entire entity surface.
- `IdGenerator<Tag extends string>` — the tag is bound at the generator type, not the call site. The old shape `IdGenerator { next: <T extends string>() => Id<T> }` let callers pick any tag for free, defeating the brand.
- Entity helpers (`sameEntity`, `findEntityById`, `hasEntityId`, `removeEntityById`, `updateEntityById`, `replaceEntityById`, `entityIds`) now compare by `===` (was `deepEqual`) and require `TId extends Id<string>`. Branded ids are primitive strings; deep equality was wasted work.

### BREAKING — Repository + persistence

- `ISpecification<T>` removed (phantom branded interface with no methods; could not be used generically).
- `IRepository.find` / `findOne` moved to the **opt-in** `IQueryableRepository<TAgg, TId, TFilter>` extension. `TFilter` is the persistence layer's native filter shape (Drizzle `SQL`, Prisma `WhereInput`, Mongo filter documents, in-memory predicates, …). The library no longer prescribes a query DSL.
- `IRepository.exists(id): Promise<boolean>` added. Collection-style existence check; cheaper than `getById !== null` when the storage supports `EXISTS`-style queries.
- `UnitOfWork` renamed to `TransactionScope`; `src/repo/uow.ts` → `src/repo/scope.ts`. The implementation was a transaction-scope helper, not Fowler's full UoW (no change tracking). The new name is honest. Consumers update `import { TransactionScope } from "@shirudo/ddd-kit"` and rename `withCommit({ uow, … })` to `withCommit({ scope, … })`.
- `RepoProvider<R>` removed (dead export, never used).
- `withCommit` publishes events **after** the transactional callback resolves (was: inside the transactional callback). Defeats the classic publish-before-commit footgun — in-process subscribers can never react to events from a rolled-back transaction.
- `ConcurrencyConflictError extends DomainError` is the canonical signal a `Repository.save()` implementation throws on optimistic-lock mismatch. Carries `aggregateType`, `aggregateId`, `expectedVersion`, `actualVersion`.

### BREAKING — Domain events

- `DomainEvent<T, P>` gains required `eventId: string` and optional `aggregateId` / `aggregateType`. Idempotent consumers, outbox dispatch tracking, and `metadata.causationId` references now have something concrete to point at.
- `createDomainEvent()` **deep-freezes** the returned event. A mutating subscriber on the `EventBus` throws instead of poisoning subsequent handlers; nested writes to `payload` / `metadata` also throw.
- `createDomainEvent()` payload-shape JSDoc fixed — the field is always present; the value is `undefined` when `P = void` (was documented as "omitted").

### BREAKING — CQRS / Buses

- `CommandBus.register` / `QueryBus.register` are now strictly typed when a `TMap` is supplied. Unknown command/query keys and wrong-typed handlers are compile errors; the no-`TMap` path stays loose for tests.
- `EventBus.subscribe<K extends Evt["type"]>(eventType, handler)` binds the handler's event type to the `eventType` argument. The previous shape let `subscribe<OrderShipped>("OrderCreated", h)` compile silently.
- `EventBus.once<K extends Evt["type"]>(eventType, options?)` — same narrowing. New optional `{ signal?: AbortSignal; timeoutMs?: number }` options bag to abort or time out a wait; the promise rejects synchronously when the signal is already aborted.
- `EventBusImpl` stores handlers in an `Array` instead of a `Set` — subscribing the same handler reference twice now invokes it twice (the canonical pub/sub expectation). The returned unsubscribe removes exactly the matching subscription.
- `Outbox<Evt>` port expanded — `add` plus new `getPending(limit?)` and `markDispatched(dispatchIds)`. Introduces an `OutboxRecord<Evt>` wrapper so implementations choose their own opaque `dispatchId` (typically reuses `eventId`). `markDispatched` is required idempotent.

### BREAKING — Utilities, exports, and types

- `/utils/array` subpath export removed — use `/utils` (or the main entry). The two subpaths resolved to identical code through layered re-exports.
- `sideEffects: false` added to `package.json` — free aggressive tree-shaking. None of the modules have top-level side effects.
- `vo()` deep-clones via `structuredClone` before freezing — the caller's nested object graph is no longer frozen as a side effect. As a side benefit, function-valued payloads now throw at construction time (Value Objects are data, not behaviour).
- `deepFreeze` iterates `Reflect.ownKeys` so Symbol-keyed properties are also frozen (asymmetric vs `deepEqual` before).
- `isBuiltInObject` replaced the `globalThis[name]` + `proto !== Object.prototype` heuristics with an explicit tag allow-list. Cross-realm safe; user classes named after globals (e.g. `class Date {}`) are no longer misclassified as built-ins.
- `deepEqual` cycle tracker switched from `WeakMap<obj, obj>` to `WeakMap<obj, WeakSet<obj>>` — pair-set semantics, can't be poisoned by a previous compare against a different B. Symbol-key membership probed via `Set` (was `Array.includes` in a loop). TypedArray indexed access typed (no more `any` leak).
- `deepOmit` cycle cache via `visited.has(obj)` (was `cached !== undefined`); built-ins **cloned** by type (`Date` / `RegExp` / `Map` / `Set`, fallback `structuredClone`) instead of returned by reference; `__proto__` / `constructor` keys assigned via `Object.defineProperty` so they can't pollute `Object.prototype`; `ignoreKeys` probed via `Set` (was `Array.includes`).

### Added

- **Documentation site** — VitePress + TypeDoc + GitHub Pages workflow at <https://shi-rudo.github.io/ddd-kit-ts>. 13 hand-written guide pages plus auto-generated API reference via `typedoc-vitepress-theme`.
- `EventIdFactory` + `setEventIdFactory(fn)` / `resetEventIdFactory()` — global override for event-id generation (default `crypto.randomUUID()`). Per-call `options.eventId` still wins.
- `ClockFactory` + `setClockFactory(fn)` / `resetClockFactory()` — symmetric global override for `occurredAt`. For deterministic event-sourcing tests / time-travel debugging.
- `AggregateRoot.commit(newState, events)` — record-after-mutation helper.
- `AggregateRoot.markPersisted(version)` / `EventSourcedAggregate.markPersisted(version)` — post-save hook.
- `IQueryableRepository<TAgg, TId, TFilter>` interface.
- `IRepository.exists(id)`, `IRepository.getByIdOrFail(id)`.
- `DomainError` (abstract) + `MissingHandlerError` + `AggregateNotFoundError` + `ConcurrencyConflictError` in `src/core/errors.ts`.
- `DomainEvent.eventId` / `aggregateId` / `aggregateType` fields.
- `OutboxRecord<Evt>` + `Outbox.getPending(limit?)` + `Outbox.markDispatched(dispatchIds)`.
- `EventBus.once(eventType, { signal, timeoutMs })` — abortable / time-limited waits.

### Fixed

- `EventSourcedAggregate.apply()` no longer leaves state partially mutated when the handler throws. Computes the next state in a temporary; only the atomic commit step mutates `_state`, pushes the event, and bumps the version.
- `loadFromHistory()` no longer stomps version to `history.length` — advances additively from the aggregate's current version.
- `restoreFromSnapshotWithEvents()` rolls back state + version when a mid-replay event throws.
- `AggregateRoot.domainEvents` and `EventSourcedAggregate.pendingEvents` getters return a `Object.freeze(arr.slice())` snapshot (were returning the internal array directly — outside code could push into it).
- `Entity._state` is shallowly frozen on every assignment (`Object.freeze`); the `state` getter exposes the same frozen object. Direct property writes throw in strict mode; nested mutation still bypasses (deep freeze on every assignment would be too costly on hot paths — documented).
- `withCommit` publishes events **after** `scope.transactional` resolves (was: inside the transactional callback). No more publish-before-commit.
- `EventBus.once()` no longer leaks the subscription forever when the event never arrives — the optional `signal` / `timeoutMs` paths clean up the handler + the timer + the abort listener atomically.

### Documentation

- README points to the docs site at the top and is no longer the primary entry point for narrative content.
- `addDomainEvent` JSDoc spells out the "record AFTER mutation" rule with a concrete example and the Vernon rationale.
- `Entity.validateState` JSDoc warns about the constructor-order footgun (subclass field initializers haven't run when validateState is called from the base constructor); a pinning test exercises it.
- `EventBus.publish` JSDoc spells out the ordering / parallelism / error-aggregation contract; three tests pin each rule.
- `EventBus.once` JSDoc and a `OnceOptions` interface document the AbortSignal + timeout semantics.
- `IRepository.save` JSDoc states the contract: throw `ConcurrencyConflictError` on version mismatch; call `aggregate.markPersisted(newVersion)` after successful write.
- `IRepository.find` (on `IQueryableRepository`) JSDoc states "returns every match — no pagination; for unbounded sets prefer read-side projections or declare domain-specific paged methods on the concrete repository."
- `Outbox.add` JSDoc documents the idempotency expectation (dedupe on `eventId`).
- `setEventIdFactory` / `setClockFactory` JSDoc warns "module-scoped, last setter wins — for multi-tenant request isolation prefer the per-call `options` override."
- README event-ordering callout points to both `EventSourcedAggregate.apply()` (structural enforcement) and `AggregateRoot.commit()` (opt-in helper) instead of treating record-after-mutation as a convention.
- New "Event-Sourcing Schema Evolution (Upcasting)" section in README documents the recommended consumer pattern. The library deliberately ships no `EventUpcaster` port.
- ValueObject section in README spells out: `voWithValidation` for parsing untrusted input at the App boundary; `ValueObject` base class for Domain construction.

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
