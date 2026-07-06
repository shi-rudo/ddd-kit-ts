# Outbox & Transactions

The transactional outbox is the canonical pattern for "domain event must persist atomically with the state change, even if downstream delivery is asynchronous". The kit ships two small ports (`TransactionScope` and `Outbox<Evt>`) plus a `withCommit` helper that wires them together.

## `TransactionScope<TCtx>`

A minimal transaction-scope abstraction generic over the persistence layer's transaction handle:

```ts
interface TransactionalOptions {
  readonly signal?: AbortSignal;
}

interface TransactionScope<TCtx> {
  transactional<T>(
    fn: (ctx: TCtx) => Promise<T>,
    options?: TransactionalOptions,
  ): Promise<T>;
}
```

`fn` runs inside the persistence layer's native transaction (Postgres `BEGIN`/`COMMIT`, Mongo session, Drizzle transaction, etc.). The transaction commits when the callback resolves, rolls back if it throws. The `ctx` parameter is the live transaction handle: `tx` in Drizzle and Prisma, `session` in Mongo, `undefined` in the no-context fake used for tests. The `options` argument is additive and optional: a one-parameter implementation still satisfies the interface, and a cancellation-aware scope can honor `options.signal` to abort an in-flight query (see [Cancellation and deadlines](./unit-of-work.md#cancellation-and-deadlines)).

`TCtx` has no default: every implementor names it explicitly so "what lives in my unit-of-work boundary" is a conscious decision. Context-free scopes spell it out as `TransactionScope<undefined>`; that's the honest "there is nothing meaningful here" statement, not an inherited `unknown` fallback.

The use case binds its repositories to `ctx`, typically by constructing tx-scoped repos from a factory. `IRepository`'s methods take only the id / aggregate; the transaction handle is wired into the repo at construction, not threaded through every call.

```ts
// Drizzle implementation
import type { drizzle } from "drizzle-orm/node-postgres";
type DrizzleDb = ReturnType<typeof drizzle>;
type DrizzleTx = Parameters<Parameters<DrizzleDb["transaction"]>[0]>[0];

class DrizzleScope implements TransactionScope<DrizzleTx> {
  constructor(private db: DrizzleDb) {}
  async transactional<T>(fn: (tx: DrizzleTx) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => fn(tx));
  }
}

// Use case
await withCommit({ scope, outbox, bus }, async (tx) => {
  // Bind your repos to the live transaction however your ORM expects.
  // Constructor injection / factory / `.withTx()` are all valid idioms.
  const orderRepository = makeOrderRepository(tx);

  const order = await orderRepository.getByIdOrFail(orderId);
  order.confirm();
  await orderRepository.save(order);                       // pure persistence
  return { result: order.id, aggregates: [order] }; // withCommit harvests pendingEvents
});
```

For tests or no-context flows, write `TransactionScope<undefined>` explicitly:

```ts
const scope: TransactionScope<undefined> = {
  transactional: (fn) => fn(undefined),
};

await withCommit({ scope, outbox }, async () => ({
  result: "ok",
  events: [],
}));
```

::: info The scope stays minimal; the Unit of Work lives above it
`TransactionScope` itself does no change tracking (`registerDirty` / `registerNew` / `registerDeleted`) and no commit-time flush; row-level change detection is the ORM's home turf. The kit's equivalents live in the layers above: the aggregate detects its own changes ([`changedKeys` / `hasChanges`](./repository.md#partial-writes-for-multi-table-aggregates-changedkeys--haschanges)), `withCommit` orchestrates the commit lifecycle, and the opt-in [`UnitOfWork` facade](./unit-of-work.md) adds tx-bound repositories, enrollment, and a per-operation identity map. See [the revised design decision](./design-decisions.md#transactionscope-stays-minimal-the-unit-of-work-lives-above-it).
:::

::: tip Persist routing columns, not just the payload
Every event harvested by `withCommit` carries `aggregateId` and `aggregateType` (guard-enforced at the harvest boundary) and is stamped with `aggregateVersion` AND `commitSequence`: the version is the commit version for saved aggregates (the OCC version the row write carries; for deletion events, the aggregate's version at deletion time), and `commitSequence` is the zero-based index of the event within its aggregate's harvest batch. Manually pre-set values pass through unchanged (an `aggregateVersion` ahead of the commit version throws). **Schema version ≠ aggregate version**: `event.version` is the payload's schema revision (upcasting); `event.aggregateVersion` is the producing aggregate's state revision. Outbox table implementations should persist `eventId`, `aggregateId`, `aggregateType`, `aggregateVersion`, and `commitSequence` as indexed columns.

**Use them correctly:** all events of one commit share the same `aggregateVersion`, so the version alone is only a *per-commit* watermark; the pair **`(aggregateVersion, commitSequence)`** is a total order per aggregate and the compact idempotency watermark ("processed `Restaurant:123` up to (12, 1)"): sort by the tuple, advance the tuple after each processed event, and no `eventId` set is needed for kit-harvested events. Set-based dedup on **`eventId`** (as the [projections guide](./projections.md) shows) remains the fully general fallback, e.g. for events that reached the outbox outside `withCommit` and carry neither stamp.

**Scope of the stamps:** `aggregateVersion` and `commitSequence` are `withCommit`-harvest-boundary guarantees. Events appended to an event STORE from `pendingEvents` (the ES save path), published via `bus.publish` by hand, or written via `outbox.add` outside `withCommit` do NOT carry it; for event-sourced streams, the store's own position/`expectedVersion` is the authority. A hand-rolled orchestration that wants the fields must stamp them itself (`aggregateVersion = aggregate.version`, `commitSequence` = harvest index); the repository contract test suite enforces both on committed outbox events.
:::

## `Outbox<Evt>`

```ts
interface OutboxRecord<Evt extends AnyDomainEvent> {
  dispatchId: string;     // opaque: the impl chooses (eventId, UUID, row PK, …)
  event: Evt;
}

interface Outbox<Evt extends AnyDomainEvent> {
  add(events: ReadonlyArray<Evt>):                 Promise<void>;
  getPending(limit?: number):                      Promise<ReadonlyArray<OutboxRecord<Evt>>>;
  markDispatched(dispatchIds: ReadonlyArray<string>): Promise<void>;
}
```

`Evt` is constrained to [`AnyDomainEvent`](../api/) so the outbox only stores proper domain events with the standard envelope (`eventId`, `type`, `payload`, `occurredAt`, etc.).

Lifecycle:

1. **`add`** is called inside the write transaction (typically from `withCommit`), so events persist atomically with the state change.
2. A separate **outbox dispatcher** polls `getPending` and forwards the events to subscribers / external brokers.
3. After successful dispatch, the dispatcher calls `markDispatched(dispatchIds)` so they don't come back next poll.

### Ordering is part of the port contract

`getPending` must return records **in the order `add()` persisted them** (commit order). `withCommit` promises subscribers per-aggregate causal order, and a sequential dispatcher can only honor that promise when this read is ordered. SQL-backed implementations need a monotonic position column (an auto-increment primary key works) plus an `ORDER BY` on it: a bare `SELECT` returns rows in storage order, not insertion order, and silently violates the causal-order promise under load.

### Idempotency

Both `add` and `markDispatched` should be idempotent; the dispatcher may retry on partial failure. A unique constraint on `(eventId)` for the outbox row is the standard pattern; the implementation can reuse the event's own `eventId` as the `dispatchId` (the common, clean choice).

### Failure tracking and dead letters (`DispatchTrackingOutbox`)

Without failure tracking, a poison message (an event whose delivery always throws) is redelivered forever: it comes back from every poll, blocks per-aggregate ordering behind it, and burns dispatcher cycles. The optional `DispatchTrackingOutbox` extension adds the bounded-retry story:

```ts
interface DispatchTrackingOutbox<Evt> extends Outbox<Evt> {
  markFailed(dispatchId: string, error?: unknown): Promise<void>;
  deadLetters():                                   Promise<ReadonlyArray<DeadLetterRecord<Evt>>>;
}
```

The dispatcher loop becomes: deliver, `markDispatched` on success, `markFailed` on failure, **and stop the batch on the first failure**. Continuing past a failed record would deliver later events of the same aggregate before the failed earlier one, breaking exactly the per-aggregate causal order the `getPending` contract exists to preserve; the next poll retries from the failed record (the implementation counts attempts, surfaced as `OutboxRecord.attempts`, so the dispatcher can add backoff per record):

```ts
for (const record of await outbox.getPending(batchSize)) {
  try {
    await broker.publish(record.event);
    await outbox.markDispatched([record.dispatchId]);
  } catch (error) {
    await outbox.markFailed(record.dispatchId, error);
    break; // later records must not overtake a failed predecessor
  }
}
```

A dispatcher that partitions by aggregate (`record.event.aggregateId`) can scope the stop to the failing aggregate's lane instead of the whole batch; the invariant is per-aggregate order, not global order.

Wire `deadLetters()` to alerting: a growing dead-letter set is an incident signal, not a log line. **Dead-lettering deliberately forfeits ordering for that aggregate's successors**: once the poison record leaves the pending set, later events of the same aggregate flow without their predecessor; that trade-off (bounded retries over strict order) is the point of the ceiling, and the alert is what makes it safe. Recovery paths: fix the cause and re-`add` the event (requeues it with a fresh attempts budget), or deliver by hand and ack via `markDispatched` (which clears dead-lettered records too). `InMemoryOutbox` implements the extension with a configurable `maxDeliveryAttempts` (default 5).

### Reference implementation

The kit ships an in-memory reference outbox; use it for tests, single-process workers, and quick-start demos:

```ts
import { InMemoryOutbox, type DomainEvent } from "@shirudo/ddd-kit";

type OrderCreated = DomainEvent<"OrderCreated", { orderId: string }>;

const outbox = new InMemoryOutbox<OrderCreated>();
```

It uses each event's own `eventId` as the `dispatchId` (the standard choice) and keys storage on `eventId`, so re-adds are naturally idempotent. For production, swap it for an outbox that writes to your transactional store: the outbox row should participate in the same transaction as the aggregate write so events and state commit atomically.

## `withCommit`: putting it together

```ts
import { withCommit } from "@shirudo/ddd-kit";

const orderId = await withCommit(
  { outbox, bus, scope },
  async () => {
    const order = await repo.getByIdOrFail(id);
    order.confirm();
    await repo.save(order);                      // pure persistence
    return {
      result: order.id,
      aggregates: [order],                       // withCommit owns the rest
    };
  },
);
```

Order of operations:

1. **`scope.transactional(fn)`:** `fn` runs inside the persistence layer's native transaction. The use case mutates state and calls `repo.save`. `repo.save` is **pure persistence**; it does NOT clear pending events.
2. **Still inside the transaction**, `withCommit` harvests `pendingEvents` from every aggregate returned by `fn` and calls `outbox.add(events)`, so events persist atomically with the state change. Skipped when no events were recorded. **Harvest order:** events are concatenated in the order aggregates appear in the returned `aggregates` array, then in each aggregate's emission order. See the [ordering note](#two-ordering-guarantees-not-one) below before designing subscribers against it.
3. **Transaction commits.**
4. **After commit:** `aggregate.markPersisted(aggregate.version)` fires on each returned aggregate. Only now are pending events considered flushed.
5. `bus.publish(events)` fires for in-process subscribers (optional; `bus` is omitted when no in-process fast path is wired).

Publishing *after* the commit is the key invariant: in-process subscribers never react to events from a rolled-back transaction. If `bus.publish` itself throws, `withCommit` does **not** reject: the write is committed, so the caller always receives the committed `result`; surfacing a subscriber failure as a rejection would make a typical caller retry and double-execute the write. The error is reported to the optional `onPublishError(error, events)` dep (observer-only; wire it to your logger/metrics). The events are still in the outbox; the dispatcher will deliver them on the next poll (eventual consistency).

If the transaction rolls back, `markPersisted` is **not** called: the aggregate keeps its pending events, so the caller can retry or discard.

### Two ordering guarantees, not one

The events harvested in step 2 carry two different ordering guarantees that consumers conflate at their peril:

- **Within a single aggregate: causal order.** `apply` / `commit` / `addDomainEvent` push to `pendingEvents` in domain-method invocation order, and that order reflects real causality: the second event happened *because* the first one did. Subscribers (in-process handlers, projection handlers, event-store replay) MUST process these in order. Out-of-order processing within an aggregate breaks state derivation. Vernon IDDD §10; Greg Young's ES talks treat this as inviolable.

- **Across aggregates within one `withCommit`: incidental, not domain.** The order in which `aggregates: [a, b, c]` were written into the array is deterministic, and the in-process `EventBus.publish` and sequential outbox-dispatchers preserve it. But this is an *implementation* artifact, not a domain guarantee. DDD treats aggregates as independent consistency boundaries; events across them are eventually consistent (Vernon §10). Parallel outbox dispatchers, message brokers, or cross-process delivery may reorder events from `a` against events from `b` at delivery time.

**Practical rule:** if a subscriber depends on the order in which events from *different aggregates* arrive, that's the wrong design. Use `EventMetadata.causationId` to express explicit causation across events (the event from `b` carries the `eventId` of the event from `a` that triggered it), or use a Process Manager to coordinate. Don't engineer against the harvest-order luck of being in the same batch.

For the downstream side (outbox-dispatcher → projection-handlers → read-model tables → `QueryBus`), see [Read-Side Projections](./projections.md).

::: tip Why the use case returns `aggregates`, not `events`
The Vernon / Axon / EventFlow pattern: `Repository.save` is pure persistence; "this aggregate has been committed" is the orchestrator's call to make, not the repo's. Returning aggregates lets `withCommit` harvest pending events itself and call `markPersisted` at the right moment (post-commit, before publish). The earlier pattern of returning `events: order.pendingEvents` directly was a footgun: if `repo.save` cleared events early, the harvest would see an empty list and the outbox would receive nothing.
:::

## When you need each piece

| You have | You need |
|---|---|
| A single Worker invocation, no external services | EventBus + `withCommit({ scope, outbox, bus })` |
| Modular monolith, in-process subscribers + external consumers | EventBus (in-process fast path) + Outbox (durable handoff) + dispatcher (cron / queue) |
| Pure microservices, no in-process subscribers | Outbox + dispatcher only; omit `bus` from `withCommit` |
| Tests | In-memory Outbox + EventBus (both ship as plug-ins) |
