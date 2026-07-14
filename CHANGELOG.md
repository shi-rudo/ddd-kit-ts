# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

3.0.0 carries everything since 2.2.0 in one breaking window. It has two
halves. The first is a tightening pass over the core: structured errors
with one identifier, a version bump on every `setState`, buses that
map only explicitly expected failures, one delete contract, identity-based repository
loads, and consumer-owned query ports. The second is the event-driven
periphery around that core: the outbox seam with a minimal dispatcher,
command idempotency, projections, a snapshot store, durable deadlines, the
specification primitive, adapter contract suites for all of it, and the
opt-in `@shirudo/ddd-kit/money` entry point. Details and rationale live
in the sections below; every break is covered in the migration guide
here, with a before and after.

### Migration guide: 2.2.0 to 3.0.0

Most of these surface at compile time. Seven do not (steps 3, 5, 11,
12, 14, 15, and 20) and deserve a deliberate pass over the call sites.

#### 1. Errors carry one identifier: match on `code`

Every kit error now carries a stable SCREAMING_SNAKE `code`, and
`error.name === error.code`. The old PascalCase class names are gone
from `error.name`.

```ts
// before (2.x)
if (error.name === "ConcurrencyConflictError") retry();

// after
if (error.code === "CONCURRENCY_CONFLICT") retry();
```

Consumer subclasses switch to the options-object super call with an
explicit code:

```ts
// before (2.x)
class OrderAlreadyShippedError extends DomainError {
  constructor(id: string) {
    super(`Order ${id} is already shipped`);
  }
}

// after
class OrderAlreadyShippedError extends DomainError<"ORDER_ALREADY_SHIPPED"> {
  constructor(id: string) {
    super({
      code: "ORDER_ALREADY_SHIPPED",
      message: `Order ${id} is already shipped`,
    });
  }
}
```

No base-error adoption is required: `switch (error.code)`, `instanceof
DomainError`, and plain `retryable` / `cause` reads cover the consumer
side; base-error's toolbox is an opt-in benefit on top.

#### 2. `setState` always bumps the OCC version

The implicit non-bumping default is gone (deprecated since 2.2.0). The
one-argument call is unchanged and now safe; the rare lossy mutation is
a word at the call site instead of a config flag.

```ts
// before (2.x): did NOT bump unless autoVersionBump was configured
this.setState(next);

// after: the same call bumps, which is what domain mutations want
this.setState(next);

// only for state that genuinely tolerates loss under a concurrent
// write (cosmetic caches, denormalized display fields)
this.setStateWithoutVersionBump(next);
```

Remove `autoVersionBump` from configs (`AggregateConfig` is now an
alias of `EntityConfig`); aggregates that had it set to `true` change
nothing else. On the event-sourced side, `apply(event)` lost its
optional `isNew` flag the same way: replay goes through
`loadFromHistory` / `restoreFromSnapshotWithEvents`, and `apply` is
only for new facts.

#### 3. Buses throw `UnregisteredHandlerError` (runtime change)

`CommandBus.execute` and `QueryBus.execute` throw the wiring-bug error
instead of returning it through the error channel. The type system does
not flag old err-branches; they just become dead code.

```ts
// before (2.x): the err branch could carry a wiring bug
const result = await commandBus.execute(command);
if (result.isErr()) {
  // domain failure OR "No handler registered for ..."
}

// after: the error channel only carries explicit expected failures;
// catch the named wiring type only at a deliberate seam
const result = await commandBus.execute(command); // throws on wiring bugs
```

#### 4. `delete` takes the aggregate

```ts
// before (2.x)
await orderRepository.delete(order.id);

// after: the instance, which deletion events and the OCC predicate
// need anyway; load first where only the id is at hand
await orderRepository.delete(order);
```

Id-only bulk cleanup moves off the aggregate repository port. Keep purely
infrastructure maintenance in an adapter-side component; if an application
use case invokes it, define a separate consumer-owned driven port such as
`ExpiredOrderPurger.purgeExpired(before)`.

#### 5. Repository loads follow the identity lookup contract (not compile-checked)

`getById` is renamed to `findById` (returns the aggregate or `null`),
and `getByIdOrFail` is renamed to `getById` (returns the aggregate or
throws `AggregateNotFoundError`).

```ts
// before (2.x)
const maybe = await repo.getById(id);       // Order | null
const order = await repo.getByIdOrFail(id); // Order, or it throws

// after
const maybe = await repo.findById(id);      // Order | null
const order = await repo.getById(id);       // Order, or it throws
```

A missed old `getById` call site compiles cleanly against the new
throwing method: the null check just becomes dead code and absence now
throws. Migrate mechanically in three steps so no site is missed:
rename `getByIdOrFail` to a placeholder, rename every `getById` to
`findById`, rename the placeholder to `getById`.

#### 6. `withCommit` / `UnitOfWork` deps carry `OutboxWriter` only

The `outbox` dependency is narrowed to the write half (`add` only).
Passing a full `Outbox` keeps working; reading it back off the deps
object no longer typechecks.

```ts
// before (2.x): deps.outbox was the full Outbox
await deps.outbox.getPending(10);

// after: hold your own reference for the delivery side
await withCommit({ outbox, bus, scope }, work); // full Outbox accepted
await outbox.getPending(10);                    // your own reference
```

#### 7. Hand-rolled `EventBus` implementations add `subscribeAll`

The port gained a required typed catch-all subscription. `EventBusImpl`
users are unaffected.

```ts
class BrokerBackedBus implements EventBus<AppEvent> {
  // new required member: deliver every event type to the handler,
  // in the same batch as the event's typed handlers
  subscribeAll(handler: (event: AppEvent) => Promise<void> | void): void {
    // ...
  }
  // subscribe, publish, ... as before
}
```

#### 8. Renamed and removed exports

Find and replace: the `deepOmit` helper types `Key` and `PathSegment`
are now `DeepOmitKey` and `DeepOmitPathSegment` (identical shapes).
`computeBackoffDelay` is no longer exported (internal since 2.x); the
retry behavior it implements is unchanged.

#### 9. Node 22+ and `@shirudo/base-error` ^8

`engines.node` moves to `>=22` (Node 20 reached end-of-life on
2026-04-30). The base-error peer moves to `^8.0.0`: its
`/presentation` and `/problem-details` subpaths merged into
`/public-error`, `toPublicErrorView` returns the 8.x
`LocalizedPublicError`, and `toProblemDetails` returns the 8.x
`ProblemDetails` with the machine-readable public `code` member. The
detailed section below has the catalog-mapping notes.

#### 10. Contract-suite assertion prefixes

Only relevant if tooling greps suite output: failure messages now start
with "Contract violated:" / "Contract test skipped:" instead of the
repository-specific prefixes. Behavior and test names are unchanged.

#### 11. Replay trusts history: `validateEvent` and `validateState` no longer judge it (runtime change)

`loadFromHistory` and `restoreFromSnapshotWithEvents` stop invoking
`validateEvent`, and the snapshot path stops running `validateState` on
the restored state; both guard NEW facts on the `apply()` path only.
History is already accepted fact, and decision rules change over time;
before this change, tightening a rule could make legitimately persisted
streams (or snapshots derived from them) fail to load, and the two load
paths disagreed about it. Now "replay from zero equals snapshot plus
tail" holds by construction.

```ts
// before (2.x): ran on apply AND on every replayed event
protected validateEvent(event: OrderEvent): void {
  if (event.type === "OrderConfirmed" && this.state.status === "confirmed") {
    throw new OrderAlreadyConfirmedError(this.id);
  }
}

// after: same override, apply-path only. Old storage shapes are decoded
// and upcast at the read boundary (event-upcasting guide); handlers and
// replay always receive the current event shape.
```

Both paths gain an address discipline in exchange, with distinct error
families because the situations differ. On `apply()`, missing address
fields are STAMPED from the aggregate (the `recordEvent` guarantee, now
by construction), and a present-but-foreign address throws
`MisaddressedEventError` (new code `MISADDRESSED_EVENT`, a wiring
error: a bug in today's code) before anything is recorded. On replay, a
history row naming a different aggregate throws `ForeignEventError`
(new code `FOREIGN_EVENT`, an `InfrastructureError`: corrupted or
miswired persistence, so it never rides a `Result` channel or a 4xx
mapping), with the usual all-or-nothing rollback; history events
without the optional stamps pass, since legacy streams predate them.
Snapshots keep a STRUCTURAL gate separate from the rules: override the
new `validateRestoredState(state)` to reject blobs no version of the
model could have produced, throwing the new `SnapshotCorruptedError`
(code `SNAPSHOT_CORRUPTED`, an `InfrastructureError`: corrupted
persistence is a storage problem, not a business rejection). It comes
back as `Err` alongside the `DomainError` decode failures, feeding the
discard-and-refold recipe;
`restoreFromSnapshotWithEvents` is now typed
`Result<void, DomainError | SnapshotCorruptedError>`.

#### 12. Events are `readonly` and must be minted (runtime component)

Every field on `DomainEvent` is `readonly` now, and the recording paths
(`apply`, `commit`, `addDomainEvent`) accept only events minted by the
kit's constructors, checked against an internal, unforgeable mint
marker; anything else throws the new wiring error `UnmintedEventError`
(code `UNMINTED_EVENT`) before any state moves. Events minted via
`createDomainEvent(...)` or `this.recordEvent(...)` are deeply frozen
with defensively copied payload and metadata and pass unchanged; only
hand-rolled objects are affected, and those are the point: a mutable
event recorded next to a state change can silently diverge from it
afterwards, and no frozen-ness probe can rule that out (a
shallow-frozen literal with mutable nested data would pass one). To
keep that guarantee true, `createDomainEvent` now rejects binary
buffers anywhere in payload or metadata (TypedArray, DataView,
ArrayBuffer, SharedArrayBuffer): they stay mutable under freezing and
do not survive JSON; encode binary as a string or store it outside the
event. Duplicate kit copies (a second npm instance, a plugin bundle)
interoperate through a cooperative global-registry brand every constructor
and kit-derived address-stamped copy carries, so their legitimately minted
events are not rejected; within one copy the check stays unforgeable.

```ts
// before (2.x): a literal was accepted and stayed mutable
this.apply({ eventId, type: "OrderConfirmed", payload, occurredAt, version: 1 });

// after: mint it, which also stamps the address
this.apply(this.recordEvent("OrderConfirmed", payload));
```

The rejection is runtime-only for literal-passers (a literal satisfies
the `readonly` interface at compile time), hence the deliberate pass.

#### 13. Live entity state is protected

`Entity.state` is now `protected`, and `IEntity<TId, TState>` becomes
`IEntity<TId>`. The old public getter returned the live `TState` graph:
its top level was frozen, but a consumer could mutate nested state and
bypass aggregate behavior, invariant validation, versioning, and dirty
tracking. A generic defensive clone is not a sound replacement because
class-based child entities would lose their prototypes.

```ts
// before: public live state
order.state.status;
await rows.update({ state: order.state, version: order.version });

// after: a domain query for application reads
order.status;

// and a detached memento for persistence
const memento = order.createSnapshot();
await rows.update({ state: memento.state, version: memento.version });
```

Concrete entities expose fachliche scalar queries or explicitly detached,
immutable read DTOs. Aggregate repositories use `createSnapshot()` (and
the existing `toSnapshotState` mapper for class-based children) instead of
reaching into the live graph. This is compile-checked unless a consumer
deliberately widens the protected accessor in its own subclass; do not do
that.

#### 14. Projection cursors prove gaps (runtime change)

The old `(aggregateVersion, commitSequence)` watermark could order events but
could not prove continuity. A previously unseen late event at or behind the
watermark was silently counted as a duplicate. Projection cursors now also
carry `commitSize` and `previousEventfulAggregateVersion`:

```ts
type ProjectionPosition = {
  aggregateVersion: number;
  commitSequence: number;
  commitSize: number;
  previousEventfulAggregateVersion: number | null;
};

type ProjectionCheckpoint = {
  position: ProjectionPosition;
  lastAppliedEventId: string;
};
```

`withCommit` leaves the domain event untouched and supplies an
`EventCommitCandidate` containing the source and current commit facts. The
outbox/event source atomically reads its last eventful aggregate version,
finalizes `previousEventfulAggregateVersion`, persists the
`CommittedDomainEvent`, and advances the source head. The projector rejects
missing sequences, incomplete commits, missing aggregate commits, malformed
cursors, and a non-genesis first event. Positions behind a fully verified chain
are skipped as already traversed under the source's one-event-per-position
contract. At the exact watermark, the checkpoint's `lastAppliedEventId`
distinguishes a true redelivery from a different event mapped to the same
position; the latter throws
`ProjectionIdentityViolationError`. If the ID matches but `commitSize` or
`previousEventfulAggregateVersion` changes, the new
`ProjectionReceiptViolationError` rejects the contradictory receipt. Both
checks run within each batch. An exact receipt repeated after a later position
in the same batch remains a legal redelivery instead of being misclassified as
an order inversion. A dead-lettered event therefore stalls its aggregate's
chain until repaired/replayed or until the projection is rebuilt; later events
cannot silently advance past it.
Malformed or absent cursor data throws `UnprojectableEventError` (wiring);
a well-formed discontinuity throws `ProjectionGapError` (infrastructure), so
delivery retries and reconciliation can classify the failure honestly.

Custom sources compose their bare event with `source` plus all four `position`
fields from a source-owned, gap-proof chain. Existing checkpoint tables add the
two cursor columns plus `lastAppliedEventId` and should be reset/rebuilt because
old rows cannot prove their predecessor or watermark identity. State-only saves
do not advance this chain: `previousEventfulAggregateVersion` names the
preceding EVENTFUL commit, not the aggregate's OCC baseline.

Genesis uses an explicit JSON-safe `null`, not `undefined`, so serializing a
committed envelope cannot silently remove the predecessor field. Durable
adapters must normalize a nullable database column to JavaScript `null`.

`InMemoryOutbox` no longer lets a stale post-dispatch retry rewind its
per-source predecessor head. It keeps a configurable bounded cache of recently
dispatched receipts (event ID, qualified source, and candidate position;
default 10,000) for exact idempotent no-ops; after eviction, a candidate behind
the source head throws `EventHarvestError` while leaving the head untouched.
Durable adapters still provide unbounded idempotency with a transactional
`eventId` unique key.

An `eventId` retry is now idempotent only for the same qualified aggregate
source and candidate commit position. `InMemoryOutbox` rejects a different
source, sequence, size, or post-finalization aggregate version with
`EventHarvestError` before changing pending, dead-letter, receipt, or
source-cursor state. It also rejects a different ID assigned to an occupied
qualified source position. Its bounded dispatched receipts retain the original
source and candidate position so the same checks remain available after
acknowledgement until receipt eviction.

`DomainEvent` and `CreateDomainEventOptions` no longer expose commit cursor
fields. `OutboxWriter.add` accepts `EventCommitCandidate` values and finalizes
the predecessor in durable source state; `OutboxRecord` exposes the committed
envelope with dispatch state; the in-process `EventBus` still receives the bare
event. An already-persisted aggregate with pending events must also advance its
version; replace event-only `addDomainEvent(event)` calls (notably hard-delete
events) with `commit({ ...this.state }, event)` so the envelope has a unique
cursor.

`OutboxContractEnvironment.addCommitted` and `addRolledBack` now receive the
same `EventCommitCandidate[]` values as `OutboxWriter.add`; adapter harnesses
must stop inventing cursor data and pass those candidates through their real
transaction. The portable suite proves commit sequence/size, eventful
predecessor linkage, qualified source-head isolation, immutable source-position
identity, and (when enabled) that rollback advances neither rows nor the source
head.

#### 15. Map domain events to JSON integration messages (runtime change)

Do not publish a `DomainEvent` or `CommittedDomainEvent` with raw
`JSON.stringify`. Domain payloads and metadata may contain valid immutable
`Date`, `Map`, and `Set` values that JSON changes or drops. Map at the outbox
boundary instead:

```ts
const message = createIntegrationMessage(record, (event) => ({
  type: "sales.order-placed.v1",
  version: 1,
  payload: {
    placedAt: event.payload.placedAt.toISOString(),
    amounts: [...event.payload.amounts],
    tags: [...event.payload.tags],
  },
}));

await broker.publish(encodeIntegrationMessage(message));
```

Receivers call `decodeIntegrationMessage` before dispatch. A receiving
`Projector` can use `integrationMessageToCommittedEvent` to compose the
validated public message into its local event input. The conversion retains
the qualified source and complete commit cursor, but deliberately does not
reconstruct the producer's private domain payload types. Invalid wire shapes
and values JSON cannot preserve throw `InvalidIntegrationMessageError`.

#### 16. EventStore streams use a qualified key

`EventStore.append` and `readStream` no longer accept the raw aggregate id.
Pass the stable aggregate type and id together:

```ts
// before
await eventStore.append(order.id, order.pendingEvents, options);
const history = await eventStore.readStream(order.id);
const snapshot = await snapshots.load("Order", order.id);

// after
const address = { aggregateType: "Order", aggregateId: order.id };
await eventStore.append(address, order.pendingEvents, options);
const stream = await eventStore.readStream(address);
if (!stream.exists) return null;
const history = stream.events;
const snapshot = await snapshots.load(address);
```

Production schemas must include both `aggregate_type` and `aggregate_id` in
their stream key, OCC predicates, and `(aggregate_type, aggregate_id,
position)` uniqueness constraint. Backfill the stable type before switching
reads; renaming an aggregate type afterwards is a stream-key migration.

Event-sourced repository contract harnesses add `streamKeyFor(id)`, and their
`committedStreamEvents` callback now receives the qualified `AggregateAddress`.
`SnapshotStore.load`, `save`, and `delete` now take that same value object
instead of separate type/id parameters. Run the new
`createEventStoreContractTests` suite against the low-level adapter to
prove OCC, atomic rejection, ordering, read ownership, `fromVersion`, and that
equal raw ids under different aggregate types remain isolated.

#### 17. EventStore reads report stream state and the actual head

`readStream` no longer returns a bare event array. Branch on `exists`, and pass
the nested `events` array to replay:

```ts
// before
const tail = await eventStore.readStream(address, {
  fromVersion: snapshot.version,
});
if (tail.length === 0) {
  // Ambiguous: missing stream, or an existing stream already at the snapshot?
}

// after
const tail = await eventStore.readStream(address, {
  fromVersion: snapshot.version,
});
if (!tail.exists || tail.lastVersion < snapshot.version) {
  return discardSnapshotAndRefold();
}
order.restoreFromSnapshotWithEvents(snapshot, tail.events);
```

The result is the new type-only `StreamReadResult<Evt>`:

- a missing stream is `{ exists: false, lastVersion: 0, events: [] }`
- an existing stream always has `exists: true`
- `lastVersion` is the actual stream head even when the requested window is
  empty or `fromVersion` lies beyond it
- `events` contains only the requested window

Event-sourced repository contract harnesses keep `committedStreamEvents`, but
that callback now returns `StreamReadResult<Evt>` instead of an array.

#### 18. Generic filtered repositories move to consumer-owned ports

`IQueryableRepository` is removed. It exposed adapter-native filters and left
selection, bounds, ordering, and continuation semantics undefined.

```ts
// before
interface PrismaInvoices
  extends IQueryableRepository<Invoice, InvoiceId, Prisma.InvoiceWhereInput> {}

// after: the use case owns this port; Prisma stays inside the adapter
interface InvoiceRepository extends IRepository<Invoice, InvoiceId> {
  findByNumber(number: InvoiceNumber): Promise<Invoice | null>;
  findDunningCandidates(
    criteria: DunningCriteria,
    page: { after?: DunningCursor; limit: DunningPageSize },
  ): Promise<DunningCandidatePage>;
}
```

Give a single-result method a domain-backed uniqueness guarantee. Give every
multi-result aggregate method a validated mandatory limit, one stable total
order, and a cursor bound to that order. UI, search, reporting, and other
read-heavy access belongs on projection/query ports. `Specification<T>` stays
available as executable domain criteria, but it is accepted through a
consumer-owned method with explicit result semantics rather than a kit-wide
generic repository.

#### 19. `withCommit` requires invocation-scoped commit tokens

`withCommit` no longer accepts naked aggregate arrays. A touched aggregate is
not proof that a repository write participated in the transaction; the old
shape could harvest a fresh, unsaved aggregate into the outbox and mark it
persisted after the transaction committed.

```ts
// before
await withCommit({ scope, outbox, bus }, async (tx) => {
  const orders = makeOrderRepository(tx);
  const order = await orders.getById(orderId);
  order.confirm();
  await orders.save(order);
  return { result: order.id, aggregates: [order] };
});

// after
await withCommit({ scope, outbox, bus }, async (tx, enrollment) => {
  const orders = makeOrderRepository(tx);
  const order = await orders.getById(orderId);
  order.confirm();
  await orders.save(order);
  const commit = enrollment.enrollSaved(order);
  return { result: order.id, commits: [commit] };
});
```

For hard deletion, return `enrollment.enrollDeleted(aggregate)` instead. The
token keeps deletion-event harvest while suppressing the post-save
`markPersisted` hook. `withIdempotentCommit` receives the same second callback
argument and uses the same work-result shape.

Tokens are opaque and bound to one transactional callback attempt. Forged
tokens and tokens retained from an earlier invocation throw
`EventHarvestError` before the outbox write. Repeated enrollment of the same
aggregate instance returns one token, and repeated tokens are harvested once.
Every token issued during the callback must be returned in `commits`; omitting
an enrolled write throws inside the transaction instead of committing state
without its event harvest and post-commit acknowledgement. To abandon an
enrolled write, throw so the transaction rolls back.
The callback capability is sealed as soon as the callback settles so delayed,
unawaited enrollment fails loudly.

This is provenance for explicit enrollment, not database attestation: the kit
cannot introspect an arbitrary adapter. Repository code remains responsible
for enrolling only a write that participates in the transaction. The scoped
capability removes accidental naked-aggregate smuggling; it is not a security
boundary against application code that deliberately lies to its own adapter.

`UnitOfWork.run` use cases keep returning their result directly. Repository
implementations continue calling `session.enrollSaved` or
`session.enrollDeleted`; the session now retains the underlying scoped tokens
and passes them to `withCommit` automatically.

#### 20. Bus error mapping is selective (runtime change)

`CommandBus.execute` and `QueryBus.execute` no longer convert every handler
throw into `Err`. The removed `errorMapper` option and the default stringifier
made programmer errors, cancellation, and unknown infrastructure failures look
like expected application outcomes. Without a policy, thrown values now
propagate unchanged.

Command handlers should return `err(E)` for expected failures they already
own. For a known exception-first dependency, replace the total mapper with a
selective `mapExpectedError` decision:

```ts
// before: every thrown value was flattened into the channel
const bus = new CommandBus<Commands, AppError>({
  errorMapper: toAppError,
});

// after: only the named expected failure becomes Err<AppError>
const bus = new CommandBus<Commands, AppError>({
  mapExpectedError: (thrown) =>
    thrown instanceof OrderAlreadyConfirmedError
      ? { error: toAppError(thrown) }
      : undefined,
});
```

Returning `undefined` means "not mine" and rethrows the exact original value;
the positive `{ error }` wrapper keeps `undefined` available as an intentional
`E`. No mapper is required for a widened error channel. Audit existing mappers
instead of mechanically renaming them: a total conversion recreates the old
catch-all behavior explicitly. `ErrorMapperFailedError` remains the crash-loud
wiring error when the configured decision itself throws and preserves both the
handler failure and mapper failure.

#### 21. Idempotency mutations use claim receipts; non-transactional stores use leases

`IdempotencyStore.claim()` now returns a store-minted claim receipt. Pass that
receipt to every lifecycle operation instead of addressing a mutable claim by
key alone:

```ts
// before
const claim = await store.claim(tx, key, fingerprint);
if (claim.status === "claimed") {
  await store.complete(tx, key, outcome);
  await store.confirm(key);
}

// after
const claim = await store.claim(tx, key, fingerprint);
if (claim.status === "claimed") {
  await store.complete(tx, claim.claim, outcome);
  await store.confirm(claim.claim);
}
```

Adapter implementations add `renew(claim)` and
`reconcile(receipt, decision)`. Transactional adapters return a claim without
`lease`; their commit remains the finalize boundary, and `renew`, `confirm`,
`abandon`, and `reconcile` are no-ops. They remain the recommended production
family.

Non-transactional adapters return a unique token plus `expiresAt` and
`renewAfterMs`. `withIdempotentCommit` renews the lease while the source
transaction runs. `complete` and `renew` compare key + token and throw
`IdempotencyClaimLostError` for a stale owner; `confirm`, `abandon`, and
`reconcile` must never mutate a successor claim.

An expired pending claim may be taken over. An expired staged outcome now
returns `reconciliation-required` instead of remaining permanently in-flight.
Wire `reconcileIdempotency` to consult the authoritative write model and return
`committed`, `not-committed`, or `unknown`. `unknown` preserves the record and
throws `IdempotencyReconciliationRequiredError`. The callback's new third
`execution` argument exposes `claimToken` for a source-side marker:

```ts
await withIdempotentCommit(
  { scope, outbox, idempotency, reconcileIdempotency },
  request,
  async (tx, enrollment, execution) => {
    await saveCommandMarker(tx, {
      key: execution.key,
      claimToken: execution.claimToken,
    });
    return { result, commits };
  },
);
```

Leases do not create an exactly-once transaction across two stores. Return
`not-committed` only when durable evidence proves the old attempt cannot still
commit; otherwise return `unknown`. See the Command Idempotency guide. The
non-transactional contract harness now requires deterministic `expireLease`
and `advanceTimeTo` controls and proves renewal, takeover, stale-owner fencing,
and staged reconciliation.

### Changed (breaking): leased idempotency claims and reconciliation

- `IdempotencyClaim` adds the `reconciliation-required` state and returns an
  `IdempotencyClaimHandle` for fresh ownership.
- `IdempotencyStore.complete`, `confirm`, and `abandon` take that handle;
  adapters add token-bound `renew` and `reconcile` operations.
- `withIdempotentCommit` heartbeats leased claims, exposes
  `IdempotentExecution` to work, accepts a three-way source-of-truth resolver,
  and reports best-effort lifecycle failures through `onIdempotencyError`.
- `InMemoryIdempotencyStore` has injectable per-instance clock, token factory,
  lease duration, and renewal interval options. It remains non-durable.
- New structured errors: `IdempotencyClaimLostError` and
  `IdempotencyReconciliationRequiredError`.

### Changed (breaking): commit enrollment is provenance-bound

- `WithCommitWorkResult` now carries `commits` with opaque
  `AggregateCommitToken` values instead of `aggregates` and `deleted`.
- `withCommit` and `withIdempotentCommit` pass a scoped `CommitEnrollment` as
  the callback's second argument. Only tokens minted by that exact callback
  attempt are accepted. The idempotent wrapper seals the user capability and
  snapshots its token array before `IdempotencyStore.complete` can yield.
- `UnitOfWorkSession` extends the same enrollment contract. Repositories remain
  responsible for enrollment, while `UnitOfWork` retains and forwards tokens
  without exposing a second use-case return protocol.
- Legacy naked aggregate results, forged tokens, stale tokens, omitted enrolled
  tokens, and enrollment after callback settlement fail inside the transaction
  before event harvest.

### Fixed: projection receipt integrity and executable source-position laws

- A watermark or in-batch position is now an exact receipt, not merely an
  `eventId` lookup. Reusing the ID while changing `commitSize` or
  `previousEventfulAggregateVersion` throws the new structured
  `ProjectionReceiptViolationError`; a different ID at the position continues
  to throw `ProjectionIdentityViolationError`. Both fail before `apply`.
- Exact in-batch redelivery remains legal even after a later position. The
  inversion tripwire ignores only a position whose event ID and complete cursor
  already matched earlier in the batch; a distinct descending position still
  throws `ProjectionOrderViolationError`.
- `InMemoryOutbox` enforces immutable qualified source positions and commit
  sizes, including pending, dead-lettered, and bounded post-ack retries. A
  conflicting add (including one `eventId` assigned two receipts within the
  same input batch) rejects during preflight without replacing the stored
  event or advancing the source head. Exact batch-local repetition remains
  idempotent.
- `createOutboxContractTests` now composes explicit `EventCommitCandidate`
  values and proves commit completeness, eventful-predecessor linkage,
  source-head isolation by aggregate type and id, position identity, and
  rollback head purity. This changes the harness callbacks `addCommitted` and
  `addRolledBack` from bare events to candidates.

### Changed (breaking): EventStore streams are qualified and report state

- `EventStore.append`, `readStream`, and `SnapshotStore` now use the existing
  `AggregateAddress` value type instead of separate stream/source/address
  shapes or positional type/id arguments.
- `readStream` returns `StreamReadResult<Evt>` so missing streams cannot alias
  existing empty windows. `lastVersion` always reports the real head, allowing
  snapshot repositories to reject a vanished or truncated authoritative
  stream instead of resurrecting stale derived state.
- All in-memory adapters share one collision-safe JSON-tuple encoder;
  `InMemoryEventStore` reports OCC conflicts with the requested qualified
  address.
- Added `createEventStoreContractTests` to `@shirudo/ddd-kit/testing`; the
  contract proves the complete observable port semantics, including equivalent
  fresh address objects, colliding raw ids, qualified `fromVersion` reads,
  append order, actual-head reporting for empty/beyond-head windows, atomic OCC
  rejection, and detached read arrays. The event-sourced repository suite now
  makes its qualified stream address explicit through `streamKeyFor` and proves
  the same missing-vs-empty distinction through `committedStreamEvents`.
- Replay remains independently defensive: `loadFromHistory` rejects a
  persisted event whose present aggregate type or id contradicts the target,
  while storage adapters remain responsible for ordered, contiguous persisted
  stream positions.

### Added: point-in-time EventStore reads

- `ReadStreamOptions.toVersion` adds an inclusive upper stream-position bound;
  with the existing exclusive `fromVersion`, reads select
  `(fromVersion, toVersion]` while `lastVersion` continues to report the actual
  stream head.
- The edge semantics are explicit: `toVersion: 0` is empty, values beyond the
  head clamp to it, and `fromVersion >= toVersion` returns an empty existing
  window instead of throwing.
- Both EventStore contract suites prove bounded reads. The event-sourced
  repository harness callback `committedStreamEvents` now accepts the same
  `ReadStreamOptions` object as `EventStore.readStream` instead of a positional
  `fromVersion` number.
- The event-sourcing guide includes a strict point-in-time reconstruction
  recipe that checks the requested version against the separately reported
  stream head before folding history.

### Changed (breaking): live entity state is protected

- `Entity.state` is protected so external code cannot obtain the live
  state graph. Concrete models expose domain queries or detached read
  DTOs; aggregate persistence uses `createSnapshot()` as its memento.
- `IEntity` now models the public entity capability only and therefore
  takes one generic (`IEntity<TId>`); state is an implementation detail.
- Repository contract examples and all guides no longer serialize or
  inspect aggregates through `aggregate.state`.

### Changed (breaking): events are readonly and minted

- Every `DomainEvent` field is `readonly` at the type level, matching
  the runtime deep-freeze the constructors have always applied. The
  recording paths (`apply`, `commit`, `addDomainEvent`) now enforce
  the mint through an internal, unforgeable marker (`WeakSet`, written
  only by `createDomainEvent`): an event the constructors did not
  produce throws the new wiring error `UnmintedEventError` (code
  `UNMINTED_EVENT`, exported from the main entry) BEFORE any state
  moves, so a rejected event can never leave a mutated aggregate
  without its recorded fact. Provenance instead of frozen-ness probes,
  because probes cannot establish deep immutability (a shallow-frozen
  literal with mutable nested payload or metadata would pass). O(1),
  one `WeakSet` lookup; replay input from storage adapters is
  deliberately exempt, since it never enters `pendingEvents`. Two
  supporting decisions keep the guarantee honest: `createDomainEvent`
  rejects binary buffers anywhere in payload or metadata (freezing
  cannot cover them, and they do not survive JSON), and events minted
  by a DIFFERENT loaded copy of the kit (duplicate dependency, plugin
  bundle) are recognized through a cooperative, non-enumerable
  global-registry brand. Constructors and kit-derived address-stamped
  copies both carry it, so multi-instance setups keep working while the
  same-instance check stays unforgeable.

### Changed (breaking): replay trusts history

- `EventSourcedAggregate`: replay (`loadFromHistory`,
  `restoreFromSnapshotWithEvents`) no longer runs `validateEvent`, and
  the snapshot path no longer runs `validateState` on the restored
  state; both guard new facts on the `apply()` path only. Re-checking
  history against current rules meant a rule change could make
  legitimately persisted streams unloadable, and the snapshot path
  disagreeing with full replay broke "a snapshot is only an
  optimization": the same stream now loads identically on both paths,
  pinned by an equivalence test. Old storage shapes are decoded and
  upcast at the read boundary (event-upcasting guide), never validated
  in handlers.
- Snapshots keep their own STRUCTURAL gate, separated from the rules:
  the new overridable `validateRestoredState(state)` rejects restored
  blobs no version of the model could have produced (missing fields,
  impossible types); its `DomainError` returns as `Err` and feeds the
  documented discard-and-refold recipe. Unlike replay, whose states
  are built by the handlers from accepted facts, a snapshot is derived
  data read back from storage and deserves an integrity check that is
  not entangled with today's decision rules.
- Address discipline on both paths, with distinct error families.
  `apply()` STAMPS missing `aggregateId`/`aggregateType` from the
  aggregate (the `recordEvent` guarantee by construction; an applied
  event can no longer fail later at harvest) and throws
  `MisaddressedEventError` (code `MISADDRESSED_EVENT`, a wiring error,
  exported from the main entry) for a present-but-foreign address,
  before anything is recorded. Replay throws `ForeignEventError` (code
  `FOREIGN_EVENT`, an `InfrastructureError`, exported from the main
  entry) for a history row naming a different aggregate, with the
  all-or-nothing rollback; rows without the optional stamps pass,
  since legacy streams predate them. Neither is a `DomainError`: a
  wrong address is a code bug or corrupted persistence, never an
  expected business rejection, so both propagate as throws instead of
  riding the replay `Result` channel. The result-vs-throw guide and
  the design-decisions page document the split channel.

### Added: ports speak the domain's language

- The design-decisions guide states the driven-port return rule in one
  place: port signatures are written in the core's types, translation
  lives in the adapter. Four cases spelled out (repositories return
  aggregates, gateways return core-owned value objects behind an
  Anti-Corruption Layer, query ports may return read models, technical
  ports return records of their own mechanic), with the repository
  guide linking to it and the domain-driven-design skill gaining a
  gateway route and a boundary-review check.

### Added: Result-returning money parsers

- `tryParseMoneyInput`, `tryMoneyFromDto`, and `tryMoneyFromSnapshot`
  in `@shirudo/ddd-kit/money`: `Result` twins of the three boundary
  parsers for batch call sites (imports, migrations, replays), with
  the `voValidated` contract: only the documented domain rejections
  become `Err` (`InvalidMoneyError`, plus `MoneyPrecisionLossError`
  for decimal-string parsing), while anything else keeps throwing, so
  a bug can never be silently counted as a bad input row. The money
  guide gains a throw-or-Result section mirroring the result-vs-throw
  guide.

### Added: property-based and mutation testing for the money module

- `src/money/money.properties.test.ts` (fast-check): the exact-money
  laws as properties instead of examples: parse/render inversion with
  the zero-excess acceptance and the non-zero-excess rejection,
  add/subtract inverse plus commutativity and associativity, negate as
  involution and additive inverse, lossless rescale up-and-back
  identity with rendered-value preservation and the lossy-downscale
  rejection, DTO and snapshot round-trips through JSON, and the
  snapshot bridge's safe-integer domain pinned from both sides (exact
  inside, loud refusal outside). `pnpm mutate:money` runs a
  Stryker mutation pass scoped to the module (dev-dependency only, not
  part of the default test run; break threshold 85, current score
  89.8 after the guard-edge tests the first pass motivated, with the
  remaining survivors dominated by behaviorally equivalent mutants:
  cache internals, fallback-masked branches, an unreachable
  comparison).

### Added: Sagas guide page

- New guide page composing the existing pieces into a saga / process
  manager, with no new machinery: the saga as a regular aggregate with
  a `DomainStateMachine` core, event intake through the dispatcher-fed
  bus, the idempotency store as the inbox, decisions leaving through
  the outbox (including why dispatching commands straight from a
  subscriber has a crash window), timeouts as inputs via the
  `DeadlineStore`, and compensation as plain business logic. Documents
  what deliberately does not ship (no `SagaStore`, no correlation
  machinery, no workflow DSL) and points to `examples/saga` as the
  runnable reference.

### Added: DeadlineStore port (durable timeout-as-input)

- `DeadlineStore` port, `InMemoryDeadlineStore` reference, and
  `createDeadlineStoreContractTests` in `@shirudo/ddd-kit/testing`:
  durable deadlines for processes that wait (saga timeouts, reservation
  holds, offer expiry). `schedule` and `cancel` join the write
  transaction (a committed wait without its deadline never wakes up; a
  rolled-back one must not leave a ghost input, both proven by the
  suite's rollback capability); `due`/`markDelivered`/`markFailed`/
  `deadLetters` form the poll surface, at-least-once, with the clock
  passed in by the poll loop. Addresses are `(scope, key)` pairs with
  at most one pending deadline each; scheduling an occupied address IS
  the reschedule and mints a fresh incarnation, so stale
  acknowledgements cannot consume a successor. Failure tracking is part
  of the port (attempts, ceiling, dead letters); deadlines carry no
  cross-address ordering, so a poison deadline blocks only itself.
  Deliberately not a scheduler: no recurrence, no cron abstraction, no
  execution engine; firing a deadline means delivering a record.
  `DeadlineProcessor` ships the hardened delivery loop (never rejects,
  jittered streak backoff, reentrancy-safe `drainOnce` for cron ticks,
  graceful stop, neutralized callbacks, injectable clock guarded even
  against Invalid Dates) while the handler and the poll cadence stay
  yours. A handler failure never stops the batch (deadlines carry no
  cross-address ordering); deliveries are acknowledged in one batch
  call per cycle, and an ack failure ends the cycle since it signals
  the store's write path, not a poison record. The loop shell itself
  (run/drainOnce, join semantics, backoff, option validation) is now
  shared between `OutboxDispatcher` and `DeadlineProcessor` as one
  internal base, so the hardening cannot drift. New guide page:
  Deadlines.

### Removed (breaking): generic filtered repository

- `IQueryableRepository<TAgg, TId, TFilter>` is no longer exported. Its native
  filter parameter reversed dependency ownership, `find` could hydrate an
  unbounded aggregate set, and `findOne` promised neither uniqueness nor a
  stable selection order.
- Consumer applications declare domain/application repository ports with
  intent-revealing methods. Single-result methods state a uniqueness law;
  multi-result methods require a validated hard limit, stable total order, and
  continuation semantics. Adapter-native filters stay private to adapters.
- Infrastructure-only bulk cleanup belongs in an adapter maintenance
  component. An application-triggered cleanup uses a separate consumer-owned
  driven port, not a method discovered on a concrete repository class.

### Added: Specification primitive

- `Specification<T>` (abstract class) and the `specification(name,
  predicate)` factory: named, executable domain criteria with
  `isSatisfiedBy` and short-circuiting `and`/`or`/`not` combinators,
  whose derived names (`"(overdue and (not high value))"`) show up in
  diagnostics. The name comes from the ubiquitous language and is what
  a storage adapter translates. Combinator nodes expose their boolean
  structure via `composite` so an adapter can walk down to the named
  leaves and translate each one explicitly; the kit deliberately ships
  no expression trees and no translation machinery. In-memory
  repositories and test fakes implement consumer-owned
  `findSatisfying`-style lookups as a filter followed by the port's declared
  stable ordering and bound. The class is
  deliberately left open, so a consumer can layer a classic
  double-dispatch translation on top; the repository guide's new
  Specifications section covers that construction, the drift risk of
  rules living as both predicate and query, and the shared-fixture
  test that contains it.

### Added: SnapshotStore port for event-sourced aggregates

- `SnapshotStore` port, `InMemorySnapshotStore` reference, and
  `createSnapshotStoreContractTests` in `@shirudo/ddd-kit/testing`:
  the persistence half of the snapshot-plus-recent-events load path
  whose aggregate half (`createSnapshot`,
  `restoreFromSnapshotWithEvents`, `snapshotSchemaVersion`) already
  shipped. Latest-only per `(aggregateType, aggregateId)`, verbatim
  round-trip of state, version, `snapshotAt` (millisecond fidelity),
  and `schemaVersion` including its absence; loads are detached
  copies and saves capture by value. Deliberately transaction-free:
  a snapshot is derived data written after the commit, so the port
  (unlike outbox and idempotency store) takes no transaction context,
  and WHEN to snapshot stays consumer policy. `delete` serves the
  schema-migration fallback (mismatch or corrupt snapshot: discard,
  refold from the stream) and erasure. The event-sourcing guide's
  snapshot section now shows the full load path with both fallback
  branches and the out-of-band save policy.

### Added: projection support (checkpoint port, projector runner, position query)

- Added the opt-in `projectionFromHandlers` helper for correctness-critical
  read models. Its mapped handler type requires one discriminator-narrowed
  handler or the explicit `ignoreProjectionEvent` token for every member of the
  declared event union, so adding an event forces a per-projection compile-time
  decision. Runtime types outside that map throw `MissingHandlerError` through
  an own-key lookup (including `constructor` / `__proto__`), rejecting the
  batch without advancing its checkpoint. Direct `Projection.apply` remains
  the intentionally partial escape hatch; the guide explains when each policy
  fits and warns that exhaustiveness is only as complete as the supplied union.
- Checkpoints are keyed by `(projection, aggregateType, aggregateId)`,
  passed to the `ProjectionCheckpointStore` port as an
  `AggregateAddress` object, and `Projector.hasProcessed` takes the
  address too: identities are type-scoped (the kit's own `Id` brands
  say so), so `Order 1` and `Payment 1` keep separate watermarks even
  when the raw id strings collide. The projector requires the
  `aggregateType` stamp on projectable events, rejecting loudly like a
  missing cursor (`withCommit` stamps both), and encodes its
  batch-local keys as JSON tuples so a separator-like character inside
  either half cannot collide two addresses. The contract suite proves
  cross-type isolation and separator hostility; the `aggregateType`
  string is thereby part of the checkpoint contract (renaming an
  aggregate type means migrating its checkpoint rows), and it is a
  TECHNICAL stream category: unique across everything feeding one
  checkpoint store, qualified at the source ("sales.order") when
  bounded contexts sharing infrastructure reuse a name.
- Projection positions include `commitSize` and
  `previousEventfulAggregateVersion`, so the projector proves continuity within
  and across aggregate commits. Missing sequences/commits and malformed
  cursors reject; a late unseen event is never silently counted as a
  duplicate. Custom sources must compose an equivalent source-owned
  predecessor chain around the bare event.
- Projector feeds are now explicitly complete per aggregate address. Broker
  subscriptions must not drop cursor positions by filtering on event type;
  projection-irrelevant facts run through `apply` as explicit no-ops and are
  checkpointed. Broker examples route projector feeds by context / aggregate
  type rather than event type.
- `CommittedDomainEvent.source` is the authoritative persistence address.
  `Projector` now rejects a bare event whose present optional `aggregateId` or
  `aggregateType` contradicts that source, using `ForeignEventError` before any
  read-model write or checkpoint mutation. Absent optional event stamps remain
  valid.
- `ProjectionCheckpointStore` port, `Projector` runner, and
  `InMemoryProjectionCheckpointStore` reference: the projection
  mechanics `read-model-design.md` demands, so a consumer's
  `Projection.apply` is a plain event-to-row mapping. One
  `project(batch)` call is one `TransactionScope` transaction, the
  read-model update and checkpoint commit atomically and roll back
  together; already-traversed positions are skipped via the four-field cursor
  the event source finalizes on `CommittedDomainEvent`, while the checkpoint
  retains the `eventId` and complete cursor at its exact watermark. It rejects
  an identity collision with `ProjectionIdentityViolationError` and changed
  receipt metadata with `ProjectionReceiptViolationError`; event-store replays
  compose their own envelope from the store cursor; missing or
  malformed cursors reject loudly with the structured
  `UnprojectableEventError`, while a well-formed discontinuity throws the
  structured infrastructure `ProjectionGapError`, before anything applies.
  `hasProcessed(aggregateId, position)` is the wait-for-version
  building block (full-cursor comparison: version-only would report
  "reached" mid-commit); `reset()` truncates the read model (via the
  projection's optional `truncate`) and clears checkpoints in one
  transaction as the rebuild entry point; `toOutboxSink()` plugs the
  projector straight into `OutboxDispatcher`. New contract suite
  `createProjectionCheckpointStoreContractTests` in
  `@shirudo/ddd-kit/testing` (rollback capability-gated, like the
  sibling suites). The projections guide is rewritten around the
  shipped runner.
- `ProjectionCheckpointStore.withCheckpointLocks` is a required critical-section
  boundary around checkpoint load, read-model apply, and checkpoint save. It
  serializes competing projectors by the full checkpoint key even at genesis,
  where no checkpoint row exists and ordinary `SELECT ... FOR UPDATE` locks
  nothing. The contract suite now exercises absent and existing keys; the
  in-memory reference provides process-local exclusion, and the guide gives
  transaction-scoped advisory-lock and durable lock-row recipes for distributed
  adapters. Adapters without missing-key exclusion are limited to an enforced
  single-projector topology.

### Added: EventBus.subscribeAll

- `subscribeAll(handler)` on the `EventBus` port and `EventBusImpl`: the
  typed catch-all subscription for cross-cutting consumers (audit log,
  metrics, dev logging, forward-all) that would otherwise have to
  enumerate the event union and silently miss every type added later.
  Catch-all handlers run in the same `Promise.allSettled` batch as the
  event's typed handlers, so the publish contract is unchanged: awaited
  delivery, no handler skipped when a peer fails, errors collected and
  thrown after the batch, events in input order. A catch-all consumer
  also counts as a subscriber under `eventBusSink`'s zero-subscriber
  rule (no event is acked unseen while one is registered). Deliberately
  minimal: no predicate subscriptions (filter in the handler) and no
  glob/topic patterns (topic routing belongs to broker sinks). Breaking
  for hand-rolled `EventBus` implementations: the interface gained a
  required method.

### Added: adapter contract suites for outbox and idempotency store

- `createOutboxContractTests` and `createIdempotencyStoreContractTests`
  in `@shirudo/ddd-kit/testing`, mirroring the repository contract
  suites: framework-agnostic test lists an adapter binds with
  `(test.skipped ? it.skip : it)(test.name, test.run)`. Both suites test
  the PORT, not the in-memory reference: every port-sanctioned adapter
  variation is a declared capability, and each skip stays visible as the
  unproven guarantee it is. The outbox suite proves commit-order reads,
  explicit-limit paging, idempotent acks, the dispatch-tracking
  lifecycle (attempts, dead-lettering, no resurrection, manual
  redelivery ack), commit sequence/size finalization, eventful-predecessor
  linkage, immutable qualified source positions, source-head isolation, and,
  capability-gated, eventId dedupe
  (`dedupesOnEventId`), head stability for non-claiming reads
  (`claimsOnGetPending`), and rollback purity (`providesRolledBackAdds`).
  The idempotency suite follows the adapter's declared `family`:
  shared lifecycle proofs (claim, replay, fingerprint reuse rejection
  on a completed record, the one same-key state both families reach)
  for both; retryable in-flight claims, lease renewal, expired pending
  takeover with stale-owner fencing, staged-never-replays, source-of-truth
  reconciliation, and abandon-releases for the `non-transactional` leased
  family
  (a committed-yet-pending claim is unreachable in the
  single-transaction pattern, so the in-flight proof cannot be forced
  onto it); rollback-releases-the-claim and commit-is-the-finalize for
  the `transactional` single-transaction family. The in-memory references
  pass their suites with exactly the capabilities they lack skipped
  (their documented limitations). The outbox guide gains a production
  checklist.

### Added: outbox seam and minimal dispatcher

- `OutboxWriter` port: the write half of the outbox (`add` only). Implement
  it alone to plug in an external delivery solution (a CDC connector, a
  delivery library, a broker-native outbox) whose own listener owns delivery;
  the kit-side poll surface is then never involved. `Outbox` extends
  `OutboxWriter`, so existing implementations keep working unchanged.
- `outboxWriterAcceptingEventLoss()`: the explicit opt-out for setups
  without delivery reliability (no events, or MVP bus-only where event
  loss on a crash between commit and publish is accepted). The outbox
  stays required while `bus` is optional on purpose: the bus is the
  best-effort fast path, the outbox is the guarantee; running without
  one is a decision the call site now spells out. Also documents the
  footgun it replaces: an undrained `InMemoryOutbox` as dummy grows its
  pending map unbounded.
- `OutboxDispatcher`: a minimal runnable poller over the `Outbox` port for
  tests, moduliths without a broker, and single-process deployments.
  At-least-once with batched prefix acks (one `markDispatched` call per
  delivered batch, only after successful publishes), sequential with
  stop-on-failure to preserve per-aggregate causal order, never rejects
  (poll and ack failures are absorbed into the `onPollError` /
  `onDispatchError` observers, and every failed cycle grows the jittered
  backoff toward `maxDelayMs`, also with plain non-tracking outboxes),
  bounded retries and dead-lettering when given a `DispatchTrackingOutbox`
  (an ack failure never counts toward the poison ceiling and is reported
  per affected record; its duplicates are rate-limited by the backoff),
  an optional `countsTowardCeiling` classifier so a transient transport
  outage does not progressively dead-letter healthy records (by default
  every failure counts; the trade-off is documented on the option and in
  the production checklist), `drainOnce()` for cron and serverless ticks
  (reentrancy-safe: a tick that overlaps an in-flight pass joins it
  instead of double-delivering, while a joining `run(signal)` still
  honors its own abort), graceful stop via `AbortSignal`, a readonly
  `usesDispatchTracking` flag for wiring tests (tracking detection is
  structural; a decorator that drops `markFailed`/`deadLetters` turns
  bounded retries off, and this flag is where that becomes assertable),
  and validated numeric options.
  `OutboxSink.publish(record)` is the transport port; `eventBusSink`
  adapts the in-process `EventBus` for zero-broker setups (never combine
  it with `withCommit`'s `bus` fast path on the same bus, that delivers
  every event twice; and subscribe before starting the dispatcher, an
  event published to zero subscribers counts as delivered and is acked). The outbox guide gains "The kit dispatcher" and
  "External dispatchers" sections, including sink mappings for common
  brokers (Kafka, RabbitMQ, SQS/SNS, Google Pub/Sub, NATS JetStream,
  Redis Streams).

### Added: command idempotency primitive

- `IdempotencyStore` port, `withIdempotentCommit` wrapper, and
  `InMemoryIdempotencyStore` reference implementation. The wrapper claims the
  idempotency key inside the `withCommit` transaction (single-transaction
  pattern: a rollback releases the claim), short-circuits duplicates by
  replaying the stored outcome without re-running the use case or re-emitting
  events, and stores the outcome atomically with the aggregate write and the
  outbox. A failed attempt releases its claim before the error leaves the
  transactional region, so a `RetryingTransactionScope` retry claims fresh
  instead of colliding with the previous attempt; after the commit the wrapper
  confirms the outcome, so a non-transactional store never replays an outcome
  whose transaction did not commit (`confirm` and `abandon` are no-ops for
  transactional adapters). New structured errors: `IdempotencyKeyReuseError`
  (same key, different command fingerprint; not retryable),
  `IdempotencyInFlightError` (first execution still running; retryable), and
  `IdempotencyCompletionWithoutClaimError` (wiring bug guard). The same store
  serves as a message inbox: key = message id. Stored outcomes must be plain,
  serialisable data, the same discipline as snapshots and event payloads.
- `WithCommitDeps` and `WithCommitWorkResult` are now exported types
  (previously inline parameter types of `withCommit`; no behavior change).

### Changed: contract-suite assertion messages generalized

- The repository contract suites' failure messages no longer start with
  "Repository contract violated:" and "Repository contract test
  skipped:"; the shared assertion helpers now serve the outbox and
  idempotency suites too, and the prefixes are "Contract violated:" and
  "Contract test skipped:". Behavior and test names are unchanged, but
  meta-tests, log greps, or snapshots that match the old prefixes must
  update their patterns.

### Changed (breaking): `withCommit` and `UnitOfWork` depend on `OutboxWriter` only

- The `outbox` dependency in `WithCommitDeps` and `UnitOfWorkDeps` is
  narrowed from `Outbox` to `OutboxWriter`: the write side needs `add()`
  and nothing else. Passing a full `Outbox` keeps working (it extends
  `OutboxWriter`), but READING `deps.outbox` back out of the deps object
  and expecting `getPending`/`markDispatched` no longer typechecks: hold
  your own reference to the full `Outbox` for the delivery side.

### Changed (breaking): repository load methods follow the get/find contract

- `IRepository` / `IUnitOfWorkRepository`: `getById` is renamed to
  `findById` (unchanged semantics: returns the aggregate or `null`), and
  `getByIdOrFail` is renamed to `getById` (unchanged semantics: returns the
  aggregate or throws `AggregateNotFoundError`). The names now carry the
  contract: `find*` makes absence explicit in the signature, `get*` never
  returns `null`. Migration warning: the type system does NOT catch a missed
  old `getById` call site. A null check against the new non-nullable `getById`
  compiles cleanly; the null branch is silently dead and a missing aggregate
  now throws `AggregateNotFoundError` instead of returning `null`. Migrate
  mechanically in three steps so no site is missed: rename `getByIdOrFail` to
  a placeholder, rename every `getById` to `findById`, rename the placeholder
  to `getById`. A plain two-step rename leaves old `getById` call sites
  compiling against the new throwing method.

### Changed (breaking): kit errors are StructuredErrors with one identifier

- Every kit error is now a base-error `StructuredError` carrying a
  stable SCREAMING_SNAKE `code`, a `category` derived mechanically from
  the hierarchy (`DOMAIN` / `INFRASTRUCTURE` / `WIRING` for the
  crash-loud family), and a plain `retryable` boolean
  (`ConcurrencyConflictError`'s hand-rolled marker became the
  structured field). By base-error's design `error.name === error.code`,
  so there is exactly ONE identifier and no name/code drift: the old
  PascalCase names ("ConcurrencyConflictError") are gone from
  `error.name`; the contract-test suites and `toPublicErrorView` match
  on the codes now (and ONLY the codes). Troubleshooting note: if a
  contract-suite failure's cause chain shows a PascalCase kit error
  name, the adapter under test resolves a pre-v3 `@shirudo/ddd-kit`
  copy; align the versions in your dependency graph.
- **No base-error adoption required.** Consumers branch with a plain
  `switch (error.code)`, catch via the kit-exported `instanceof
  DomainError` / `instanceof InfrastructureError`, and read
  `retryable` / `cause` as ordinary properties. base-error's toolbox
  (exhaustive `matchError` on the codes, `isStructuredError`, the
  public-error pipeline) works on every kit error as an opt-in benefit
  on top, never as a prerequisite.
- Consumer subclasses of `DomainError` / `InfrastructureError` supply
  their `code` and `message` via an options object; `category` is fixed
  by the base and `retryable` defaults to `false`:
  `class OrderAlreadyShippedError extends DomainError<"ORDER_ALREADY_SHIPPED"> {
  constructor(id: string) { super({ code: "ORDER_ALREADY_SHIPPED",
  message: ... }); } }`.
- Added: the `KitErrorCode` union (every code the kit itself produces)
  and the `KitErrorOptions` type are exported from the main entry.

### Changed (breaking): Node 22+ and `@shirudo/base-error` ^8

- `engines.node` moves to `>=22`: Node 20 reached end-of-life on
  2026-04-30, and a major is the right window to drop it. Cloudflare
  Workers, Vercel Edge, Deno, and Bun remain supported unchanged.
- The `@shirudo/base-error` peer dependency moves from `^7.1.1` to
  `^8.0.0`, and the kit follows 8.x's public-error consolidation: the
  `/presentation` and `/problem-details` subpaths merged into
  `/public-error`, so `toPublicErrorView` now returns base-error's
  `LocalizedPublicError` (structurally the same `code` / `message` /
  `locale` / `details` view the 7.x `PublicErrorView` carried) and
  `toProblemDetails` returns the 8.x `ProblemDetails`, whose contract
  includes the machine-readable public `code` member; the body now
  carries the `ValidationError`'s own code (`"VALIDATION_FAILED"` by
  default). For catalog-driven mapping use 8.x's `toProblem` /
  `definePublicErrors` (the 7.x `defineProblemDetailsAdapter` /
  `PublicErrorPresenter` are gone); consumers that use base-error's
  API directly follow its own migration notes.

### Changed (breaking): one repository delete contract, on the aggregate

- `IRepository.delete` now takes the AGGREGATE instead of the bare id,
  unifying the delete shape with `IUnitOfWorkRepository` (which is now
  simply the minimal subset of `IRepository`): deletion-event harvest,
  the identity-map tombstone, and an OCC predicate on `persistedVersion`
  all need the instance, which an id cannot provide. The contract-test
  suites already used the aggregate-taking shape and are unchanged.
- Id-only BULK cleanup deliberately has no aggregate-repository method. Keep
  infrastructure maintenance in an adapter-side component, or expose an
  application-triggered cleanup through a separate consumer-owned driven port
  instead of loading aggregates one by one.
- Migration: change `delete(id)` implementations and call sites to
  `delete(aggregate)`; where only the id is at hand, load first
  (`getByIdOrFail`), which the richer deletion flows require anyway.

### Removed (breaking): internal exports and generic type names

- `computeBackoffDelay` is no longer exported from the main entry. It has
  been marked `@internal` since 2.x (exported only for its unit tests,
  which already import the source module directly); the retry behavior it
  implements is unchanged.
- The `deepOmit` helper types `Key` and `PathSegment` are renamed to
  `DeepOmitKey` and `DeepOmitPathSegment`: the old names polluted the
  root namespace with generic identifiers. Hard rename, no aliases;
  migration is a find-and-replace on the two type names (the shapes are
  identical).

### Changed (breaking): `AggregateRoot.setState` always bumps; the no-bump path is a named method

- `setState(newState)` now ALWAYS advances the OCC version, and the
  rare non-bumping mutation moved to the deliberately loud
  `setStateWithoutVersionBump(newState)`. The optimistic-concurrency
  decision is a WORD at the call site, not a boolean flag a reader has
  to look up. The previously implicit no-bump default permitted silent
  lost updates (a save whose version did not move writes
  `WHERE version = v SET version = v`, so a concurrent writer that
  loaded the same `v` commits over it without a
  `ConcurrencyConflictError`); deprecated since 2.2.0, removed now.
- The `autoVersionBump` option is removed; `AggregateConfig` is now an
  alias of `EntityConfig` (the named methods replaced the config
  fallback entirely).
- Calls that bypass the compiler (an `Entity`-typed reference, plain
  JavaScript) hit the same safe bumping default: `setState` keeps the
  identical one-argument signature as `Entity.setState`, so the
  bivariant-override footgun and the runtime `TypeError` guard of the
  interim two-argument design are gone.
- Migration from 2.x: audit every `setState` call site. Domain
  mutations keep their one-argument call and gain the version bump;
  only mutations that genuinely tolerate loss under a concurrent write
  (cosmetic caches, denormalized display fields) switch to
  `setStateWithoutVersionBump(next)`. Aggregates configured with
  `autoVersionBump: true` drop the config and change nothing else;
  `commit()` users are unaffected.

### Changed (breaking): `apply()` is only for new facts; the `isNew` flag is gone

- `EventSourcedAggregate.apply(event)` drops its optional `isNew`
  boolean (the same flag-argument cleanup as `setState`): `apply()`
  always records the event and bumps the version. Replaying history is
  a different operation with its own entry points, `loadFromHistory`
  and `restoreFromSnapshotWithEvents`; internally both share the
  record-free `dispatch` transition path. No known consumer passed
  `isNew` explicitly; call sites using `this.apply(event)` are
  unaffected.

### Changed (breaking): buses throw `UnregisteredHandlerError` for unregistered types

- `CommandBus.execute` and `QueryBus.execute` THROW the
  `UnregisteredHandlerError` introduced in 2.2.0 instead of returning it
  through the error channel, completing the crash-loud wiring-bug posture
  (`MissingHandlerError` precedent): a mis-wired bus fails the request
  loudly instead of surfacing as an expected failure a generic err-branch
  can absorb. The selective `mapExpectedError` policy never receives a direct
  unregistered dispatch or the same error propagated by a nested dispatch.
  `executeUnsafe` already threw.
- Migration: remove err-branches that matched the
  "No handler registered" message (default string channel) or the
  `UnregisteredHandlerError` type (typed channels); where the case must
  be handled at a specific seam, catch the named type around `execute`.

### Added: gap-proof committed-event envelopes

- `withCommit` composes every harvested domain event into an immutable
  `EventCommitCandidate` with `source`, `commitSequence`, `commitSize`, and
  `aggregateVersion`. The outbox/event source atomically supplies
  `previousEventfulAggregateVersion` from its last eventful source head and
  persists the resulting `CommittedDomainEvent`.
  The index and size prove completeness inside a commit; the predecessor
  links commits without assuming versions increase by one (several domain
  mutations or state-only saves may occur between eventful commits). Cursor
  fields are absent from `DomainEvent`; `ProjectionPosition` requires all four.
  The outbox and projector consume finalized envelopes, while the domain bus
  receives the original event. `eventId` remains the general dedupe key outside
  verified chains.
- `Projector.project` rejects descending distinct positions that were still
  unseen at batch start with `ProjectionOrderViolationError`, exposing a
  mis-partitioned or reordering transport before it can become silent read-model
  drift. Late redeliveries already covered by the stored checkpoint and exact
  receipts repeated inside the current batch remain ordinary skips.
- `ProjectionCheckpoint` composes the gap-proof `position` with
  `lastAppliedEventId`. `Projector.project` rejects different event identities
  mapped to one position inside a batch or at the stored watermark with
  `ProjectionIdentityViolationError`, before `apply`. The same ID with changed
  commit cardinality or predecessor throws `ProjectionReceiptViolationError`.
  Older positions remain bounded cursor skips under the documented
  source-uniqueness invariant; the checkpoint does not pretend to retain a full
  processed-event ledger.
- `IntegrationMessage` is the explicit JSON-safe broker contract separate from
  internal `DomainEvent` and `CommittedDomainEvent` values.
  `createIntegrationMessage` requires an application-owned mapping;
  `encodeIntegrationMessage` and `decodeIntegrationMessage` validate the full
  graph and cursor. The decoder accepts explicit-offset RFC 3339 timestamps up
  to millisecond precision and normalizes them to canonical UTC `.sssZ`, while
  the producer-side codec remains canonical-only;
  `integrationMessageToCommittedEvent` adapts a validated public message to a
  projector input. Raw `Date`, `Map`, `Set`, cycles,
  non-finite numbers, sparse arrays, and properties JSON would discard reject
  as `InvalidIntegrationMessageError` instead of being silently corrupted;
  hostile own `__proto__` keys reject before downstream copy operations can
  activate them.

### Added: `@shirudo/ddd-kit/money`, the money contract and its boundaries

- New opt-in entry point shipping the canonical money shape so
  consumers stop re-implementing (and mis-implementing) it. `Money` is
  `{ amountMinor: bigint, currency, scale }`: exact, frozen plain data
  that is safe inside aggregate state, event payloads, and snapshots
  (survives `structuredClone`, deep-freeze, and dirty diffing), with
  `MoneyDto` carrying `amountMinor` as an integer string for JSON
  safety. Exact operations only: `addMoney` / `subtractMoney` (exact on
  aligned minor units with same-currency and same-scale guards raising
  `MONEY_CURRENCY_MISMATCH` / `MONEY_SCALE_MISMATCH`), `negateMoney`,
  and lossless `rescaleMoney` (upscaling and exact downscaling; inexact
  conversions throw `MONEY_PRECISION_LOSS`), so domain code needs no
  third-party import and the kit never rounds outside parsing.
  Deliberately NOT shipped: everything carrying a rounding or
  distribution policy (multiplication, ratios, fees, division, lossy
  rescaling, allocation, FX); those are domain policy executed by a
  calculation library at the use-case boundary, and `moneyFromSnapshot`
  / `moneyToSnapshot` bridge its structural `{ amount, currency, scale }`
  snapshot shape without depending on any of them (non-base-10
  currencies and unsafe number amounts are rejected loudly at the
  boundary).
- `parseMoneyInput` parses decimal strings into exact minor units (the
  safe replacement for `Number(input) * 100`) and is EXACT OR
  REJECTED: over-precise input throws `MONEY_PRECISION_LOSS`, and the
  kit ships NO rounding at all (no modes, no rounding engine). Whether
  `10.999 EUR` is rejected or becomes `11.00 EUR` is a business
  decision; the guide shows how to put it in a domain-named policy
  function that rounds via the calculation library.
  `moneyToDecimalString` is the exact inverse; `formatMoney` /
  `createMoneyFormatter` feed `Intl.NumberFormat` the exact decimal
  string, precision-safe past 2^53.
- The kit ships no currency table: `createMoneyFactory({ scaleFor })`
  binds a consumer-provided `CurrencyScaleResolver` once
  (`currencyScaleFromRecord`, `currencyScaleFromIntl`, or a one-liner
  over a calculation library's currency package); unresolved
  currencies throw `UNKNOWN_CURRENCY`.
- New codes in the `KitErrorCode` union: `INVALID_MONEY`,
  `MONEY_CURRENCY_MISMATCH`, `MONEY_SCALE_MISMATCH`,
  `MONEY_PRECISION_LOSS`, `UNKNOWN_CURRENCY` (DomainErrors, registered
  in `createKitPublicErrors()` at status 422 with client-safe
  messages).
- `Money` is branded with a NON-EXPORTED unique symbol: structural
  literals do not type-check as `Money`, not even ones spelling out a
  `__brand` property; only the module's constructors mint it.
  `moneyFromUnknown` re-hydrates foreign plain shapes by validating,
  copying, and freezing (later mutation of the input cannot reach
  domain state); `isMoney` is a check, not a door. The trust-boundary
  parsers (`moneyFromDto`, `parseMoneyInput`, `moneyFromSnapshot`,
  `factory.parse`) take `unknown`, so raw request or storage values go straight in
  without casts or lossy `String(...)` coercion. The Intl-backed resolver
  accepts only canonical uppercase ISO codes ("eur" resolves to
  `undefined` instead of silently aliasing "EUR") and is documented as
  a convenience, not an enterprise source of truth (production paths
  pin a closed, versioned currency map).
- Hard bounds by construction, sized for hostile input on the parse and
  DTO boundaries: amounts up to 96 digits (uint256 fits with headroom),
  scale up to 64, currency up to 32 characters, parse input up to 256
  characters. Oversized input is rejected in O(1) before any bigint
  conversion, diagnostic messages truncate what they echo, the
  Intl-backed resolver and formatter caches are size-capped, and every
  emitting boundary (`moneyToDto`, `moneyToSnapshot`,
  `moneyToDecimalString`, the formatters) rejects non-Money input
  loudly.

### Fixed: audit follow-ups across entity, aggregate, state machine, and utils

- A clock factory returning a SHARED `Date` (the documented
  `withClockFactory(() => fixed, ...)` pattern) is no longer frozen in
  place by `createDomainEvent` nor aliased into `createSnapshot`'s
  `snapshotAt`; both copy the reading.
- `Entity` construction and `setState` share one order (copy, freeze,
  validate, assign): `validateState` always sees the exact frozen
  object that will be stored, so a normalizing or input-reading
  override cannot behave differently between the two paths.
- `Entity` state copies preserve own enumerable NON-INDEX keys on array
  states (`items.total = 5` style annotations), mirroring the
  plain-object branch instead of silently dropping them.
- `IdentityMap.clear()` resets the pending-event baselines; a reused
  map no longer under-reports new events to the
  `UnenrolledChangesError` safety net.
- The domain state machine re-validates the defensive COPY of raw
  definitions and snapshots, closing the Proxy TOCTOU where a lying
  `getOwnPropertyDescriptor` could smuggle values validation never
  saw (exhaustively pinned over every read position); the
  `DomainStateMachine` constructor now shares
  `prepareDomainMachineSnapshot` with the pure path instead of
  hand-rolling it.
- `deepEqual` compares opaque exotics (boxed Symbols, generator
  objects, WeakRefs; tags outside every curated set) by identity
  instead of as empty plain objects that all equaled each other;
  `deepOmit` passes them through by reference so `deepEqualExcept`
  stays consistent.
- `withCommit` enforces the documented subset contract inside the
  transaction: an aggregate listed in `deleted` but missing from
  `aggregates` throws `EventHarvestError` instead of silently losing
  its deletion events (never harvested into the outbox) and
  double-emitting them on a later commit. The `UnitOfWork` facade was
  always immune; only direct `withCommit` callers could trip this.
- `transitionDomainState` outcomes are `Object.freeze`d like every
  sibling return value (snapshots, outputs, the analyzer result), so a
  cast can no longer rewrite `from`/`to` at runtime despite the
  readonly typing.
- `deepOmit`'s `ignoreKeyPredicate` receives a stable path snapshot;
  captured paths no longer read as empty after the walk.
- `mergeMetadata` and `copyMetadata` reject an own `__proto__` data key
  with `HostileStateKeyError` (same contract as entity state) instead
  of carrying the pollution payload into event metadata.
- Added: `DuplicateHandlerRegistrationError` (code
  `DUPLICATE_HANDLER_REGISTRATION`, WIRING): duplicate bus handler
  registration now throws a named, routable error instead of an
  anonymous `Error`; the message still contains "already registered"
  for existing matchers.
- Performance: `InMemoryEventStore.append` pushes in place (O(batch)
  instead of O(stream) per append), `InMemoryOutbox.getPending(limit)`
  stops at the limit instead of materializing the whole backlog, and
  `hasChanges` reads an internal pending-event count instead of
  allocating the frozen `pendingEvents` copy per save.
- `updateEntityById` / `replaceEntityById` / `removeEntityById` use
  structural sharing: they return the ORIGINAL array when nothing
  changed (no match, same-reference result) so the reference-based
  `changedKeys` diff stays clean and partial-write repositories skip
  untouched collections; a new array only when an element reference
  actually changed. Their return type is now `ReadonlyArray<T>` (the
  result may BE the frozen input); spread it for a mutable copy.
- Docs: the transaction-scope module doc now attaches to
  `TransactionScope`; the remaining German test names were translated.

### Added: `createKitPublicErrors`, and `toPublicErrorView` rides the pipeline

- New `createKitPublicErrors()` (presentation entry) builds base-error's
  `PublicErrorCatalog` with one descriptor per public code the kit can
  emit (`AGGREGATE_NOT_FOUND` 404, `CONCURRENCY_CONFLICT` 409 retryable,
  `DUPLICATE_AGGREGATE` 409, the validation family 422 with sanitized
  issues under `details.issues`, `INTERNAL_ERROR` 500 fallback).
  Deliberately a FACTORY: base-error's `registerByCode` / `register`
  widen the type but register into the same instance, so a shared
  export would leak one consumer's extensions into every other. Build
  your catalog at the composition root and extend it there:
  `createKitPublicErrors().registerByCode("ORDER_ALREADY_SHIPPED", ...)`.
- `toPublicErrorView` now delegates to that pipeline (`project` +
  `localize` over a private default catalog) and accepts a `catalog`
  option, so consumer codes and locales resolve through the same
  machinery. Totality and the validation hardening are unchanged and
  stay test-pinned.
- Breaking within the unreleased 3.0.0: the `locale` option is now a
  PREFERENCE (RFC 4647 lookup); the view carries the locale that
  actually RESOLVED instead of stamping the requested one onto an
  English message (`locale: "de-DE"` with the built-in messages now
  yields `locale: "en"`).

### Changed (breaking): `toProblemDetails` delegates to base-error's `toProblem`

- `toProblemDetails` now runs base-error's transport stage instead of
  hand-building the body: one pipeline, one wire profile, one hardening
  implementation. It returns `toProblem`'s `ProblemDetailsResult`
  (`{ status, headers, body, outcome }`), so boundaries stop restating
  the status and content-type; the whitelisted issues ride under
  `details.issues` (the same shape `toPublicErrorView` uses) and the
  body carries the error's public `code`.
- Wire changes: the `member` option (`errors` / `invalid-params`, both
  non-standard conventions) is gone; the `ValidationProblemMember` type
  was removed and `ValidationProblemDetails` added. The body inherits
  `toProblem`'s guarantees: deeply frozen, null prototype, JSON-safe (a
  non-serializable value drops that member into `outcome.omitted`
  instead of corrupting the wire), and an extensions set colliding with
  reserved members is dropped and recorded rather than merged.
- Migration: `Response.json(toProblemDetails(e), { status: 422 })`
  becomes `const p = toProblemDetails(e); Response.json(p.body,
  { status: p.status, headers: p.headers })`; clients read the issues
  from `details.issues` instead of the `errors` member.

### Fixed: the analyzer honors the prepared-definition fast path

- `analyzeDomainMachineDefinition` hand-rolled validate-and-copy
  instead of going through the shared entry-point normalization, so a
  definition prepared with `prepareDomainMachineDefinition` paid the
  full O(definition) re-validation and deep re-copy on every analysis
  call, contradicting the documented prepared-definition contract. It
  now uses the same fast path as the other pure functions and the
  `DomainStateMachine` constructor: prepared definitions pass through
  untouched, raw definitions keep the per-call validate-and-copy.

### Fixed: `deepOmit` preserves non-enumerable own string properties

- `deepOmit` cloned plain objects from `Object.keys` only, silently
  dropping non-enumerable own string properties, while `deepEqual`
  deliberately compares via `Object.getOwnPropertyNames`: two objects
  differing only in such a property gave `deepEqual` `false` but
  `deepEqualExcept` `true`, and `deepEqual(deepOmit(x, {}), x)` was
  `false`. The clone now walks `Object.getOwnPropertyNames` (matching
  `deepEqual`, and matching the symbol and array-property handling that
  already survived) and preserves each property's enumerability, so
  the omit of nothing is an exact key-set image of the input.

### Fixed: `restoreFromSnapshot` rejects targets carrying pending events

- `AggregateRoot.restoreFromSnapshot` silently kept pre-restore
  `pendingEvents` while re-baselining the version via `markRestored`,
  so events recorded before the restore would later be harvested with
  a version baseline from a state lineage the snapshot had discarded.
  The event-sourced replay methods already guarded against exactly
  this; the guard is now one shared, non-overridable module-internal
  function checking the public `pendingEvents` surface, and both
  restore paths throw `UnreplayableAggregateError` before anything
  moves.
- Migration for the in-memory undo pattern (snapshot before a risky
  operation, restore on failure): take the undo snapshot while the
  aggregate is CLEAN (no `pendingEvents`, e.g. right after load or
  save), since `createSnapshot` bakes pending events' version bumps
  into `snapshot.version`; on failure call `clearPendingEvents()`
  BEFORE `restoreFromSnapshot` to discard the events recorded since
  that clean point. Restoring first and clearing afterwards now
  throws.
- The `UnreplayableAggregateError` message no longer recommends a bare
  `markPersisted` (harmful on the snapshot-restore path: it flips
  repository routing to UPDATE and silently drops the unflushed
  events); it names `clearPendingEvents()` as the deliberate-discard
  remedy instead.

### Fixed: a throwing retry classifier no longer masks the transaction error

- `RetryingTransactionScope` invoked the `isRetryable` classifier
  unguarded inside its catch block, so a throwing classifier replaced
  the original transaction failure with its own error (losing the
  error type upstream mapping relies on, e.g.
  `ConcurrencyConflictError` to HTTP 409). Reachable with the DEFAULT
  policy: base-error's `someChainRetryable` throws on a circular cause
  chain. The classifier is now guarded like the `onRetry` observer: a
  classifier throw counts as "not retryable" and the ORIGINAL error
  surfaces unchanged.

### Changed (breaking): buses map only explicitly expected failures

- Removed the total `errorMapper` option and its implicit string fallback.
  With no policy, every registered-handler throw propagates unchanged, so its
  identity, cause chain, cancellation semantics, and retry classification are
  preserved.
- Added the selective `mapExpectedError(thrown)` option. Returning
  `{ error: E }` positively classifies the failure into the Result channel;
  returning `undefined` declines it and rethrows the exact original. The
  wrapper makes `E = undefined` unambiguous.
- Widened error channels no longer require constructor options. A command
  handler can return `err(E)` directly without configuring exception mapping.
  Literal-union channels remain closed because a positive mapper decision must
  produce their declared `E`.
- A `mapExpectedError` that throws or returns a malformed decision produces
  `ErrorMapperFailedError` (crash-loud,
  same family as `UnregisteredHandlerError`) carrying the handler failure as
  `cause` and the mapper failure as `mapperCause`. Nested wiring and mapper
  failures never enter an outer Result channel.
- Internal shared bus wiring still owns registration, dispatch, and failure
  classification once, so command and query semantics cannot drift.

### Fixed: `toPublicErrorView` is total and no longer trusts duck-typed `publicIssues()`

- A throwing `publicIssues()` implementation (or a throwing `name` /
  `publicIssues` accessor) crashed the presenter inside the 500 path,
  contradicting the documented totality over `unknown`; any non-kit
  object that happened to expose a `publicIssues()` method also had
  its raw `name` emitted as the client-facing `code` and its arbitrary
  return value shipped to the client in `details.issues`. The mapper
  now degrades to the `INTERNAL_ERROR` fallback view on any throw, and
  the validation branch requires a SCREAMING_SNAKE `name` (the shape
  base-error gives a `ValidationError`, which is named after its code)
  in addition to the capability, so class-named infrastructure errors
  can no longer masquerade as validation errors. Issues are re-emitted
  through the `PublicIssue` whitelist (`message`, `path`, `code`,
  `pointer`): unknown fields, non-conforming entries, and non-array
  `publicIssues()` results are dropped.

### Fixed: entity state rejects `__proto__` prototype pollution loudly

- An own `__proto__` data key on a plain-object state (the shape
  `JSON.parse` produces for DB rows or request bodies handed to
  reconstitute factories) was applied through the `Object.prototype`
  setter by `Object.assign` during `Entity`'s internal shallow copy:
  the copy's prototype was replaced with the injected object and the
  key was dropped. The constructor and `setState` now throw the new
  `HostileStateKeyError` when a plain-object, null-prototype, or array
  state carries such a key: it can never be legitimate domain state,
  carrying it onward would re-arm pollution in downstream
  `Object.assign`-style consumers of `state`, and dropping it would be
  silent data mutation. On `setState` the previous state is kept. The
  internal copy also switched from `Object.assign` to object spread
  (data properties, never `[[Set]]`) as defense in depth.
- Added: `HostileStateKeyError` is exported from the main entry.

## [2.2.0] - 2026-07-04

### Added: Unit of Work observability

- Add an optional `onPersistError(error, aggregate)` observer to `withCommit`
  and `UnitOfWork`, symmetric with `onPublishError`. Post-commit cleanup
  failures (a throw from `markPersisted`, the user-overridable `onPersisted`
  hook, or `clearPendingEvents`) were previously swallowed silently; they are
  now reported per failing aggregate. The observer never rejects the committed
  write.
- Harden both post-commit observers (`onPersistError`, `onPublishError`)
  against a misbehaving hook: a synchronous throw AND an `async` observer
  whose promise rejects are both neutralised, so neither can surface as an
  unhandled rejection after the transaction has committed. The `=> void`
  signature admits an `async` function, so this guards a real footgun.

### Added: named wiring-bug error for the buses, prepared state machines, curated exports

- New `UnregisteredHandlerError` (`busKind`, `messageType`): dispatching a
  command or query type no handler was registered under is a wiring bug,
  in the same crash-loud `BaseError` family as `MissingHandlerError`. For
  2.x compatibility `execute` still delivers it through the error channel
  via the `errorMapper` (the default string channel keeps its exact
  message, so nothing observable changes there), but typed error channels
  can now route it explicitly instead of pattern-matching message
  strings; `QueryBus.executeUnsafe` throws it directly. v3 makes
  `execute` throw it too. Note for CUSTOM `errorMapper`s: the value they
  receive for this path changes from a plain `Error` to this structured
  `BaseError` subclass (own `name`, `toJSON`, `busKind`, `messageType`),
  the same shape kit errors thrown by handlers have always arrived in;
  a mapper that serializes or branches on the thrown value will see the
  richer structure.
- New `prepareDomainMachineDefinition` (+ `PreparedDomainMachineDefinition`
  type): validates and stabilizes a machine definition ONCE for the pure
  API. `transitionDomainState`, `canTransitionDomainState`,
  `createInitialDomainMachineSnapshot`, and the `DomainStateMachine`
  constructor recognize the prepared handle and skip their per-call
  validate-and-copy of the definition; raw definitions keep the
  documented per-call safety. Snapshots and inputs are still validated
  and copied per call.
- All package entry points now use curated named exports instead of
  `export *`, and a new API-surface test pins the runtime export list of
  every entry, so internals can no longer leak into the public SemVer
  surface by accident. The exported surface is byte-for-byte unchanged
  (verified against the previous build); already-shipped internals
  (`computeBackoffDelay`, `freezeShallow`) stay exported until v3.

### Added: `EventStore` port and event-sourced repository contract suite

- New `EventStore<Evt>` driven port (`append` with an `expectedVersion`
  guard, `readStream` with `fromVersion` for snapshot catch-up), following
  Greg Young's stream-per-aggregate model: the stream id is the aggregate
  id and the stream version is the event count, aligned with the aggregate
  version. Adapters map their store's conflict signal to
  `ConcurrencyConflictError` (for the duplicate-create race specifically,
  an adapter that can distinguish it may throw the non-retryable
  `DuplicateAggregateError` instead, matching the state-stored insert
  path); rejected appends must be atomic, which the contract suite's
  mandatory test now exercises with a two-event stale batch. The port
  documents the one-save-per-aggregate-per-unit-of-work rule (the ES
  spelling of the existing "mutate first, save last" contract).
- New `InMemoryEventStore` reference implementation (tests, single-process
  workers, demos), with the same rollback caveat as `InMemoryOutbox`.
- New `createEsRepositoryContractTests` in `@shirudo/ddd-kit/testing`: the
  event-sourced counterpart to the state-stored suite. Proves the
  two-writer append conflict (expectedVersion guard + atomicity), replay
  equality and fold order, the commit lifecycle (outbox harvest,
  `markPersisted`, rollback purity, retried first save), the
  duplicate-create race (capability-gated), and `fromVersion` slicing.
  The in-repo reference adapter doubles as the example harness and pins
  that the suite exposes blind appends and reversed reads.

### Added: snapshot schema versioning

- `AggregateSnapshot` carries an optional `schemaVersion`, stamped by
  `createSnapshot` from the new overridable `snapshotSchemaVersion` on the
  aggregate (default `1`). Both restore paths (`restoreFromSnapshot`,
  `restoreFromSnapshotWithEvents`) compare it before anything is assigned:
  a mismatched stored snapshot throws the new `SnapshotSchemaMismatchError`
  (an `InfrastructureError`; catch it in the repository, discard the
  snapshot, and refold from the stream), or is upgraded through the new
  overridable `migrateSnapshotState(stored, storedSchemaVersion)` hook.
  A `DomainError` thrown by a `migrateSnapshotState` override (an
  unupgradable snapshot) rides `restoreFromSnapshotWithEvents`'
  documented `Err` channel like every other domain rejection, so the
  repository's discard-and-refold branch sees it.
  Previously a snapshot written against an older `TSnapshotState` shape
  surfaced as an undefined-field crash on the first method call after a
  much later restore. Snapshots from older kit versions (no
  `schemaVersion`) are treated as schema `1`.

### Changed: `AggregateSnapshot` fields are `readonly` at the type level

- `state`, `version`, and `snapshotAt` are now declared `readonly`,
  matching what snapshots are (point-in-time values) and what the kit's
  restore paths already assumed. **Compile impact:** code that assigned to
  these fields after construction (`snapshot.version = ...`) will no
  longer typecheck. That pattern was never supported (a mutated snapshot
  desyncs state from version); construct a new snapshot object instead.
  Object-literal construction is unaffected. Runtime behavior is
  unchanged.

### Added: outbox ordering contract and dead-letter affordances

- `Outbox.getPending` now documents ordering as part of the port
  contract: records come back in the order `add()` persisted them (commit
  order). `withCommit` has always promised subscribers per-aggregate
  causal order; a dispatcher can only honor it when this read is ordered,
  so SQL-backed implementations need a monotonic position column plus an
  `ORDER BY`. This is a contract clarification, not a behavior change in
  the kit; `InMemoryOutbox` already preserved insertion order and now
  pins it with a test.
- New optional `DispatchTrackingOutbox` extension port: `markFailed`
  records a failed delivery attempt (surfaced as the new optional
  `OutboxRecord.attempts`), and records past the implementation's attempt
  ceiling move to a dead-letter set exposed by `deadLetters()` (new
  `DeadLetterRecord` type), so a poison message stops blocking the
  dispatcher instead of being redelivered forever. `InMemoryOutbox`
  implements the extension with a configurable `maxDeliveryAttempts`
  (default `5`). Re-`add` semantics are part of the contract: re-adding a
  pending eventId refreshes the stored copy (a retried commit re-stamps
  `aggregateVersion`) while the delivery attempt count survives, and
  re-adding a dead-lettered event requeues it with a fresh attempts
  budget instead of silently succeeding while the event stays dead. The
  outbox guide documents the retry-then-dead-letter dispatcher loop,
  including stopping the batch on the first failure so later events
  cannot overtake a failed predecessor of the same aggregate.

### Added: opt-in deep freeze for entity and aggregate state

- New `deepFreezeState` option on `EntityConfig` / `AggregateConfig`
  (`super(id, state, { deepFreezeState: true })`): the whole state graph is
  frozen via `deepFreeze` instead of the default shallow freeze, so nested
  outside writes (`order.state.items.push(x)`) throw instead of silently
  bypassing `validateState`, the version bump, and the `changedKeys` dirty
  diff. Applies to construction, `setState`, event-sourced `apply`, and both
  snapshot-restore paths. Only for plain-data states: class-based child
  entities inside the state would be frozen along with the graph, and nested
  input objects are frozen in place (the ownership transfer widens to the
  whole graph). The default stays shallow; nothing changes without the
  opt-in.
- Aggregate and entity subclasses that assign `this._state` directly should
  freeze through the new protected `freezeState(value)` method instead of
  `freezeShallow`, so the configured freeze mode is honored.

### Deprecated: relying on the implicit non-bumping `setState` default

- Calling `AggregateRoot.setState(newState)` without a per-call
  `bumpVersion` argument and without an explicit `autoVersionBump` config is
  deprecated. The implicit default (`false`) permits silent lost updates: a
  save whose version did not move writes `WHERE version = v SET version = v`,
  so a concurrent writer that loaded the same `v` commits over it without a
  `ConcurrencyConflictError`. v3 will make the `bumpVersion` argument
  required so every mutation states its OCC intent at the call site; code
  that already passes `bumpVersion`, sets `autoVersionBump` explicitly, or
  uses `commit()` is unaffected. The JSDoc and the aggregates guide now
  document the lost-update mechanics.

### Fixed: architecture-audit findings

- `toPublicErrorView` no longer throws a `TypeError` when the caught value is
  `null` or `undefined` (`throw null` and `reject(undefined)` happen in real
  systems). It now degrades to the generic `INTERNAL_ERROR` view, as its
  "total over `unknown`" contract always promised.
- `createDomainEvent` now deep-clones `payload` and `metadata` before the
  deep-freeze, so the caller's own object graph is never frozen in place
  (same ownership contract as `vo()` and the existing `occurredAt` copy).
  Previously, passing parts of live aggregate state as a payload, or reusing
  a metadata object across events, froze the caller's objects; the next
  mutation then threw far away from the cause. Behavioral notes: the event's
  `payload` is no longer reference-identical to the input; function-bearing
  payloads and metadata now throw a descriptive `TypeError` (domain events
  are plain data by contract); symbol-keyed properties are not carried over
  (`structuredClone` semantics).
- `EventSourcedAggregate.restoreFromSnapshotWithEvents` now runs the
  `validateState` hook on the restored snapshot state before applying it,
  matching `AggregateRoot.restoreFromSnapshot`. Previously a corrupt snapshot
  store could reconstitute an invalid aggregate; with zero events after the
  snapshot, no validation ran at all. A rejecting `validateState` surfaces as
  `Err` (infrastructure boundary), and the aggregate is left untouched.
- Correct the `aggregateVersion` guidance in the `DomainEvent` and
  `withCommit` JSDoc: all events of one commit share the stamp, so it is not
  a per-event idempotency key; dedup belongs on `eventId`, and a watermark
  keyed on `aggregateVersion` is per-commit only. The outbox guide already
  said this; the JSDoc now matches it.
- `EventSourcedAggregate.loadFromHistory` and
  `restoreFromSnapshotWithEvents` now guard their replay target: an
  aggregate carrying unflushed `pendingEvents`, or (for `loadFromHistory`)
  an in-memory version that was never persisted, throws the new
  `UnreplayableAggregateError` before anything moves. Previously the JSDoc
  even blessed replaying onto a factory-created instance holding its
  creation event; doing so set a `persistedVersion` counting unpersisted
  history, which flipped repository routing from INSERT to UPDATE (a false
  `ConcurrencyConflictError` against a missing row) and let harvested
  events claim a version baseline the stream does not carry. Fresh
  reconstitution and catch-up replay on a persisted aggregate
  (`persistedVersion` set) behave as before. The error extends `BaseError`
  directly (crash-loud posture, like `MissingHandlerError`) and is thrown,
  never returned as `Err`.
- `createSnapshot` now stamps `snapshotAt` from the kit's swappable clock
  instead of a hard `new Date()`, so `setClockFactory` / `withClockFactory`
  pin snapshot timestamps in deterministic tests exactly like event
  `occurredAt`. The clock implementation moved to an internal module; the
  public API (`ClockFactory`, `setClockFactory`, `withClockFactory`,
  `resetClockFactory`) is unchanged.
- `RetryingTransactionScope` now neutralises its `onRetry` observer the
  same way `withCommit` neutralises `onPublishError` / `onPersistError`: a
  synchronous throw or an async rejection from the observer is swallowed,
  so a buggy logging/metrics hook can no longer abort the retry loop and
  mask the original retryable error (typically a
  `ConcurrencyConflictError`) with its own.

### Documentation: audit follow-up corrections

- Align the supported-Node claim with the package's `engines` field:
  README, getting-started, LLM.md, and the edge-runtimes guide now say
  Node 20+ (the previous "Node 18+" contradicted `engines: >=20`).
- Fix the stale `EntityBase` references in the `entity.ts` module header
  (the exported class is `Entity`) and rewrite both JSDoc examples to
  mutate through `setState` instead of assigning `this._state` directly,
  which skipped `validateState` and the freeze the getter contract
  documents.
- Record the decision to keep `commit()`'s transaction-flavored name in
  the design-decisions guide (the atomic semantics are the point; the
  method is `protected`, so aggregates expose domain verbs publicly).

### Fixed: Value Object cloning and equality hardening

- Enforce absolute Value Object semantics: reject `Error`, `ArrayBuffer`,
  `SharedArrayBuffer`, TypedArrays, and `DataView` from `vo()` and `ValueObject`
  because they cannot be both deeply immutable and reliably value-compared.
- Require intrinsic prototype evidence for unprobeable `Promise` and `Error`
  tags, so plain records spoofing those names remain ordinary structural data.
- Reject object-valued Map keys and Set members, whose identity-based lookup
  semantics cannot survive defensive cloning while preserving value equality.
- Clone arrays and records through data descriptors, rejecting accessors without
  invoking them while preserving sparse holes and all symbol-keyed properties.
- Read Map and Set contents through captured intrinsic iterators so instance-level
  iterator overrides cannot execute behavior during Value Object construction.
- Include array own properties in deep equality so preserved symbols and sparse
  structure remain part of Value Object equality.
- Preserve sparse holes, descriptors, and custom string and symbol properties
  while omitting array keys, keeping `deepEqualExcept` and `voEqualsExcept`
  aligned with strict array equality.
- Reject Proxy-wrapped user constructors that imitate intrinsic constructor
  names by comparing their exact source with a captured intrinsic allowlist.
- Preserve the complete Array `length` descriptor in `deepOmit`, including a
  non-writable length.
- Document that Value Object inputs must be trusted and Proxy-free because
  portable ECMAScript cannot identify transparent Proxies without invoking
  their traps.
- Reject a global or sticky `RegExp` from `vo()` and `ValueObject`: its
  `lastIndex` is mutable scan state that deep freezing turns non-writable, so
  every `test()`/`exec()` would throw. A plain `RegExp` never touches
  `lastIndex` and stays an admitted immutable value.
- Preserve non-enumerable own properties (including symbols) through
  `ValueObject.clone()`, which previously lost them to its `{ ...props }`
  spread and made `x.equals(x.clone())` false.
- Stop `deepOmit` (and therefore `voEqualsExcept`/`deepEqualExcept`) from
  applying `ignoreKeys`/`ignoreKeyPredicate` to array index keys, which
  silently dropped elements and made structurally different arrays compare
  equal. Key filtering still applies to custom, non-index array properties.
- Compare accessor-defined array elements in `deepEqual` by the value they
  yield, matching how plain-object accessor properties are compared, instead of
  by getter/setter function identity.
- Count non-enumerable own string properties in `deepEqual`, consistent with its
  existing handling of symbols, so two objects that differ only by a hidden
  string property are no longer reported equal.
- Drop non-enumerable string properties on arrays in `vo()`/`ValueObject` just
  like the plain-object clone path already did, so structurally parallel inputs
  clone to the same value surface.

### Changed: Domain State Machine DDD contracts and runtime hardening

- Rename `DomainMachineEvent` to `DomainMachineInput`, including callback fields
  and validation errors, so machine commands, observed facts, and internal
  triggers cannot be confused with published Aggregate Domain Events.
- Let guards return a concrete `DomainError`: `can()` treats it as a rejected
  transition, while `dispatch()` throws the exact typed domain error. Boolean
  `false` keeps the generic `DomainTransitionGuardRejectedError` behavior.
- Add state-local `validateContext` invariants, typed to each concrete state and
  evaluated across creation, reconstitution, functional inputs, and transition
  results; retain `validateSnapshot` for cross-state rules.
- Narrow transition guard and reducer `state` values to their concrete source
  state instead of the full machine state union.
- Add `analyzeDomainMachineDefinition` for deterministic transition matrices and
  sound diagnostics for unreachable states, structural dead ends, and missing
  terminal paths without executing definition callbacks.
- Document versioned snapshot migrations, transactional inbox/outbox
  deduplication, and deadlines supplied as explicit machine input data.
- Reject async reducers, unknown definition/result properties, inherited or
  hidden definition entries, and Array subclasses instead of silently dropping
  behavior or outputs.
- Evaluate functional transitions against stable definition copies and reject
  reentrant evaluation of the same stateful wrapper.
- Restrict machine context, inputs, and outputs to primitives, plain arrays, and
  plain objects. Native built-ins such as `Date`, `RegExp`, `Map`, and `Set` are
  rejected because their internal slots cannot satisfy the machine's strict
  deep-immutability contract.
- Add `ReentrantDomainStateMachineEvaluationError` for structured reentrancy
  failures.
- Preserve non-enumerable transition fields in stable definition copies, so a
  validated `guard`, `reduce`, or `target` cannot disappear during evaluation.
- Add optional `validateSnapshot` invariants across initial creation,
  reconstitution, functional inputs, and transition results.
- Accept cross-Realm plain objects and arrays while normalizing copied values to
  local prototypes; custom classes and Array subclasses remain rejected.
- Verify cross-Realm Object and Array prototypes through native intrinsic
  constructors instead of accepting user functions with matching names.
- Reject Proxy-wrapped user constructors that imitate intrinsic Object or Array
  prototypes.
- Reject own and inherited `Symbol.toStringTag` accessors without invoking them
  while validating machine data, including cross-Realm object and array
  prototypes.
- Expose deeply frozen context, input, snapshot, and output data through the
  recursive `DomainMachineReadonly<T>` type.
- Reuse the stateful wrapper's prepared definition, validated snapshot, and
  unchanged frozen context to avoid redundant validation and deep copies on
  every operation.
- Treat an explicit `undefined` snapshot argument to the `DomainStateMachine`
  constructor as "no snapshot", falling back to the initial snapshot instead of
  failing validation, and widen the reconstitution overload to accept
  `undefined` so a nullable stored snapshot can be passed straight through.
- Bound every context, input, and output copy to 256 levels, 10,000 unique
  object nodes, and 100,000 own properties.
- Document the Proxy-free input precondition and clarify that the machine is a
  domain-consistency component rather than an in-process security sandbox.
- Document snapshot persistence, reconstitution, JSON encoding boundaries, and
  atomic output handoff; update the executable saga example to use the actual
  domain state machine API.

## [2.1.0] - 2026-06-25

The domain-state-machine release. This minor adds a small, framework-free
`DomainStateMachine` building block for finite, named domain states with typed
context. It is meant for aggregate lifecycles, process managers, and
long-running business workflows where the allowed transitions should be explicit
without turning the kit into a workflow engine.

### Added: `DomainStateMachine`

New root export:

- `DomainStateMachine`
- `DomainMachineDefinition`
- `DomainMachineSnapshot`
- `DomainMachineInput`
- `DomainStateNode`
- `DomainTransition`
- `DomainTransitionGuardResult`
- `DomainTransitionResult`
- `DomainTransitionOutcome`
- `createInitialDomainMachineSnapshot`
- `canTransitionDomainState`
- `transitionDomainState`

The machine supports synchronous guards, synchronous reducers, terminal states,
typed transition outputs, validated reconstitution snapshots, and a pure
transition function for aggregate methods that want to decide first and commit
afterward. Transition callbacks are typed by the specific input selected by the
`on` key, so `PaymentReceived` guards/reducers see the `PaymentReceived` input
shape rather than the full input union.

The stateful wrapper defensively copies its definition at construction time, so
mutating the caller's definition object later cannot alter machine behavior.
Snapshots and output arrays returned by the API are shallow-frozen copies, and
constructor snapshots are copied before being stored. Definition copies preserve
own special-property keys such as `__proto__`, and malformed runtime definitions
fail as structured definition errors rather than leaking raw `TypeError`s.
Explicit `null` or `undefined` context updates are preserved when the `context`
property is present in a reducer result. The context object remains
application-owned by design: model it immutably, use value objects where deep
immutability matters, and keep aggregate methods as the public domain language
instead of exposing generic `dispatch(...)` calls to application code.

Domain-rule failures throw `DomainError` subclasses:

- `InvalidDomainTransitionError`
- `DomainTransitionGuardRejectedError`

Definition and reconstitution failures throw structured `BaseError` subclasses:

- `InvalidDomainMachineDefinitionError`
- `InvalidDomainMachineSnapshotError`

### Documentation and release hygiene

- Added the Domain State Machine guide and sidebar entry.
- Enabled Biome's VCS ignore-file integration so generated `dist` and
  VitePress output stay out of `pnpm run lint`.
- Quoted YAML frontmatter strings in the docs home page that contained `:`
  characters, so the docs build parses consistently.
- Ignored known TypeDoc-generated guide-relative dead links in VitePress' API
  media output; the canonical guide links remain intact.

## [2.0.0] - 2026-06-23

The error-stack release. The `@shirudo/base-error` peer dependency moves from `^5.0.0` to `^7.1.1`, which crossed two of its major versions: v6 made base-error's core purely technical (it removed the localization layer and every in-core serializer) and v7 reorganized public output into opt-in subpaths. This release migrates the kit onto v7 and adopts the same posture: technical errors in the core, client-safe and localized output projected at the boundary. The major also irons out two long-standing footguns while the door is open: the swap-prone positional error constructors move to options objects, and the redundant `createDomainEventWithMetadata` is removed. Two additive features round it out: a generic `Result<T, E>` error channel for the buses (default `string`), and a transport-neutral `@shirudo/ddd-kit/presentation` entry. The retry, validation, and class-discrimination surfaces are unchanged. base-error v7 requires Node.js `>=20`.

### Changed (breaking): upgrade the `@shirudo/base-error` peer dependency from `^5.0.0` to `^7.1.1`

base-error v6 made its core purely technical: it removed the localization layer (`withUserMessage` / `getUserMessage` / `addLocalizedMessage`), every public serializer (`toPublicJSON`, `toProblemDetails`, `toErrorResponse`), and the `ProblemDetails` / `ProblemDetailsOptions` types from the package root. Client-safe, localized output now lives in the opt-in `@shirudo/base-error/presentation` subpath (`PublicErrorPresenter`); RFC 9457 mapping lives in `@shirudo/base-error/problem-details`.

- **`AggregateNotFoundError`, `DuplicateAggregateError`, and `ConcurrencyConflictError` no longer ship a default user message.** They previously called the removed `withUserMessage(...)`, so `error.getUserMessage()` returned a client-safe string. That method is gone. The errors still carry their full technical `message`, `name`, `cause` chain, timestamps, and the `retryable` marker. To present a user-facing or localized message at the boundary, register the kit's errors in a base-error `PublicErrorRegistry` and project them through `PublicErrorPresenter` (the `@shirudo/base-error/presentation` subpath); the technical core deliberately stays free of presentation strings.
- **`toProblemDetails` (`@shirudo/ddd-kit/http`) no longer delegates to the removed `ValidationError.toProblemDetails()`.** It now builds the RFC 9457 body directly from `error.publicIssues()` and returns base-error's own `ProblemDetails` type, imported from the new `@shirudo/base-error/problem-details` subpath, so the RFC 9457 shape stays a single source of truth across the ecosystem rather than being re-declared by the kit. Defaults are unchanged (`type: "about:blank"`, `title: "Validation Failed"`, `status: 422`), as are the `member` / `extensions` options and the output shape. `ValidationProblemOptions` no longer extends the removed `ProblemDetailsOptions`; it declares the standard RFC 9457 members (`type`, `title`, `status`, `detail`, `instance`) plus `member` and `extensions` explicitly, and `extensions` is now typed JSON-safe (`ProblemDetailsExtensions`). `traceId` is a plain extension member (pass it via `extensions`), not a recognized top-level field. For the general error-to-Problem-Details mapping, base-error's `defineProblemDetailsAdapter` over a `PublicErrorView` is the catalog-driven path; this helper stays the narrow validation shortcut.

### Packaging

- Declared `engines.node` `">=20"` to match base-error v7's requirement, so an unsupported Node fails at install instead of at runtime.
- Ordered every `package.json` export condition `types`-first (before `import`), so consumer type resolution under `node16` / `nodenext` finds the declarations reliably.

The retry surface is unaffected: `someChainRetryable`, `isRetryable`, `isBaseError`, `ValidationError`, and the `retryable = true` marker on `ConcurrencyConflictError` all behave as before. No source changes are needed in consumer code that does not call `getUserMessage()` or rely on the removed base-error serializers.

### Changed (breaking): error constructors take a single options object

`AggregateNotFoundError`, `DuplicateAggregateError`, and `ConcurrencyConflictError` had adjacent positional parameters of the same type (two strings, and for the conflict two strings plus two numbers), which a repository adapter could silently transpose at the call site. They now take one options object, so every field is named and a swap is impossible:

- `new AggregateNotFoundError({ aggregateType, id, cause? })`
- `new DuplicateAggregateError({ aggregateType, aggregateId, cause? })`
- `new ConcurrencyConflictError({ aggregateType, aggregateId, expectedVersion, actualVersion, cause? })`

The public readonly fields, `name`, message format, `cause` chain, and the `retryable` marker are unchanged; only the constructor signature changed. This sets the kit's convention: positional parameters for one or two clearly distinct values, an options object for three or more, multiple optionals, or any adjacent same-typed parameters.

### Removed (breaking): `createDomainEventWithMetadata`

`createDomainEventWithMetadata(type, payload, metadata, options?)` was a thin wrapper over `createDomainEvent` whose two trailing object parameters (`metadata`, `options`) were themselves transposable. It is removed; `createDomainEvent` already accepts metadata through its options object.

### Added: generic error channel for `CommandBus` / `QueryBus` (`Result<T, E>`, default `E = string`)

The App-Service boundary has always been documented as returning `Result<T, E>`, but `CommandBus`, `QueryBus`, and `CommandHandler` hardcoded `Result<T, string>`, so a thrown `DomainError` was flattened to a string and the documented typed channel was unreachable through the bus. The error type is now a real generic `E` that **defaults to `string`**, so existing code (`new CommandBus<Map>()`, `CommandHandler<C, R>`) compiles and behaves exactly as before.

To carry typed failures, widen `E` and pass an `errorMapper` (`(thrown: unknown) => E`) that maps thrown values (a handler throw, or dispatch to an unregistered type) into the channel; base-error's `toStructuredError` fits this slot directly. The mapper is **required at construction once `E` is widened** (enforced at the type level), so a typed channel can never silently fall back to string values; with the default `string` channel the built-in `describeThrown` mapper applies and construction stays argument-free. A handler may also return `err(typedError)` directly and it passes through unchanged. New exported types: `CommandBusOptions`, `QueryBusOptions`. `QueryHandler` is unchanged (it still returns a bare value; its only error source is a throw, routed through the mapper); `QueryBus.executeUnsafe` still throws the raw error. Additive; nothing changes unless you widen `E`.

### Added: `toPublicErrorView` for transport-neutral error presentation (`@shirudo/ddd-kit/presentation`)

New opt-in entry point `@shirudo/ddd-kit/presentation` with `toPublicErrorView(error, options?)`: it maps a kit error (or any caught value) to a base-error `PublicErrorView` (`code`, `message`, `locale`, optional `details`), the **transport-neutral**, client-safe representation. It carries no HTTP status, header, or exit code on purpose: that mapping is the consumer's, exactly where base-error puts it. Feed the view into base-error's `defineProblemDetailsAdapter` (HTTP / RFC 9457), a gRPC status table, or a CLI exit-code map, whichever boundary you are at.

The helper is total over `unknown`: an unmapped or non-kit value degrades to a generic `INTERNAL_ERROR` view rather than leaking the technical message or throwing. The kit's class-based errors (`AggregateNotFoundError`, `ConcurrencyConflictError`, `DuplicateAggregateError`) match by their pinned `error.name` (no `instanceof`, so it survives minification and duplicate installs) and carry safe, occurrence-free English messages; a `ValidationError` is detected by its `publicIssues()` whitelist and its issues ride along in `details.issues`. This is the opt-in home for the client-safe messages that this release removed from the technical core: the core stays presentation-free, the boundary opts in. For richer, multi-locale messages, register the kit's errors in a base-error `PublicErrorRegistry` and use `PublicErrorPresenter`; this helper is the lean, single-locale default. Additive; nothing changes if you do not import it.

### Migration

1. **Bump the peer dependency** (and the kit) and ensure you are on Node.js `>=20`:

   ```sh
   pnpm add @shirudo/ddd-kit@^2.0.0 @shirudo/base-error@^7.1.1
   ```

2. **Replace `getUserMessage()` on kit errors.** The method is gone from `AggregateNotFoundError`, `DuplicateAggregateError`, `ConcurrencyConflictError`, and every other kit error. For logs, read `error.message` (or `error.toLogObject()`). For a client-safe, localized message, project at the boundary through the presentation subpath:

   ```ts
   // before (1.x)
   return err(e.getUserMessage() ?? e.message);

   // after (2.0): technical fallback
   return err(e.message);

   // after (2.0): client-safe / localized
   import { PublicErrorPresenter, PublicErrorRegistry } from "@shirudo/base-error/presentation";
   const presenter = new PublicErrorPresenter(registry); // registry maps error name/code → public message
   return err(presenter.present(e).message);
   ```

3. **Update Problem Details type imports.** `ProblemDetails` and `ProblemDetailsOptions` are no longer exported from the `@shirudo/base-error` root. `ProblemDetails` now comes from `@shirudo/base-error/problem-details`; `ProblemDetailsOptions` was removed (the adapter takes a `ProblemDetailsContext` instead).

   ```ts
   // before (1.x)
   import type { ProblemDetails } from "@shirudo/base-error";
   // after (2.0)
   import type { ProblemDetails } from "@shirudo/base-error/problem-details";
   ```

4. **`toProblemDetails(...)` call sites need no change.** The defaults, `member` / `extensions` options, and the emitted body shape are identical. The only type-level change: `extensions` is now JSON-safe (`ProblemDetailsExtensions`); pass `traceId` and similar through `extensions` as before.

5. **Replace removed base-error serializers** if you called them directly on errors: `toPublicJSON()` / `toProblemDetails()` / `toErrorResponse()` are gone. Use `@shirudo/base-error/presentation` (`PublicErrorPresenter`) for client output and `@shirudo/base-error/problem-details` (`defineProblemDetailsAdapter`) for RFC 9457 mapping.

6. **Pass error constructor arguments as an options object.** Wherever your repository (or tests) construct the kit's errors, replace positional arguments with named fields:

   ```ts
   // before (1.x)
   throw new AggregateNotFoundError("Order", id);
   throw new ConcurrencyConflictError("Order", id, expected, actual);
   // after (2.0)
   throw new AggregateNotFoundError({ aggregateType: "Order", id });
   throw new ConcurrencyConflictError({
     aggregateType: "Order", aggregateId: id, expectedVersion: expected, actualVersion: actual,
   });
   ```

7. **Replace `createDomainEventWithMetadata` with `createDomainEvent`.** Move the metadata into the options object:

   ```ts
   // before (1.x)
   createDomainEventWithMetadata("OrderConfirmed", payload, { correlationId });
   // after (2.0)
   createDomainEvent("OrderConfirmed", payload, { metadata: { correlationId } });
   ```

If your code only throws/catches the kit's errors by class, reads `error.message` / `error.name`, or uses the retry helpers (`someChainRetryable`, `isRetryable`), no source change is required beyond step 1.

## [1.3.0] - 2026-06-13

A unit-of-work robustness release: closes the backlog from a full review of the 1.2.0 unit of work. Everything is additive, no breaking API changes. Four new error/seam surfaces harden the write path: cooperative cancellation (`AbortSignal` on `UnitOfWork.run` / `withCommit`), a non-retryable `EventHarvestError` so harvest-guard violations stay out of retry loops, an `UnenrolledChangesError` safety net for events recorded on a loaded aggregate but never enrolled, and `RetryingTransactionScope`, a reference retry wrapper (error classification, exponential backoff with jitter, abort-bounded) so consumers stop hand-rolling the OCC retry loop. The repository contract test suite is now documented as mandatory for proving an adapter holds the OCC and enrollment contract. Test suite grew from 667 to 699.

### Added: `RetryingTransactionScope`, a reference retry wrapper for OCC and serialization conflicts

The unit of work has always told you to retry conflicts in a fresh `run()` and to "pair it with a retrying `TransactionScope`", but shipped none, so every consumer hand-rolled the retry loop (the part teams reliably get wrong: classifying which errors are retryable, capping attempts, backing off with jitter). `RetryingTransactionScope` is that wrapper. Compose it as the unit of work's scope (`new UnitOfWork({ scope: new RetryingTransactionScope(inner, policy), ... })`); each attempt opens a fresh transaction and the unit of work resets its per-attempt state, so reload-and-retry is sound. It retries only errors the `isRetryable` predicate accepts (default `someChainRetryable`, so `ConcurrencyConflictError` matches even when wrapped; deterministic kit errors like `EventHarvestError` / `UnenrolledChangesError` / `DomainError` / `DuplicateAggregateError` are surfaced immediately, never looped), uses exponential backoff with a +/-20% jitter band capped at `maxDelayMs`, rethrows the last error unchanged after `maxAttempts` (so callers can still map `ConcurrencyConflictError` to 409), and aborts its backoff waits on the existing `AbortSignal` (`AbortSignal.timeout(ms)` bounds the waits, though not an in-flight attempt unless the driver honors the signal). An invalid policy (`maxAttempts < 1` or non-integer, negative/non-finite delays) throws at construction rather than failing at run time. Defaults: 3 attempts, 50ms base, 1000ms cap. **Retry replays the whole transactional region including `outbox.add`, so it is only safe with a transactional outbox** (the in-memory reference outbox is not transactional and would accumulate events from rolled-back attempts). Additive; nothing changes if you do not wrap your scope.

### Added: `UnenrolledChangesError`, an end-of-run guard against silently dropped events

The unit of work's exactly-once harvest depends on every repository calling `enrollSaved`; a `save()` that forgets it (or a use case that records events on a loaded aggregate and never saves it) previously dropped those events with no error. `UnitOfWork.run` now adds a runtime safety net: when the identity map holds a loaded aggregate that recorded MORE pending events than it carried at load time but was never enrolled (and not deleted), `run()` throws the new `UnenrolledChangesError` (extends `BaseError`, not `InfrastructureError`, so it crashes loud rather than being absorbed by a retry handler) and rolls back. The detection is precise: it compares pending-event count at identity-map registration against commit time, so a read-only load and a "dirty" reconstitution that already carried events do not false-positive. Scope limit (documented): it only sees aggregates loaded via `getById`; a freshly created aggregate that is never enrolled is invisible to the kit, so the repository contract test suite remains the full mitigation.

### Changed: harvest-guard violations throw the new `EventHarvestError` instead of landing in `CommitError`

`withCommit`'s harvest guards (an event missing `aggregateId` / `aggregateType`, or a pre-set `aggregateVersion` ahead of the commit version) are deterministic programming bugs: they fail identically on every retry. They previously surfaced as a plain `Error` from `withCommit` and, through `UnitOfWork.run`, were wrapped in `CommitError` (an `InfrastructureError`), so a retry-on-`InfrastructureError` handler or a retrying `TransactionScope` would loop on them forever. They now throw the new `EventHarvestError`, which extends `BaseError` directly (NOT `InfrastructureError`, same posture as `MissingHandlerError`), so it stays out of retry paths by construction and crashes loud. `UnitOfWork.run` surfaces it even when a wrapping `TransactionScope` nests it (it walks the cause chain, the same treatment the `RollbackError` path uses). `CommitError` now means only the potentially transient post-completion failures (outbox write, the commit itself); decide whether to retry one by inspecting its cause (e.g. `someChainRetryable`), since it composes with the `retryable` marker convention rather than being retryable by class. Behavioral change for code that caught `CommitError`/`InfrastructureError` to handle a harvest-guard violation; catching a programming-bug guard was never the intended path (it should crash), but the thrown type is now `EventHarvestError`.

### Added: cooperative `AbortSignal` for `UnitOfWork.run` and `withCommit`

`UnitOfWork.run(work, { signal })` and `withCommit({ ..., signal })` now accept an optional `AbortSignal` (use `AbortSignal.timeout(ms)` for a deadline). If the signal is already aborted, the call rejects with the signal's `reason` before opening a transaction. Otherwise the signal is forwarded to `TransactionScope.transactional(fn, { signal })` (new `TransactionalOptions`, an additive optional second argument that existing one-argument scopes still satisfy) and exposed on the unit-of-work context as `context.signal`, so a long callback can poll `aborted` between steps and throw `signal.reason` to roll back. The kit does not race the work promise: actual cancellation of an in-flight query happens only when the scope's driver honors the signal, so this is cooperative by design, not a kill switch. Fully additive; no behavior change when no signal is passed.

## [1.2.0] - 2026-06-12

The unit-of-work release. One coherent feature line, built and adversarially reviewed in stages: aggregate-level **dirty tracking** (`changedKeys` / `hasChanges`) makes partial writes for multi-table aggregates affordable; the opt-in **`UnitOfWork` facade** over `withCommit` adds tx-bound repositories, repository-side enrollment, and a per-operation **`IdentityMap`**; the **repository contract test suite** (new `@shirudo/ddd-kit/testing` entry point) turns OCC from a documented pattern into a testable contract; harvested events carry **`aggregateVersion`**; and **`DuplicateAggregateError`** completes the 409 story alongside the OCC conflict. Everything is additive: no breaking API changes; `withCommit` with hand-rolled repositories remains fully supported. Two behavioral notes for existing consumers: the outbox/bus now receive frozen stamped *copies* of harvested events (reference identity with `pendingEvents` no longer holds; `eventId` is the stable handle), and `markRestored` overriders must call `super` first (see the entry below). Test suite grew from 569 to 667.

### Added: dirty tracking on `AggregateRoot` for unit-of-work partial writes: `changedKeys` / `hasChanges`

Repositories for aggregates whose state spans multiple tables (root row + N child-collection tables) previously had to write everything on every save or orchestrate per-collection writes manually, the pattern that breeds forgotten OCC version bumps and manual "touch" methods. `AggregateRoot` now exposes `changedKeys: ReadonlySet<keyof TState & string>` (the top-level state keys whose value or presence changed since `markRestored` / `markPersisted`; never-persisted aggregates report all keys) and `hasChanges` (true when never persisted, `version !== persistedVersion`, there are unflushed `pendingEvents`, any key is dirty, or (for keyless states the per-key diff cannot see, like a primitive `TState`) the state reference changed; `hasChanges === false` is therefore a safe skip-save signal that cannot desync the OCC baseline or drop a decoupled deletion event). The diff is a shallow per-key reference comparison against the state captured at the lifecycle markers: exact under the kit's immutable-`setState` convention, O(top-level keys), no proxies, no deep diff, computed fresh per access. Scoped to `AggregateRoot` only: `EventSourcedAggregate`'s `pendingEvents` are its change record, and `IAggregateRoot` is unchanged. The per-key diff is exact only for plain-record `TState` mutated via `setState` / `commit`; in-place nested mutation bypasses the diff exactly as it bypasses `freezeShallow`. New guide section: repository.md → "Partial writes for multi-table aggregates"; `BaseAggregate.markRestored` docs now carry the same call-`super`-first override warning as `markPersisted`.

**Behavioral note for `markRestored` overriders:** the marker now also captures the dirty-tracking baseline on `AggregateRoot`. A pre-existing subclass override that re-implements version sync without calling `super.markRestored(version)` was functionally equivalent before; after this release it leaves the baseline uncaptured, so `changedKeys` reports all keys and `hasChanges` never returns `false` for that aggregate (the safe degradation direction: full writes, never skipped ones). Call `super` first.

### Added: explicit-save `UnitOfWork` facade over `withCommit`

New `UnitOfWork<Evt, TCtx, TRepos>` (src/app/unit-of-work.ts): one `run()` call is one application-level write operation; all repository writes share one transaction and either persist completely or not at all. Built on top of `withCommit`: outbox-in-transaction, post-commit `markPersisted`, and best-effort publish are inherited, not reimplemented. The facade adds: tx-bound repositories via a factory-map registry (every factory called once per run with the same transaction handle); **repository-side aggregate enrollment** (`UnitOfWorkSession.enrollSaved` / `enrollDeleted`) replacing `withCommit`'s returned-aggregates-array footgun (forgetting to enroll moves from per-call-site to per-repository-implementation, where one test pins it); and a lifecycle error taxonomy: `CommitError` (callback completed, then harvest/outbox/commit rejected), `RollbackError` (callback failed and the scope rejected with an unrelated error; primary error preserved as `cause`, scope error in `rollbackCause`; wrapper-scopes detected via the cause chain and passed through), `NestedUnitOfWorkError` (nesting, or sharing one instance across concurrent operations: one instance owns one operation at a time, sequential reuse is fine), `TransactionClosedError` (context/session use after close), `AggregateDeletedError` (save after delete of the same instance in one unit of work; deleted aggregates still get their recorded deletion events harvested). Callback errors pass through unchanged: a `ConcurrencyConflictError` stays catchable as-is. Deliberately not in v1: auto-flush (explicit `save()` only), savepoints, transaction joining. New guide: docs/guide/unit-of-work.md.

The raw transaction handle on the callback context is named **`rawTransaction`**, deliberately ugly, because it is the escape hatch: writes on it bypass enrollment (events not harvested without manual `session.enrollSaved`) and the identity map. The guide gained the hard contract rules: the UoW is the only write boundary; repositories do not commit; **OCC is a repository contract, not a kit guarantee** (the kit ships boundary, baseline, error, and pattern; the consumer's repository must implement the version predicate); `version` is a **mutation sequence, not a commit revision** (three mutations = +3; the OCC predicate always uses the load-time `persistedVersion`); no external side effects inside the transaction (outbox-first, with the Stripe anti-example); aggregates must not be reused after a rollback; OCC applies to contended deletes; plus an isolation-level section in the concurrency guide.

Hardening from the adversarial review of this feature: the session is **sealed the moment the work callback resolves**, so a late enrollment from an un-awaited `repo.save()` promise throws `TransactionClosedError` instead of being silently accepted-but-never-harvested; a **retrying `TransactionScope`** (serialization-retry wrappers) gets a fresh session, identity map, and error-flag state per attempt, so enrollments from a rolled-back attempt never reach the outbox; `withCommit` gained an optional **`deleted` marker array** in its callback-return shape: deleted aggregates' events are harvested, but `markPersisted` is skipped for them (pending events cleared directly), so the post-save `onPersisted` hook never fires for a row that was just deleted (no cache-resurrection); the `RollbackError`/pass-through detection is hardened against a thrown `undefined` (no longer matches every cause-less scope error) and against throwing `cause` getters on hostile driver errors; `CommitError`'s documentation no longer claims "safe to retry" unconditionally: `withCommit`'s harvest guard (a deterministic programming bug) lands in the same wrapper, so inspect the `cause` before retrying.

### Added: per-unit-of-work `IdentityMap` on the session

New `IdentityMap` (src/repo/identity-map.ts), exposed as `session.identityMap` inside `UnitOfWork.run()`: the shipped implementation of the Fowler Identity Map contract the repository guide previously left to implementer discipline. Two-level storage keyed on the aggregate CLASS (no name strings, no cross-type id collisions), typed `get<TAgg>` without casts. `set` is strict: re-registering the same instance is a no-op; a *different* instance for an occupied type+id throws (the hydrated-twice violation that breaks `withCommit`'s exactly-once dedupe); a type+id deleted in the same unit of work throws `AggregateDeletedError` via deletion tombstones, so a second instance of a deleted aggregate cannot re-enter the operation even through a deferred-write repository. The map is created fresh per `run()` and cleared on close; `session.identityMap` throws `TransactionClosedError` afterwards. `AggregateDeletedError` moved from `src/app/unit-of-work.ts` to `src/core/errors.ts` (same barrel export; both the session gate and the map throw it).

Hardening from the adversarial review: `AggregateClass<TAgg>` accepts classes with **protected constructors** via a prototype-witness branch: the kit's own aggregate convention (protected constructor + static factories) would otherwise fail to compile as a map key on every `get`/`set`/`delete` call; new **`isDeleted(Type, id)`** probe distinguishes deleted-in-this-UoW from never-loaded, so the documented read path returns `null` uniformly for deleted aggregates instead of crashing at registration when the physical delete is deferred; **`enrollDeleted` now does all deletion bookkeeping in one call**: it removes and tombstones the identity-map entry automatically (keyed on the instance's concrete class), and `enrollSaved` consults the tombstone, so deletion-finality holds across instances (a re-created aggregate with the same class+id throws) without a forgettable second `identityMap.delete()` call.

### Added: repository contract test suite, `@shirudo/ddd-kit/testing`

New opt-in entry point shipping `createRepositoryContractTests(harness)`: the kit is ORM-agnostic, so the OCC version predicate lives in the consumer repository's SQL, which makes optimistic concurrency a **repository contract the adapter must prove**, not a kit guarantee. The suite is that proof. Framework-agnostic (assertions throw plain `Error`s; bind with `it(test.name, test.run)` under vitest/jest/node:test), one isolated environment per test via a consumer-supplied harness. **Error matching is by name along the `cause` chain, never `instanceof`**: the suite ships in its own bundle entry, and cross-entry (or cross-install) class identity would otherwise fail every compliant adapter spuriously. Covers: the **mandatory two-writer conflict** (stale writer must reject with `ConcurrencyConflictError`; final version (and, with the `snapshotState` capability, deep-equal state) equals the winner's; the outbox contains *exactly* the winner's events, compared by eventId), insert routing on `persistedVersion === undefined` after pre-save mutations, version arithmetic + predicate baseline, rollback leaving state/version/outbox untouched, identity-map sameness, deletion finality (same instance and, capability-gated, re-created instances), the **stale-delete conflict** (capability-gated: a predicated `DELETE … WHERE version = ?` must reject instead of destroying the concurrent writer's update), event lifecycle (cleared on commit, kept on rollback), and `persistedVersion` syncing only after commit. Tests for absent capabilities come back **marked `skipped`** with a loudly-failing `run()`: bound via `(test.skipped ? it.skip : it)(test.name, test.run)` they stay visible in every report, and a naive binding fails instead of green-no-op'ing; capabilities are captured at suite creation. Outbox eventIds are compared as a sorted multiset (no ordering requirement on `committedOutboxEvents`); `snapshotState` projections must be roundtrip-stable (documented, and the failure message names the projection as a suspect); `env.run` must provide unit-of-work semantics (identity map + deletion gates): `withCommit`-only setups without equivalents are outside the suite's scope. A teardown failure never masks the in-flight contract diagnostic; adapter load failures surface as contract violations, not bare TypeErrors. The suite's JSDoc classifies which tests prove adapter SQL vs read-path/UoW wiring and documents the sequential-deterministic limitation (lock interaction and raw serialization-failure mapping need adapter-specific tests). SQL/ORM adapters must run the suite against a real database (testcontainers); the in-memory reference adapter in `src/testing/repository-contract.test.ts` (repo-only, not shipped to npm; identity-map read path with `isDeleted`, enroll-before-write, real predicates on update AND delete) is the copyable example, and two mutant tests pin that the suite exposes a repository missing the update predicate or the delete predicate.

Companion API: **`IUnitOfWorkRepository<TAgg, TId, Evt>`** (main entry, defined alongside `IRepository` in `src/repo/repository.ts`) is the canonical unit-of-work-facing repository shape (`getById`/`getByIdOrFail`/`save(aggregate)`/`delete(aggregate)`, branded ids end-to-end); the suite's `ContractRepository` is its minimal structural subset. Repository contract refinements: `save()` enrolls **before** the row write, so the deleted-gate throws `AggregateDeletedError` before any SQL instead of surfacing as a confusing conflict against the deleted row. The corollary is now documented as a hard rule (guide rule 10 + `ConcurrencyConflictError` JSDoc): **a repository write rejection aborts the unit of work**; catching it and continuing in the same `run()` would commit the failed aggregate's events, so an OCC retry always means a fresh `run()`.

### Added: `aggregateVersion` on harvested events, distinct from the event schema version

`DomainEvent` gains an optional **`aggregateVersion`** field: the producing aggregate's version at COMMIT time, identical to the OCC version the row write carries. **Deliberately distinct from `event.version`**, which is (and remains) the payload's *schema* version for upcasting. The two must never be conflated. `withCommit` stamps it automatically at the harvest boundary onto a frozen copy of each event (events are deeply frozen at creation; the aggregate's own `pendingEvents` stay untouched; a value pre-set via `CreateDomainEventOptions.aggregateVersion` is never overwritten), so the outbox and the in-process bus receive stamped events with zero changes to the `Outbox` port or to aggregate code. All events of one aggregate in one commit share the version (their relative order within the commit is the harvest order); event-store stream positions for event-sourced aggregates remain the event store's concern. Consumers use it for ordering, per-commit idempotency watermarks, debugging, and projections; the outbox guide now recommends persisting `eventId`/`aggregateId`/`aggregateType`/`aggregateVersion` as indexed columns, **with the safety rules spelled out**: dedup keys on `eventId`, never on `(aggregateId, aggregateVersion)` alone (all events of one commit share the version; a version-keyed dedup would silently drop every event after the first), and watermarks advance only after ALL events of a version are processed. The stamp is a **`withCommit`-harvest-boundary guarantee**: event-store appends from `pendingEvents` (the ES save path), hand-published bus events, and manual `outbox.add` calls do not carry it, documented in the outbox and event-sourcing guides (stream-rebuilt projections see `undefined`; the store's position is the ES ordering authority), and hand-rolled orchestrations must stamp it themselves. Hardening: a pre-set `aggregateVersion` AHEAD of the aggregate's commit version now throws at the harvest (a leaked replay fixture would otherwise advance consumer watermarks past real history); events are documented as plain-data objects (the harvest's stamping spread does not carry class prototypes). The repository contract suite's mandatory test asserts the winner's committed outbox events carry exactly the winner's commit version (and its failure message names the outbox read-back mapping as the first suspect).

### Added: `DuplicateAggregateError`, the insert-path counterpart to the OCC conflict

New `InfrastructureError` subclass for the unique-violation race: a repository's INSERT path hits an existing row because two creators raced on a business-derived id or the id generator collided. Same delegation model as `ConcurrencyConflictError`: the kit ships the class, the consumer repository maps its driver's unique-violation signal to it (Postgres SQLSTATE `23505`, MySQL errno `1062`, SQLite `SQLITE_CONSTRAINT_UNIQUE`) instead of letting a raw driver error escape uncatchable-by-class. NOT retryable (re-running the same INSERT cannot succeed); map to HTTP 409 or, for idempotency-key flows, load the existing aggregate and treat the request as already applied. The repository guide's save() skeleton shows the mapping; the contract test suite gains a capability-gated duplicate-insert test (requires `createAggregateWithId`; the existing row must be untouched by the rejected insert: version AND, with `snapshotState`, deep-equal state, with the duplicate built at a different version so clobbering is visible) plus a mutant test pinning that an unguarded upserting insert fails it; the in-memory reference adapter implements the check. The suite's stance is explicit: `save()` is insert-or-update, never upsert; create-idempotency belongs in the use case; a deliberately upserting adapter opts out of the duplicate test ALONE via `insertsAreDuplicateChecked: false` (default `true`), without losing the deletion-finality coverage that `createAggregateWithId` also gates. The central error guide (result-vs-throw.md) maps it to HTTP 409 alongside `ConcurrencyConflictError`, with opposite retry semantics.

### Changed: kit error classes pin their runtime `name`

All concrete error classes (`ConcurrencyConflictError`, `AggregateNotFoundError`, `AggregateDeletedError`, `MissingHandlerError`, `NestedUnitOfWorkError`, `TransactionClosedError`, `CommitError`, `RollbackError`) now pass an explicit `options.name` to `BaseError` instead of relying on `constructor.name`. Two consequences: the names survive class-name minification in consumer builds, and **subclasses inherit the pinned name** (`class PgConflictError extends ConcurrencyConflictError` still reports `name === "ConcurrencyConflictError"`), which is what the contract suite's name-based error matching keys on, with a prototype-chain fallback for errors from older kit copies.

### Changed: the "no Fowler UoW" stance in the design-decisions guide is consciously revised

`docs/guide/design-decisions.md` no longer claims the kit categorically ships no Fowler-style Unit of Work. The revised section ("TransactionScope stays minimal; the Unit of Work lives above it") explains where the pieces actually landed: change detection on the aggregate (`changedKeys` / `hasChanges`, deliberately not ORM-style), commit orchestration in `withCommit`, and the opt-in `UnitOfWork` facade (tx-bound repository registry, per-operation identity map, repository-side aggregate enrollment) shipped in this release (see the Added entries above). `TransactionScope` remains the minimal port; `withCommit` with hand-rolled repositories remains fully supported. The same revision is reflected in `docs/guide/outbox.md` and the `TransactionScope` JSDoc.

## [1.1.0] - 2026-06-10

Bug-fix and hardening release from a full-library audit (23 fixes: 5 P1 + 8 P2 + 10 P3) plus an adversarial code review of the fix branch itself (7 more). Two additive API surfaces make this a minor: the optional `withCommit` dep **`onPublishError(error, events)`**, and the snapshot mapping hooks **`toSnapshotState`/`fromSnapshotState`** with the trailing `TSnapshotState` generic on `BaseAggregate`/`AggregateRoot`/`EventSourcedAggregate`. Behavioral contract changes to know about: `withCommit` never rejects after the commit; `CommandBus`/`QueryBus` throw on duplicate registration; `vo()`/`ValueObject` reject function-valued props with a `TypeError`; `createSnapshot` fails fast on non-plain-data state. Test suite grew from 470 to 569.

### Fixed: remaining audit P3s: empty-history sentinel, metadata prototype pollution, NaN consistency, `voWithValidation` error path

Four more low-severity fixes. (1) `loadFromHistory([])` no longer calls `markRestored`: it replaced the never-persisted sentinel with `persistedVersion = 0`, flipping repository routing from INSERT to UPDATE against a nonexistent row. (2) `mergeMetadata` copies keys via `defineProperty` instead of `Object.assign`, whose `[[Set]]` semantics invoked the `__proto__` setter for parsed-JSON metadata (outbox rows, message envelopes) and installed an attacker-controlled prototype. (3) `deepEqual`'s documented NaN semantics now hold everywhere numbers are compared: NaN elements in TypedArrays, two invalid Dates, and two NaN `Number` wrappers compare equal (SameValueZero, where `+0 === -0` is preserved, unlike `Object.is`). (4) `voWithValidation`'s default failure message used `JSON.stringify`, which throws for cyclic or BigInt-bearing input, so the error path of a Result-returning function never throws now (best-effort rendering with fallback). Documented: non-data values (functions, Promise/WeakMap/WeakSet) still throw a `TypeError` from `vo()`: they cannot occur in parsed JSON and signal programming errors, not validation failures.

### Changed: shared mutator throwers; documented deny-list limitation; one source of truth for reference-compared built-ins

`deepFreeze`'s Date/Map/Set mutator shadows are now shared module-level functions instead of per-instance closures; `createDomainEvent` freezes a Date per event, so the previous 16 closure allocations per event were pure churn on the hot path. The mutator blocking is documented as deny-by-enumeration (a future runtime mutator like the stage-3 `Map.prototype.getOrInsert` is not blocked until the list is updated; it is a guard rail, not a security boundary). The clone-vs-alias rule between `deepEqual` and `deepOmit` now lives in one exported set (`REFERENCE_COMPARED_TAGS` in `is-built-in.ts`), so the two modules cannot drift; `Entity`'s class-instance state ownership-transfer contract is documented on the public constructor and `setState`.

### Fixed: bus/outbox edge cases: thrown-object diagnostics, duplicate registration, negative `getPending` limit, `markPersisted` isolation

Four low-severity fixes from the bug audit. (1) Handlers throwing non-Error values (driver SDKs commonly throw `{ code: … }` objects) no longer collapse to `err("[object Object]")`; `CommandBus`/`QueryBus` JSON-serialise the thrown value into the error string, and `EventBusImpl` attaches it as the wrapping Error's `cause`. (2) `CommandBus.register`/`QueryBus.register` now throw on duplicate registration instead of silently replacing the previous handler (which became dead code with no signal); wiring bugs surface at startup. (3) `InMemoryOutbox.getPending` clamps negative limits to zero: `slice`'s end-relative indexing previously turned a dispatcher's `batchSize - inFlight` going negative into "dispatch almost the whole backlog". (4) `withCommit`'s post-commit `markPersisted` loop isolates per-aggregate failures: a throwing user `onPersisted` hook no longer leaves the remaining aggregates un-marked (double-emitting their events on the next commit) nor rejects the committed write; the hook is documented as observer-only.

### Fixed: `vo()` no longer silently drops symbol-keyed properties

`vo()` cloned via `structuredClone`, which silently drops symbol-keyed properties, yet `voEquals`/`deepEqual` DO consider symbol keys, so a symbol-keyed value vanished from the VO while still being claimed by the equality contract. (The existing test passed vacuously: `Object.isFrozen(undefined) === true`.) `vo()` now walks plain objects, arrays, and **Map values** itself, preserving symbol keys, shared-reference identity, and cycles through Map values, with `__proto__`-as-data safety. Map keys and Set members must be primitive because their identity-based lookup semantics cannot survive defensive cloning while retaining Value Object equality. Only atomic built-ins (Date, RegExp, TypedArrays, ArrayBuffer, wrappers, Error) delegate to `structuredClone`, brand-verified against `Symbol.toStringTag` spoofing. Function values throw the documented data-not-behaviour `TypeError` everywhere (including inside Map values, previously a raw `DataCloneError`); Promise/WeakMap/WeakSet throw a descriptive `TypeError` ("Value Objects are plain data") instead of `DataCloneError`. Custom class instances and subclasses of built-ins are rejected instead of being cloned into incomplete objects that have lost private fields, non-enumerable state, or internal slots.

### Fixed: `deepOmit` no longer reuses path-sensitive predicate results across shared references

The visited cache served two purposes at once, cycle detection and structure sharing, so an object reached via two paths got the clone computed under the *first* path, even when `ignoreKeyPredicate` decides per path: `deepOmit({ a: s, b: s }, { ignoreKeyPredicate: (k, p) => k === "x" && p[0] === "a" })` wrongly dropped `b.x` too. With a predicate, the cache now only tracks in-progress ancestors (pure cycle detection) and every path gets its own clone; cycles still terminate and are preserved. Without a predicate, results are path-independent and shared references keep deduplicating to a single clone, exactly as before. Transitively fixes `deepEqualExcept`/`voEqualsExcept` with path-sensitive predicates over DAG-shaped inputs. Per-path cloning is inherently exponential on diamond-shaped sharing (a node reachable via 2^n paths is cloned 2^n times), so the path-sensitive walk aborts with a descriptive error after one million node visits instead of hanging the process.

### Fixed: `deepEqual` / `deepOmit` no longer crash (or mis-compare) on `Symbol.toStringTag` spoofing

Type detection was purely tag-based, then type-specific code ran unverified: `deepEqual({ [Symbol.toStringTag]: "Date" }, …)` crashed with `objA.getTime is not a function`, spoofed `"Map"` with `mapA is not iterable` (same class of crash in `deepOmit`'s `cloneBuiltIn`), and two plain objects spoofing `"Array"` compared equal regardless of content (both sides got `length === undefined`, so the element loop never ran). Tags are now brand-verified through internal-slot probes (`Date.prototype.getTime`, the `Map`/`Set` `size` getters, `ArrayBuffer.isView`, wrapper `valueOf`s, …): the one check `Symbol.toStringTag` cannot spoof, still cross-realm safe. Spoofed objects are compared/cloned as the plain objects they are; a genuine built-in never equals a spoofed lookalike; arrays are detected via `Array.isArray` in both modules. Real built-ins behave exactly as before.

### Fixed: snapshots of states with class-based child entities no longer silently corrupt; new `toSnapshotState` / `fromSnapshotState` hooks

`createSnapshot` and both restore paths ran `structuredClone` over the state. For the documented class-children pattern (`OrderState` containing `OrderItem extends Entity`) the clone silently stripped prototypes: snapshot and restore *appeared* to succeed, and the aggregate crashed on the first child-entity method call, arbitrarily far from the cause. Function-valued state members crashed `createSnapshot` outright with a cryptic `DataCloneError`. A prototype-preserving clone was rejected as a fix: a snapshot is a persistence artifact, and prototypes cannot survive the snapshot-store round-trip anyway: the snapshot state *must* be plain data.

Two changes: (1) the default `toSnapshotState` now walks the state graph and **fails fast with the offending path** ("state.items[0] is a class instance (OrderItem); override toSnapshotState()/fromSnapshotState()…") for class instances, functions, Promise/WeakMap/WeakSet, Errors (structuredClone downgrades subclasses to plain `Error` and silently drops custom fields) and enumerable symbol-keyed properties (silently dropped by structuredClone); (2) new overridable hooks `toSnapshotState(state)` / `fromSnapshotState(stored)` plus a trailing `TSnapshotState` generic (default `TState`) on `BaseAggregate`/`AggregateRoot`/`EventSourcedAggregate` let aggregates map class children to a plain DTO shape and reconstruct them on restore, honest across the persistence boundary. The guard's built-in detection is brand-verified (a `Symbol.toStringTag` spoofer cannot smuggle functions past it) and its plain-object walk mirrors `structuredClone` exactly: own enumerable string-keyed values only. Plain-data states are unaffected. Additive API: confirms the next release is a minor (1.1.0).

### Fixed: `loadFromHistory` rolls back on mid-stream failure (all-or-nothing)

When a replayed event threw mid-stream, `loadFromHistory` returned `err` but left the aggregate partially mutated: `_state` already reflected the events before the failure while `version` was never advanced; state and version were mutually inconsistent, and reusing or re-loading the aggregate produced wrong results. Its sibling `restoreFromSnapshotWithEvents` always promised (and implemented) all-or-nothing rollback. `loadFromHistory` now snapshots the pre-call state and restores it in the catch path, both for `DomainError`s (returned as `err`) and for propagating non-domain throws alike. Partial replay is never observable.

### Fixed: `EventSourcedAggregate` handler lookup no longer walks the prototype chain

The `handlers` map is an object literal, so `this.handlers[event.type]` resolved through `Object.prototype` for corrupt or adversarial stream rows: an event with `type: "toString"` invoked `Object.prototype.toString` as the handler and silently replaced the aggregate state with the string `"[object Undefined]"`; `"constructor"` silently no-opped; `"__proto__"` / `"hasOwnProperty"` crashed with a raw `TypeError` instead of the documented `MissingHandlerError`. The lookup is now guarded with `Object.hasOwn`, so every unregistered type, including `Object.prototype` member names, consistently throws `MissingHandlerError` and leaves state and version untouched, in `apply` and in the replay paths (`loadFromHistory`, `restoreFromSnapshotWithEvents`).

### Fixed: `ValueObject` and `Entity` no longer freeze caller-owned objects in place

The class-based `ValueObject` constructor ran `deepFreeze({ ...props })`: the spread only copies the top level, so every nested object of the caller's input was frozen **by reference**: the caller's own graph silently became immutable (later writes throw in strict mode). The constructor now deep-clones `props` with the same clone as `vo()` (with Map/Set entries walked, so caller-owned objects inside collections are never frozen or mutator-shadowed in place, verified down to a Date inside a Map), then freezes the clone; later mutation of the input no longer bleeds into the VO. Aligned with `vo()`, the constructor now also rejects function-valued props and custom class instances with a descriptive `TypeError`. Similarly, `Entity`'s constructor and `setState` froze the very state object the caller passed; they now take a shallow copy first for plain objects and arrays (class instances and primitives pass through unchanged, since spreading would strip an instance's prototype). The shallow-freeze design is unchanged: nested state objects stay shared, there is still no deep clone on reads.

### Fixed: `deepFreeze` now actually delivers deep immutability for Date, Map and Set

`Object.freeze` does not protect internal slots: `event.occurredAt.setTime(0)` succeeded on a frozen event and `vo({ m: new Map() }).m.set(…)` succeeded on a frozen VO: a mutating subscriber could poison the timestamp (or any Map/Set payload) for every subsequent handler, exactly the scenario the deep-freeze guarantee claims to prevent. `deepFreeze` now shadows the mutator methods of Date (`setTime`, `set*`), Map (`set`/`delete`/`clear`) and Set (`add`/`delete`/`clear`) with throwing own properties and recursively freezes Map/Set contents (entries are not own keys, so the regular key walk missed them). The shadows are non-enumerable: invisible to `Object.keys`/spread/`deepEqual`, and `structuredClone` drops them, so `vo()` round-trips are unaffected. Reads work unchanged. Non-extensible built-ins (frozen, sealed, or `preventExtensions`'d) are skipped: they cannot receive shadow properties (best effort, no crash). The Date/Map/Set dispatch is brand-verified via the same internal-slot probes as `deepEqual`/`deepOmit`, so a plain object spoofing one of these tags through `Symbol.toStringTag` is simply frozen as a plain object instead of crashing the freeze (or receiving useless shadow methods). Additionally, `createDomainEvent` now defensively copies `options.occurredAt`: the event no longer shares the caller's live Date instance. Tests that asserted identity (`event.occurredAt === when`) were updated to value equality; that identity was the bug.

### Fixed: `withCommit` no longer rejects when a post-commit `bus.publish` fails; new optional `onPublishError` hook

The `EventBus.publish` contract throws after dispatching when any subscriber failed, so a single throwing in-process subscriber made `withCommit` reject AFTER the transaction had committed and `markPersisted` had run. The caller received a use-case failure for a committed write (and lost the result, e.g. the new order's id); a typical caller retries, double-executing the write. This also contradicted `withCommit`'s own documentation, which frames publish failure as recoverable eventual consistency: the outbox already holds the events and an outbox dispatcher will deliver them.

`bus.publish` failures after the commit are now caught and never reject `withCommit`; the committed `result` is always returned. The error is reported to the new optional `deps.onPublishError(error, events)` hook (wire it to your logger/metrics); the hook is observer-only, so its own failures are swallowed too. Pre-commit failures (use-case errors, the recordEvent guard, `outbox.add`) reject exactly as before and roll the transaction back. Note: `onPublishError` is additive public API, so the next release should be a minor (1.1.0), not a patch.

### Fixed: `deepEqualExcept(x, x)` no longer returns `false` for objects containing an Error or ArrayBuffer

`deepEqual` compares its unhandled built-ins (Error, ArrayBuffer, SharedArrayBuffer) by reference, intentionally, but `deepOmit` cloned them via `structuredClone`, producing two distinct instances. `deepEqualExcept` (deepOmit both sides, then deepEqual) therefore reported even the *same object compared with itself* as unequal: reflexivity was broken, and `voEqualsExcept` inherited the bug. `cloneBuiltIn` now passes every type that `deepEqual` compares by reference (Error, ArrayBuffer, SharedArrayBuffer, plus the already-aliased Promise/WeakMap/WeakSet) through by reference; types `deepEqual` compares by value (Date, RegExp, Map, Set, TypedArrays, DataView, wrappers) are still cloned.

### Fixed: `deepOmit` (and `deepEqualExcept` / `voEqualsExcept`) no longer crash on Promise, WeakMap, WeakSet

`isBuiltInObject` classifies `Promise`/`WeakMap`/`WeakSet` as atomic built-ins, but `cloneBuiltIn` fell through to `structuredClone` for them, which rejects all three with `DataCloneError` (`#<Promise> could not be cloned`). Any `deepOmit` call over a graph containing one of these crashed, and `deepEqualExcept`/`voEqualsExcept` inherited the crash. These types have no meaningful by-value copy, so `cloneBuiltIn` now passes them through by reference, which also keeps `deepEqualExcept` reflexive for them, since `deepEqual` compares unhandled built-ins by reference.

### Fixed: `vo()` / `ValueObject` no longer crash on props containing a non-empty TypedArray

`deepFreeze` called `Object.freeze` on every nested object, but the spec forbids freezing an ArrayBuffer view with elements, so `vo({ data: new Uint8Array([1, 2, 3]) })` (and any class-based `ValueObject` with a TypedArray prop) threw `TypeError: Cannot freeze array buffer views with elements`, even though `deepEqual`/`deepOmit` explicitly support TypedArrays. `deepFreeze` now treats ArrayBuffer views (TypedArrays, DataView) as atomic and passes them through unfrozen, mirroring `deepEqual`'s atomic treatment; the surrounding object graph is still deeply frozen. Documented limitation: view contents remain mutable, since freezing cannot protect the underlying buffer.

### Fixed: `EventBusImpl.publish` no longer lets a synchronously throwing handler bypass the error-aggregation contract

`EventHandler` permits plain synchronous handlers (`Promise<void> | void`), but `publish` invoked handlers directly inside `.map(...)`, so a synchronous throw escaped before `Promise.allSettled` received the array. Consequences: peer handlers subscribed after the thrower were skipped, remaining events in the batch were never dispatched, the raw error surfaced instead of the documented single-Error/`AggregateError`, and already-started peer promises were orphaned (their rejections became unhandled promise rejections, process-fatal in Node by default). The handler invocation is now wrapped in an async closure so a sync throw becomes a rejection and gets the same allSettled treatment as a rejecting async handler, restoring the contract documented on `EventBus.publish`: peers run, the batch completes, errors are collected and thrown at the end.

## [1.0.1] - 2026-06-01

### Fixed: `@shirudo/result` peer dependency aligned to `^1.0.0`

1.0.0 still declared `@shirudo/result` as `^0.0.6`, a pre-1.0 prerelease of the companion Result library. Bumped the peer (and dev) dependency to `^1.0.0` so a stable ddd-kit pairs with stable `@shirudo/result`, and consumers on `@shirudo/result` 1.x no longer hit a peer-range conflict. The API surface ddd-kit uses (`ok`, `err`, `Result`, `isOk`/`isErr`, `.value`/`.error`) is unchanged between `0.0.6` and `1.0.1`; the full suite (468 tests) passes unchanged. No code changes.

## [1.0.0] - 2026-06-01

First stable release. The API is now under Semantic Versioning: breaking changes will bump the major and ship with a migration path here. The kit's surface (Value Objects, Entities, Aggregate Roots, Domain Events, Repositories, CQRS handlers, the outbox/`withCommit` unit-of-work) is frozen as of this release; the two changes below land with it.

### BREAKING: `@shirudo/base-error` peer-dep bumped to `^5.0.0`; new `voValidated` + `@shirudo/ddd-kit/http` Problem Details presenter

base-error v5 ships a `ValidationError` aggregate (collects N field-level issues, ingests [Standard Schema](https://standardschema.dev) output) and safe-by-default `toProblemDetails()` (RFC 9457). The kit adopts v5 and adds thin, Result-first glue on top instead of re-implementing it.

The v5 bump is BREAKING only at the peer-dep level; ddd-kit's own errors are unaffected. v5 preserves `BaseError` `name` / `_tag` inference (only `StructuredError._tag` changed, which the kit does not use), so the class-discriminated hierarchy (`DomainError`, `InfrastructureError`, `AggregateNotFoundError`, `ConcurrencyConflictError`, `MissingHandlerError`) and the `e.name` / `toJSON().name` / `isBaseError` contracts all hold. The full test suite (461 → 468) passes unchanged across the bump.

New surface:

- **`voValidated(t, (issues, value) => …, message?)`** (`src/validation/`): the Result-axis, multi-issue counterpart to `voWithValidation`. Runs every check, collects each violation into one base-error `ValidationError`, and returns a deep-frozen `VO<T>` only when none fired. Returns `Result<VO<T>, ValidationError>`: the failure is a **value you destructure, not a throw you catch**. `ValidationError` is imported from `@shirudo/base-error` (like `Result` from `@shirudo/result`), not re-exported.
- **`toProblemDetails(error, { member?, status?, … })`**: new opt-in entry point **`@shirudo/ddd-kit/http`**. Projects a `ValidationError` to an RFC 9457 Problem Details object, attaching `publicIssues()` under `errors` (default) or `invalid-params`, defaulting to `422` / `"Validation Failed"`. base-error is safe-by-default and hides issues unless whitelisted; this helper performs that explicit projection. Shipped from a separate subpath so transport concerns stay out of the core barrel.

This establishes a deliberate **two-error-style axis**, documented in [Result vs Throw](https://github.com/shi-rudo/ddd-kit-ts/blob/main/docs/guide/result-vs-throw.md): `DomainError` is thrown and caught at the boundary; `ValidationError` is a Result-axis value you destructure. Validation does **not** fold into the `DomainError` hierarchy by design: a kit hands back the value and stays out of your boundary.

Migration:

1. **Bump the peer dep**: `pnpm add @shirudo/base-error@^5.0.0`. No code changes are required for existing ddd-kit error usage.
2. If you call base-error's `StructuredError.toProblemDetails()` directly, review v5's safe-by-default serialization (technical messages / details no longer exposed without an explicit `mapDetails` projection); see base-error's `MIGRATION.md`.

### Documentation: `llms.txt` + `llms-full.txt` auto-generated at docs build; hand-curated guide moved to `LLM.md`

The repo-root file at `/llms.txt` previously served two distinct audiences with one document: a Howard-convention sitemap (for LLM tools that discover docs via the standard endpoint) AND a hand-curated consumer-coding guide (with rc-rename trail, common-mistakes block, "use X not Y" directives). The two never aligned cleanly: the curated content didn't fit the sitemap convention, and the sitemap couldn't carry the curation.

Split into two artifacts:

- **`LLM.md`** at repo root: hand-curated consumer-coding guide (the former `llms.txt` content), audience: LLM coding tools that read directly from the GitHub repo.
- **`llms.txt` + `llms-full.txt`** generated by [`vitepress-plugin-llms`](https://github.com/okineadev/vitepress-plugin-llms) at docs build time, served at the deployed docs site root. `llms.txt` is the Howard-convention sitemap (section-grouped page index); `llms-full.txt` is the full docs concatenated for paste-into-LLM-context use.

No source / API changes.

## [1.0.0-rc.9] - 2026-05-26

One BREAKING change closing a real consumer-reported footgun in OCC routing, plus a quiet internal refactor that deduplicates the aggregate hierarchy without touching the public API.

Highlights:

- **`persistedVersion` is the correct Insert-vs-Update marker.** The pre-rc.9 convention "route on `aggregate.version === 0`" breaks the moment a fresh aggregate is mutated before its first save, which is common in setup wizards, profile editors, and any factory-followed-by-edit flow. The new `persistedVersion: Version | undefined` field tracks the DB baseline explicitly. Repositories route INSERT vs UPDATE on `persistedVersion === undefined` and use it as the OCC predicate's `WHERE version = ?` baseline (NOT `aggregate.version`, which has already advanced by `pendingEvents.length` since load).
- **`markRestored(version)` is the Post-Load lifecycle marker.** Symmetric with `markPersisted(version)` (Post-Save). Consumers' `reconstitute(...)` factories migrate from `setVersion` to `markRestored`. The pair honours Vernon §11's Factory-vs-Reconstitution distinction at the lifecycle-marker level: load fires no hook, save fires `onPersisted`.
- **Internal refactor**: lifecycle machinery (version + persistedVersion + pending events + markPersisted / markRestored / onPersisted / recordEvent / aggregateType) was duplicated across `AggregateRoot` and `EventSourcedAggregate`. Extracted to a new `BaseAggregate<TState, TId, TEvent>` abstract class between `Entity` and the two flavours. Net -257 LOC across the three files; no public API change.

Migration in one paragraph: in every consumer `Repository.save`, swap `aggregate.version === 0` → `aggregate.persistedVersion === undefined` for INSERT vs UPDATE routing, and `expected = aggregate.version` → `baseline = aggregate.persistedVersion` for the OCC predicate. In every `reconstitute(...)` factory, swap `order.setVersion(version)` → `order.markRestored(version)`. No changes needed for ES aggregates loading via `loadFromHistory` / `restoreFromSnapshotWithEvents`; those now align `persistedVersion` automatically.

441 → 461 tests (+20 covering the H1 factory-then-mutate-before-save regression, `markRestored` semantics, hook isolation between load and save, snapshot-rollback baseline preservation, multi-save cycles, `loadFromHistory` failure-path baseline preservation, and `restoreFromSnapshot` failure-path state preservation).

Per-section migration details below.

### BREAKING: `persistedVersion` replaces `version === 0` as the Insert-vs-Update marker

`Repository.save` implementations that routed INSERT vs UPDATE on `aggregate.version === 0` are broken in any flow where a fresh aggregate is mutated before the first save. A setup wizard, profile editor, or any factory-followed-by-edit advances `version` past zero in memory while the DB row still doesn't exist; the save flow tries an UPDATE that affects zero rows and throws a spurious `ConcurrencyConflictError`.

The fix exposes the DB baseline explicitly on the aggregate API:

- **`aggregate.persistedVersion: Version | undefined`** (new). The version the persistence layer currently holds. `undefined` until the aggregate has been persisted or restored at least once. Repository implementations route INSERT vs UPDATE on `persistedVersion === undefined` and use it as the OCC baseline in the UPDATE's `WHERE version = ?` predicate.
- **`aggregate.version`** keeps its current semantics: an in-memory post-mutation value, bumped by every `setState(_, true)` / `commit()` / `apply()`. It is no longer the right field for INSERT vs UPDATE routing.
- **`markRestored(version)`** (new, protected). Lifecycle marker for the Post-Load transition: syncs both `version` and `persistedVersion` to the loaded DB version, does NOT fire `onPersisted`. Consumers' `reconstitute(...)` factories migrate from `order.setVersion(version)` to `order.markRestored(version)`. Vernon §11 Factory-vs-Reconstitution distinction is now enforced at the lifecycle-marker level: load and save are mechanically separate.
- **`markPersisted(version)`** keeps Post-Save semantics: syncs both fields, clears `pendingEvents`, fires `onPersisted`.
- **Internal alignments**: `AggregateRoot.restoreFromSnapshot`, `EventSourcedAggregate.loadFromHistory`, and `EventSourcedAggregate.restoreFromSnapshotWithEvents` now call `markRestored` internally so the kit's own reconstitution paths align `persistedVersion` automatically.

Migration:

1. **In every consumer Repository's `save`**, swap the routing check:
   ```diff
   - if (aggregate.version === 0) {
   + if (aggregate.persistedVersion === undefined) {
       // INSERT
     } else {
   -   const expected = aggregate.version;
   +   const baseline = aggregate.persistedVersion;
       // UPDATE WHERE version = baseline SET version = aggregate.version
     }
   ```
2. **In every consumer `reconstitute(...)` factory**, swap `setVersion` for `markRestored`:
   ```diff
     static reconstitute(id, state, version): Order {
       const order = new Order(id, state);
   -   order.setVersion(version);
   +   order.markRestored(version);
       return order;
     }
   ```
3. No changes needed for ES aggregates that load via `loadFromHistory` / `restoreFromSnapshotWithEvents`; those now sync `persistedVersion` automatically.

Background: the prior `version === 0` convention was internally inconsistent with the kit's own factory pattern. `Order.place(...)` invokes `commit(state, event)` which bumps `version` to 1, so the documented `version === 0 → INSERT` check would already misroute the kit's own examples if those examples persisted via the documented Repository pattern. The `persistedVersion` field surfaces what was always implicit and lets Repository implementations distinguish "row exists at version N in DB" from "in-memory version is N after N mutations from a never-persisted aggregate."

## [1.0.0-rc.8] - 2026-05-26

Two coordinated BREAKING changes: aggregate-event metadata is now framework-enforced (no more silent missing `aggregateId` / `aggregateType` in the outbox), and the `@shirudo/base-error` peer-dep is bumped to `^4.7.0` to unlock `someChainRetryable` for the OCC retry-chain pattern.

Highlights:

- **Aggregate metadata by construction.** `protected abstract readonly aggregateType: string` on both aggregate flavours, `protected recordEvent(type, payload, options?)` helper that auto-injects `aggregateId`/`aggregateType`, and a runtime guard in `withCommit` that throws if any harvested event is missing either. Closes the long-standing "outbox dispatcher routes nothing because the aggregate forgot a field" footgun.
- **`someChainRetryable` is the canonical retry-chain predicate.** `@shirudo/base-error`'s `isChainRetryable` filters strictly on the `StructuredError` shape (`code` + `category` + `retryable`) and returns `false` for ddd-kit's class-based errors (`ConcurrencyConflictError` etc). 4.7.0 ships `someChainRetryable`, which composes `someCauseChain` over the loose `isRetryable` predicate and walks the whole chain. Peer-dep minimum bumped accordingly so docs can recommend it without a pre-4.7 fallback path.
- **Docs**: `result-vs-throw.md` catch example + helper-compatibility callout (loose vs strict helpers from `@shirudo/base-error`); `repository.md` OCC example updated with tip callout distinguishing `isRetryable` / `someChainRetryable` / `isChainRetryable`; `llms.txt` Silent-runtime block now warns about `isChainRetryable` returning `false` silently.
- **Test coverage**: 435 → 441 (+6 covering the new aggregate-metadata helper and guard).

Migration in one paragraph: every concrete `AggregateRoot` / `EventSourcedAggregate` subclass adds `protected readonly aggregateType = "X";` where X is the canonical domain name; optionally migrate internal `createDomainEvent(...)` calls inside aggregate methods to `this.recordEvent(...)`; consumers on `@shirudo/base-error` 4.6.x bump to 4.7.0 (additive over 4.6.x, no API changes).

Per-section migration details below.

### BREAKING: `@shirudo/base-error` peer-dep bumped to `^4.7.0`

`@shirudo/base-error`'s `isChainRetryable` filters strictly on the `StructuredError` shape (`code` + `category` + `retryable`). ddd-kit's errors extend `BaseError<Name>` directly, discriminating by class (Vernon-canonical DDD) rather than RFC 9457 code/category fields, so `isChainRetryable(err)` returns `false` for `ConcurrencyConflictError` and consumers' OCC retry middleware silently skips the conflict.

`@shirudo/base-error` 4.7.0 ships `someChainRetryable`, which walks the cause chain with the loose `retryable === true` predicate (the same one `isRetryable` uses). It is now the canonical retry-chain check across the ddd-kit guides.

Migration:

- Consumers on `@shirudo/base-error` 4.7.x: no action.
- Consumers on `@shirudo/base-error` 4.6.x: bump to `4.7.0`. 4.7.0 is additive over 4.6.x (only new exports; no API changes), so a clean upgrade.

Docs updated to recommend `someChainRetryable`:

- `docs/guide/result-vs-throw.md`: catch example updated, helper-compatibility callout listing the loose helpers that work with ddd-kit errors vs the strict ones that do not.
- `docs/guide/repository.md`: `ConcurrencyConflictError` example updated, callout explaining the choice between `isRetryable` / `someChainRetryable` / `isChainRetryable`.
- `llms.txt`: new Silent-runtime entry warning about `isChainRetryable` returning `false` for ddd-kit errors; base-error helper list expanded to flag strict-shape helpers as incompatible with ddd-kit's class-based hierarchy.

### BREAKING: `recordEvent` helper + `aggregateType` abstract property; `withCommit` validates aggregate metadata

Aggregate-emitted events now carry `aggregateId` and `aggregateType` by construction, not by user discipline. Three coordinated changes:

1. **`protected abstract readonly aggregateType: string`** on both `AggregateRoot` and `EventSourcedAggregate`. Every concrete subclass MUST declare it as a string literal:

   ```diff
     class Order extends AggregateRoot<OrderState, OrderId, OrderEvent> {
   +   protected readonly aggregateType = "Order";
       static place(id, customerId): Order { ... }
     }
   ```

   This is the breaking change. Existing aggregates fail to compile until they declare the property. The string is what downstream consumers (outbox dispatchers, projection handlers, audit logs) route by, so pick the canonical domain name. `constructor.name` was rejected as a default because it's fragile under minification and bundler transforms; the explicit string is robust.

2. **`protected recordEvent<E extends TEvent>(type, payload, options?)`** on both aggregate flavours. Sugar for `createDomainEvent` that auto-injects `aggregateId = this.id` and `aggregateType = this.aggregateType`. The canonical path for recording events from inside aggregate domain methods:

   ```ts
   class Order extends AggregateRoot<OrderState, OrderId, OrderEvent> {
     protected readonly aggregateType = "Order";

     confirm(): void {
       this.commit(
         { ...this.state, status: "confirmed" },
         this.recordEvent("OrderConfirmed", { orderId: this.id }),
       );
     }
   }
   ```

   Direct `createDomainEvent(...)` calls outside aggregates still work and are still appropriate for system events, integration events, or anything the aggregate didn't emit.

3. **Runtime guard in `withCommit`** validates every harvested event has both `aggregateId` and `aggregateType` set. Throws a diagnostic error naming the event type and listing missing fields:

   ```
   withCommit: event "OrderCreated" is missing aggregateId and aggregateType.
   Use this.recordEvent(type, payload) inside aggregate methods instead of
   createDomainEvent(...); recordEvent auto-injects aggregateId and
   aggregateType. Outbox dispatchers and projection handlers rely on these
   fields for routing.
   ```

   This catches the case where someone bypassed `recordEvent` by calling `createDomainEvent` directly inside an aggregate.

**Also tightened**: `AggregateRoot`'s `TEvent` generic now constrains `extends AnyDomainEvent = never` (matches `EventSourcedAggregate`). Tests using ad-hoc `{ type: "X"; value: number }` event shapes were migrated to proper `DomainEvent<T, P>` shapes.

Migration:

- Every existing `AggregateRoot` / `EventSourcedAggregate` subclass adds one line: `protected readonly aggregateType = "X";` where X is the canonical aggregate name.
- Optional but recommended: migrate internal `createDomainEvent(...)` calls inside aggregate domain methods to `this.recordEvent(...)`. The new helper is shorter and removes the chance of forgetting `aggregateId`/`aggregateType`.
- Tests / examples using ad-hoc inline event types (`{ type: "X"; ... }`) must move to proper `DomainEvent<T, P>` shapes, since `AggregateRoot`'s TEvent now requires `AnyDomainEvent`.

Future direction (NOT in this release): the cleaner long-term shape splits `DomainEvent` into a base type and a richer `AggregateDomainEvent` that REQUIRES `aggregateId` and `aggregateType` at the type level. That would eliminate the runtime guard entirely. Candidate for 2.0.

435 → 441 tests (+6 covering the new helper and guard).

## [1.0.0-rc.7] - 2026-05-24

The settling-period release before 1.0. No breaking changes since rc.6; this cycle is dedicated to hardening, doc completeness, and consumer-feedback follow-through. Real-world production usage of rc.5/rc.6 surfaced one footgun (forgotten `super.markPersisted` in a subclass) and the architectural depth of several DDD patterns the kit had implemented but never explicitly documented.

Highlights:

- **`onPersisted(version)` Template-Method hook** on both aggregate flavours. The proper extension point for post-persist logging, metrics, and cache eviction; overriding `markPersisted` directly is now structurally discouraged (silent `pendingEvents` leak if `super` is forgotten). Closed via the GoF Template Method pattern: framework owns the cleanup; subclasses override the hook.
- **`withEventIdFactory` / `withClockFactory`**: scoped factory helpers with try/finally restore + runtime thenable-guard catching the async-misuse footgun. Closes the parallel-test and multi-tenant race conditions inherent to the module-global factory design.
- **Process Manager / Saga example** (`examples/saga/`) showing the canonical Order → Payment → Shipping flow with compensation paths, the last big pedagogical gap.
- **Read-Side Projections guide** (`docs/guide/projections.md`): end-to-end CQRS read flow from outbox dispatcher to QueryBus, including the `last_event_id` idempotency trick and the projection-vs-process-manager distinction.
- **Snapshot policies** documented (`event-sourcing.md`): three canonical strategies (every-N, time-based, background-sweep) with explicit trade-offs.
- **Reconstitution pattern** (state-stored + ES): Vernon §11's factory-vs-reconstitution distinction documented with worked code for both flavours.
- **`InMemoryOutbox<Evt>` reference implementation** alongside `EventBusImpl`.
- **DDD-canonical architectural notes**: where invariants live (per-state/per-event/per-method/cross-aggregate), Domain Services and Bounded Contexts in design-decisions, static-factory convention (Vernon §11 Aggregate Factory), the globals-vs-DI trade-off for clock/id factories.
- **Sharpened contracts**: `withCommit` aggregate-dedupe by reference (defensive), event-ordering contract within vs across aggregates (Vernon §10 distinction made explicit), Identity Map requirement on `IRepository` implementations (Fowler PoEAA), IdGenerator collision/monotonicity requirements.
- **Test coverage** grew from 416 to 435 (+19): dedicated tests for `core/errors` and `repo/scope`, regression tests for every new contract, three Saga end-to-end scenarios.

Several previously-published claims were re-reviewed against the DDD canon (Vernon / Young / Khononov / Evans / Fowler) and sharpened where they overstated. The library's posture is now consistent: ship parts not glue, document the conventions the parts assume, and stay honest about what's pragmatic-default versus what's DDD-canonical.

The next step is 1.0 unless rc.7 surfaces new feedback that requires API-level changes.

### Added: Document IdGenerator collision and monotonicity requirements

`IdGenerator<Tag>` consumers can today implement `next: () => Date.now().toString() as Id<...>`: compiles fine, looks clean in tests, collides silently in production. The kit makes no attempt to dedupe or detect collisions, so a duplicate id either overwrites an earlier row (under unique-key constraints) or silently aliases two different entities (without).

JSDoc on `IdGenerator` in `src/core/id.ts` now states the requirement explicitly with concrete safe choices (`crypto.randomUUID`, ULID, UUIDv7, KSUID) and the unsafe-looking-fine traps (`Date.now()` alone, process-local counter without persistence, sequential id from non-atomic state). One-paragraph echo of the same requirement in `docs/guide/repository.md` next to the `IdGenerator` introduction, plus a note that `EventIdFactory` has identical semantics.

### Added: Document Identity-Map requirement for Repository implementations

`docs/guide/repository.md` gains a new "Identity Map: one instance per aggregate per Unit of Work" section that names the unspoken assumption behind `withCommit`'s aggregate-dedupe: two `getById(id)` calls within the same UoW MUST return the **same in-memory instance**. This is Fowler's Identity Map pattern (*PoEAA*, 2002), implicitly assumed by Evans, Vernon, Khononov, and the broader DDD/CQRS-ES canon, but never previously stated in the kit's docs.

Without the contract spelled out, a consumer could read `withCommit`'s dedupe behaviour as "the kit handles aggregate identity entirely" and build a Repository without Identity-Map semantics, silently corrupting outbox dispatch when two distinct instances with the same id are returned.

The new section covers: the contract verbatim, why it matters (dedupe is by JS object identity, not by aggregate id), how most ORMs provide it for free (Drizzle session, Prisma client, EF Core context, Mongo session), and a worked code snippet for hand-rolled repositories using a per-UoW `Map<TId, TAgg>`. Closes by warning that the identity map's lifetime IS the Unit of Work: caching across UoW boundaries silently bypasses optimistic concurrency.

Cross-referenced from `withCommit`'s JSDoc so a reader landing on the duplicate-aggregate dedupe behaviour sees the Repository requirement that makes it sound.

### Changed: `withCommit` dedupes aggregates by reference

If a use case accidentally returns the same aggregate instance more than once in the `aggregates` array, typically because two repository references resolve to the same identity-map entry, `withCommit` now dedupes by JavaScript object identity before harvesting. Each event lands in the outbox exactly once and `markPersisted` fires exactly once.

Previously the same event would land in the outbox twice (duplicate `dispatchId` collisions in `InMemoryOutbox`, row-uniqueness conflicts in a SQL outbox without `(eventId)` constraints) and `markPersisted` would run twice on the same aggregate (second call a no-op since `pendingEvents` was empty after the first, but version assignment ran twice with the same value).

Dedupe is by object identity (`new Set(aggregates)`). Two **different** instances with the same logical id, which would indicate a separate aggregate-instance-sharing violation upstream, cannot be detected at this layer. Defensive behaviour change, non-breaking: no consumer's existing code does worse after this change.

JSDoc on `withCommit` mentions the dedupe behaviour explicitly so the contract is part of the published surface.

### Added: Doc: globals-vs-DI trade-off for `EventIdFactory` / `ClockFactory`

`docs/guide/design-decisions.md` gains a new section naming the architectural choice the kit made: module-level globals + scoped helpers + per-call overrides for `EventIdFactory` and `ClockFactory`, instead of Vernon IDDD §13's preferred constructor-injection pattern. Reading the docs in order without this section, a consumer sees the global-with-helpers path as THE supported way and either assumes the kit endorses globals as best practice, or rolls Vernon-DI ad-hoc without realising the kit's per-call `{ eventId, occurredAt }` is the canonical hook for it.

The new section spells out:

- **Why globals are the default.** Production fast path (events with default clock + UUID) benefits from minimal aggregate-construction surface.
- **Trade-off table.** Race-free-structurally vs minimal-constructor, edge-runtime plumbing, DDD-canon strictness.
- **Worked code snippet showing Vernon-DI on top.** Constructor-injected `clock` and `idGen`, no globals touched, `createDomainEvent`'s per-call `{ eventId, occurredAt }` doing the work. No library change required.
- **When the scoped helpers still win even in a DI-leaning codebase.** Events constructed deep inside domain methods where threading explicit options through every `createDomainEvent` call is awkward.

Doc-only. Honest framing for Vernon-leaning readers; the kit's design choice is preserved.

### Added: Scoped factory helpers `withEventIdFactory` / `withClockFactory`

`setEventIdFactory` and `setClockFactory` mutate module-level globals, which races under two real workloads:

- **Parallel tests**: vitest's default `pool: "threads"` (and `"forks"`) runs test files concurrently. Test A's `setEventIdFactory(deterministicGen)` leaks into Test B's `createDomainEvent(...)` running in parallel; the "call once at bootstrap" advice in the existing JSDoc breaks down here.
- **Multi-tenant request handlers**: Request A and Request B sharing the same process collide on the global if each wants a tenant-specific factory.

New helpers:

```ts
withEventIdFactory(factory, () => { /* sync work */ });
withClockFactory(factory, () => { /* sync work */ });
```

Both install the supplied factory, run the callback, and restore the previous factory in a `finally` block, so restoration happens even when the callback throws. Composable via nesting: an inner `withEventIdFactory` restores back to the outer's factory; the outer restores to the original.

**Sync-contract enforced at runtime.** If `fn` returns a thenable (a Promise or any object with a `then` method), both helpers throw before returning the value to the caller. This catches the async-misuse footgun where the JS try/finally + return semantics would restore the factory before the awaited body of `fn` ran, leaving the awaited code silently reading the previous factory. For async-scoped factories spanning `await` boundaries, use `AsyncLocalStorage`, which is explicitly out of scope for these helpers; build on top if needed.

`setEventIdFactory` / `setClockFactory` stay as the global-mutation helpers (still appropriate for once-at-bootstrap calls); the new helpers are the safer choice for tests and short-lived contexts. Their JSDoc now points at the scoped variants.

Tests cover: factory installed during fn (eventId + clock variants), restored after fn returns, restored after fn throws, fn's return value propagated, nested composition (inner restores to outer, outer restores to original), and the thenable-guard rejecting both real Promises and raw thenables.

### Added: `onPersisted(version)` Template-Method hook on both aggregate flavours

`AggregateRoot` and `EventSourcedAggregate` both gain a `protected onPersisted(version: Version): void` no-op default. `markPersisted(version)` calls it after the framework's cleanup (`setVersion` + `pendingEvents = []`). Subclasses should override `onPersisted` for post-persist logging, metrics, or cache-eviction; never override `markPersisted` directly.

Why: a consumer shipped an aggregate that overrode `markPersisted(version)` without calling `super.markPersisted(version)`. The framework's `pendingEvents = []` reset never ran; subsequent `withCommit` calls re-harvested the same events and double-dispatched them through the outbox. The bug was in user code (forgotten `super`) but the API surface invited it: `markPersisted` was the only obvious lifecycle hook, with no extension point next to it. This release adds the proper extension point structurally.

Design choices documented in JSDoc:

- **`onPersisted` receives only `version`, not the drained events.** Aggregate-level event-driven logic (audit logging, per-event-type side effects) belongs in `EventBus` subscribers or the outbox dispatcher: that's the Aggregate-Boundary separation Vernon's aggregate discipline is meant to preserve. Building event-aware logic into `onPersisted` recreates exactly the boundary problems the framework wants to keep apart. (Object-shape `onPersisted({ version, drainedEvents })` was considered and rejected for this reason; if a use case appears it can be added additively without breaking.)
- **Cleanup runs BEFORE the hook.** `markPersisted` does `setVersion` + `pendingEvents = []` *then* calls `onPersisted(version)`. Hook code can't accidentally read stale events.
- **`onPersisted` stays off `IAggregateRoot`.** Interface is the repository contract (`markPersisted` callable from outside); the hook is an internal subclass extension point. Keeps mock-shaped consumers (`{ id, version, markPersisted, … }`) compiling without ceremony.

Regression tests on both flavours assert the positive path (subclass overrides `onPersisted`, hook fires with correct version, `pendingEvents` is empty at hook time) and include a **negative example test** documenting the bug pattern with explicit ❌/✅ contrast: the same intent expressed via direct `markPersisted` override (broken) vs `onPersisted` override (correct), so any future reader sees exactly what to avoid.

#### Migration

If you override `markPersisted(version)`, switch to overriding `onPersisted(version)`:

```diff
  class Restaurant extends AggregateRoot<RestaurantState, RestaurantId, RestaurantEvent> {
-   public override markPersisted(version: Version): void {
-     // logger.info("persisted", { id: this.id, version });
-     // ❌ Missing super call: pendingEvents leaks; next save double-dispatches
-   }
+   protected override onPersisted(version: Version): void {
+     // logger.info("persisted", { id: this.id, version });
+     // ✅ Framework cleanup already ran; pendingEvents is empty here.
+   }
  }
```

Direct `markPersisted` overrides without `super.markPersisted(version)` silently leak `pendingEvents`, as observed in production usage on rc.5/rc.6. The kit cannot detect the missing `super` in TypeScript (no `final` keyword), but the JSDoc `@sealed`-style warning now flags it explicitly.

Non-breaking: existing overrides that DO call `super.markPersisted` continue to work; the new hook simply gives consumers a safer place to put their logic.

### Added: Reconstitution pattern documented (state-stored + event-sourced)

The kit shipped the mechanisms but only documented half: `loadFromHistory` is the canonical reconstitution path for event-sourced aggregates, but the state-stored case (`Repository.getById` reading a row and rebuilding an `Order` instance) had no documented pattern at all. Consumers had to discover that `protected constructor` + `protected setVersion` together form the kit's state-stored reconstitution surface, accessed via a `static Order.reconstitute(id, state, version)` helper on the aggregate.

New "Reconstitution" section in `docs/guide/aggregates.md` makes the convention explicit and grounds it in Vernon IDDD §11's explicit factory-vs-reconstitution distinction. Notes the terminology variations across DDD authors (Vernon: *reconstitute* / *materialize*; Khononov: *reconstitute*; Greg Young: *rehydrate*; all the same operation). Covers both aggregate flavours with worked code, and a "why reconstitution must NOT record events" subsection making the no-side-effects-on-the-event-pipeline rule explicit.

`docs/guide/repository.md` updated with the matching `getById` implementation showing `Order.reconstitute(row.id, row.state, row.version)` in context for both flavours.

Bonus: fixed a stale fact in `repository.md`'s `getByIdOrFail` description, where `AggregateNotFoundError` is correctly described as an `InfrastructureError` (post the rc.5 error-hierarchy split), not a `DomainError`.

### Added: Static-factory convention documented in the aggregates guide

Every example in the kit uses `static Order.place(...)` / `static Customer.register(...)` style construction, but the prose never named the pattern. New section in `docs/guide/aggregates.md` makes the convention explicit and grounds it in Vernon IDDD §11 *Factories*, specifically the **Factory Method on the Aggregate Root** shape (§11 also covers standalone factory classes for cases that need external dependencies; both are valid).

Includes a worked code snippet showing `Order.place(id, customerId)` recording an `OrderPlaced` event inside the factory, plus three rationales: two from Vernon §11 (domain language, whole-object validity at construction) and one from ES/CQRS canon (atomic creation event). The section explicitly distinguishes which is which so readers don't conflate Vernon's `§11` argument with the event-recording concern.

Calls out that `Order.create(...)` is the weakest verb choice, because it borrows JS boilerplate instead of the ubiquitous language, and recommends a domain-specific verb (place / draft / register / open / submit) when there is one. Notes that `protected constructor` on `AggregateRoot` and `EventSourcedAggregate` makes `new Order(...)` from outside the aggregate's file a compile error, so the static factory is the only public construction path.

### Added: Domain Services + Bounded Contexts notes in design-decisions.md

Two short prophylactic sections close common consumer questions that the kit's API surface raised but never answered:

- **Domain Services**: Vernon IDDD §7. The kit ships no `IDomainService` marker, no base class, no decorator. The reason: a marker that adds nothing at type or runtime level is just noise. A Domain Service is a function or interface alongside your aggregates; file naming and module structure identify it. With an example showing `calculateShippingCost(order, destination, rates): Money` as the canonical shape. Includes the Vernon §7 rule of thumb: a stateful "service" is a sign you've found a new aggregate.

- **Bounded Contexts**: Evans, *Domain-Driven Design* §14. The kit is BC-agnostic. Each BC is a module / package / repo importing the kit; the library prescribes no layout, no naming, no integration. Inter-BC communication is typically outbox + message broker (the topology the kit is designed for, but enforces nothing); the receiving BC translates incoming events via an Anti-Corruption Layer (Evans §14) using plain functions.

### Added: Event-ordering documented for `withCommit`, with the Vernon/Young caveat

The harvest order of events flowing through `withCommit` is now stated explicitly: events are concatenated in the order aggregates appear in the returned `aggregates` array, then in each aggregate's emission order. A regression test in `handler.test.ts` pins this down across three aggregates with multi-event emissions.

Crucially, the same docs now distinguish the two ordering guarantees that consumers conflate at their peril (Vernon IDDD §10; Greg Young):

- **Within a single aggregate**: causal order. `apply` / `commit` / `addDomainEvent` push to `pendingEvents` in domain-method invocation order, and subscribers MUST process them in that order. Inviolable.
- **Across aggregates within one `withCommit`**: incidental order, not a domain guarantee. Aggregates are independent consistency boundaries; events across them are eventually consistent. Parallel outbox dispatchers or message brokers may reorder them at delivery time.

The practical rule, now stated in `outbox.md` and the `withCommit` JSDoc: if a subscriber depends on the order in which events from *different aggregates* arrive, that's the wrong design: use `EventMetadata.causationId` for explicit causation, or a Process Manager to coordinate. Don't engineer against the harvest-order luck of being in the same batch.

### Added: "Where invariants live" map in the aggregates guide

DDD aggregates enforce business rules at four distinct locations and the kit exposes hooks at each, but consumers were re-deriving the map from scratch every time and often choosing the wrong location. New section in `docs/guide/aggregates.md` provides the canonical table:

| Location | What it guards | Library hook |
|---|---|---|
| **Per-state** | structural invariants ("total ≥ 0") | `validateState` (every `setState` / `commit`) |
| **Per-event (ES only)** | lifecycle invariants ("OrderShipped only after OrderConfirmed") | `validateEvent` (start of `apply()`) |
| **Per-method** | command-side guards ("can't confirm an empty order") | inline `if (...) throw` at the top of the domain method |
| **Cross-aggregate** | spanning invariants ("payment within 30min of order") | `EventBus` + Process Manager (eventual consistency) |

Each row has a worked code snippet and an explicit warning that cross-aggregate invariants cannot be enforced transactionally: Vernon's "modify one aggregate per transaction" rule (IDDD §10). If you want transactional cross-aggregate consistency, the aggregate boundaries are wrong.

Bonus: while in the file, fixed two stale facts in the Optimistic Concurrency section: `ConcurrencyConflictError` is now correctly described as an `InfrastructureError` subclass (post rc.5 hierarchy split), and the rc.5-era "repository calls `aggregate.markPersisted`" claim is replaced with the rc.6 `save()`-is-pure-persistence + `withCommit`-owns-the-lifecycle shape.

### Added: Snapshot-policy guidance in `event-sourcing.md`

`createSnapshot` and `restoreFromSnapshotWithEvents` shipped with mechanics-only docs. The when-to-snapshot question dominates load latency at scale and was nowhere addressed. New "Snapshot policies" subsection covers the three canonical strategies:

- **Every-N-events**: simplest, predictable; oversamples hot streams and undersamples cold ones
- **Time-based**: smooths bursts and idle periods; quiet aggregates still get snapshots eventually
- **On-demand / background job**: moves snapshot pressure off the write path; needs operational machinery

Each strategy has working pseudocode with the appropriate snapshot-store sketches, plus an honest trade-off block. The section explicitly notes what the library does NOT ship (no `SnapshotPolicy` port, no default frequency, no built-in sweeper) and adds a closing note on snapshot invalidation when event schemas change.

Bonus: while in the file, fixed a stale rc.5-era `save()` example that still called `markPersisted` from inside `Repository.save`; replaced with the rc.6 pure-persistence shape and a pointer to the `withCommit` lifecycle.

### Added: Process Manager / Saga example (`examples/saga/`)

A worked example showing how `EventBus`, `CommandBus`, `withCommit`, `IRepository`, and `InMemoryOutbox` compose into a Vernon-style Process Manager (IDDD §12-13). Four aggregates (`Order`, `Payment`, `Shipment`, and `CheckoutSaga`, the Process Manager itself) orchestrate a multi-step checkout flow with three end-to-end tests: happy path, payment-failure compensation, and shipping-failure compensation (payment refunded + order cancelled).

The saga is itself an `AggregateRoot<CheckoutSagaState, OrderId>`. This example takes the strict form (`TEvent = never`, outputs are exclusively dispatched commands), but the README documents the looser alternative where Process Managers also publish progress / observability events, as Vernon's IDDD §12 examples often do.

Includes a `README.md` explaining the pattern, the saga-as-aggregate framing, the Saga-vs-Process-Manager terminology (Garcia-Molina/Salem 1987 vs Hohpe/Woolf), EventBus-subscribers-as-reflexes, the compensation-via-forward-commands principle, and production caveats: outbox-dispatcher for durability, optimistic concurrency on the saga aggregate, **idempotent compensating domain methods** (the example's `Payment.refund()` throws on second call: fine for in-process tests, broken under at-least-once delivery; needs rework for production per Newman, *Building Microservices* §4), subscriber error-handling semantics, and saga-timeout strategies.

The library deliberately ships no `Saga` abstraction: sagas vary too much (choreography vs orchestration, state-machine shapes); the example is the documentation. Cross-linked from `docs/guide/cqrs-and-buses.md`.

### Added: Documentation for `Repository.delete` + domain-event pipeline

`IRepository.delete(id)` is pure persistence: the contract takes only the id, so there's no aggregate to harvest pending events from. Consumers who need an event recorded atomically with the row removal had to figure out the wiring themselves. Now spelled out in three canonical patterns (`docs/guide/repository.md` → "Deletion and Domain Events"), framed around the right question: *"is `delete` even the right domain verb here?"* Most user-facing deletes are state transitions (cancel, archive, close, deactivate, terminate) with proper domain names; they aren't deletes at all.

1. **State transition that records an event**: the most common case. The use case calls a domain method like `order.archive()` or `subscription.cancel()`; `save()` persists the new state; `delete(id)` is never called.
2. **Hard-delete with event harvest**: when the row truly must vanish (privacy/regulatory purge, retention windows, true termination) *and* the disappearance is a domain fact subscribers care about. Inside `withCommit`: record the event on the aggregate, call `delete(id)`, return the aggregate in `aggregates[]` so the outbox receives the event before the row is gone.
3. **Hard-delete without event**: internal GC where deletion is invisible to the domain (abandoned carts, expired sessions). If the entity has identity in the ubiquitous language, you probably want pattern 1 or 2 instead.

The new section also notes that `IRepository.delete` is rarely meaningful in pure event-sourced systems: end-of-lifecycle there lives in the stream as a `Closed` / `Terminated` event, and identity persists in the event log. `delete` applies primarily to state-stored aggregates and snapshot tables.

`IRepository.delete`'s JSDoc points at the doc and summarises the three patterns inline.

### Added: Read-Side Projections guide (`docs/guide/projections.md`)

New documentation page for the canonical CQRS read-side flow: outbox → dispatcher → projection handlers → read-model tables → `QueryBus`. Covers the dispatcher loop pattern (polling + queue-based variants), the event-type-keyed projection-handler shape (mirroring `EventSourcedAggregate.handlers`), the `last_event_id` idempotency trick, the QueryHandler-reads-from-projection wiring, and eventual-consistency UX strategies. Closes a long-standing pedagogical gap where the kit shipped all the pieces but never showed them composed end-to-end.

Includes a full topology snippet wiring `withCommit`, `InMemoryOutbox`, `EventBusImpl`, `CommandBus`, `QueryBus`, and a projection together. Explicitly documents what the library does NOT ship (no `ProjectionHandler` type, no dispatcher impl, no replay tooling) and why: projections are consumer territory; the kit's contract ends at the outbox.

Cross-links from `outbox.md` and `cqrs-and-buses.md`; new sidebar entry under "Application Layer".

### Changed: Document the `version === 0` / `version > 0` insert-vs-update convention

`IRepository.save`'s JSDoc and `docs/guide/repository.md` now explicitly document the library's convention for distinguishing fresh aggregates from existing ones: `aggregate.version === 0` means INSERT, `aggregate.version > 0` means UPDATE with the OCC predicate `WHERE id = ? AND version = expected`. Every persistence-layer adapter has to make this distinction; now it's stated once and pointed at from JSDoc. Also fixes two stale facts in `repository.md`: `save()` no longer instructs implementors to call `markPersisted` (the `withCommit` orchestrator owns the lifecycle since rc.6), and `AggregateNotFoundError` / `ConcurrencyConflictError` are correctly described as `InfrastructureError` subclasses, not `DomainError`.

Docs-only: no API change.

## [1.0.0-rc.6] - 2026-05-24

The big architectural hardening pass. Closes the gap between what the kit's docs promised and what the code actually delivered, particularly around the Repository/withCommit lifecycle, the event-port contract, and the EventSourcedAggregate version model. Six breaking changes, all driven by Vernon / Greg Young / Khononov / Axon / EventFlow research into the canonical DDD patterns; each one removes a footgun rather than adding a feature.

Highlights:

- `withCommit` now owns the post-save event lifecycle (harvest, outbox, mark-persisted, publish). `Repository.save` is pure persistence. The previous documented use-case pattern was latently broken: `repo.save` cleared events before they could be harvested.
- `EventSourcedAggregate` loses the `autoVersionBump` flag entirely. Version IS event count per Greg Young / Vernon §9; there is no canonical use-case for opting out, and the flag was non-functional anyway (it promised `setVersion` access that was private).
- `TransactionScope<TCtx>`, `EventBus`, `Outbox`, `withCommit` all tighten their generic constraints: `TCtx` has no default; events must extend `AnyDomainEvent`. The looser shapes invited misuse the kit's own implementations didn't follow.
- `AggregateRoot.domainEvents` is renamed to `pendingEvents` to unify with `EventSourcedAggregate`. The `IAggregateRoot` interface now exposes `pendingEvents` + `clearPendingEvents` so generic repository code works across both flavours.
- `restoreFromSnapshot*` deep-clones the snapshot input, fixing a latent footgun where caller mutations bled into the live aggregate.
- Three convenience helpers (`hasPendingEvents`, `getEventCount`, `getLatestEvent`) removed; `.length > 0` / `.length` / `.at(-1)` are the idioms.

Plus: `InMemoryOutbox<Evt>` reference implementation shipped, entity-collection helpers widened to `ReadonlyArray<T>`, dedicated test files for `core/errors` and `repo/scope` (+21 tests).

Naming: every example identifier follows Vernon's Persistence-oriented Repository style (`orderRepository`, not `orders`).

### Changed: Entity-collection helpers accept `ReadonlyArray<T>`

`findEntityById`, `hasEntityId`, `removeEntityById`, `updateEntityById`, `replaceEntityById`, and `entityIds` now declare their `entities` parameter as `ReadonlyArray<T>` instead of `T[]`. None of these helpers ever mutated the input; the mutable-array signature was forcing callers holding a `readonly OrderItem[]` (e.g. inside a frozen aggregate state slice) to cast or copy unnecessarily. Mutable arrays continue to work since `T[]` is assignable to `ReadonlyArray<T>`.

### Added: `InMemoryOutbox<Evt>` reference implementation

Ships an in-memory `Outbox<Evt>` implementation alongside `EventBusImpl`, so consumers no longer have to copy-paste the Map-backed boilerplate from the docs for every test or quick-start demo:

```ts
import { InMemoryOutbox } from "@shirudo/ddd-kit";

const outbox = new InMemoryOutbox<OrderEvent>();
await withCommit({ scope, outbox, bus }, async (tx) => { … });
```

Uses each event's own `eventId` as the `dispatchId` and keys storage on `eventId`, so re-adds are naturally idempotent. For production, swap it for an outbox backed by your transactional store.

### BREAKING: `withCommit` use case returns `aggregates`, not `events`; `Repository.save` is pure persistence

`withCommit` now owns the post-save lifecycle (harvest pending events, write outbox, mark persisted after commit, publish to bus). `Repository.save` is responsible for **persistence only** and must NOT call `aggregate.markPersisted(...)` itself. This is the Vernon / Axon / EventFlow unit-of-work pattern: `save` is "I wrote this row"; "this aggregate has been committed" is the orchestrator's call to make.

```diff
  await withCommit({ scope, outbox, bus }, async (tx) => {
    const orderRepository = makeOrderRepository(tx);
    const order = await orderRepository.getByIdOrFail(orderId);
    order.confirm();
-   await orderRepository.save(order);  // also called markPersisted internally
-   return { result: order.id, events: order.pendingEvents };
+   await orderRepository.save(order);  // pure persistence, no markPersisted
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

Why this is BREAKING and worth doing: the prior contract had `Repository.save` clear pending events as a side effect, but the documented use-case pattern then read `order.pendingEvents` AFTER the call. With a correct `save` implementation that list would be empty by then, and the outbox would receive nothing. The bug was latent in the kit's docs and tests; no integration test exercised the full path. The new shape closes both ends: pending events are harvested by the library (so the user can't get the order wrong), and `markPersisted` only fires after the transaction commits (so a rolled-back transaction never silently consumes the aggregate's pending events).

Migration:
1. Use-case bodies inside `withCommit`: return `{ result, aggregates: [agg, ...] }` instead of `{ result, events: agg.pendingEvents }`.
2. Repository implementations: remove the `aggregate.markPersisted(...)` call from `save`. `save` should now just write and return.
3. Custom orchestration outside `withCommit`: call `aggregate.markPersisted(aggregate.version)` yourself **after** you have harvested `aggregate.pendingEvents` for downstream dispatch.

### BREAKING: Unify `pendingEvents` accessor across both aggregate flavours

`AggregateRoot.domainEvents` / `clearDomainEvents()` are renamed to `pendingEvents` / `clearPendingEvents()`, matching `EventSourcedAggregate`. The shared accessor is hoisted to the `IAggregateRoot<TId, TEvent = never>` interface so a generic `Repository.save()` can harvest pending events uniformly without branching on the aggregate flavour.

```diff
- aggregate.domainEvents              // ReadonlyArray<TEvent>
- aggregate.clearDomainEvents()
+ aggregate.pendingEvents             // ReadonlyArray<TEvent>
+ aggregate.clearPendingEvents()
```

The protected `addDomainEvent(event)` helper on `AggregateRoot` is **unchanged**: the verb-object pattern names what's being added (a domain event), while the container's lifecycle name (`pendingEvents`) describes the not-yet-flushed state. Both readings coexist consistently.

`IAggregateRoot<TId>` gains a second generic param `TEvent` (default `never`) so the interface can carry the typed `pendingEvents` array. Existing consumers writing `IAggregateRoot<OrderId>` keep compiling; `pendingEvents` is `ReadonlyArray<never>` (always empty) for the no-events case.

### Removed: `hasPendingEvents`, `getEventCount`, `getLatestEvent` helpers on `EventSourcedAggregate`

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

### Fixed: `restoreFromSnapshot*` now deep-clones the snapshot input

`AggregateRoot.restoreFromSnapshot` and `EventSourcedAggregate.restoreFromSnapshotWithEvents` previously did only `freezeShallow(snapshot.state)`, leaving nested fields aliased to the caller's snapshot object. A caller that mutated a nested field on `snapshot.state` after passing it in would silently bleed the mutation into the live aggregate (only the top-level object was frozen).

`createSnapshot` already clones on the way out; the restore paths now mirror that contract on the way in:

```diff
+ const cloned = structuredClone(snapshot.state);
- this._state = freezeShallow(snapshot.state);
+ this._state = freezeShallow(cloned);
```

Adds tests on both flavours that mutate the original snapshot post-restore and assert the aggregate is unaffected. No API change; non-breaking.

### BREAKING: Remove `EventSourcedAggregateConfig` / `autoVersionBump` from `EventSourcedAggregate`

`EventSourcedAggregate` no longer accepts a config object. The `EventSourcedAggregateConfig` interface and the `autoVersionBump` flag are deleted. Every `apply()` bumps the version by one, with no opt-out.

```diff
- super(id, initialState, { autoVersionBump: false });
+ super(id, initialState);
```

The flag was non-functional in practice: its JSDoc promised user-controlled versioning via `bumpVersion()` / `setVersion()` calls, but `setVersion` was `private`, so consumers had no way to actually set the version. Replay (`loadFromHistory`, `restoreFromSnapshotWithEvents`) also ignored the flag entirely, always deriving version from `history.length`. The escape hatch led nowhere.

DDD literature is unanimous on the canonical rule (Greg Young; Vernon IDDD §9; Khononov *Learning DDD*): for an event-sourced aggregate, **the aggregate version IS the event count**. There is no canonical use-case for manual version control on an event-sourced aggregate. If your event store has a stream-position concept (EventStoreDB `streamRevision`, Marten / Equinox offsets), keep it as a store-layer detail; it is not the aggregate's domain version.

`AggregateRoot.autoVersionBump` is **unchanged**. That flag is well-designed and Vernon-conformant: state-stored aggregates legitimately need a per-call escape hatch for cosmetic / denormalized state mutations that are not domain-meaningful (`setState(newState, false)`). The protected `bumpVersion()` / `setVersion()` methods stay where the user can reach them.

Migration: any subclass passing a config object to `super(...)` drops the third argument. Anyone who relied on `autoVersionBump: false` was almost certainly working around a misunderstanding of the JSDoc; the actual behavior they got never matched the promise. The library now matches the documentation.

### BREAKING: `TransactionScope<TCtx>`: no default for the context generic

`TCtx` no longer defaults to `unknown`. Every implementor names its context type explicitly:

```diff
- interface TransactionScope<TCtx = unknown> {
+ interface TransactionScope<TCtx> {
    transactional<T>(fn: (ctx: TCtx) => Promise<T>): Promise<T>;
  }
```

The `unknown` default in rc.5 was a back-compat convenience but encouraged a degenerate "ignore the ctx" mental model. In practice the ctx is almost always meaningful: the ORM tx handle, a tx-scoped logger, a correlation id. Forcing the type makes consumers articulate what lives in their unit-of-work boundary.

Migration: pick a concrete type. Drizzle / Prisma / Mongo users already write `TransactionScope<DrizzleTx>` etc. and need no change. Context-free scopes (in-memory tests, naive no-tx scopes) spell out `TransactionScope<undefined>`:

```diff
- const scope: TransactionScope = {
-   transactional: <T>(fn: (_ctx: unknown) => Promise<T>) => fn(undefined),
+ const scope: TransactionScope<undefined> = {
+   transactional: <T>(fn: (_ctx: undefined) => Promise<T>) => fn(undefined),
  };
```

`withCommit` loses its `TCtx = unknown` default as well; `TCtx` is inferred from the `scope` argument, so call sites typically need no change.

### BREAKING: Event-port constraints tightened to `AnyDomainEvent`

`EventBus`, `Outbox`, `OutboxRecord`, and `withCommit` previously accepted any `{ type: string }` shape (or, for `Outbox` / `OutboxRecord`, no constraint at all). They now all require `Evt extends AnyDomainEvent`, a new exported alias for `DomainEvent<string, unknown>`:

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

The DDD-kit ports are for *domain* events, not arbitrary tagged unions. Previously the concrete `EventBusImpl` already constrained to `DomainEvent<string, unknown>`; the public ports were looser than the only implementation. The new constraint aligns the interfaces with their stated purpose and prevents non-event objects from leaking through the outbox / bus pipeline.

The `unknown` in `AnyDomainEvent` is an upper bound, not a value that flows through methods: when a consumer supplies a concrete event union as the type argument, `EventBus.subscribe<K>` still sees the specific payload via `Extract<Evt, { type: K }>`.

Migration: ad-hoc shapes like `{ type: "OrderCreated"; orderId: string }` need to become proper domain events:

```diff
- type OrderCreated = { type: "OrderCreated"; orderId: string };
+ type OrderCreated = DomainEvent<"OrderCreated", { orderId: string }>;

- const events = [{ type: "OrderCreated", orderId: "o-1" }];
+ const events = [createDomainEvent("OrderCreated", { orderId: "o-1" })];
```

Same alignment landed for `IEventSourcedAggregate`, `EventSourcedAggregate`, and the internal `Handler<TState, TEvent>` type all now reference `AnyDomainEvent` instead of inlining `DomainEvent<string, unknown>`. `copyMetadata` and the `EventUpcaster` examples in the docs follow the same alias.

### BREAKING: `loadFromHistory` / `restoreFromSnapshotWithEvents` accept `ReadonlyArray<TEvent>`

```diff
- loadFromHistory(history: TEvent[]): Result<void, DomainError>;
+ loadFromHistory(history: ReadonlyArray<TEvent>): Result<void, DomainError>;

- restoreFromSnapshotWithEvents(snapshot, eventsAfterSnapshot: TEvent[]): …
+ restoreFromSnapshotWithEvents(snapshot, eventsAfterSnapshot: ReadonlyArray<TEvent>): …
```

The implementations never mutated the input; the mutable-array signature was misleading. The new shape declares the actual contract: the aggregate only consumes the history, it never writes back. Callers passing `TEvent[]` continue to work (mutable arrays are assignable to `ReadonlyArray<T>`); callers whose own variable was already typed `ReadonlyArray<TEvent>` no longer need a copy.

## [1.0.0-rc.5] - 2026-05-24

Adds an explicit transaction context to `TransactionScope` so consumer repositories can bind to the live Drizzle/Prisma/Mongo handle without falling back to `AsyncLocalStorage`. Also polishes the error contract (cause chains now actually propagate through library errors) and fixes JSDoc examples that referenced a non-existent `repo.save(tx, order)` API.

### BREAKING: `TransactionScope<TCtx>`: explicit context generic

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

Default `TCtx = unknown` keeps the no-context callers compiling: `withCommit({ scope, outbox }, async () => ({...}))` still works; the `ctx` parameter is simply ignored.

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

### BREAKING: Drop `KitError`; `DomainError` / `InfrastructureError` extend `BaseError` directly

`KitError` was a redundant abstraction layer. Semantically it duplicated the `isBaseError(e)` predicate from `@shirudo/base-error`, while the name "kit" said nothing about what the library does, and the boundary it claimed to draw ("library-internal") didn't actually hold: `DomainError` is shared between library and consumer-derived errors. Removing it.

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

### BREAKING: New error hierarchy on top of `@shirudo/base-error`

Library-internal errors are reorganised into a three-tier hierarchy that separates **business-rule violations**, **infrastructure failures**, and **programming bugs**, and the abstract bases now extend `BaseError<Name>` from [`@shirudo/base-error`](https://www.npmjs.com/package/@shirudo/base-error) (added as a `peerDependency`, analogous to `@shirudo/result`):

```ts
import { BaseError } from "@shirudo/base-error";

abstract class KitError<Name>            extends BaseError<Name> {}   // marker for App-Service catch
abstract class DomainError<Name>         extends KitError<Name> {}    // invariant violations (consumer-derived)
abstract class InfrastructureError<Name> extends KitError<Name> {}    // persistence + concurrency

class AggregateNotFoundError    extends InfrastructureError<"AggregateNotFoundError"> {}    // was DomainError
class ConcurrencyConflictError  extends InfrastructureError<"ConcurrencyConflictError"> {}  // was DomainError; retryable: true
class MissingHandlerError       extends KitError<"MissingHandlerError"> {}                  // was DomainError, now a programming bug
```

The previous hierarchy had `AggregateNotFoundError`, `ConcurrencyConflictError`, and `MissingHandlerError` all under `DomainError`, conflating three categories. `MissingHandlerError` deliberately no longer extends `DomainError`: it represents "the aggregate's subclass forgot to register a handler", which is a configuration/programming bug, not a business-rule violation. `loadFromHistory` and `restoreFromSnapshotWithEvents` continue to catch only `DomainError` thrown by `apply()`; a `MissingHandlerError` now propagates uncaught, so the bug surfaces loudly instead of being silently wrapped in `Result.Err`.

Because every library error now extends `BaseError<Name>`, consumers get for free:

- **Timestamps** (`error.timestamp`, `error.timestampIso`)
- **`error.toJSON()`** for structured logging
- **`error.getUserMessage()`** + `withUserMessage()` / `addLocalizedMessage()` for i18n-aware end-user messages
- **Cause chains** via the native `error.cause`, with traversal helpers (`getRootCause`, `findInCauseChain`, `filterCauseChain`)
- **`isRetryable(error)`** predicate. `ConcurrencyConflictError` ships with `retryable: true` so the canonical OCC retry-on-conflict pattern is one check away.
- **Typed `error.name`**: the concrete classes set their literal so `error.name` is `"AggregateNotFoundError"` (literal type), not `string`.
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
- Consumers who subclassed the abstract bases without a generic (`class X extends DomainError {}`) keep compiling: the `Name` generic defaults to `string`. For typed `error.name` literals, pass the name: `class FooError extends DomainError<"FooError"> {}`.

### Documentation

- New "Where to bootstrap the factory" subsection in `docs/guide/domain-events.md` shows the three canonical placements for `setEventIdFactory` / `setClockFactory` (Node entry, Cloudflare Worker module-top-level, test setup file). Spells out "call it once per isolate boot, not inside `fetch()`" and routes per-tenant variance to the per-call `options.eventId` override instead of mutating the global per request.
- `docs/guide/domain-events.md` and `docs/guide/edge-runtimes.md` now explicitly tag the default `eventId` as **UUID v4** and recommend time-ordered alternatives (UUID v7 / ULID / KSUID) for production. v4 is random and amplifies B-tree index writes once the event store grows; time-ordered ids stay clustered.
- `EventIdFactory` JSDoc gets the same v4-vs-time-ordered note so IDE hover surfaces the recommendation.
- `package.json` `homepage` now points at the docs site (<https://shi-rudo.github.io/ddd-kit-ts/>) instead of the GitHub repo, so npmjs.com routes visitors through the guide first.


## [1.0.0-rc.2] - 2026-05-23

A consolidation release. Closed 60+ audit items across the entire surface, restructured the kit around DDD-canonical conventions (domain throws, App boundary returns Result), and shipped a documentation site at <https://shi-rudo.github.io/ddd-kit-ts>. Many breaking changes; the kit is in RC explicitly so these can land before the API freezes.

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

// Functional aggregate dropped; extend the class
- const order = aggregate<OrderState>(initialState);
- const next  = bump(order);
+ class Order extends AggregateRoot<OrderState, OrderId> { ... }
```

`result.value` / `result.error` field access is unchanged (both fields exist on the new shape; the inactive variant is `undefined`).

### BREAKING: Result moved to `@shirudo/result`

- Internal `Result<T, E>` and the class-based `Outcome` / `Success` / `Erroneous` API removed. Add `@shirudo/result` as a dependency in your app (now declared as a `peerDependency`).
- Shape changed: discriminator is now `_tag: 'Ok' | 'Err'` (was `ok: boolean`); type guards are methods (`result.isOk()` / `result.isErr()`); pure-function variants `isOk(result)` / `isErr(result)` are also exported. `andThen` is now `flatMap` (curried, pipe-style).
- `@shirudo/ddd-kit/result` subpath export removed; import directly from `@shirudo/result`.
- `tanstack-server-fn` examples removed (they demonstrated the now-gone `Outcome` API).

### BREAKING: Domain layer throws, App boundary returns Result

- Domain methods (Aggregates, ValueObject constructors, `validateEvent`) **throw** `DomainError`-derived exceptions. Result is reserved for the App-Service boundary (`CommandBus.execute`, `QueryBus.execute`, `withCommit`) and the Infrastructure boundary where stream corruption is recoverable (`loadFromHistory`, `restoreFromSnapshotWithEvents`).
- `EventSourcedAggregate.apply()` is now `void` (was `Result<void, string>`). Throws `DomainError` on validation failure and `MissingHandlerError` when no handler is registered. State, pending events, and version commit atomically: if the handler or `validateEvent` throws, no mutation occurs.
- `EventSourcedAggregate.applyUnsafe()` removed; `apply()` already throws.
- `validateEvent(event)` is now `void` (was `Result<true, string>`). Subclasses override to throw a concrete `DomainError` subclass.
- `loadFromHistory()` and `restoreFromSnapshotWithEvents()` now return `Result<void, DomainError>` (was `Result<void, string>`). They catch `DomainError` thrown by `apply()` during replay; non-domain throws propagate.
- `guard()` removed. Use inline `if (!cond) throw new YourDomainError(...)`. No replacement helper; the indirection wasn't earning its keep.
- `voWithValidationUnsafe()` removed (redundant with the `ValueObject` base class, whose constructor throws via `validate()`).
- New `DomainError` abstract base in `src/core/errors.ts`. Concrete library-internal subclasses: `MissingHandlerError`, `AggregateNotFoundError`, `ConcurrencyConflictError`.
- `IRepository.getByIdOrFail(id)` added; throws `AggregateNotFoundError` when the aggregate does not exist. Use `getById` when `null` is a valid outcome.

### BREAKING: Aggregate API consolidation

- **Functional aggregate API removed.** `aggregate(state, version)`, `bump(agg)`, and `AggregateState<S>` are gone. Class-based `AggregateRoot` / `EventSourcedAggregate` is the canonical model and pairs with the rest of the kit (Entity, IAggregateRoot, Repository).
- `AggregateRoot<TState, TId, TEvent>`: `TEvent` defaults to `never` (was `unknown`). Forces an explicit event union whenever the subclass actually records events; the no-events path (`setState` only) still works.
- `AggregateRoot.commit(newState, events)` added: the opt-in record-after-mutation helper. Calls `setState(newState, true)` first (which throws on `validateState` failure), then appends the event(s). Always bumps the version (no `bumpVersion` parameter, since recording an event implies a version-worthy change). Use `setState(newState, false)` directly for state-only mutations.
- `AggregateRoot.markPersisted(version)` and `EventSourcedAggregate.markPersisted(version)` added. The post-save hook a `Repository.save()` implementation calls to push the persisted version back into the in-memory aggregate and clear recorded events. Lets `save()` keep its `Promise<void>` return type.
- `EventSourcedAggregate.apply()` is now generic in the event tag (`K extends TEvent["type"]`): concrete callers narrow the dispatched handler at compile time without an `as` cast.
- `loadFromHistory()` advances version **additively** (`startVersion + history.length`); it was previously stomped to `history.length`, breaking continuity for aggregates loaded mid-life.
- `restoreFromSnapshotWithEvents()` is now **all-or-nothing**: a mid-replay `DomainError` rolls back to the pre-call state and version. Partial restoration is never observable.
- `autoVersionBump` defaults documented as pattern-specific: `false` on `AggregateRoot` (because `setState` already takes an explicit `bumpVersion` argument), `true` on `EventSourcedAggregate` (one event = one version bump, canonical ES).

### BREAKING: Interfaces and identity

- `IAggregateRoot.markPersisted(version)` required by the interface (previously only on the abstract classes). Repository implementations can now code against the interface alone.
- `Identifiable<TId extends Id<string>>` constrained: `Identifiable<string>` no longer compiles. Aligns with `IAggregateRoot<TId extends Id<string>>` and `IEntity<TId extends Id<string>, TState>`. The brand discipline of `Id<Tag>` is now uniform across the entire entity surface.
- `IdGenerator<Tag extends string>`: the tag is bound at the generator type, not the call site. The old shape `IdGenerator { next: <T extends string>() => Id<T> }` let callers pick any tag for free, defeating the brand.
- Entity helpers (`sameEntity`, `findEntityById`, `hasEntityId`, `removeEntityById`, `updateEntityById`, `replaceEntityById`, `entityIds`) now compare by `===` (was `deepEqual`) and require `TId extends Id<string>`. Branded ids are primitive strings; deep equality was wasted work.

### BREAKING: Repository + persistence

- `ISpecification<T>` removed (phantom branded interface with no methods; could not be used generically).
- `IRepository.find` / `findOne` moved to the **opt-in** `IQueryableRepository<TAgg, TId, TFilter>` extension. `TFilter` is the persistence layer's native filter shape (Drizzle `SQL`, Prisma `WhereInput`, Mongo filter documents, in-memory predicates, …). The library no longer prescribes a query DSL.
- `IRepository.exists(id): Promise<boolean>` added. Collection-style existence check; cheaper than `getById !== null` when the storage supports `EXISTS`-style queries.
- `UnitOfWork` renamed to `TransactionScope`; `src/repo/uow.ts` → `src/repo/scope.ts`. The implementation was a transaction-scope helper, not Fowler's full UoW (no change tracking). The new name is honest. Consumers update `import { TransactionScope } from "@shirudo/ddd-kit"` and rename `withCommit({ uow, … })` to `withCommit({ scope, … })`.
- `RepoProvider<R>` removed (dead export, never used).
- `withCommit` publishes events **after** the transactional callback resolves (was: inside the transactional callback). Defeats the classic publish-before-commit footgun: in-process subscribers can never react to events from a rolled-back transaction.
- `ConcurrencyConflictError extends DomainError` is the canonical signal a `Repository.save()` implementation throws on optimistic-lock mismatch. Carries `aggregateType`, `aggregateId`, `expectedVersion`, `actualVersion`.

### BREAKING: Domain events

- `DomainEvent<T, P>` gains required `eventId: string` and optional `aggregateId` / `aggregateType`. Idempotent consumers, outbox dispatch tracking, and `metadata.causationId` references now have something concrete to point at.
- `createDomainEvent()` **deep-freezes** the returned event. A mutating subscriber on the `EventBus` throws instead of poisoning subsequent handlers; nested writes to `payload` / `metadata` also throw.
- `createDomainEvent()` payload-shape JSDoc fixed: the field is always present; the value is `undefined` when `P = void` (was documented as "omitted").

### BREAKING: CQRS / Buses

- `CommandBus.register` / `QueryBus.register` are now strictly typed when a `TMap` is supplied. Unknown command/query keys and wrong-typed handlers are compile errors; the no-`TMap` path stays loose for tests.
- `EventBus.subscribe<K extends Evt["type"]>(eventType, handler)` binds the handler's event type to the `eventType` argument. The previous shape let `subscribe<OrderShipped>("OrderCreated", h)` compile silently.
- `EventBus.once<K extends Evt["type"]>(eventType, options?)`: same narrowing. New optional `{ signal?: AbortSignal; timeoutMs?: number }` options bag to abort or time out a wait; the promise rejects synchronously when the signal is already aborted.
- `EventBusImpl` stores handlers in an `Array` instead of a `Set`: subscribing the same handler reference twice now invokes it twice (the canonical pub/sub expectation). The returned unsubscribe removes exactly the matching subscription.
- `Outbox<Evt>` port expanded: `add` plus new `getPending(limit?)` and `markDispatched(dispatchIds)`. Introduces an `OutboxRecord<Evt>` wrapper so implementations choose their own opaque `dispatchId` (typically reuses `eventId`). `markDispatched` is required idempotent.

### BREAKING: Utilities, exports, and types

- `/utils/array` subpath export removed; use `/utils` (or the main entry). The two subpaths resolved to identical code through layered re-exports.
- `sideEffects: false` added to `package.json`: free aggressive tree-shaking. None of the modules have top-level side effects.
- `vo()` deep-clones via `structuredClone` before freezing; the caller's nested object graph is no longer frozen as a side effect. As a side benefit, function-valued payloads now throw at construction time (Value Objects are data, not behaviour).
- `deepFreeze` iterates `Reflect.ownKeys` so Symbol-keyed properties are also frozen (asymmetric vs `deepEqual` before).
- `isBuiltInObject` replaced the `globalThis[name]` + `proto !== Object.prototype` heuristics with an explicit tag allow-list. Cross-realm safe; user classes named after globals (e.g. `class Date {}`) are no longer misclassified as built-ins.
- `deepEqual` cycle tracker switched from `WeakMap<obj, obj>` to `WeakMap<obj, WeakSet<obj>>`: pair-set semantics, can't be poisoned by a previous compare against a different B. Symbol-key membership probed via `Set` (was `Array.includes` in a loop). TypedArray indexed access typed (no more `any` leak).
- `deepOmit` cycle cache via `visited.has(obj)` (was `cached !== undefined`); built-ins **cloned** by type (`Date` / `RegExp` / `Map` / `Set`, fallback `structuredClone`) instead of returned by reference; `__proto__` / `constructor` keys assigned via `Object.defineProperty` so they can't pollute `Object.prototype`; `ignoreKeys` probed via `Set` (was `Array.includes`).

### Added

- **Documentation site**: VitePress + TypeDoc + GitHub Pages workflow at <https://shi-rudo.github.io/ddd-kit-ts>. 13 hand-written guide pages plus auto-generated API reference via `typedoc-vitepress-theme`.
- `EventIdFactory` + `setEventIdFactory(fn)` / `resetEventIdFactory()`: global override for event-id generation (default `crypto.randomUUID()`). Per-call `options.eventId` still wins.
- `ClockFactory` + `setClockFactory(fn)` / `resetClockFactory()`: symmetric global override for `occurredAt`. For deterministic event-sourcing tests / time-travel debugging.
- `AggregateRoot.commit(newState, events)`: record-after-mutation helper.
- `AggregateRoot.markPersisted(version)` / `EventSourcedAggregate.markPersisted(version)`: post-save hook.
- `IQueryableRepository<TAgg, TId, TFilter>` interface.
- `IRepository.exists(id)`, `IRepository.getByIdOrFail(id)`.
- `DomainError` (abstract) + `MissingHandlerError` + `AggregateNotFoundError` + `ConcurrencyConflictError` in `src/core/errors.ts`.
- `DomainEvent.eventId` / `aggregateId` / `aggregateType` fields.
- `OutboxRecord<Evt>` + `Outbox.getPending(limit?)` + `Outbox.markDispatched(dispatchIds)`.
- `EventBus.once(eventType, { signal, timeoutMs })`: abortable / time-limited waits.

### Fixed

- `EventSourcedAggregate.apply()` no longer leaves state partially mutated when the handler throws. Computes the next state in a temporary; only the atomic commit step mutates `_state`, pushes the event, and bumps the version.
- `loadFromHistory()` no longer stomps version to `history.length`; it advances additively from the aggregate's current version.
- `restoreFromSnapshotWithEvents()` rolls back state + version when a mid-replay event throws.
- `AggregateRoot.domainEvents` and `EventSourcedAggregate.pendingEvents` getters return a `Object.freeze(arr.slice())` snapshot (were returning the internal array directly, so outside code could push into it).
- `Entity._state` is shallowly frozen on every assignment (`Object.freeze`); the `state` getter exposes the same frozen object. Direct property writes throw in strict mode; nested mutation still bypasses (deep freeze on every assignment would be too costly on hot paths, as documented).
- `withCommit` publishes events **after** `scope.transactional` resolves (was: inside the transactional callback). No more publish-before-commit.
- `EventBus.once()` no longer leaks the subscription forever when the event never arrives: the optional `signal` / `timeoutMs` paths clean up the handler + the timer + the abort listener atomically.

### Documentation

- README points to the docs site at the top and is no longer the primary entry point for narrative content.
- `addDomainEvent` JSDoc spells out the "record AFTER mutation" rule with a concrete example and the Vernon rationale.
- `Entity.validateState` JSDoc warns about the constructor-order footgun (subclass field initializers haven't run when validateState is called from the base constructor); a pinning test exercises it.
- `EventBus.publish` JSDoc spells out the ordering / parallelism / error-aggregation contract; three tests pin each rule.
- `EventBus.once` JSDoc and a `OnceOptions` interface document the AbortSignal + timeout semantics.
- `IRepository.save` JSDoc states the contract: throw `ConcurrencyConflictError` on version mismatch; call `aggregate.markPersisted(newVersion)` after successful write.
- `IRepository.find` (on `IQueryableRepository`) JSDoc states "returns every match, with no pagination; for unbounded sets prefer read-side projections or declare domain-specific paged methods on the concrete repository."
- `Outbox.add` JSDoc documents the idempotency expectation (dedupe on `eventId`).
- `setEventIdFactory` / `setClockFactory` JSDoc warns "module-scoped, last setter wins; for multi-tenant request isolation prefer the per-call `options` override."
- README event-ordering callout points to both `EventSourcedAggregate.apply()` (structural enforcement) and `AggregateRoot.commit()` (opt-in helper) instead of treating record-after-mutation as a convention.
- New "Event-Sourcing Schema Evolution (Upcasting)" section in README documents the recommended consumer pattern. The library deliberately ships no `EventUpcaster` port.
- ValueObject section in README spells out: `voWithValidation` for parsing untrusted input at the App boundary; `ValueObject` base class for Domain construction.

## [1.0.0-rc.1] - 2026-03-16

First Release Candidate. The API is considered stable.

### Added

- **Value Objects**: `vo()`, `voEquals()`, `voEqualsExcept()`, `voWithValidation()`, `deepFreeze()` for functional immutable value objects
- **Value Objects (class-based)**: `ValueObject<T>` base class with `equals()`, `clone()`, `toJSON()`
- **Entities**: `Entity<TState, TId>` base class, `Identifiable<TId>` interface, and collection helpers (`findEntityById`, `removeEntityById`, `updateEntityById`, `replaceEntityById`, `entityIds`)
- **Aggregate Roots**: `AggregateRoot<TState, TId, TEvent>` with version management, domain events, and snapshot support
- **Event-Sourced Aggregates**: `EventSourcedAggregate<TState, TEvent, TId>` with event handlers, history replay, snapshot+events restore, and event validation
- **Functional Aggregates**: `aggregate()`, `bump()` for lightweight state+version patterns without classes
- **Domain Events**: `DomainEvent<T, P>` with versioning and `EventMetadata` (correlationId, causationId, userId, source). Helpers: `createDomainEvent()`, `createDomainEventWithMetadata()`, `copyMetadata()`, `mergeMetadata()`
- **Event Bus**: `EventBusImpl<Evt>` with pub/sub, `subscribe()` (returns unsubscribe fn), `once()`, and `AggregateError` on multiple handler failures
- **Command Bus**: `CommandBus<TMap>` with type-safe dispatch, `Result`-based error handling, and optional `TMap` for return type inference
- **Query Bus**: `QueryBus<TMap>` with `execute()` (returns `Result`) and `executeUnsafe()` (throws), optional `TMap` for return type inference
- **CQRS Types**: `Command`, `CommandHandler<C, R>`, `Query`, `QueryHandler<Q, R>` marker interfaces for use with any bus implementation
- **Transaction Helper**: `withCommit()` for executing commands within a `UnitOfWork` transaction with outbox and optional event bus publishing
- **Repository**: `IRepository<TAgg, TId>` interface with `getById`, `findOne`, `find`, `save`, `delete`
- **Specification**: `ISpecification<T>` branded marker interface for query specifications
- **Unit of Work**: `UnitOfWork` interface and `RepoProvider<R>` type
- **Result Type**: Functional API: `ok()`, `err()`, `isOk()`, `isErr()`, `andThen()`, `map()`, `mapErr()`, `match()`, `matchAsync()`, `matchResult()`, `pipe()`, `tryCatch()`, `tryCatchAsync()`, `unwrapOr()`, `unwrapOrElse()`
- **Result Type (class-based)**: `Outcome<T, E>`, `Success<T>`, `Erroneous<E>` with method chaining (`map`, `andThen`, `mapErr`, `unwrap`, `match`)
- **Guard**: `guard(cond, error)` for concise precondition checks returning `Result`
- **ID**: Branded `Id<Tag>` type and `IdGenerator` interface
- **Utilities**: Deep equality (`deepEqual`), deep equality with exclusions (`deepEqualExcept`), deep omit (`deepOmit`)
- **Sub-path exports**: `@shirudo/ddd-kit/result`, `@shirudo/ddd-kit/utils`, `@shirudo/ddd-kit/utils/array`

### Changed (since 0.x beta)

- **EventBus type safety**: `subscribe()` and `once()` now require `Evt["type"]` instead of `string`, preventing typos in event type names
- **CommandBus/QueryBus type inference**: Both buses accept an optional `TMap` generic for automatic return type inference from command/query type
- **ISpecification**: Replaced phantom `_type: T` field with a branded symbol. Implementors no longer need to add a dummy field
- **Entity hierarchy**: Unified to single `Entity<TState, TId>` base class. `AggregateRoot` extends `Entity`
- **`Aggregate` → `AggregateState`**: Renamed to clarify it's a state projection, not a full aggregate with identity
- **`AggregateRoot.version`**: Now encapsulated (`private` + `get version()`). External code can read but not set the version
- **`DomainEvent.version`**: Now required (`number` instead of `number?`). Essential for schema evolution in event sourcing
- **`sameAggregate()` → `sameVersion()`**: Renamed to reflect actual semantics (concurrency check, not identity check)
- **`IRepository`**: Simplified from `<TState, TEvent, TAgg, TId>` to `<TAgg, TId>`. Works with both `AggregateRoot` and `EventSourcedAggregate`
- **`createSnapshot()`**: Now uses `structuredClone()` for deep copy. Snapshots are fully isolated from the aggregate
- **`AggregateEventSourced` → `EventSourcedAggregate`**: Renamed to match Vernon's IDDD terminology. Now extends `Entity` directly (not `AggregateRoot`), so `setState()` and `addDomainEvent()` are not available; state changes can only happen through event handlers
- **Functional API**: `AggregateState` is now state+version only (no `pendingEvents`). Event sourcing is exclusively class-based via `EventSourcedAggregate`

### Removed (since 0.x beta)

- **`AggregateBase`**: Removed dead code (`entity/aggregate-base.ts`). Use `AggregateRoot` instead
- **`Clock` interface**: Removed unused interface from `ports.ts`
- **`withEvent()`**: Removed from functional API. It appended events without applying state changes, which is not event sourcing. Use `EventSourcedAggregate` for proper ES
- **`sameAggregate()`**: Replaced by `sameVersion()` with correct semantics
- **Minified output**: Library now ships unminified for better debugging and consumer bundler compatibility

## [0.9.0 – 0.16.0] - Beta

Beta development phase with rapid iteration. Key milestones:

- 0.9.0: Initial public API: aggregates, entities, value objects, events, repository, Result type
- 0.9.1: Aggregate Root / child entity distinction, improved docs
- 0.9.3: `matchAsync`, object syntax for `match`
- 0.9.5: `pipe`, `tryCatch`, `tryCatchAsync`, dedicated `/result` export path
- 0.9.6: `/utils` and `/utils/array` export paths
- 0.9.7: `voEqualsExcept` for partial VO comparison
- 0.16.0: `EventBus.once()`, `withCommit` handler, hardened event handling, `TEvent` generic on `AggregateRoot`
