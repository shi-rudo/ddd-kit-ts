# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — `InMemoryOutbox<Evt>` reference implementation

Ships an in-memory `Outbox<Evt>` implementation alongside `EventBusImpl`, so consumers no longer have to copy-paste the Map-backed boilerplate from the docs for every test or quick-start demo:

```ts
import { InMemoryOutbox } from "@shirudo/ddd-kit";

const outbox = new InMemoryOutbox<OrderEvent>();
await withCommit({ scope, outbox, bus }, async (tx) => { … });
```

Uses each event's own `eventId` as the `dispatchId` and keys storage on `eventId`, so re-adds are naturally idempotent. For production, swap it for an outbox backed by your transactional store.

### BREAKING — `withCommit` use case returns `aggregates`, not `events`; `Repository.save` is pure persistence

`withCommit` now owns the post-save lifecycle (harvest pending events, write outbox, mark persisted after commit, publish to bus). `Repository.save` is responsible for **persistence only** and must NOT call `aggregate.markPersisted(...)` itself. This is the Vernon / Axon / EventFlow unit-of-work pattern — `save` is "I wrote this row"; "this aggregate has been committed" is the orchestrator's call to make.

```diff
  await withCommit({ scope, outbox, bus }, async (tx) => {
    const orderRepository = makeOrderRepository(tx);
    const order = await orderRepository.getByIdOrFail(orderId);
    order.confirm();
-   await orderRepository.save(order);  // also called markPersisted internally
-   return { result: order.id, events: order.pendingEvents };
+   await orderRepository.save(order);  // pure persistence — no markPersisted
+   return { result: order.id, aggregates: [order] };
  });
```

```diff
  // Repository implementation
  async save(aggregate: Order): Promise<void> {
    if (aggregate.version !== currentDbVersion + 1) {
      throw new ConcurrencyConflictError("Order", aggregate.id, currentDbVersion, aggregate.version);
    }
    await db.upsert({ id: aggregate.id, state: aggregate.state, version: aggregate.version });
-   aggregate.markPersisted(aggregate.version);  // DON'T do this anymore
+   // withCommit calls markPersisted after the transaction commits
  }
```

Why this is BREAKING and worth doing: the prior contract had `Repository.save` clear pending events as a side effect, but the documented use-case pattern then read `order.pendingEvents` AFTER the call. With a correct `save` implementation that list would be empty by then — the outbox would receive nothing. The bug was latent in the kit's docs and tests; no integration test exercised the full path. The new shape closes both ends: pending events are harvested by the library (so the user can't get the order wrong), and `markPersisted` only fires after the transaction commits (so a rolled-back transaction never silently consumes the aggregate's pending events).

Migration:
1. Use-case bodies inside `withCommit`: return `{ result, aggregates: [agg, ...] }` instead of `{ result, events: agg.pendingEvents }`.
2. Repository implementations: remove the `aggregate.markPersisted(...)` call from `save`. `save` should now just write and return.
3. Custom orchestration outside `withCommit`: call `aggregate.markPersisted(aggregate.version)` yourself **after** you have harvested `aggregate.pendingEvents` for downstream dispatch.

### BREAKING — Unify `pendingEvents` accessor across both aggregate flavours

`AggregateRoot.domainEvents` / `clearDomainEvents()` are renamed to `pendingEvents` / `clearPendingEvents()`, matching `EventSourcedAggregate`. The shared accessor is hoisted to the `IAggregateRoot<TId, TEvent = never>` interface so a generic `Repository.save()` can harvest pending events uniformly without branching on the aggregate flavour.

```diff
- aggregate.domainEvents              // ReadonlyArray<TEvent>
- aggregate.clearDomainEvents()
+ aggregate.pendingEvents             // ReadonlyArray<TEvent>
+ aggregate.clearPendingEvents()
```

The protected `addDomainEvent(event)` helper on `AggregateRoot` is **unchanged** — the verb-object pattern names what's being added (a domain event), while the container's lifecycle name (`pendingEvents`) describes the not-yet-flushed state. Both readings coexist consistently.

`IAggregateRoot<TId>` gains a second generic param `TEvent` (default `never`) so the interface can carry the typed `pendingEvents` array. Existing consumers writing `IAggregateRoot<OrderId>` keep compiling; `pendingEvents` is `ReadonlyArray<never>` (always empty) for the no-events case.

### Removed — `hasPendingEvents`, `getEventCount`, `getLatestEvent` helpers on `EventSourcedAggregate`

These three convenience methods are deleted. Each was a trivial wrapper that adds API-surface bloat without earning its keep:

```diff
- aggregate.hasPendingEvents()
- aggregate.getEventCount()
- aggregate.getLatestEvent()
+ aggregate.pendingEvents.length > 0
+ aggregate.pendingEvents.length
+ aggregate.pendingEvents.at(-1)
```

`getEventCount` was actively misleading (a method wrapping `.length`); `getLatestEvent` predates `Array.prototype.at()` being idiomatic. Reduces the symmetric surface across both aggregate flavours.

### Fixed — `restoreFromSnapshot*` now deep-clones the snapshot input

`AggregateRoot.restoreFromSnapshot` and `EventSourcedAggregate.restoreFromSnapshotWithEvents` previously did only `freezeShallow(snapshot.state)`, leaving nested fields aliased to the caller's snapshot object. A caller that mutated a nested field on `snapshot.state` after passing it in would silently bleed the mutation into the live aggregate (only the top-level object was frozen).

`createSnapshot` already clones on the way out; the restore paths now mirror that contract on the way in:

```diff
+ const cloned = structuredClone(snapshot.state);
- this._state = freezeShallow(snapshot.state);
+ this._state = freezeShallow(cloned);
```

Adds tests on both flavours that mutate the original snapshot post-restore and assert the aggregate is unaffected. No API change; non-breaking.

### BREAKING — Remove `EventSourcedAggregateConfig` / `autoVersionBump` from `EventSourcedAggregate`

`EventSourcedAggregate` no longer accepts a config object. The `EventSourcedAggregateConfig` interface and the `autoVersionBump` flag are deleted. Every `apply()` bumps the version by one — no opt-out.

```diff
- super(id, initialState, { autoVersionBump: false });
+ super(id, initialState);
```

The flag was non-functional in practice: its JSDoc promised user-controlled versioning via `bumpVersion()` / `setVersion()` calls, but `setVersion` was `private` — consumers had no way to actually set the version. Replay (`loadFromHistory`, `restoreFromSnapshotWithEvents`) also ignored the flag entirely, always deriving version from `history.length`. The escape hatch led nowhere.

DDD literature is unanimous on the canonical rule (Greg Young; Vernon IDDD §9; Khononov *Learning DDD*): for an event-sourced aggregate, **the aggregate version IS the event count**. There is no canonical use-case for manual version control on an event-sourced aggregate. If your event store has a stream-position concept (EventStoreDB `streamRevision`, Marten / Equinox offsets), keep it as a store-layer detail — it is not the aggregate's domain version.

`AggregateRoot.autoVersionBump` is **unchanged**. That flag is well-designed and Vernon-conformant: state-stored aggregates legitimately need a per-call escape hatch for cosmetic / denormalized state mutations that are not domain-meaningful (`setState(newState, false)`). The protected `bumpVersion()` / `setVersion()` methods stay where the user can reach them.

Migration: any subclass passing a config object to `super(...)` drops the third argument. Anyone who relied on `autoVersionBump: false` was almost certainly working around a misunderstanding of the JSDoc — the actual behavior they got never matched the promise. The library now matches the documentation.

### BREAKING — `TransactionScope<TCtx>`: no default for the context generic

`TCtx` no longer defaults to `unknown`. Every implementor names its context type explicitly:

```diff
- interface TransactionScope<TCtx = unknown> {
+ interface TransactionScope<TCtx> {
    transactional<T>(fn: (ctx: TCtx) => Promise<T>): Promise<T>;
  }
```

The `unknown` default in rc.5 was a back-compat convenience but encouraged a degenerate "ignore the ctx" mental model. In practice the ctx is almost always meaningful — the ORM tx handle, a tx-scoped logger, a correlation id. Forcing the type makes consumers articulate what lives in their unit-of-work boundary.

Migration: pick a concrete type. Drizzle / Prisma / Mongo users already write `TransactionScope<DrizzleTx>` etc. and need no change. Context-free scopes (in-memory tests, naive no-tx scopes) spell out `TransactionScope<undefined>`:

```diff
- const scope: TransactionScope = {
-   transactional: <T>(fn: (_ctx: unknown) => Promise<T>) => fn(undefined),
+ const scope: TransactionScope<undefined> = {
+   transactional: <T>(fn: (_ctx: undefined) => Promise<T>) => fn(undefined),
  };
```

`withCommit` loses its `TCtx = unknown` default as well; `TCtx` is inferred from the `scope` argument, so call sites typically need no change.

### BREAKING — Event-port constraints tightened to `AnyDomainEvent`

`EventBus`, `Outbox`, `OutboxRecord`, and `withCommit` previously accepted any `{ type: string }` shape (or, for `Outbox` / `OutboxRecord`, no constraint at all). They now all require `Evt extends AnyDomainEvent` — a new exported alias for `DomainEvent<string, unknown>`:

```diff
- interface EventBus<Evt extends { type: string }> { … }
- interface Outbox<Evt> { … }
- interface OutboxRecord<Evt> { … }
- function withCommit<Evt extends { type: string }, R, TCtx>(…)
+ interface EventBus<Evt extends AnyDomainEvent> { … }
+ interface Outbox<Evt extends AnyDomainEvent> { … }
+ interface OutboxRecord<Evt extends AnyDomainEvent> { … }
+ function withCommit<Evt extends AnyDomainEvent, R, TCtx>(…)
```

The DDD-kit ports are for *domain* events, not arbitrary tagged unions. Previously the concrete `EventBusImpl` already constrained to `DomainEvent<string, unknown>` — the public ports were looser than the only implementation. The new constraint aligns the interfaces with their stated purpose and prevents non-event objects from leaking through the outbox / bus pipeline.

The `unknown` in `AnyDomainEvent` is an upper bound, not a value that flows through methods: when a consumer supplies a concrete event union as the type argument, `EventBus.subscribe<K>` still sees the specific payload via `Extract<Evt, { type: K }>`.

Migration: ad-hoc shapes like `{ type: "OrderCreated"; orderId: string }` need to become proper domain events:

```diff
- type OrderCreated = { type: "OrderCreated"; orderId: string };
+ type OrderCreated = DomainEvent<"OrderCreated", { orderId: string }>;

- const events = [{ type: "OrderCreated", orderId: "o-1" }];
+ const events = [createDomainEvent("OrderCreated", { orderId: "o-1" })];
```

Same alignment landed for `IEventSourcedAggregate`, `EventSourcedAggregate`, and the internal `Handler<TState, TEvent>` type — all now reference `AnyDomainEvent` instead of inlining `DomainEvent<string, unknown>`. `copyMetadata` and the `EventUpcaster` examples in the docs follow the same alias.

### BREAKING — `loadFromHistory` / `restoreFromSnapshotWithEvents` accept `ReadonlyArray<TEvent>`

```diff
- loadFromHistory(history: TEvent[]): Result<void, DomainError>;
+ loadFromHistory(history: ReadonlyArray<TEvent>): Result<void, DomainError>;

- restoreFromSnapshotWithEvents(snapshot, eventsAfterSnapshot: TEvent[]): …
+ restoreFromSnapshotWithEvents(snapshot, eventsAfterSnapshot: ReadonlyArray<TEvent>): …
```

The implementations never mutated the input — the mutable-array signature was misleading. The new shape declares the actual contract: the aggregate only consumes the history, it never writes back. Callers passing `TEvent[]` continue to work (mutable arrays are assignable to `ReadonlyArray<T>`); callers whose own variable was already typed `ReadonlyArray<TEvent>` no longer need a copy.

## [1.0.0-rc.5] - 2026-05-24

Adds an explicit transaction context to `TransactionScope` so consumer repositories can bind to the live Drizzle/Prisma/Mongo handle without falling back to `AsyncLocalStorage`. Also polishes the error contract (cause chains now actually propagate through library errors) and fixes JSDoc examples that referenced a non-existent `repo.save(tx, order)` API.

### BREAKING — `TransactionScope<TCtx>`: explicit context generic

`TransactionScope` is now generic over the persistence layer's transaction handle:

```ts
interface TransactionScope<TCtx = unknown> {
  transactional<T>(fn: (ctx: TCtx) => Promise<T>): Promise<T>;
}
```

The previous shape gave `fn` no way to receive Drizzle's `tx`, Prisma's `tx`, or Mongo's session, so consumers had to fall back to `AsyncLocalStorage` or constructor injection to bind their repositories to the live transaction. The new generic lets the scope pass the handle in, and `withCommit` threads it through:

```ts
// Drizzle-flavoured
class DrizzleScope implements TransactionScope<DrizzleTx> {
  constructor(private db: DrizzleDb) {}
  async transactional<T>(fn: (tx: DrizzleTx) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => fn(tx));
  }
}

await withCommit({ scope, outbox }, async (tx) => {
  // IRepository takes only the aggregate / id; bind tx into the repo
  // at construction (constructor injection / factory / `.withTx()`).
  const orderRepository = makeOrderRepository(tx);
  const order = await orderRepository.getByIdOrFail(orderId);
  order.confirm();
  await orderRepository.save(order);
  return { result: order.id, events: order.domainEvents };
});
```

Default `TCtx = unknown` keeps the no-context callers compiling — `withCommit({ scope, outbox }, async () => ({...}))` still works; the `ctx` parameter is simply ignored.

Migration: any custom `TransactionScope` implementation needs to update its `fn` parameter to accept `(ctx: TCtx) => Promise<T>` (or `(_ctx: unknown) => Promise<T>` for the no-context path). Test fakes typically change `fn()` to `fn(undefined)`.

### Added

- **`cause?: unknown` parameter on every library error constructor.** `AggregateNotFoundError`, `ConcurrencyConflictError`, and `MissingHandlerError` now forward the cause to `BaseError`, so the cause-chain helpers from `@shirudo/base-error` (`getRootCause`, `findInCauseChain`, `filterCauseChain`) traverse into wrapped lower-level errors. A `Repository.save()` implementation can now wrap the driver error without losing context:
  ```ts
  catch (driverError) {
    throw new ConcurrencyConflictError("Order", id, expected, actual, driverError);
  }
  ```

### Changed

- **`withCommit` no longer calls `outbox.add` or `bus.publish` when the use case emits no events.** State-only mutations and audit-only commands now skip the SQL round-trip and the `Promise.allSettled([])` allocation. Functional behaviour is unchanged for use cases that do emit events.
- **`AggregateNotFoundError`'s default user message no longer lowercases the aggregate type.** Compound names like `OrderLineItem` now read naturally in the message instead of `orderlineitem`. Behaviour change for consumers reading `error.getUserMessage()` directly without overriding it via `addLocalizedMessage`.

### Fixed

- **Documentation no longer shows a fictional `repo.save(tx, order)` signature.** `IRepository.save` takes only the aggregate; the tx handle is bound into the repository at construction (constructor injection / factory / `.withTx()` chain). The `TransactionScope` / `withCommit` JSDoc examples and `docs/guide/outbox.md` now show the canonical idiom so copy-paste consumers don't hit a TS error against the kit's own contract.

## [1.0.0-rc.4] - 2026-05-23

Cleanup release on top of rc.3. Drops the redundant `KitError` marker class and adjusts the legal posture of the docs site (Pages deployment disabled until the legal-notice + privacy pages are in place). Repo hygiene: stale `.DS_Store` entries untracked, `.beads/` ignore-rule corrected so project-shared Beads files (hooks, config) stay in git per Beads' own convention.

### BREAKING — Drop `KitError`; `DomainError` / `InfrastructureError` extend `BaseError` directly

`KitError` was a redundant abstraction layer. Semantically it duplicated the `isBaseError(e)` predicate from `@shirudo/base-error`, while the name "kit" said nothing about what the library does, and the boundary it claimed to draw ("library-internal") didn't actually hold — `DomainError` is shared between library and consumer-derived errors. Removing it.

New hierarchy:

```ts
import { BaseError } from "@shirudo/base-error";

abstract class DomainError<Name>         extends BaseError<Name> {}
abstract class InfrastructureError<Name> extends BaseError<Name> {}

class MissingHandlerError       extends BaseError<"MissingHandlerError"> {}
class AggregateNotFoundError    extends InfrastructureError<"AggregateNotFoundError"> {}
class ConcurrencyConflictError  extends InfrastructureError<"ConcurrencyConflictError"> {}
```

Migration: replace `instanceof KitError` at the App-Service catch-all with `isBaseError(e)` from `@shirudo/base-error`:

```diff
- import { KitError } from "@shirudo/ddd-kit";
+ import { isBaseError } from "@shirudo/base-error";

  catch (e) {
-   if (e instanceof KitError) { ... }
+   if (isBaseError(e)) { ... }
  }
```

The discriminators `DomainError` / `InfrastructureError` / `MissingHandlerError` keep the same behaviour and remain the canonical catch points for HTTP 400 / 4xx / re-throw mapping.

### Other

- **GitHub Pages docs deployment disabled** pending a legal-notice page (Germany's TMG §5) and a privacy notice (GDPR Art. 13). The `Deploy Docs` workflow is now `workflow_dispatch`-only with a `legal_pages_in_place` boolean input gating the build job, so a re-deploy can only happen after those pages are published. The docs source stays in the repo and remains fully usable locally via `pnpm docs:dev`. `package.json`'s `homepage` reverted from the docs-site URL to the GitHub README.
- **`.beads/` ignore rule corrected.** The blanket `.beads/` entry in the top-level `.gitignore` was overriding Beads's own intended per-file tracking (`.beads/hooks/`, `config.yaml`, `metadata.json`, `README.md` are project-shared; Beads' nested `.beads/.gitignore` handles per-machine exclusions). Removed the blanket rule.
- **`.DS_Store` untracked.** Two stale entries (`./.DS_Store`, `src/.DS_Store`) committed before the ignore rule existed were removed from the index via `git rm --cached`.

## [1.0.0-rc.3] - 2026-05-23

Tightens the error contract on top of rc.2: every library error now extends `BaseError<Name>` from `@shirudo/base-error`, so timestamps / cause chains / user messages / retryable hints / structured-log serialisation come for free. Also splits the error hierarchy into three honest tiers (`KitError` / `DomainError` / `InfrastructureError`) so a "catch domain errors → HTTP 400" handler at the App boundary can't silently mask a programming bug like a forgotten event handler. Migration mostly mechanical: install `@shirudo/base-error` as a peer dep, switch `instanceof DomainError` to `instanceof InfrastructureError` where you were catching `AggregateNotFoundError` or `ConcurrencyConflictError`.

### BREAKING — New error hierarchy on top of `@shirudo/base-error`

Library-internal errors are reorganised into a three-tier hierarchy that separates **business-rule violations**, **infrastructure failures**, and **programming bugs** — and the abstract bases now extend `BaseError<Name>` from [`@shirudo/base-error`](https://www.npmjs.com/package/@shirudo/base-error) (added as a `peerDependency`, analogous to `@shirudo/result`):

```ts
import { BaseError } from "@shirudo/base-error";

abstract class KitError<Name>            extends BaseError<Name> {}   // marker for App-Service catch
abstract class DomainError<Name>         extends KitError<Name> {}    // invariant violations (consumer-derived)
abstract class InfrastructureError<Name> extends KitError<Name> {}    // persistence + concurrency

class AggregateNotFoundError    extends InfrastructureError<"AggregateNotFoundError"> {}    // was DomainError
class ConcurrencyConflictError  extends InfrastructureError<"ConcurrencyConflictError"> {}  // was DomainError; retryable: true
class MissingHandlerError       extends KitError<"MissingHandlerError"> {}                  // was DomainError — now programming bug
```

The previous hierarchy had `AggregateNotFoundError`, `ConcurrencyConflictError`, and `MissingHandlerError` all under `DomainError`, conflating three categories. `MissingHandlerError` deliberately no longer extends `DomainError` — it represents "the aggregate's subclass forgot to register a handler", which is a configuration/programming bug, not a business-rule violation. `loadFromHistory` and `restoreFromSnapshotWithEvents` continue to catch only `DomainError` thrown by `apply()`; a `MissingHandlerError` now propagates uncaught, so the bug surfaces loudly instead of being silently wrapped in `Result.Err`.

Because every library error now extends `BaseError<Name>`, consumers get for free:

- **Timestamps** (`error.timestamp`, `error.timestampIso`)
- **`error.toJSON()`** for structured logging
- **`error.getUserMessage()`** + `withUserMessage()` / `addLocalizedMessage()` for i18n-aware end-user messages
- **Cause chains** via the native `error.cause`, with traversal helpers (`getRootCause`, `findInCauseChain`, `filterCauseChain`)
- **`isRetryable(error)`** predicate. `ConcurrencyConflictError` ships with `retryable: true` so the canonical OCC retry-on-conflict pattern is one check away.
- **Typed `error.name`** — the concrete classes set their literal so `error.name` is `"AggregateNotFoundError"` (literal type), not `string`.
- **Cross-environment stack traces** for Node, browser, and edge runtimes.

`AggregateNotFoundError` and `ConcurrencyConflictError` ship with default English user-safe messages via `withUserMessage(...)` in their constructors. Consumers using non-English locales can override with `addLocalizedMessage("de", ...)` at use-site.

Catch-pattern at the App-Service boundary:
- `instanceof DomainError` → HTTP 400 (business rule)
- `instanceof InfrastructureError` → HTTP 404 / 409 (persistence boundary)
- `instanceof KitError` (else) → HTTP 500 / log + alert (currently only `MissingHandlerError`)
- anything else → HTTP 500 (unexpected programmer error)

Migration:
- `pnpm add @shirudo/base-error` (new peer dependency).
- Consumers who did `instanceof DomainError` to catch `AggregateNotFoundError` or `ConcurrencyConflictError` switch to `instanceof InfrastructureError` (or `KitError` if they want both branches).
- Consumers who subclassed the abstract bases without a generic (`class X extends DomainError {}`) keep compiling — the `Name` generic defaults to `string`. For typed `error.name` literals, pass the name: `class FooError extends DomainError<"FooError"> {}`.

### Documentation

- New "Where to bootstrap the factory" subsection in `docs/guide/domain-events.md` shows the three canonical placements for `setEventIdFactory` / `setClockFactory` (Node entry, Cloudflare Worker module-top-level, test setup file). Spells out "call it once per isolate boot, not inside `fetch()`" and routes per-tenant variance to the per-call `options.eventId` override instead of mutating the global per request.
- `docs/guide/domain-events.md` and `docs/guide/edge-runtimes.md` now explicitly tag the default `eventId` as **UUID v4** and recommend time-ordered alternatives (UUID v7 / ULID / KSUID) for production. v4 is random and amplifies B-tree index writes once the event store grows; time-ordered ids stay clustered.
- `EventIdFactory` JSDoc gets the same v4-vs-time-ordered note so IDE hover surfaces the recommendation.
- `package.json` `homepage` now points at the docs site (<https://shi-rudo.github.io/ddd-kit-ts/>) instead of the GitHub repo, so npmjs.com routes visitors through the guide first.


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
