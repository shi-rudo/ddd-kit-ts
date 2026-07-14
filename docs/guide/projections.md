# Read-Side Projections

Aggregates are built for decisions. Read models are built for screens.

That is the reason projections exist. A command handler loads an aggregate
because it must protect invariants. A query handler should usually not load
three aggregates, calculate display fields, and sort them in memory. It should
read a table shaped for the query.

The normal flow is:

1. A use case mutates an aggregate.
2. The repository saves the aggregate; `withCommit` validates its commit
   token and writes the domain events to the outbox in the same transaction.
3. A dispatcher delivers those events to a `Projector`.
4. The `Projector` updates one read-model table and advances its checkpoint
   in the same transaction.
5. Query handlers read that table.

The read side is eventually consistent with the write side. That is the
trade-off: the read model can be denormalized, indexed, replicated, and tuned
for the UI, but it may lag behind the write by a small amount.

## When To Use One

Do not add projections just because the app uses CQRS. Add them when the read
shape is different from the write shape.

Good reasons:

- A list view needs fields from several aggregates.
- A query needs sorting, filtering, search, or aggregation that the aggregate
  repository is bad at.
- The UI needs denormalized rows such as `order_list_views`.
- Reads must scale independently from writes.
- You want rebuildable read models from an event history.

Weak reasons:

- "All queries must avoid aggregates" as a rule.
- A single-id query already has a cheap repository method.
- The projection would duplicate a table without making the query simpler.

It is normal to mix both styles. A `GetOrderById` query can read the
aggregate. A `GetOrdersForCustomer` query should usually read a projection.

## Read-Model Shape

A read model is not an aggregate and it is not a normalized domain model. It
is a table for one query or one family of queries.

```sql
create table order_list_views (
  id text primary key,
  customer_id text not null,
  customer_name text not null,
  total_minor bigint not null,
  total_currency char(3) not null,
  total_scale smallint not null,
  item_count integer not null,
  status text not null,
  updated_at timestamptz not null
);
```

You might also have `order_detail_views`, `customer_order_summary_views`, or
`invoice_export_views`. They can all be fed by the same events. Keep each
projection focused on one read shape; that makes rebuilds and failures much
easier to reason about.

## The Kit Projector

`Projector` runs one projection with the mechanics that are easy to get wrong:
cursor checks, duplicate skipping, atomic checkpointing, rebuild reset, and
wait-for-version.

```ts
import {
  Projector,
  projectionFromHandlers,
  type ProjectionCheckpointStore,
} from "@shirudo/ddd-kit";

const orderListProjection = projectionFromHandlers<OrderEvent, DbTx>({
  name: "order-list",
  handlers: {
    OrderCreated: async (tx, event) => {
      await tx("order_list_views").insert({
        id: event.aggregateId,
        customer_id: event.payload.customerId,
        customer_name: event.payload.customerName,
        total_minor: "0",
        total_currency: event.payload.currency,
        total_scale: event.payload.scale,
        item_count: 0,
        status: "pending",
        updated_at: event.occurredAt,
      });
    },

    OrderLineAdded: async (tx, event) => {
      await tx("order_list_views")
        .where({ id: event.aggregateId })
        .update({
          total_minor: tx.raw("total_minor + ?", [
            event.payload.lineTotal.amountMinor.toString(),
          ]),
          item_count: tx.raw("item_count + 1"),
          updated_at: event.occurredAt,
        });
    },

    OrderConfirmed: async (tx, event) => {
      await tx("order_list_views")
        .where({ id: event.aggregateId })
        .update({
          status: "confirmed",
          updated_at: event.occurredAt,
        });
    },

    OrderCancelled: async (tx, event) => {
      await tx("order_list_views").where({ id: event.aggregateId }).delete();
    },
  },

  truncate: async (tx) => {
    await tx("order_list_views").truncate();
  },
});

const projector = new Projector({
  scope,
  checkpoints: checkpointStore,
  projection: orderListProjection,
});
```

`apply` receives one event and writes the read model. It should not send mail,
call another service, issue commands, or update domain state. A rebuild
replays events; side effects would run again.

The projection name is part of the checkpoint key. Rename it only when you
intend to replay from the beginning.

## Exhaustive vs Intentionally Partial Handling

Use `projectionFromHandlers` for correctness-critical read models: financial
totals, audit trails, entitlements, operational state, and anything else where
silently missing a newly introduced event would leave a plausibly wrong row.
Its handler map is exhaustive over the declared event union. Adding a member to
`OrderEvent` is a compile error in every such projection until that member has
either a handler or the explicit `ignoreProjectionEvent` token.

The runtime check is independent of the type proof. An undeclared event type,
including object-prototype names such as `constructor` or `__proto__`, throws
`MissingHandlerError`. The batch rejects and its checkpoint does not advance.

Implement `Projection` directly when partial routing is genuinely the desired
contract. For example, an optional search-hint index may intentionally react to
only one fact and remain valid when unrelated event types appear:

```ts
import type { Projection } from "@shirudo/ddd-kit";

const searchHints: Projection<OrderEvent, DbTx> = {
  name: "order-search-hints",
  apply: async (tx, event) => {
    // Intentionally partial: every other current or future OrderEvent is a no-op.
    if (event.type !== "OrderCreated") return;
    await tx("order_search_hints").insert({
      id: event.aggregateId,
      customer_name: event.payload.customerName,
    });
  },
};
```

That escape hatch is deliberately free-form rather than a second partial
handler-map helper, so the silent policy remains visible in review. In either
style, exhaustiveness is only as honest as the event union you supply. Do not
narrow `OrderEvent` to the subset a projection happens to use; give the helper
and its `Projector` the complete union delivered by the source.

## Projectors Need A Complete Source Feed

For every `(aggregateType, aggregateId)` address a projector consumes, its
input must contain every committed envelope in that address's source chain.
Do not subscribe a projector to an event-type-filtered topic such as only
`OrderPlaced`: another event from the same commit still owns a cursor position,
and dropping it would make the next commit correctly fail with
`ProjectionGapError`.

Route the complete, ordered per-address feed to the projector and explicitly
ignore known facts that do not affect this read model:

```ts
import {
  ignoreProjectionEvent,
  projectionFromHandlers,
} from "@shirudo/ddd-kit";

const placedOrders = projectionFromHandlers<OrderEvent, DbTransaction>({
  name: "placed-orders",
  handlers: {
    OrderPlaced: async (tx, event) => {
      await tx.placedOrders.insert({ id: event.payload.orderId });
    },
    // Explicit no-op: still consumed and checkpointed by the projector.
    OrderShipped: ignoreProjectionEvent,
  },
});
```

Here `result.applied` counts envelopes whose `apply` callback ran and whose
cursor was checkpointed; it does not promise that every callback changed a
row. Event-type filtering remains fine for consumers that do not use this
source cursor contract. If infrastructure can only provide filtered feeds, it
must assign a separate, contiguous projection-specific cursor after routing;
the aggregate commit cursor cannot be reused for that feed.

## Checkpoints

The projector stores one watermark per `(projection, aggregateType,
aggregateId)`. The type is part of the key because identities are type-scoped
(`Order 1` and `Payment 1` are different aggregates even when the raw id
strings collide), and every envelope `withCommit` creates carries the source.
Two consequences for adapters: the checkpoint table's primary key is the full
triple, and the `aggregateType` string becomes a durable contract, so renaming
an aggregate type means migrating its checkpoint rows.

```ts
interface ProjectionPosition {
  aggregateVersion: number;
  commitSequence: number;
  commitSize: number;
  previousEventfulAggregateVersion: number | null;
}

interface ProjectionCheckpoint {
  position: ProjectionPosition;
  lastAppliedEventId: string;
}

interface AggregateAddress {
  aggregateType: string;
  aggregateId: string;
}

interface ProjectionCheckpointStore<TCtx> {
  withCheckpointLocks<R>(
    ctx: TCtx,
    projection: string,
    addresses: ReadonlyArray<AggregateAddress>,
    work: () => Promise<R>,
  ): Promise<R>;

  load(
    ctx: TCtx,
    projection: string,
    address: AggregateAddress,
  ): Promise<ProjectionCheckpoint | undefined>;

  save(
    ctx: TCtx,
    projection: string,
    address: AggregateAddress,
    checkpoint: ProjectionCheckpoint,
  ): Promise<void>;

  hasReached(
    projection: string,
    address: AggregateAddress,
    position: ProjectionPosition,
  ): Promise<boolean>;

  reset(ctx: TCtx, projection: string): Promise<void>;
}
```

`withCommit` supplies the source plus current commit facts; the outbox/event
source finalizes all four cursor fields on `CommittedDomainEvent.position`.
The envelope's `source` is authoritative. Optional `aggregateId` and
`aggregateType` values repeated on the bare event must match it; a contradiction
throws `ForeignEventError` before the transaction starts. Missing optional
event stamps are allowed because the committed envelope already supplies the
address.
`commitSize` proves that every event of the current commit was consumed;
`previousEventfulAggregateVersion` links the next eventful commit to the
checkpoint. State-only aggregate saves are intentionally absent from that
chain. The projector rejects a missing
sequence, an incomplete commit, a missing aggregate commit, and a first event
that claims a predecessor. It never advances past an unknown hole.

Only after that chain has been verified does a position at or behind the
watermark count as already traversed under the source contract. A reordering
transport therefore fails loudly at the first gap instead of silently dropping
the late event. Repair/replay the missing event (or reset and rebuild) before
the chain can advance.

The checkpoint stores the full position receipt plus the `eventId` at exactly
its watermark. If the source later supplies another ID at that position, the
projector throws `ProjectionIdentityViolationError` before `apply`. If the ID
matches but `commitSize` or `previousEventfulAggregateVersion` changes, it
throws `ProjectionReceiptViolationError`: identity alone cannot prove that the
source has not rewritten its chain. The same two checks run for repeated
positions inside one batch. Only an exact receipt -- the same ID and all four
position fields -- is an ordinary redelivery.

This is deliberately a bounded receipt, not an unbounded processed-event
ledger. A position older than the watermark cannot be compared with the stored
receipt; skipping it relies on the source invariant that one qualified
aggregate position maps immutably to one logical event and one commit shape.
Enforce that at the persistence boundary with a unique key such as
`(aggregate_type, aggregate_id, aggregate_version, commit_sequence)`, and reject
conflicting IDs or commit sizes before advancing the source head. `eventId` is
a consistency check, not a security proof for messages from an untrusted
producer.

The projector also scans each batch before `apply`: when two distinct positions
that were both still unseen at batch start descend for the same aggregate, it
throws `ProjectionOrderViolationError`. Positions already covered by the
batch-start checkpoint remain valid late redeliveries. An exact receipt already
seen earlier in the same batch is also a legal redelivery, even after a later
position; it is not mistaken for an inversion.

The `aggregateType` in the address is a technical stream category: unique
across everything feeding one checkpoint store. Two bounded contexts may both
have an `Order`; if their events share projection infrastructure, qualify the
name at the source ("sales.order", "fulfillment.order").

This means your read-model rows do not need their own event-id column for the
normal kit path. The checkpoint table does need `lastAppliedEventId` plus all
four position fields. If the dispatcher redelivers the same event after a
crash, the checkpoint verifies an exact watermark receipt or recognizes an
older traversed position and skips it before `apply` runs.

The checkpoint table must live in the same database as the read model. The
read-model update and checkpoint save are one transaction. A checkpoint
without the row update loses events; a row update without the checkpoint
replays work. The projector keeps those two writes together, but your adapter
must participate in the same transaction.

Competing projector instances also need exclusion around the complete
`load -> apply -> save` path. `Projector` calls the required
`withCheckpointLocks` port method inside that transaction with a unique,
canonically sorted address set. The adapter must serialize every
`(projection, aggregateType, aggregateId)` key even when no checkpoint exists
yet. `SELECT ... FOR UPDATE` on the checkpoint table alone is wrong at
genesis: an absent row locks nothing, so two consumers can both observe
`undefined` and apply the first event.

For PostgreSQL, one correct implementation acquires a transaction-scoped
advisory lock for every sorted key before invoking `work`:

```ts
async function withCheckpointLocks<R>(
  tx: DbTx,
  projection: string,
  addresses: ReadonlyArray<AggregateAddress>,
  work: () => Promise<R>,
): Promise<R> {
  const keys = [...new Set(
    addresses.map(({ aggregateType, aggregateId }) =>
      JSON.stringify([projection, aggregateType, aggregateId]),
    ),
  )].sort();

  for (const key of keys) {
    await tx.query(
      "select pg_advisory_xact_lock(hashtextextended($1, 0))",
      [key],
    );
  }
  return work(); // the database retains xact locks through commit/rollback
}
```

A collision in the database hash only over-serializes unrelated keys; it does
not weaken correctness. Run this advisory-lock recipe at `READ COMMITTED`, so
the checkpoint load after a wait receives a fresh statement snapshot containing
the preceding holder's commit. At `REPEATABLE READ` or another transaction-wide
snapshot level, a contender can retain the pre-wait snapshot; use a
serialization-conflict retry/CAS protocol that the contract suite proves, or a
different acquisition boundary.

A database-neutral alternative is a permanent lock table keyed by the same
triple: `INSERT ... ON CONFLICT DO NOTHING`, then lock those rows in canonical
order with `SELECT ... FOR UPDATE` before `work`. Do not delete those lock rows
while projectors are active. Whichever recipe you choose, the callback must
observe the checkpoint committed by the previous holder, not merely run later
in wall-clock time.

An adapter that cannot provide missing-key exclusion supports only a hard
single-projector topology for each projection. A no-op
`withCheckpointLocks(..., work) { return work(); }` may express that local
deployment restriction, but it is not safe for competing consumers and does
not conform to the concurrency contract test. The in-memory reference provides
process-local exclusion only across projectors sharing the same store instance;
it is not a distributed lock and remains non-transactional.

Checkpoint rows are correctness state, not a cache: never TTL or prune an
active aggregate's row. Reclaim one only after the source guarantees that the
stream is terminal and its complete redelivery/retention window has elapsed;
otherwise a later event rejects as a gap and the projection must be rebuilt.

When migrating a pre-identity checkpoint table, add the event-id column and
reset/rebuild the projection. A fabricated placeholder cannot prove which
event established an existing watermark.

Use `createProjectionCheckpointStoreContractTests` from
`@shirudo/ddd-kit/testing` to verify a production adapter. Set the harness's
`providesConcurrentRuns` capability to exercise exclusive access for both
absent and existing checkpoint rows; a skipped capability leaves that guarantee
explicitly unproven. Transactional adapters should also enable the rollback
capability.

`InMemoryProjectionCheckpointStore` is a test/reference implementation. It is
not transaction-aware, so it does not prove production rollback behavior.

## Feeding The Projector

For the common outbox path, adapt the projector as an `OutboxSink`:

```ts
import { OutboxDispatcher } from "@shirudo/ddd-kit";

const dispatcher = new OutboxDispatcher({
  outbox,
  sink: projector.toOutboxSink(),
});

const stop = new AbortController();
void dispatcher.run(stop.signal);
```

`toOutboxSink()` projects one outbox record at a time. If projection fails,
the sink throws, the dispatcher leaves the outbox record pending, and the next
poll retries it.

You can also feed batches directly:

```ts
const result = await projector.project(committedEvents);

log.info({
  applied: result.applied,
  skipped: result.skipped,
});
```

That is useful for queue consumers, tests, and replay jobs.

The projector accepts committed envelopes, not bare domain events. `withCommit`
creates those envelopes automatically. For another source, compose the event
with that source's gap-proof predecessor chain:

```ts
const committed = storedEvents.map(({ event, streamId }) => ({
  event,
  source: {
    aggregateType: streamId.type,
    aggregateId: streamId.id,
  },
  position: {
    aggregateVersion: event.storePosition,
    commitSequence: 0,
    commitSize: 1,
    previousEventfulAggregateVersion: event.previousStorePosition,
  },
}));

await projector.project(committed);
```

Use this when an event store's stream position and predecessor link are the
authority. A missing or malformed envelope cursor rejects with
`UnprojectableEventError` because it cannot be safely deduped. A valid cursor
that does not continue the stored chain rejects with `ProjectionGapError`
(`INFRASTRUCTURE`) so retry/reconciliation can distinguish a delivery gap from
bad projector wiring. Descending unseen positions inside one input batch reject
with `ProjectionOrderViolationError`, identifying a per-aggregate transport
ordering violation directly. A different `eventId` at one batch position or at
the stored watermark rejects with `ProjectionIdentityViolationError`, exposing
a broken source-position mapping. The same ID with a different commit size or
predecessor rejects with `ProjectionReceiptViolationError`, exposing a rewritten
source-chain receipt.

## Several Projections From One Outbox

The outbox has one dispatched flag per record. If one event feeds several read
models, fan out in the sink:

```ts
const sink: OutboxSink<OrderEvent> = {
  publish: async (record) => {
    await orderListProjector.project([record]);
    await orderDetailProjector.project([record]);
  },
};
```

If `orderDetailProjector` fails after `orderListProjector` succeeds, the
outbox record stays pending. On retry, `orderListProjector` skips the event
via its checkpoint, then `orderDetailProjector` gets another chance. The
record is acknowledged only after every projector has processed it.

Competing projector instances are safe only when the checkpoint adapter meets
the `withCheckpointLocks` missing-key contract described above. Otherwise,
enforce one logical projector instance per projection at deployment level.

## QueryHandlers Read The Projection

Once the read model exists, the query handler reads it directly.

```ts
import type { Query, QueryHandler } from "@shirudo/ddd-kit";
import {
  moneyFromDto,
  moneyToDto,
  type MoneyDto,
} from "@shirudo/ddd-kit/money";

type GetOrderListQuery = Query & {
  type: "GetOrderList";
  customerId: string;
  limit?: number;
};

type OrderListItem = {
  id: string;
  customerName: string;
  total: MoneyDto;
  itemCount: number;
  status: string;
};

function moneyDtoFromColumns(
  amountMinor: string,
  currency: string,
  scale: number,
): MoneyDto {
  return moneyToDto(moneyFromDto({ amountMinor, currency, scale }));
}

const getOrderList: QueryHandler<
  GetOrderListQuery,
  ReadonlyArray<OrderListItem>
> = async (query) => {
  const rows = await db("order_list_views")
    .select(
      "id",
      "customer_name",
      "total_minor",
      "total_currency",
      "total_scale",
      "item_count",
      "status",
    )
    .where({ customer_id: query.customerId })
    .orderBy("updated_at", "desc")
    .limit(query.limit ?? 50);

  return rows.map((row) => ({
    id: row.id,
    customerName: row.customer_name,
    total: moneyDtoFromColumns(
      String(row.total_minor),
      row.total_currency,
      Number(row.total_scale),
    ),
    itemCount: row.item_count,
    status: row.status,
  }));
};

queryBus.register("GetOrderList", getOrderList);
```

A query handler returns data. `QueryBus.execute(...)` wraps that result in the
kit's `Result` type; the handler itself does not return `ok(...)`.

## Eventual Consistency

Projection lag is normal. In a healthy local setup it is often tiny, but it is
still real: write, outbox, dispatcher, projector, query.

Measure lag at the transport/source boundary — for example oldest pending
outbox age and depth, broker partition lag, or subscription distance — not by
counting per-aggregate checkpoint rows. Per-address watermarks prove local
progress and power bounded waits; without a global source position they cannot
produce one meaningful global lag number.

Handle that in the product flow:

- Optimistic UI: update the local screen after the command succeeds, then let
  the projection catch up.
- Read-your-own-write: for the user who just wrote, return or query the
  aggregate result from the command path.
- Bounded wait: wait until the projection reaches the commit position, then
  read the view. If it does not catch up before the deadline, return the stale
  view with an explicit pending state.

`Projector.hasProcessed(...)` is the primitive for bounded waits:

```ts
const caughtUp = await projector.hasProcessed(
  { aggregateType: "Order", aggregateId: orderId },
  {
    aggregateVersion: 12,
    commitSequence: 1,
    commitSize: 2,
    previousEventfulAggregateVersion: 10,
  },
);
```

Pass the position of the last event your command emitted. Version alone is not
enough because several events in one commit can share the same
`aggregateVersion`.

## Rebuilds

`projector.reset()` clears this projection's checkpoints and calls
`projection.truncate(...)` in one transaction when `truncate` exists.
Stop every live consumer for that projection before reset and keep them stopped
until the replay has caught up; reset is an operational exclusivity boundary,
not an address-scoped delivery operation.

```ts
await projector.reset();

for await (const batch of eventHistory.readBatches()) {
  await projector.project(batch);
}
```

The reset is only the start. You still need a history source:

- Event-sourced aggregates can replay from the event store.
- State-stored aggregates need a separate event archive if you want full
  historical rebuilds.
- Without history, you can seed a read model from current aggregate state, but
  that is not the same as replay.

The outbox is not an event log. It is a handoff buffer. Once records are
dispatched, it may mark them done or remove them depending on the adapter.

A rebuild must also respect privacy and retention rules. Do not replay data
that the system is no longer allowed to materialize.

## Poison Events

Projection failures are delivery failures. If `apply` throws, the dispatcher
does not ack the outbox record.

There are two real strategies:

- Plain `Outbox`: the poison event retries forever with backoff. The read
  model stalls, but it does not skip the bad event.
- `DispatchTrackingOutbox`: after the attempt ceiling, the event is
  dead-lettered. Unrelated aggregates can flow; the affected aggregate's
  next event is rejected by the cursor gap.

Dead-lettering projection events is not free, but it no longer permits silent
loss: a later event from the same aggregate cannot advance the checkpoint past
the missing sequence/commit.

The normal remediation is a code/data fix followed by redelivery of the missing
event, or a projection rebuild. Wire `deadLetters()` to alerting.

## Projection vs Process Manager

Both consume events, but they have different responsibilities.

A projection updates a read model. It does not issue commands, does not make
business decisions, and does not protect invariants.

A process manager coordinates a workflow. It reacts to events by issuing
commands, and if it needs state, that state should be modeled explicitly.

Do not hide workflow decisions in a projection handler. If an event should
trigger payment, shipping, email, or another command, that is not a read-model
update.

## Full Wiring Sketch

```ts
import {
  CommandBus,
  EventBusImpl,
  InMemoryOutbox,
  OutboxDispatcher,
  Projector,
  QueryBus,
  withCommit,
} from "@shirudo/ddd-kit";
import { ok } from "@shirudo/result";

const outbox = new InMemoryOutbox<OrderEvent>();
const bus = new EventBusImpl<OrderEvent>();
const commands = new CommandBus<OrderCommands>();
const queries = new QueryBus<OrderQueries>();

const orderListProjector = new Projector({
  scope,
  checkpoints: checkpointStore,
  projection: orderListProjection,
});

const dispatcher = new OutboxDispatcher({
  outbox,
  sink: orderListProjector.toOutboxSink(),
});

const stop = new AbortController();
void dispatcher.run(stop.signal);

commands.register("CreateOrder", async (command) => {
  return withCommit({ scope, outbox, bus }, async (tx, enrollment) => {
    const orders = makeOrderRepository(tx);
    const order = Order.create(orderIds.next(), command.customerId);

    for (const line of command.lines) {
      order.addLine(line.sku, line.quantity, line.price);
    }

    await orders.save(order);

    return {
      result: ok(order.id),
      commits: [enrollment.enrollSaved(order)],
    };
  });
});

queries.register("GetOrderList", getOrderList);
```

This sketch has three contracts:

- `withCommit` writes state and outbox events atomically.
- The dispatcher delivers at least once.
- The projector updates the read model and checkpoint atomically.

If those hold, the read model converges to the event history.

## What The Kit Does Not Own

The kit does not define your read-model schema. That belongs to the query.

It does not ship a read-model ORM abstraction. `Projection.apply` writes with
your database tool.

It does not provide a universal replay source. Event stores, event archives,
CDC logs, and current-state rebuilds have different semantics.

It does not make projection handlers safe for side effects. Keep side effects
out of projections.
