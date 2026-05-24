# Outbox & Transactions

The transactional outbox is the canonical pattern for "domain event must persist atomically with the state change, even if downstream delivery is asynchronous". The kit ships two small ports — `TransactionScope` and `Outbox<Evt>` — plus a `withCommit` helper that wires them together.

## `TransactionScope<TCtx>`

A minimal transaction-scope abstraction generic over the persistence layer's transaction handle:

```ts
interface TransactionScope<TCtx> {
  transactional<T>(fn: (ctx: TCtx) => Promise<T>): Promise<T>;
}
```

`fn` runs inside the persistence layer's native transaction (Postgres `BEGIN`/`COMMIT`, Mongo session, Drizzle transaction, etc.). The transaction commits when the callback resolves, rolls back if it throws. The `ctx` parameter is the live transaction handle — `tx` in Drizzle and Prisma, `session` in Mongo, `undefined` in the no-context fake used for tests.

`TCtx` has no default: every implementor names it explicitly so "what lives in my unit-of-work boundary" is a conscious decision. Context-free scopes spell it out as `TransactionScope<undefined>` — that's the honest "there is nothing meaningful here" statement, not an inherited `unknown` fallback.

The use case binds its repositories to `ctx` — typically by constructing tx-scoped repos from a factory. `IRepository`'s methods take only the id / aggregate; the transaction handle is wired into the repo at construction, not threaded through every call.

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

::: info Not Fowler's full Unit of Work
`TransactionScope` is intentionally **not** Fowler's UoW — no change tracking, no `registerDirty` / `registerNew` / `registerDeleted`, no commit-time flush. That's the ORM's job; competing with Prisma / Drizzle / TypeORM on their home turf only creates incompatibility. The kit stays out of it.
:::

## `Outbox<Evt>`

```ts
interface OutboxRecord<Evt extends AnyDomainEvent> {
  dispatchId: string;     // opaque — the impl chooses (eventId, UUID, row PK, …)
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

### Idempotency

Both `add` and `markDispatched` should be idempotent — the dispatcher may retry on partial failure. A unique constraint on `(eventId)` for the outbox row is the standard pattern; the implementation can reuse the event's own `eventId` as the `dispatchId` (the common, clean choice).

### Reference implementation

The kit ships an in-memory reference outbox — use it for tests, single-process workers, and quick-start demos:

```ts
import { InMemoryOutbox, type DomainEvent } from "@shirudo/ddd-kit";

type OrderCreated = DomainEvent<"OrderCreated", { orderId: string }>;

const outbox = new InMemoryOutbox<OrderCreated>();
```

It uses each event's own `eventId` as the `dispatchId` (the standard choice) and keys storage on `eventId`, so re-adds are naturally idempotent. For production, swap it for an outbox that writes to your transactional store — the outbox row should participate in the same transaction as the aggregate write so events and state commit atomically.

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

1. **`scope.transactional(fn)`** — `fn` runs inside the persistence layer's native transaction. The use case mutates state and calls `repo.save`. `repo.save` is **pure persistence** — it does NOT clear pending events.
2. **Still inside the transaction**, `withCommit` harvests `pendingEvents` from every aggregate returned by `fn` and calls `outbox.add(events)` — events persist atomically with the state change. Skipped when no events were recorded.
3. **Transaction commits.**
4. **After commit:** `aggregate.markPersisted(aggregate.version)` fires on each returned aggregate. Only now are pending events considered flushed.
5. `bus.publish(events)` fires for in-process subscribers (optional — `bus` is omitted when no in-process fast path is wired).

Publishing *after* the commit is the key invariant: in-process subscribers never react to events from a rolled-back transaction. If `bus.publish` itself throws, events are still in the outbox; the dispatcher will deliver them on the next poll (eventual consistency).

If the transaction rolls back, `markPersisted` is **not** called — the aggregate keeps its pending events, so the caller can retry or discard.

For the downstream side — outbox-dispatcher → projection-handlers → read-model tables → `QueryBus` — see [Read-Side Projections](./projections.md).

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
