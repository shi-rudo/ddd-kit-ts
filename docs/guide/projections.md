# Read-Side Projections

In CQRS the write side and the read side have different shapes. Aggregates are optimised for **invariants and mutation** (Vernon IDDD §10: small, single-transaction-bounded). Read models are optimised for **the queries your UI actually asks** (denormalised, often spanning multiple aggregate types, often duplicated across views).

The bridge between the two is the **transactional outbox + projection** pipeline. The pieces ship in this kit; their composition is your call. This page documents the canonical wiring.

## The flow at a glance

```
┌──────────────────┐  withCommit          ┌─────────────┐
│ Use Case         │  ──────────────────▶ │ outbox table │
│ (writes order)   │   tx-atomic add      └─────────────┘
└──────────────────┘                            │
                                                │ polled by
                                                ▼
                                         ┌──────────────┐
                                         │ dispatcher   │
                                         │ (cron / loop)│
                                         └──────────────┘
                                                │
                                                │ event → projection handler
                                                ▼
                                         ┌──────────────┐
                                         │ projection   │  (eventType-keyed map,
                                         │ handlers     │   idempotent updates)
                                         └──────────────┘
                                                │
                                                │ UPSERT
                                                ▼
                                         ┌──────────────┐
                                         │ read model   │  (denormalised table,
                                         │ table        │   one per query view)
                                         └──────────────┘
                                                │
                                                │ SELECT
                                                ▼
                                         ┌──────────────┐
                                         │ QueryHandler │
                                         └──────────────┘
                                                │
                                                ▼
                                         ┌──────────────┐
                                         │ QueryBus     │
                                         └──────────────┘
```

The whole right column is **eventually consistent** with the left. Sub-second lag is typical; the trade-off is the read side can be denormalised, replicated, and scaled independently.

## When you need this

You don't always. Rules of thumb:

- **Small app, no scale problems**: skip projections. A `QueryHandler` that calls `orderRepository.findById(id)` and returns the aggregate is fine. The pieces in this guide are dormant until you need them.
- **The read query needs fields from multiple aggregates**: projections start paying for themselves. Loading three aggregates per request to derive one view is the wrong shape.
- **You need to scale reads independently from writes**: projections are the canonical answer.
- **Read patterns differ from write patterns** (search, full-text, aggregations, list views): yes.

### Projection vs Process Manager (Saga)

Both projections and process managers consume events from the outbox. They are different things:

- A **projection** updates a read model: a table you `SELECT` from. It does not issue commands, does not change domain state, does not have invariants. Pure state-of-the-world for queries.
- A **process manager / saga** orchestrates multi-step business workflows by **issuing commands** in response to events (e.g. on `OrderConfirmed`, dispatch a `RequestPayment` command; on `PaymentReceived`, dispatch `RequestShipping`). Its own state lives in an aggregate; the kit treats it as a regular aggregate that happens to be driven by events instead of direct user commands.

A single application has many of both. They share the dispatcher pipeline but serve different purposes; this page is about projections only.

## The read-model schema

A read model is a **table shaped exactly for the query that reads it**. It is not an aggregate. It is not normalised. It carries denormalised copies of whatever fields the view needs:

```sql
CREATE TABLE order_list_views (
  id              TEXT PRIMARY KEY,
  customer_name   TEXT NOT NULL,    -- denormalised from Customer
  total_cents     INT  NOT NULL,
  item_count      INT  NOT NULL,    -- derived; not on the aggregate
  status          TEXT NOT NULL,
  last_event_id   TEXT NOT NULL,    -- for projection idempotency, see below
  updated_at      TIMESTAMP
);
```

You'll typically have several read-model tables per bounded context, one per view shape. `order_list_views`, `order_detail_views`, `order_invoice_views` are three separate tables, each populated by a different projection handler reading the same event stream.

## The dispatcher loop

A background process polls the outbox, dispatches each pending event to one or more projection handlers, and marks the events dispatched on success. The kit ships `OutboxDispatcher` for exactly this (see the [outbox guide](./outbox.md), "The kit dispatcher"): long-running `run(signal)` for workers, `drainOnce()` per tick for cron and serverless. Wire a projector into it via `projector.toOutboxSink()` (below), or any handler via a custom `OutboxSink`.

**Poison events are a projection concern too.** The dispatcher is sequential
with stop-on-failure, so one event that deterministically fails in a
projection handler (a malformed payload, a handler bug) blocks EVERY event
behind it: all read models on that dispatcher stop updating. Your two options
are the two halves of a real trade-off:

- **Plain `Outbox`**: the poison event retries forever (rate-limited by the
  backoff). The read model stalls but stays consistent; delivery resumes the
  moment you fix the handler.
- **`DispatchTrackingOutbox`**: the attempt ceiling dead-letters the poison
  event and the queue flows again, but that leaves a **permanent hole** in the
  read model. Later events of the same aggregate advance the projection's
  watermark past the dead letter, and the cursor cannot distinguish "already
  applied" from "never applied": redelivering the dead letter afterwards is a
  silent skip, and applying it out of order would be wrong anyway. The
  remediation for a dead-lettered projection event is a rebuild
  (`projector.reset()` + replay) or a manual read-model correction, which is
  why wiring `deadLetters()` to alerting matters doubly for projections.

### Queue-based alternative

For higher throughput or multi-tenant fanout, replace polling with a queue:

1. The outbox dispatcher pushes each pending event to a durable queue (SQS, NATS, Redis Streams) and marks dispatched on enqueue success.
2. Projection handlers subscribe to the queue and process events independently.

This shifts the back-pressure problem from "polling rate" to "queue capacity" and lets you parallelise projections across consumers, at the cost of an extra moving piece.

## The kit projector

The mechanics `read-model-design.md` demands (idempotent apply, update and checkpoint committed atomically, ordering cursor, rebuild, wait-for-version) ship as `Projector` plus the `ProjectionCheckpointStore` port, so your handler is a plain event-to-row mapping:

```ts
import {
  Projector,
  type Projection,
  type ProjectionCheckpointStore,
} from "@shirudo/ddd-kit";

const orderList: Projection<OrderEvent, KnexTx> = {
  name: "order-list", // keys the checkpoints; renaming replays from zero
  apply: async (tx, event) => {
    switch (event.type) {
      case "OrderCreated":
        await tx("order_list_views").insert({ /* ... */ });
        return;
      case "OrderCancelled":
        // Deletes/tombstones handled explicitly, not upsert-only.
        await tx("order_list_views").where({ id: event.aggregateId }).delete();
        return;
    }
  },
  truncate: async (tx) => {
    await tx("order_list_views").truncate(); // rebuild support
  },
};

const projector = new Projector({
  scope,                       // the SAME database as the read model
  checkpoints: checkpointStore, // your ProjectionCheckpointStore adapter
  projection: orderList,
});

// Feed it: straight from the dispatcher...
const dispatcher = new OutboxDispatcher({ outbox, sink: projector.toOutboxSink() });
// ...or batch-wise from any source (queue consumer, replay):
await projector.project(events);
```

What the runner guarantees:

- **Update and checkpoint commit atomically.** One `project(batch)` call is one `TransactionScope` transaction; a failure rolls back rows AND checkpoints together, so at-least-once redelivery replays cleanly. It is never possible to checkpoint an unapplied event.
- **Duplicates and stale events are skipped by the cursor.** The watermark is the `(aggregateVersion, commitSequence)` pair `withCommit` already stamps on every harvested event: a total order per aggregate. Your `apply` never sees an event at or behind the watermark, so plain writes are safe without `last_event_id` tricks.
- **Uncursored events fail loudly.** Events that did not pass through `withCommit` carry no stamps; either stamp them or supply the `position` extractor option (an event-sourced replay uses the store's own position).
- **Wait-for-version**: `projector.hasProcessed(aggregateId, position)` answers "has this projection caught up to my commit". Pass the position of the last event your commit emitted; comparing on the version alone would report "reached" while later events of the same commit are still unapplied.
- **Rebuild**: `projector.reset()` truncates the read model (via the projection's `truncate`) and clears the checkpoints in one transaction; then replay the history through `project`. This is why `apply` must be side-effect-free.

One `Projector` per read model; several projectors share one checkpoint store under distinct projection names. Like the dispatcher, run one logical projector instance per projection unless your checkpoint adapter serializes the check-then-apply (row lock on the checkpoint row).

### Several projections, one outbox

The outbox has ONE dispatched flag per record, so fan-out to several read
models happens in the sink, not in the outbox. A composite sink feeds each
projector in turn; the per-projector watermark is exactly the per-consumer
cursor that makes this safe:

```ts
const sink: OutboxSink<OrderEvent> = {
  publish: async (record) => {
    await orderListProjector.project([record.event]);
    await orderDetailProjector.project([record.event]);
  },
};
```

When `orderDetailProjector` fails, the record stays pending and the whole sink
retries; `orderListProjector` then skips its already-applied event via the
watermark instead of double-applying it. The record is acked only once every
projector has processed it.

The `ProjectionCheckpointStore` adapter (a two-column table keyed by `(projection, aggregate_id)` next to your read models) is verified with `createProjectionCheckpointStoreContractTests` from `@shirudo/ddd-kit/testing`; `InMemoryProjectionCheckpointStore` is the reference for tests and in-memory views.

**Why a per-aggregate cursor, not a global one:** the watermark rides on the event itself (`withCommit` stamps it), so it survives every transport (outbox, broker, replay), and per-aggregate order is the only order the kit guarantees; a global cursor would need a globally ordered, gap-free feed the ports deliberately do not promise. The cost is honest: one checkpoint row per `(projection, aggregate)` instead of one per projection, the same cardinality the common `last_event_id` column pattern hides inside the read model. For a source that does carry a global position (an event store), feed it through the `position` extractor. Projection lag is monitored on the outbox side (age of the oldest pending record, see the outbox production checklist), not on the checkpoint table.

## Projection handlers

A projection handler maps **one event** to **one read-model update**. Where you bypass the kit projector (or inside `apply` when you prefer the shape), the canonical routing is an event-type-keyed map, mirroring `EventSourcedAggregate.handlers`:

```ts
import type { DomainEvent } from "@shirudo/ddd-kit";

type OrderCreated  = DomainEvent<"OrderCreated",  { customerId: string; customerName: string }>;
type OrderConfirmed = DomainEvent<"OrderConfirmed", { confirmedAt: string }>;
type OrderItemAdded = DomainEvent<"OrderItemAdded", { productId: string; quantity: number; priceCents: number }>;

type OrderEvent = OrderCreated | OrderConfirmed | OrderItemAdded;

class OrderListProjection {
  constructor(private readonly db: Db) {}

  // Single entry point the dispatcher calls; routes on event.type.
  handle = async (event: OrderEvent): Promise<void> => {
    const handler = this.handlers[event.type] as
      | ((e: typeof event) => Promise<void>)
      | undefined;
    if (handler) await handler(event);
  };

  private readonly handlers: {
    [K in OrderEvent["type"]]: (
      e: Extract<OrderEvent, { type: K }>,
    ) => Promise<void>;
  } = {
    OrderCreated: async (e) => {
      // Idempotent UPSERT: insert if missing, no-op if last_event_id
      // already matches this event's id.
      await this.db.execute(sql`
        INSERT INTO order_list_views (id, customer_name, total_cents, item_count, status, last_event_id)
        VALUES (${e.aggregateId}, ${e.payload.customerName}, 0, 0, 'pending', ${e.eventId})
        ON CONFLICT (id) DO UPDATE SET
          customer_name = EXCLUDED.customer_name,
          last_event_id = EXCLUDED.last_event_id
        WHERE order_list_views.last_event_id <> EXCLUDED.last_event_id
      `);
    },

    OrderItemAdded: async (e) => {
      await this.db.execute(sql`
        UPDATE order_list_views
        SET total_cents   = total_cents + ${e.payload.quantity * e.payload.priceCents},
            item_count    = item_count  + ${e.payload.quantity},
            last_event_id = ${e.eventId}
        WHERE id = ${e.aggregateId}
          AND last_event_id <> ${e.eventId}
      `);
    },

    OrderConfirmed: async (e) => {
      await this.db.execute(sql`
        UPDATE order_list_views
        SET status = 'confirmed', last_event_id = ${e.eventId}
        WHERE id = ${e.aggregateId} AND last_event_id <> ${e.eventId}
      `);
    },
  };
}
```

A few things to notice:

1. **Routing is on `event.type`**, the same pattern as `EventSourcedAggregate.handlers`. The dispatcher hands the projection a typed `OrderEvent`; the handler narrows via the discriminator.
2. **One projection class per read-model table.** `OrderListProjection` only touches `order_list_views`. A separate `OrderDetailProjection` would handle the same events but write to `order_detail_views`. This keeps each projection's failure mode isolated.
3. **Many projections from one outbox.** The dispatcher can route the same event to multiple projections, and each gets its own `markDispatched` accounting (use a separate "subscription cursor" per projection, or extend `Outbox` with multi-consumer tracking if your store supports it).

### Idempotency: the `last_event_id` trick

The dispatcher may retry on partial failure (process killed between `handle` succeeding and `markDispatched` succeeding). The projection handler MUST be safe to apply the same event twice.

The simplest pattern is the `last_event_id` column above:

- Every UPDATE / UPSERT carries `WHERE last_event_id <> incoming.eventId`.
- A retry of the same event is a no-op (the predicate fails; zero rows affected).
- This works regardless of whether the events are commutative (`OrderItemAdded` adding `+5` to a total is NOT commutative: applying it twice would double-count).

For projections that span aggregates (a `customer_with_recent_orders_view` updated by both `CustomerCreated` and `OrderCreated`), the **same single column still works**: `eventId` is globally unique, so `WHERE last_event_id <> incoming.eventId` skips duplicates regardless of source. Per-aggregate tracking columns are only needed if you also need **per-stream ordering guarantees** ("apply `CustomerCreated` before any `OrderCreated` for that customer"), and that's a separate concern from idempotency. The simplest pattern for ordering is a `processed_events(projection_id, event_id)` audit table queried before applying.

### Pure projections

Projections do not have invariants. They do not return `DomainError`. They do not validate. They are stateless functions of `(currentRow, event) → newRow`. The closest the kit gets to encoding this is: a `ProjectionHandler<E>` is just `(event: E) => Promise<void>`. There is no library type for it because there is nothing to constrain; projections are just functions.

If a projection handler throws, **let it throw**. The dispatcher will leave the event in the outbox and retry next tick. Don't catch-and-swallow inside the handler; that silently drops events from the read model.

## QueryHandlers read from projections

Once a read model exists, the `QueryHandler` reads from it directly, **not** from the aggregate repository:

```ts
import type { QueryHandler } from "@shirudo/ddd-kit";

type GetOrderListQuery = Query & {
  type: "GetOrderList";
  customerId: string;
  limit?: number;
};

type OrderListItem = {
  id: string;
  customerName: string;
  totalCents: number;
  itemCount: number;
  status: string;
};

const getOrderListHandler: QueryHandler<GetOrderListQuery, OrderListItem[]> = async (q) => {
  return await db.execute(sql`
    SELECT id, customer_name AS "customerName", total_cents AS "totalCents",
           item_count AS "itemCount", status
    FROM order_list_views
    WHERE customer_id = ${q.customerId}
    ORDER BY updated_at DESC
    LIMIT ${q.limit ?? 50}
  `);
};

queryBus.register("GetOrderList", getOrderListHandler);
```

Contrast with the typical write-side handler shown in [CQRS & Buses](./cqrs-and-buses.md):

```ts
// Loads the aggregate. Fine for "GetOrder by id"; awful for "GetOrderList".
const getOrderHandler: QueryHandler<GetOrderQuery, Order | null> = async (q) => {
  return await orderRepository.findById(q.orderId as OrderId);
};
```

Both shapes coexist in one codebase. Single-id lookups can hit the aggregate; list/search/aggregation queries hit projections. Mix as needed.

## Eventual consistency

The write→outbox→dispatcher→projection→query chain has measurable lag. In a healthy in-process system, sub-second is typical. Under load, it can stretch.

The library does not hide this: eventual consistency is a fact of distributed systems, not a bug to abstract over. UX strategies:

1. **Optimistic UI updates**: after a successful command, update the local UI without waiting for the projection. The next refresh confirms.
2. **Read-your-own-writes via the aggregate**: for the user who just wrote, query the aggregate directly (write-side) instead of the projection. Inconsistent everywhere else, but the writer sees their own action immediately.
3. **Bounded wait**: poll the projection for up to N ms; if the expected change hasn't landed, return the stale view.

Vernon discusses these in IDDD §4. None of them require library support; they are application-layer decisions.

## The full topology

```ts
// Application bootstrap
import {
  InMemoryOutbox,
  EventBusImpl,
  CommandBus,
  QueryBus,
  OutboxDispatcher,
  Projector,
  withCommit,
} from "@shirudo/ddd-kit";

const outbox = new InMemoryOutbox<OrderEvent>();
const bus    = new EventBusImpl<OrderEvent>();
const commands = new CommandBus<OrderCommands>();
const queries  = new QueryBus<OrderQueries>();

// Wire the projection (see "The kit projector" above)
const orderListProjector = new Projector({
  scope,
  checkpoints: checkpointStore,
  projection: orderList,
});

// Start the dispatcher
const controller = new AbortController();
const dispatcher = new OutboxDispatcher({
  outbox,
  sink: orderListProjector.toOutboxSink(),
});
void dispatcher.run(controller.signal);

// Command path: writes go through withCommit -> outbox
commands.register("CreateOrder", async (cmd) => {
  return withCommit({ outbox, bus, scope }, async (tx) => {
    const orderRepository = makeOrderRepository(tx);
    const order = Order.create(idGen.next(), cmd.customerId);
    for (const item of cmd.items) {
      order.addItem(item.productId, item.quantity, item.priceCents);
    }
    await orderRepository.save(order);
    return { result: ok(order.id), aggregates: [order] };
  });
});

// Query path: reads from the projection
queries.register("GetOrderList", getOrderListHandler);
```

Three contracts hold this together:

1. **`withCommit` writes the outbox atomically with the aggregate.** No "publish before commit" race.
2. **The dispatcher is at-least-once.** It will deliver each event ≥1 times until `markDispatched`.
3. **Projection handlers are idempotent.** `last_event_id` (or your store's equivalent) ensures duplicates are no-ops.

If all three hold, the read model converges to a function of the event history. Order of arrival within an aggregate is preserved by `withCommit` ([event-ordering contract](./outbox.md)); across aggregates, order is by aggregate-array position, then by emission order within each.

## What the library does NOT ship

- **No read-model storage abstraction.** `Projection.apply` writes to your existing database with whatever DDL/ORM your write side already uses, or a separate read-store if you want true scale separation. The kit owns the mechanics around the write, never the write itself.
- **No replay SOURCE for rebuilding projections.** `Projector.reset()` gives you the consistent zero; where the history you replay through `project` comes from is a consumer decision:
  - **Event-sourced aggregates**: the event store IS the durable history. Replay reads from it directly (supply the `position` extractor; the store's position is the cursor there). The outbox holds *unpublished* events only; once `markDispatched` runs, they're gone (or marked, depending on the implementation), so the outbox is **not** a rebuild source.
  - **State-stored aggregates**: there is no built-in event archive. Without one, projections cannot be rebuilt from history; you'd seed the read model from current aggregate state (losing the history) or maintain a separate event-archive table a second consumer copies events into.
  The kit's outbox is a transient handoff buffer, not a durable event log.
- **No privacy handling.** A rebuild must not resurrect erased or anonymized data; replaying from a permitted source view is your retention policy's job, not the projector's.

The kit's role is the **write-side guarantee** (`withCommit` → outbox is transactional; projections see every event ≥ once) plus the **projection mechanics** (cursor, atomic checkpoint, rebuild entry, wait-for-version). The read-model shape and its store are consumer territory.
