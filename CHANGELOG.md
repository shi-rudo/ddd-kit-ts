# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — Document Identity-Map requirement for Repository implementations

`docs/guide/repository.md` gains a new "Identity Map: one instance per aggregate per Unit of Work" section that names the unspoken assumption behind `withCommit`'s aggregate-dedupe: two `getById(id)` calls within the same UoW MUST return the **same in-memory instance**. This is Fowler's Identity Map pattern (*PoEAA*, 2002), implicitly assumed by Evans, Vernon, Khononov, and the broader DDD/CQRS-ES canon, but never previously stated in the kit's docs.

Without the contract spelled out, a consumer could read `withCommit`'s dedupe behaviour as "the kit handles aggregate identity entirely" and build a Repository without Identity-Map semantics — silently corrupting outbox dispatch when two distinct instances with the same id are returned.

The new section covers: the contract verbatim, why it matters (dedupe is by JS object identity, not by aggregate id), how most ORMs provide it for free (Drizzle session, Prisma client, EF Core context, Mongo session), and a worked code snippet for hand-rolled repositories using a per-UoW `Map<TId, TAgg>`. Closes by warning that the identity map's lifetime IS the Unit of Work — caching across UoW boundaries silently bypasses optimistic concurrency.

Cross-referenced from `withCommit`'s JSDoc so a reader landing on the duplicate-aggregate dedupe behaviour sees the Repository requirement that makes it sound.

### Changed — `withCommit` dedupes aggregates by reference

If a use case accidentally returns the same aggregate instance more than once in the `aggregates` array — typically because two repository references resolve to the same identity-map entry — `withCommit` now dedupes by JavaScript object identity before harvesting. Each event lands in the outbox exactly once and `markPersisted` fires exactly once.

Previously the same event would land in the outbox twice (duplicate `dispatchId` collisions in `InMemoryOutbox`, row-uniqueness conflicts in a SQL outbox without `(eventId)` constraints) and `markPersisted` would run twice on the same aggregate (second call a no-op since `pendingEvents` was empty after the first, but version assignment ran twice with the same value).

Dedupe is by object identity (`new Set(aggregates)`). Two **different** instances with the same logical id — which would indicate a separate aggregate-instance-sharing violation upstream — cannot be detected at this layer. Defensive behaviour change, non-breaking: no consumer's existing code does worse after this change.

JSDoc on `withCommit` mentions the dedupe behaviour explicitly so the contract is part of the published surface.

### Added — Doc: globals-vs-DI trade-off for `EventIdFactory` / `ClockFactory`

`docs/guide/design-decisions.md` gains a new section naming the architectural choice the kit made: module-level globals + scoped helpers + per-call overrides for `EventIdFactory` and `ClockFactory`, instead of Vernon IDDD §13's preferred constructor-injection pattern. Reading the docs in order without this section, a consumer sees the global-with-helpers path as THE supported way and either assumes the kit endorses globals as best practice, or rolls Vernon-DI ad-hoc without realising the kit's per-call `{ eventId, occurredAt }` is the canonical hook for it.

The new section spells out:

- **Why globals are the default.** Production fast path (events with default clock + UUID) benefits from minimal aggregate-construction surface.
- **Trade-off table.** Race-free-structurally vs minimal-constructor, edge-runtime plumbing, DDD-canon strictness.
- **Worked code snippet showing Vernon-DI on top.** Constructor-injected `clock` and `idGen`, no globals touched, `createDomainEvent`'s per-call `{ eventId, occurredAt }` doing the work. No library change required.
- **When the scoped helpers still win even in a DI-leaning codebase.** Events constructed deep inside domain methods where threading explicit options through every `createDomainEvent` call is awkward.

Doc-only. Honest framing for Vernon-leaning readers; the kit's design choice is preserved.

### Added — Scoped factory helpers `withEventIdFactory` / `withClockFactory`

`setEventIdFactory` and `setClockFactory` mutate module-level globals, which races under two real workloads:

- **Parallel tests** — vitest's default `pool: "threads"` (and `"forks"`) runs test files concurrently. Test A's `setEventIdFactory(deterministicGen)` leaks into Test B's `createDomainEvent(...)` running in parallel; the "call once at bootstrap" advice in the existing JSDoc breaks down here.
- **Multi-tenant request handlers** — Request A and Request B sharing the same process collide on the global if each wants a tenant-specific factory.

New helpers:

```ts
withEventIdFactory(factory, () => { /* sync work */ });
withClockFactory(factory, () => { /* sync work */ });
```

Both install the supplied factory, run the callback, and restore the previous factory in a `finally` block — so restoration happens even when the callback throws. Composable via nesting: an inner `withEventIdFactory` restores back to the outer's factory; the outer restores to the original.

**Sync-contract enforced at runtime.** If `fn` returns a thenable (a Promise or any object with a `then` method), both helpers throw before returning the value to the caller. This catches the async-misuse footgun where the JS try/finally + return semantics would restore the factory before the awaited body of `fn` ran, leaving the awaited code silently reading the previous factory. For async-scoped factories spanning `await` boundaries, use `AsyncLocalStorage` — explicitly out of scope for these helpers; build on top if needed.

`setEventIdFactory` / `setClockFactory` stay as the global-mutation helpers (still appropriate for once-at-bootstrap calls); the new helpers are the safer choice for tests and short-lived contexts. Their JSDoc now points at the scoped variants.

Tests cover: factory installed during fn (eventId + clock variants), restored after fn returns, restored after fn throws, fn's return value propagated, nested composition (inner restores to outer, outer restores to original), and the thenable-guard rejecting both real Promises and raw thenables.

### Added — `onPersisted(version)` Template-Method hook on both aggregate flavours

`AggregateRoot` and `EventSourcedAggregate` both gain a `protected onPersisted(version: Version): void` no-op default. `markPersisted(version)` calls it after the framework's cleanup (`setVersion` + `pendingEvents = []`). Subclasses should override `onPersisted` for post-persist logging, metrics, or cache-eviction — never override `markPersisted` directly.

Why: a consumer shipped an aggregate that overrode `markPersisted(version)` without calling `super.markPersisted(version)`. The framework's `pendingEvents = []` reset never ran; subsequent `withCommit` calls re-harvested the same events and double-dispatched them through the outbox. The bug was in user code (forgotten `super`) but the API surface invited it — `markPersisted` was the only obvious lifecycle hook, with no extension point next to it. This release adds the proper extension point structurally.

Design choices documented in JSDoc:

- **`onPersisted` receives only `version`, not the drained events.** Aggregate-level event-driven logic (audit logging, per-event-type side effects) belongs in `EventBus` subscribers or the outbox dispatcher — that's the Aggregate-Boundary separation Vernon's aggregate discipline is meant to preserve. Building event-aware logic into `onPersisted` recreates exactly the boundary problems the framework wants to keep apart. (Object-shape `onPersisted({ version, drainedEvents })` was considered and rejected for this reason; if a use case appears it can be added additively without breaking.)
- **Cleanup runs BEFORE the hook.** `markPersisted` does `setVersion` + `pendingEvents = []` *then* calls `onPersisted(version)`. Hook code can't accidentally read stale events.
- **`onPersisted` stays off `IAggregateRoot`.** Interface is the repository contract (`markPersisted` callable from outside); the hook is an internal subclass extension point. Keeps mock-shaped consumers (`{ id, version, markPersisted, … }`) compiling without ceremony.

Regression tests on both flavours assert the positive path (subclass overrides `onPersisted`, hook fires with correct version, `pendingEvents` is empty at hook time) and include a **negative example test** documenting the bug pattern with explicit ❌/✅ contrast — same intent expressed via direct `markPersisted` override (broken) vs `onPersisted` override (correct), so any future reader sees exactly what to avoid.

#### Migration

If you override `markPersisted(version)`, switch to overriding `onPersisted(version)`:

```diff
  class Restaurant extends AggregateRoot<RestaurantState, RestaurantId, RestaurantEvent> {
-   public override markPersisted(version: Version): void {
-     // logger.info("persisted", { id: this.id, version });
-     // ❌ Missing super call — pendingEvents leaks; next save double-dispatches
-   }
+   protected override onPersisted(version: Version): void {
+     // logger.info("persisted", { id: this.id, version });
+     // ✅ Framework cleanup already ran; pendingEvents is empty here.
+   }
  }
```

Direct `markPersisted` overrides without `super.markPersisted(version)` silently leak `pendingEvents` — observed in production usage on rc.5/rc.6. The kit cannot detect the missing `super` in TypeScript (no `final` keyword), but the JSDoc `@sealed`-style warning now flags it explicitly.

Non-breaking — existing overrides that DO call `super.markPersisted` continue to work; the new hook simply gives consumers a safer place to put their logic.

### Added — Reconstitution pattern documented (state-stored + event-sourced)

The kit shipped the mechanisms but only documented half: `loadFromHistory` is the canonical reconstitution path for event-sourced aggregates, but the state-stored case (`Repository.getById` reading a row and rebuilding an `Order` instance) had no documented pattern at all. Consumers had to discover that `protected constructor` + `protected setVersion` together form the kit's state-stored reconstitution surface, accessed via a `static Order.reconstitute(id, state, version)` helper on the aggregate.

New "Reconstitution" section in `docs/guide/aggregates.md` makes the convention explicit and grounds it in Vernon IDDD §11's explicit factory-vs-reconstitution distinction. Notes the terminology variations across DDD authors (Vernon: *reconstitute* / *materialize*; Khononov: *reconstitute*; Greg Young: *rehydrate* — all the same operation). Covers both aggregate flavours with worked code, and a "why reconstitution must NOT record events" subsection making the no-side-effects-on-the-event-pipeline rule explicit.

`docs/guide/repository.md` updated with the matching `getById` implementation showing `Order.reconstitute(row.id, row.state, row.version)` in context for both flavours.

Bonus: fixed a stale fact in `repository.md`'s `getByIdOrFail` description — `AggregateNotFoundError` is correctly described as an `InfrastructureError` (post the rc.5 error-hierarchy split), not a `DomainError`.

### Added — Static-factory convention documented in the aggregates guide

Every example in the kit uses `static Order.place(...)` / `static Customer.register(...)` style construction, but the prose never named the pattern. New section in `docs/guide/aggregates.md` makes the convention explicit and grounds it in Vernon IDDD §11 *Factories* — specifically the **Factory Method on the Aggregate Root** shape (§11 also covers standalone factory classes for cases that need external dependencies; both are valid).

Includes a worked code snippet showing `Order.place(id, customerId)` recording an `OrderPlaced` event inside the factory, plus three rationales — two from Vernon §11 (domain language, whole-object validity at construction) and one from ES/CQRS canon (atomic creation event). The section explicitly distinguishes which is which so readers don't conflate Vernon's `§11` argument with the event-recording concern.

Calls out that `Order.create(...)` is the weakest verb choice — it borrows JS boilerplate instead of the ubiquitous language — and recommends a domain-specific verb (place / draft / register / open / submit) when there is one. Notes that `protected constructor` on `AggregateRoot` and `EventSourcedAggregate` makes `new Order(...)` from outside the aggregate's file a compile error, so the static factory is the only public construction path.

### Added — Domain Services + Bounded Contexts notes in design-decisions.md

Two short prophylactic sections close common consumer questions that the kit's API surface raised but never answered:

- **Domain Services** — Vernon IDDD §7. The kit ships no `IDomainService` marker, no base class, no decorator. The reason: a marker that adds nothing at type or runtime level is just noise. A Domain Service is a function or interface alongside your aggregates; file naming and module structure identify it. With an example showing `calculateShippingCost(order, destination, rates): Money` as the canonical shape. Includes the Vernon §7 rule of thumb: a stateful "service" is a sign you've found a new aggregate.

- **Bounded Contexts** — Evans, *Domain-Driven Design* §14. The kit is BC-agnostic. Each BC is a module / package / repo importing the kit; the library prescribes no layout, no naming, no integration. Inter-BC communication is typically outbox + message broker (the topology the kit is designed for, but enforces nothing); the receiving BC translates incoming events via an Anti-Corruption Layer (Evans §14) using plain functions.

### Added — Event-ordering documented for `withCommit`, with the Vernon/Young caveat

The harvest order of events flowing through `withCommit` is now stated explicitly: events are concatenated in the order aggregates appear in the returned `aggregates` array, then in each aggregate's emission order. A regression test in `handler.test.ts` pins this down across three aggregates with multi-event emissions.

Crucially, the same docs now distinguish the two ordering guarantees that consumers conflate at their peril (Vernon IDDD §10; Greg Young):

- **Within a single aggregate** — causal order. `apply` / `commit` / `addDomainEvent` push to `pendingEvents` in domain-method invocation order, and subscribers MUST process them in that order. Inviolable.
- **Across aggregates within one `withCommit`** — incidental order, not a domain guarantee. Aggregates are independent consistency boundaries; events across them are eventually consistent. Parallel outbox dispatchers or message brokers may reorder them at delivery time.

The practical rule, now stated in `outbox.md` and the `withCommit` JSDoc: if a subscriber depends on the order in which events from *different aggregates* arrive, that's the wrong design — use `EventMetadata.causationId` for explicit causation, or a Process Manager to coordinate. Don't engineer against the harvest-order luck of being in the same batch.

### Added — "Where invariants live" map in the aggregates guide

DDD aggregates enforce business rules at four distinct locations and the kit exposes hooks at each — but consumers were re-deriving the map from scratch every time and often choosing the wrong location. New section in `docs/guide/aggregates.md` provides the canonical table:

| Location | What it guards | Library hook |
|---|---|---|
| **Per-state** | structural invariants ("total ≥ 0") | `validateState` (every `setState` / `commit`) |
| **Per-event (ES only)** | lifecycle invariants ("OrderShipped only after OrderConfirmed") | `validateEvent` (start of `apply()`) |
| **Per-method** | command-side guards ("can't confirm an empty order") | inline `if (...) throw` at the top of the domain method |
| **Cross-aggregate** | spanning invariants ("payment within 30min of order") | `EventBus` + Process Manager (eventual consistency) |

Each row has a worked code snippet and an explicit warning that cross-aggregate invariants cannot be enforced transactionally — Vernon's "modify one aggregate per transaction" rule (IDDD §10). If you want transactional cross-aggregate consistency, the aggregate boundaries are wrong.

Bonus: while in the file, fixed two stale facts in the Optimistic Concurrency section — `ConcurrencyConflictError` is now correctly described as an `InfrastructureError` subclass (post rc.5 hierarchy split), and the rc.5-era "repository calls `aggregate.markPersisted`" claim is replaced with the rc.6 `save()`-is-pure-persistence + `withCommit`-owns-the-lifecycle shape.

### Added — Snapshot-policy guidance in `event-sourcing.md`

`createSnapshot` and `restoreFromSnapshotWithEvents` shipped with mechanics-only docs. The when-to-snapshot question dominates load latency at scale and was nowhere addressed. New "Snapshot policies" subsection covers the three canonical strategies:

- **Every-N-events** — simplest, predictable; oversamples hot streams and undersamples cold ones
- **Time-based** — smooths bursts and idle periods; quiet aggregates still get snapshots eventually
- **On-demand / background job** — moves snapshot pressure off the write path; needs operational machinery

Each strategy has working pseudocode with the appropriate snapshot-store sketches, plus an honest trade-off block. The section explicitly notes what the library does NOT ship (no `SnapshotPolicy` port, no default frequency, no built-in sweeper) and adds a closing note on snapshot invalidation when event schemas change.

Bonus: while in the file, fixed a stale rc.5-era `save()` example that still called `markPersisted` from inside `Repository.save` — replaced with the rc.6 pure-persistence shape and a pointer to the `withCommit` lifecycle.

### Added — Process Manager / Saga example (`examples/saga/`)

A worked example showing how `EventBus`, `CommandBus`, `withCommit`, `IRepository`, and `InMemoryOutbox` compose into a Vernon-style Process Manager (IDDD §12-13). Four aggregates — `Order`, `Payment`, `Shipment`, and `CheckoutSaga` (the Process Manager itself) — orchestrate a multi-step checkout flow with three end-to-end tests: happy path, payment-failure compensation, and shipping-failure compensation (payment refunded + order cancelled).

The saga is itself an `AggregateRoot<CheckoutSagaState, OrderId>`. This example takes the strict form (`TEvent = never`, outputs are exclusively dispatched commands), but the README documents the looser alternative where Process Managers also publish progress / observability events — Vernon's IDDD §12 examples often do.

Includes a `README.md` explaining the pattern, the saga-as-aggregate framing, the Saga-vs-Process-Manager terminology (Garcia-Molina/Salem 1987 vs Hohpe/Woolf), EventBus-subscribers-as-reflexes, the compensation-via-forward-commands principle, and production caveats: outbox-dispatcher for durability, optimistic concurrency on the saga aggregate, **idempotent compensating domain methods** (the example's `Payment.refund()` throws on second call — fine for in-process tests, broken under at-least-once delivery; needs rework for production per Newman, *Building Microservices* §4), subscriber error-handling semantics, and saga-timeout strategies.

The library deliberately ships no `Saga` abstraction — sagas vary too much (choreography vs orchestration, state-machine shapes); the example is the documentation. Cross-linked from `docs/guide/cqrs-and-buses.md`.

### Added — Documentation for `Repository.delete` + domain-event pipeline

`IRepository.delete(id)` is pure persistence — the contract takes only the id, so there's no aggregate to harvest pending events from. Consumers who need an event recorded atomically with the row removal had to figure out the wiring themselves. Now spelled out in three canonical patterns (`docs/guide/repository.md` → "Deletion and Domain Events"), framed around the right question: *"is `delete` even the right domain verb here?"* Most user-facing deletes are state transitions (cancel, archive, close, deactivate, terminate) with proper domain names — they aren't deletes at all.

1. **State transition that records an event** — the most common case. The use case calls a domain method like `order.archive()` or `subscription.cancel()`; `save()` persists the new state; `delete(id)` is never called.
2. **Hard-delete with event harvest** — when the row truly must vanish (privacy/regulatory purge, retention windows, true termination) *and* the disappearance is a domain fact subscribers care about. Inside `withCommit`: record the event on the aggregate, call `delete(id)`, return the aggregate in `aggregates[]` so the outbox receives the event before the row is gone.
3. **Hard-delete without event** — internal GC where deletion is invisible to the domain (abandoned carts, expired sessions). If the entity has identity in the ubiquitous language, you probably want pattern 1 or 2 instead.

The new section also notes that `IRepository.delete` is rarely meaningful in pure event-sourced systems — end-of-lifecycle there lives in the stream as a `Closed` / `Terminated` event, and identity persists in the event log. `delete` applies primarily to state-stored aggregates and snapshot tables.

`IRepository.delete`'s JSDoc points at the doc and summarises the three patterns inline.

### Added — Read-Side Projections guide (`docs/guide/projections.md`)

New documentation page for the canonical CQRS read-side flow: outbox → dispatcher → projection handlers → read-model tables → `QueryBus`. Covers the dispatcher loop pattern (polling + queue-based variants), the event-type-keyed projection-handler shape (mirroring `EventSourcedAggregate.handlers`), the `last_event_id` idempotency trick, the QueryHandler-reads-from-projection wiring, and eventual-consistency UX strategies. Closes a long-standing pedagogical gap where the kit shipped all the pieces but never showed them composed end-to-end.

Includes a full topology snippet wiring `withCommit`, `InMemoryOutbox`, `EventBusImpl`, `CommandBus`, `QueryBus`, and a projection together. Explicitly documents what the library does NOT ship (no `ProjectionHandler` type, no dispatcher impl, no replay tooling) and why — projections are consumer territory; the kit's contract ends at the outbox.

Cross-links from `outbox.md` and `cqrs-and-buses.md`; new sidebar entry under "Application Layer".

### Changed — Document the `version === 0` / `version > 0` insert-vs-update convention

`IRepository.save`'s JSDoc and `docs/guide/repository.md` now explicitly document the library's convention for distinguishing fresh aggregates from existing ones: `aggregate.version === 0` means INSERT, `aggregate.version > 0` means UPDATE with the OCC predicate `WHERE id = ? AND version = expected`. Every persistence-layer adapter has to make this distinction; now it's stated once and pointed at from JSDoc. Also fixes two stale facts in `repository.md`: `save()` no longer instructs implementors to call `markPersisted` (the `withCommit` orchestrator owns the lifecycle since rc.6), and `AggregateNotFoundError` / `ConcurrencyConflictError` are correctly described as `InfrastructureError` subclasses, not `DomainError`.

Docs-only — no API change.

## [1.0.0-rc.6] - 2026-05-24

The big architectural hardening pass. Closes the gap between what the kit's docs promised and what the code actually delivered — particularly around the Repository/withCommit lifecycle, the event-port contract, and the EventSourcedAggregate version model. Six breaking changes, all driven by Vernon / Greg Young / Khononov / Axon / EventFlow research into the canonical DDD patterns; each one removes a footgun rather than adding a feature.

Highlights:

- `withCommit` now owns the post-save event lifecycle (harvest, outbox, mark-persisted, publish). `Repository.save` is pure persistence. The previous documented use-case pattern was latently broken — `repo.save` cleared events before they could be harvested.
- `EventSourcedAggregate` loses the `autoVersionBump` flag entirely. Version IS event count per Greg Young / Vernon §9; there is no canonical use-case for opting out, and the flag was non-functional anyway (it promised `setVersion` access that was private).
- `TransactionScope<TCtx>`, `EventBus`, `Outbox`, `withCommit` all tighten their generic constraints: `TCtx` has no default; events must extend `AnyDomainEvent`. The looser shapes invited misuse the kit's own implementations didn't follow.
- `AggregateRoot.domainEvents` is renamed to `pendingEvents` to unify with `EventSourcedAggregate`. The `IAggregateRoot` interface now exposes `pendingEvents` + `clearPendingEvents` so generic repository code works across both flavours.
- `restoreFromSnapshot*` deep-clones the snapshot input — fixes a latent footgun where caller mutations bled into the live aggregate.
- Three convenience helpers (`hasPendingEvents`, `getEventCount`, `getLatestEvent`) removed — `.length > 0` / `.length` / `.at(-1)` are the idioms.

Plus: `InMemoryOutbox<Evt>` reference implementation shipped, entity-collection helpers widened to `ReadonlyArray<T>`, dedicated test files for `core/errors` and `repo/scope` (+21 tests).

Naming: every example identifier follows Vernon's Persistence-oriented Repository style (`orderRepository`, not `orders`).

### Changed — Entity-collection helpers accept `ReadonlyArray<T>`

`findEntityById`, `hasEntityId`, `removeEntityById`, `updateEntityById`, `replaceEntityById`, and `entityIds` now declare their `entities` parameter as `ReadonlyArray<T>` instead of `T[]`. None of these helpers ever mutated the input — the mutable-array signature was forcing callers holding a `readonly OrderItem[]` (e.g. inside a frozen aggregate state slice) to cast or copy unnecessarily. Mutable arrays continue to work since `T[]` is assignable to `ReadonlyArray<T>`.

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
