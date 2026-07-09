# Outbox And Transactions

A domain event is useful only if it survives the same commit as the state
change that produced it. The transactional outbox is the pattern for that:
write the aggregate and enqueue its events in one database transaction, then
deliver the events after the commit.

The kit gives you four pieces:

- `TransactionScope<TCtx>`: opens the storage transaction.
- `withCommit`: runs the use case, harvests aggregate events, writes the
  outbox row, commits, then publishes optional in-process notifications.
- `OutboxWriter<Evt>` / `Outbox<Evt>`: the durable queue boundary.
- `OutboxDispatcher`: a small poller for setups that do not already have CDC
  or broker-owned delivery.

The main path looks like this:

```ts
import { InMemoryOutbox, withCommit } from "@shirudo/ddd-kit";

const outbox = new InMemoryOutbox<OrderEvent>();

const orderId = await withCommit({ scope, outbox }, async (tx) => {
  const orders = makeOrderRepository(tx);
  const order = await orders.getById(id);

  order.confirm();
  await orders.save(order);

  return { result: order.id, aggregates: [order] };
});
```

The important line is the return value. The use case returns the aggregates
it touched, not `order.pendingEvents`. `withCommit` owns event harvesting and
persistence cleanup. Repositories save state; they do not clear events and
they do not call `markPersisted`.

## What Happens On Commit

`withCommit` does the same sequence every time:

1. It calls `scope.transactional(...)`.
2. Your callback loads aggregates, mutates them, and saves them through
   repositories bound to the transaction handle.
3. Still inside the transaction, `withCommit` harvests `pendingEvents` from
   the returned aggregates and calls `outbox.add(events)`.
4. The transaction commits.
5. After commit, `withCommit` marks the aggregates as persisted and clears
   their pending events.
6. If a `bus` was supplied, it publishes the same committed events to
   in-process subscribers.

If the transaction rolls back, step 5 never happens. The aggregate still has
its pending events, so the caller can retry or discard the instance.

If `bus.publish` fails after the commit, `withCommit` does not reject. The
write already succeeded, and returning an error would make normal callers
retry a committed command. Wire `onPublishError` to logs or metrics, and let
the outbox deliver the durable copy.

## TransactionScope

`TransactionScope<TCtx>` is intentionally small:

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

`TCtx` is whatever your persistence layer exposes inside a transaction:
Drizzle `tx`, Prisma `tx`, a Mongo session, or `undefined` for a fake test
scope. Name it explicitly. A context-free scope should be
`TransactionScope<undefined>`, not an accidental `unknown`.

```ts
import type { TransactionScope } from "@shirudo/ddd-kit";
import type { drizzle } from "drizzle-orm/node-postgres";

type DrizzleDb = ReturnType<typeof drizzle>;
type DrizzleTx = Parameters<Parameters<DrizzleDb["transaction"]>[0]>[0];

class DrizzleScope implements TransactionScope<DrizzleTx> {
  constructor(private readonly db: DrizzleDb) {}

  transactional<T>(fn: (tx: DrizzleTx) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => fn(tx));
  }
}
```

Repositories are usually created inside the callback from that transaction
handle:

```ts
await withCommit({ scope, outbox }, async (tx) => {
  const orders = makeOrderRepository(tx);
  const order = await orders.getById(orderId);

  order.confirm();
  await orders.save(order);

  return { result: order.id, aggregates: [order] };
});
```

For a no-context test scope:

```ts
const scope: TransactionScope<undefined> = {
  transactional: (fn) => fn(undefined),
};

await withCommit({ scope, outbox }, async () => ({
  result: "ok",
  aggregates: [],
}));
```

`TransactionScope` does not track dirty objects, registered repositories, or
deletes. That lives above it. Use `withCommit` for the commit lifecycle, and
use `UnitOfWork` when you want tx-bound repositories, enrollment, and an
identity map.

## The Outbox Ports

The write side depends only on `OutboxWriter`:

```ts
interface OutboxWriter<Evt extends AnyDomainEvent> {
  add(events: ReadonlyArray<Evt>): Promise<void>;
}
```

`withCommit` calls `add()` inside the same transaction as the aggregate
write. That is the delivery guarantee. The actual delivery mechanism is a
separate decision.

If the kit's dispatcher will poll the outbox, implement the full `Outbox`
port:

```ts
interface OutboxRecord<Evt extends AnyDomainEvent> {
  dispatchId: string;
  event: Evt;
  attempts?: number;
}

interface Outbox<Evt extends AnyDomainEvent> extends OutboxWriter<Evt> {
  getPending(limit?: number): Promise<ReadonlyArray<OutboxRecord<Evt>>>;
  markDispatched(dispatchIds: ReadonlyArray<string>): Promise<void>;
}
```

`getPending` must return records in commit order. In SQL, that means a
monotonic position column and an `ORDER BY`. A bare `SELECT` is not an
ordering guarantee.

`markDispatched` must be idempotent. Re-acking a dispatched id or an unknown
id should be a no-op. This lets the dispatcher recover from partial failures
without turning duplicates into crashes.

`add()` should dedupe on `eventId`. The usual implementation is a unique
constraint plus an idempotent insert, not a unique-constraint exception:

```sql
create table outbox (
  position bigserial primary key,
  event_id text not null unique,
  aggregate_id text not null,
  aggregate_type text not null,
  aggregate_version integer,
  commit_sequence integer,
  event_type text not null,
  payload jsonb not null,
  dispatched_at timestamptz
);
```

Persist routing columns, not only the JSON payload. `withCommit` harvests
events that carry `aggregateId` and `aggregateType`, and it stamps harvested
events with `aggregateVersion` and `commitSequence`.

Those stamps have a specific meaning:

- `event.version` is the event payload schema version used for upcasting.
- `event.aggregateVersion` is the producing aggregate's state version at
  commit time.
- `event.commitSequence` is the zero-based order of that event within the
  aggregate's commit batch.

For a projection of one aggregate stream, `(aggregateVersion, commitSequence)`
is a compact watermark. For general deduplication across all event sources,
use `eventId`.

## InMemoryOutbox

`InMemoryOutbox` is the reference implementation. Use it for tests, examples,
single-process demos, and small workers where process restart losing pending
events is acceptable.

```ts
import { InMemoryOutbox, type DomainEvent } from "@shirudo/ddd-kit";

type OrderCreated = DomainEvent<"OrderCreated", { orderId: string }>;

const outbox = new InMemoryOutbox<OrderCreated>({
  maxDeliveryAttempts: 5,
});
```

It uses `event.eventId` as `dispatchId`, preserves insertion order, dedupes
re-adds by `eventId`, and implements dispatch tracking.

It is not a production outbox for a database-backed app. It is not part of
your database transaction, and it does not roll back when the database rolls
back. If you use it without a dispatcher, pending records accumulate in
memory. For a deliberate no-delivery setup, use the explicit writer:

```ts
import { outboxWriterAcceptingEventLoss } from "@shirudo/ddd-kit";

const outbox = outboxWriterAcceptingEventLoss<OrderEvent>();
```

The name is long because the decision is serious. Use it only when the
events are deliberately best-effort or when the aggregate cannot emit events.

## Dispatching Events

If you do not already have CDC, a broker-owned outbox, or another delivery
system, use `OutboxDispatcher`.

```ts
import {
  OutboxDispatcher,
  eventBusSink,
} from "@shirudo/ddd-kit";

const dispatcher = new OutboxDispatcher({
  outbox,
  sink: eventBusSink(bus),
  onDispatchError: (error, record) =>
    log.warn({ error, eventId: record.event.eventId }, "dispatch failed"),
  onPollError: (error) => log.warn({ error }, "outbox poll failed"),
});

const stop = new AbortController();
void dispatcher.run(stop.signal);

// On shutdown:
stop.abort();
```

The dispatcher has a narrow contract:

- It is at-least-once. A crash after publish but before ack means the record
  will be delivered again.
- It dispatches sequentially in commit order.
- It stops the batch on the first delivery failure.
- It never rejects from `run()` or `drainOnce()`. Failures go to observers
  and the loop backs off.
- It does not coordinate multiple process instances. If several dispatchers
  poll the same outbox, your adapter must claim records in `getPending`
  (`FOR UPDATE SKIP LOCKED`, leases, visibility timeouts, or equivalent).

For cron and serverless runtimes, call `drainOnce()` instead of running a
permanent loop:

```ts
const result = await dispatcher.drainOnce(AbortSignal.timeout(25_000));

if (result === "stopped") {
  log.info("outbox drain stopped before the backlog was empty");
}
```

Overlapping `drainOnce()` calls on the same dispatcher instance join the
in-flight pass instead of starting a competing pass.

## Dispatch Tracking And Dead Letters

A plain `Outbox` can retry forever. That may be acceptable in tests, but it
is usually not acceptable in production. A poison event can block every later
record behind it.

Use `DispatchTrackingOutbox` when you run a poller:

```ts
interface DispatchTrackingOutbox<Evt extends AnyDomainEvent>
  extends Outbox<Evt> {
  markFailed(dispatchId: string, error?: unknown): Promise<void>;
  deadLetters(): Promise<ReadonlyArray<DeadLetterRecord<Evt>>>;
}
```

On delivery failure, the dispatcher calls `markFailed` if the outbox exposes
both `markFailed` and `deadLetters`. The store counts attempts and moves the
record to a dead-letter set when it reaches the configured ceiling.

Dead-lettering is a trade-off. Once the poison record leaves the pending set,
later records can flow again, but strict ordering for that aggregate has been
forfeited. That is why `deadLetters()` must be wired to alerting. A growing
dead-letter set is an incident, not background noise.

Recovery is explicit:

- Fix the cause and re-add the event. `InMemoryOutbox` requeues a dead-lettered
  event with a fresh attempt budget.
- Deliver the event manually and call `markDispatched` to clear it.

The dispatcher also supports `countsTowardCeiling`:

```ts
const dispatcher = new OutboxDispatcher({
  outbox,
  sink,
  countsTowardCeiling: (error) => isPermanentDeliveryError(error),
});
```

Use it when transient outages should back off but not consume the poison
message budget. Without this classifier, every delivery failure counts.

## Sinks And Brokers

An `OutboxSink` is the adapter from an outbox record to a real delivery
target:

```ts
interface OutboxSink<Evt extends AnyDomainEvent> {
  publish(record: OutboxRecord<Evt>): Promise<void>;
}
```

The rule is simple: resolve `publish` only after the transport has accepted
the message. Await the Kafka producer ack, RabbitMQ publisher confirm, SQS
response, JetStream publish ack, or HTTP `2xx`. If you fire-and-forget and
return early, the dispatcher will mark the record as dispatched even though
the broker may never store it.

Broker mapping is usually straightforward:

| Broker | Mapping |
| --- | --- |
| Kafka | partition key = `aggregateId`, consumer dedup = `eventId` |
| RabbitMQ | publisher confirms, routing key from `aggregateType` or `type` |
| SQS FIFO | `MessageGroupId` = `aggregateId`, `MessageDeduplicationId` = `eventId` |
| SNS FIFO | same group and dedup mapping as SQS FIFO |
| Google Pub/Sub | `orderingKey` = `aggregateId`, consumer dedup = `eventId` |
| NATS JetStream | `Nats-Msg-Id` = `eventId`, subject from `aggregateType` or `type` |
| Redis Streams | stream per context or topic, consumer dedup = `eventId` |

Example SQS FIFO sink:

```ts
import type { AnyDomainEvent, OutboxSink } from "@shirudo/ddd-kit";

const sqsSink: OutboxSink<AnyDomainEvent> = {
  publish: async ({ event }) => {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(event),
        MessageGroupId: event.aggregateId ?? event.type,
        MessageDeduplicationId: event.eventId,
      }),
    );
  },
};
```

The dispatcher preserves order up to the sink. After that, broker
configuration decides what consumers observe. If the broker cannot preserve
per-aggregate order, consumers must reject stale events using
`(aggregateVersion, commitSequence)` or dedupe with `eventId`.

## EventBus And Outbox

The in-process bus and the outbox solve different problems.

Use the bus for same-process, post-commit reactions whose loss is acceptable:
metrics, dev logging, local cache cleanup, tests, and live UI notifications
that can be recomputed.

Use the outbox for consequences that must survive a crash: emails, billing,
workflow triggers, projections you do not want to rebuild, and anything that
leaves the process or bounded context.

The litmus test is: would it be a bug if this reaction disappeared after the
state commit? If yes, it belongs behind the outbox.

You may use both channels for different audiences:

```ts
await withCommit({ scope, outbox, bus }, async (tx) => {
  // bus: in-process fast path after commit
  // outbox: durable handoff for dispatchers
});
```

Do not point `OutboxDispatcher` with `eventBusSink(bus)` at the same bus that
you passed to `withCommit`. `withCommit` already publishes to that bus after
the commit, and the outbox record remains pending. The dispatcher would later
deliver the same event to the same subscribers again.

Pick one of these:

- Durable in-process delivery: omit `bus` from `withCommit`, then use
  `OutboxDispatcher` with `eventBusSink(bus)`.
- Fast in-process delivery plus durable external delivery: pass `bus` to
  `withCommit`, and point the dispatcher at a broker sink, not the same bus.

If you use `eventBusSink`, register subscribers before starting the
dispatcher. Publishing to a bus with no subscribers is still a successful
publish; the dispatcher will ack the outbox record.

## Ordering Rules

There are two different ordering stories.

Within one aggregate, event order is causal. If an aggregate emits
`OrderPlaced` and then `OrderConfirmed`, subscribers must process those in
that order. `withCommit` harvests events in the order the aggregate recorded
them, and a sequential outbox dispatcher preserves that order.

Across aggregates, order is not a domain guarantee. `aggregates: [a, b]`
creates a deterministic harvest order, but brokers, parallel dispatchers, and
separate processes may reorder events from `a` against events from `b`.

If a consumer depends on the order of events from different aggregates, model
the dependency explicitly. Use `metadata.causationId`, a process manager, or a
read-model policy that tolerates eventual consistency. Do not rely on the
array order of one `withCommit` call as a cross-aggregate contract.

## External Dispatchers

If another system already owns delivery, implement only `OutboxWriter`.
`withCommit` does not care whether delivery is done by the kit dispatcher,
Debezium, a delivery library, or a platform outbox.

```ts
import type { AnyDomainEvent, OutboxWriter } from "@shirudo/ddd-kit";

function makeOutboxWriter(tx: YourTxHandle): OutboxWriter<AnyDomainEvent> {
  return {
    add: async (events) => {
      for (const event of events) {
        await insertIntoDeliveryOutbox(tx, {
          id: event.eventId,
          aggregateId: event.aggregateId,
          aggregateType: event.aggregateType,
          aggregateVersion: event.aggregateVersion,
          commitSequence: event.commitSequence,
          type: event.type,
          payload: event,
        });
      }
    },
  };
}
```

The hard requirement is transaction participation. The enqueue must join the
same transaction as the aggregate write. If the external API cannot do that,
you are back to a dual write.

Common variants:

- CDC or transaction-log tailing: write the outbox row; a connector reads the
  WAL/binlog and publishes to the broker.
- Delivery library: write through the library's outbox table inside the same
  transaction and let its listener deliver.
- Broker-native outbox: valid only when the broker/framework enqueue truly
  joins your database transaction.
- Inbox side: if the external solution brings an inbox, do not also model the
  same dedup table with `IdempotencyStore` unless you intentionally need both.

## Production Checklist

Use this checklist before calling an outbox production-ready:

- Transactional adapter: outbox rows commit and roll back with aggregate rows.
- Contract tests: run `@shirudo/ddd-kit/testing` outbox contracts against the
  real storage adapter.
- Commit-order reads: `getPending` is ordered by a monotonic position.
- Multi-instance claiming: if more than one dispatcher runs, `getPending`
  claims records or uses visibility timeouts.
- Idempotent add and ack: duplicates on `eventId` do not create duplicate
  records, and repeated `markDispatched` calls are safe.
- Dispatch tracking: poison records have bounded retries and dead-lettering.
- Alerting: `deadLetters()`, oldest pending age, poll failures, dispatch
  failures, and ack failures are visible.
- Consumer dedup: every subscriber tolerates at-least-once delivery.
- Shutdown: `run(signal)` receives the runtime stop signal, or `drainOnce` is
  bounded by a deadline.

## Which Piece Do I Need?

| Situation | Use |
| --- | --- |
| Tests or examples | `InMemoryOutbox` |
| No events, or accepted event loss | `outboxWriterAcceptingEventLoss()` |
| Single process with durable in-process subscribers | `OutboxDispatcher` + `eventBusSink(bus)`, omit `bus` from `withCommit` |
| Modular monolith with fast local reactions and external consumers | `withCommit({ scope, outbox, bus })` plus dispatcher to a broker sink |
| Pure external delivery | `Outbox` + `OutboxDispatcher` to a broker sink |
| Existing CDC or delivery platform | `OutboxWriter` adapter only |
| Multiple dispatcher instances | Outbox adapter with claiming reads |
