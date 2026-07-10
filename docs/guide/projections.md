# Read-Side Projections

Aggregates are built for decisions. Read models are built for screens.

That is the reason projections exist. A command handler loads an aggregate
because it must protect invariants. A query handler should usually not load
three aggregates, calculate display fields, and sort them in memory. It should
read a table shaped for the query.

The normal flow is:

1. A use case mutates an aggregate.
2. `withCommit` saves the aggregate and writes its domain events to the
   outbox in the same transaction.
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
  type Projection,
  type ProjectionCheckpointStore,
} from "@shirudo/ddd-kit";

const orderListProjection: Projection<OrderEvent, DbTx> = {
  name: "order-list",

  apply: async (tx, event) => {
    switch (event.type) {
      case "OrderCreated":
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
        return;

      case "OrderLineAdded":
        await tx("order_list_views")
          .where({ id: event.aggregateId })
          .update({
            total_minor: tx.raw("total_minor + ?", [
              event.payload.lineTotal.amountMinor.toString(),
            ]),
            item_count: tx.raw("item_count + 1"),
            updated_at: event.occurredAt,
          });
        return;

      case "OrderConfirmed":
        await tx("order_list_views")
          .where({ id: event.aggregateId })
          .update({
            status: "confirmed",
            updated_at: event.occurredAt,
          });
        return;

      case "OrderCancelled":
        await tx("order_list_views").where({ id: event.aggregateId }).delete();
        return;
    }
  },

  truncate: async (tx) => {
    await tx("order_list_views").truncate();
  },
};

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

## Checkpoints

The projector stores one watermark per `(projection, aggregateType,
aggregateId)`. The type is part of the key because identities are type-scoped
(`Order 1` and `Payment 1` are different aggregates even when the raw id
strings collide), and every event `withCommit` harvests carries both stamps.
Two consequences for adapters: the checkpoint table's primary key is the full
triple, and the `aggregateType` string becomes a durable contract, so renaming
an aggregate type means migrating its checkpoint rows.

```ts
interface ProjectionPosition {
  aggregateVersion: number;
  commitSequence: number;
}

interface AggregateAddress {
  aggregateType: string;
  aggregateId: string;
}

interface ProjectionCheckpointStore<TCtx> {
  load(
    ctx: TCtx,
    projection: string,
    address: AggregateAddress,
  ): Promise<ProjectionPosition | undefined>;

  save(
    ctx: TCtx,
    projection: string,
    address: AggregateAddress,
    position: ProjectionPosition,
  ): Promise<void>;

  hasReached(
    projection: string,
    address: AggregateAddress,
    position: ProjectionPosition,
  ): Promise<boolean>;

  reset(ctx: TCtx, projection: string): Promise<void>;
}
```

`withCommit` stamps harvested events with `aggregateVersion` and
`commitSequence`. Together they form a total order for one aggregate. The
projector uses that pair to skip duplicates and stale events.

This means your `apply` handler does not need a per-row event-id column for
the normal kit path. If the dispatcher redelivers the same event after a
crash, the checkpoint sees that the event is at or behind the watermark and
skips it before `apply` runs.

The checkpoint table must live in the same database as the read model. The
read-model update and checkpoint save are one transaction. A checkpoint
without the row update loses events; a row update without the checkpoint
replays work. The projector keeps those two writes together, but your adapter
must participate in the same transaction.

Use `createProjectionCheckpointStoreContractTests` from
`@shirudo/ddd-kit/testing` to verify a production adapter.

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
const result = await projector.project(events);

log.info({
  applied: result.applied,
  skipped: result.skipped,
});
```

That is useful for queue consumers, tests, and replay jobs.

Events must have a cursor. The default cursor is
`(event.aggregateVersion, event.commitSequence)`, which `withCommit` supplies.
For another source, pass a custom extractor:

```ts
const projector = new Projector({
  scope,
  checkpoints,
  projection,
  position: (event) => event.storePosition,
});
```

Use this when replaying from an event store whose own stream position is the
authority. An event with no cursor rejects with `UnprojectableEventError`
because it cannot be safely deduped.

## Several Projections From One Outbox

The outbox has one dispatched flag per record. If one event feeds several read
models, fan out in the sink:

```ts
const sink: OutboxSink<OrderEvent> = {
  publish: async (record) => {
    await orderListProjector.project([record.event]);
    await orderDetailProjector.project([record.event]);
  },
};
```

If `orderDetailProjector` fails after `orderListProjector` succeeds, the
outbox record stays pending. On retry, `orderListProjector` skips the event
via its checkpoint, then `orderDetailProjector` gets another chance. The
record is acknowledged only after every projector has processed it.

Run one logical projector instance per projection unless your checkpoint
adapter serializes the check-then-apply path, for example with a row lock on
the checkpoint row.

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
  { aggregateVersion: 12, commitSequence: 1 },
);
```

Pass the position of the last event your command emitted. Version alone is not
enough because several events in one commit can share the same
`aggregateVersion`.

## Rebuilds

`projector.reset()` clears this projection's checkpoints and calls
`projection.truncate(...)` in one transaction when `truncate` exists.

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
  dead-lettered and later events can flow.

Dead-lettering projection events is not free. If a later event from the same
aggregate advances the checkpoint, redelivering the old dead letter later will
look stale and be skipped. Applying it out of order would be wrong anyway.

The normal remediation is a code/data fix followed by a projection rebuild, or
a manual read-model correction when a rebuild is not appropriate. Wire
`deadLetters()` to alerting.

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
  return withCommit({ scope, outbox, bus }, async (tx) => {
    const orders = makeOrderRepository(tx);
    const order = Order.create(orderIds.next(), command.customerId);

    for (const line of command.lines) {
      order.addLine(line.sku, line.quantity, line.price);
    }

    await orders.save(order);

    return { result: ok(order.id), aggregates: [order] };
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
