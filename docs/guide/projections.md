# Read-Side Projections

In CQRS the write side and the read side have different shapes. Aggregates are optimised for **invariants and mutation** (Vernon IDDD §10 — small, single-transaction-bounded). Read models are optimised for **the queries your UI actually asks** (denormalised, often spanning multiple aggregate types, often duplicated across views).

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

- **Small app, no scale problems** — skip projections. A `QueryHandler` that calls `orderRepository.getById(id)` and returns the aggregate is fine. The pieces in this guide are dormant until you need them.
- **The read query needs fields from multiple aggregates** — projections start paying for themselves. Loading three aggregates per request to derive one view is the wrong shape.
- **You need to scale reads independently from writes** — projections are the canonical answer.
- **Read patterns differ from write patterns** (search, full-text, aggregations, list views) — yes.

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

You'll typically have several read-model tables per bounded context — one per view shape. `order_list_views`, `order_detail_views`, `order_invoice_views` are three separate tables, each populated by a different projection handler reading the same event stream.

## The dispatcher loop

A background process polls the outbox, dispatches each pending event to one or more projection handlers, and marks the events dispatched on success. The kit doesn't ship a dispatcher — implementations differ too much across runtimes — but the pattern is straightforward.

### Polling-based dispatcher

```ts
import type { Outbox } from "@shirudo/ddd-kit";

const BATCH_SIZE = 100;
const POLL_INTERVAL_MS = 250;

async function dispatcherLoop<Evt extends AnyDomainEvent>(
  outbox: Outbox<Evt>,
  handle: (event: Evt) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    const pending = await outbox.getPending(BATCH_SIZE);
    if (pending.length === 0) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const dispatched: string[] = [];
    for (const record of pending) {
      try {
        await handle(record.event);
        dispatched.push(record.dispatchId);
      } catch (err) {
        // Log and continue — the event stays pending and will be
        // re-attempted on the next tick. For a poison message you
        // want a max-retry counter on the outbox row or a dead-letter
        // strategy; both are storage-specific and out of scope here.
        logger.error("Projection handler failed", { record, err });
      }
    }

    if (dispatched.length > 0) {
      await outbox.markDispatched(dispatched);
    }
  }
}
```

Run this in a long-lived worker, a `setInterval` in a single-process Node app, or a cron job for batchier workloads. Edge runtimes typically delegate to a separate worker — `setInterval` in a Cloudflare Worker invocation won't survive past the request.

### Queue-based alternative

For higher throughput or multi-tenant fanout, replace polling with a queue:

1. The outbox dispatcher pushes each pending event to a durable queue (SQS, NATS, Redis Streams) and marks dispatched on enqueue success.
2. Projection handlers subscribe to the queue and process events independently.

This shifts the back-pressure problem from "polling rate" to "queue capacity" and lets you parallelise projections across consumers — at the cost of an extra moving piece.

## Projection handlers

A projection handler maps **one event** to **one read-model update**. The canonical shape is an event-type-keyed map, mirroring `EventSourcedAggregate.handlers`:

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

1. **Routing is on `event.type`** — same pattern as `EventSourcedAggregate.handlers`. The dispatcher hands the projection a typed `OrderEvent`; the handler narrows via the discriminator.
2. **One projection class per read-model table.** `OrderListProjection` only touches `order_list_views`. A separate `OrderDetailProjection` would handle the same events but write to `order_detail_views`. This keeps each projection's failure mode isolated.
3. **Many projections from one outbox.** The dispatcher can route the same event to multiple projections — each gets its own `markDispatched` accounting (use a separate "subscription cursor" per projection, or extend `Outbox` with multi-consumer tracking if your store supports it).

### Idempotency — the `last_event_id` trick

The dispatcher may retry on partial failure (process killed between `handle` succeeding and `markDispatched` succeeding). The projection handler MUST be safe to apply the same event twice.

The simplest pattern is the `last_event_id` column above:

- Every UPDATE / UPSERT carries `WHERE last_event_id <> incoming.eventId`.
- A retry of the same event is a no-op (the predicate fails; zero rows affected).
- This works regardless of whether the events are commutative (`OrderItemAdded` adding `+5` to a total is NOT commutative — applying it twice would double-count).

For projections that span aggregates (a `customer_with_recent_orders_view` updated by both `CustomerCreated` and `OrderCreated`), use one tracking column per source aggregate, or a per-event-id audit table — depending on how much storage you're willing to spend on idempotency.

### Pure projections

Projections do not have invariants. They do not return `DomainError`. They do not validate. They are stateless functions of `(currentRow, event) → newRow`. The closest the kit gets to encoding this is: a `ProjectionHandler<E>` is just `(event: E) => Promise<void>`. There is no library type for it because there is nothing to constrain — projections are just functions.

If a projection handler throws, **let it throw**. The dispatcher will leave the event in the outbox and retry next tick. Don't catch-and-swallow inside the handler; that silently drops events from the read model.

## QueryHandlers read from projections

Once a read model exists, the `QueryHandler` reads from it directly — **not** from the aggregate repository:

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
  return await orderRepository.getById(q.orderId as OrderId);
};
```

Both shapes coexist in one codebase. Single-id lookups can hit the aggregate; list/search/aggregation queries hit projections. Mix as needed.

## Eventual consistency

The write→outbox→dispatcher→projection→query chain has measurable lag. In a healthy in-process system, sub-second is typical. Under load, it can stretch.

The library does not hide this — eventual consistency is a fact of distributed systems, not a bug to abstract over. UX strategies:

1. **Optimistic UI updates** — after a successful command, update the local UI without waiting for the projection. The next refresh confirms.
2. **Read-your-own-writes via the aggregate** — for the user who just wrote, query the aggregate directly (write-side) instead of the projection. Inconsistent everywhere else, but the writer sees their own action immediately.
3. **Bounded wait** — poll the projection for up to N ms; if the expected change hasn't landed, return the stale view.

Vernon discusses these in IDDD §4. None of them require library support — they are application-layer decisions.

## The full topology

```ts
// Application bootstrap
import {
  InMemoryOutbox,
  EventBusImpl,
  CommandBus,
  QueryBus,
  withCommit,
} from "@shirudo/ddd-kit";

const outbox = new InMemoryOutbox<OrderEvent>();
const bus    = new EventBusImpl<OrderEvent>();
const commands = new CommandBus<OrderCommands>();
const queries  = new QueryBus<OrderQueries>();

// Wire the projection
const orderListProjection = new OrderListProjection(db);

// Start the dispatcher
const controller = new AbortController();
void dispatcherLoop(outbox, orderListProjection.handle, controller.signal);

// Command path — writes go through withCommit -> outbox
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

// Query path — reads from the projection
queries.register("GetOrderList", getOrderListHandler);
```

Three contracts hold this together:

1. **`withCommit` writes the outbox atomically with the aggregate.** No "publish before commit" race.
2. **The dispatcher is at-least-once.** It will deliver each event ≥1 times until `markDispatched`.
3. **Projection handlers are idempotent.** `last_event_id` (or your store's equivalent) ensures duplicates are no-ops.

If all three hold, the read model converges to a function of the event history. Order of arrival within an aggregate is preserved by `withCommit` ([event-ordering contract](./outbox.md)); across aggregates, order is by aggregate-array position, then by emission order within each.

## What the library does NOT ship

- **No `ProjectionHandler<E>` type or `Projector` base class.** A projection is just an `(event: E) => Promise<void>` function. The eventType-keyed map pattern shown above is convention; the kit has no opinion.
- **No outbox-dispatcher implementation.** Runtime-specific (Node `setInterval`, Cloudflare cron triggers, AWS Lambda + EventBridge, etc.). Pseudocode above is the contract.
- **No read-model storage abstraction.** Projections write to your existing database. Pick whatever DDL/ORM your write side already uses, or a separate read-store if you want true scale separation.
- **No event-replay tooling for rebuilding projections.** Rebuilds are a separate concern (truncate read table → re-run the dispatcher from outbox start). Outbox semantics support it but the library doesn't automate it.

The kit's role is the **write-side guarantee** (`withCommit` → outbox is transactional; projections see every event ≥ once). Everything to the right of the outbox is consumer territory.
