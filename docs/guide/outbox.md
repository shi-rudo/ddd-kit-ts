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

const orderId = await withCommit({ scope, outbox }, async (tx, enrollment) => {
  const orders = makeOrderRepository(tx);
  const order = await orders.getById(id);

  order.confirm();
  await orders.save(order);

  return {
    result: order.id,
    commits: [enrollment.enrollSaved(order)],
  };
});
```

The important line is the return value. The use case returns opaque tokens for
the repository writes it enrolled, not naked aggregates and not
`order.pendingEvents`. A fresh but unsaved aggregate therefore cannot be
harvested or acknowledged accidentally. `withCommit` owns event harvesting
and persistence cleanup. Every issued token must be present in `commits`; an
omission rejects inside the transaction rather than committing state without
its events. Repositories save state; aggregate lifecycle acknowledgement is
not part of their API.

## What Happens On Commit

`withCommit` does the same sequence every time:

1. It calls `scope.transactional(...)`.
2. Your callback loads aggregates, mutates them, and saves them through
   repositories bound to the transaction handle.
3. Still inside the transaction, `withCommit` validates the invocation-bound
   commit tokens, harvests `pendingEvents` from their aggregates, and calls
   `outbox.add(events)`.
4. The transaction commits.
5. After commit, `withCommit` acknowledges every saved aggregate through a
   non-exported capability and discards harvested events for deleted rows.
6. The optional `onPersisted(aggregate, version, effectContext)` Application observer runs
   for successfully acknowledged saved aggregates only, after every commit
   record has completed its acknowledgement attempt. Its version argument is
   the commit-time value captured before any observer ran.
7. If a `bus` was supplied, it publishes the same committed events to
   in-process subscribers.

If the transaction rolls back, step 5 never happens. The aggregate still has
its pending events, so the caller can retry or discard the instance.

`onPersisted` may be asynchronous and is awaited, but it is not a delivery
guarantee. All invocations and the optional bus publication share one absolute
`postCommitTimeoutMs` budget (30 seconds by default), rather than receiving a
fresh budget each. Every invocation receives an `EffectContext` with the
corresponding `signal` and shared absolute `deadlineAt`; observers and bus work
that have not started when it expires are skipped. A throw, timeout, or request abort is reported to
`onPersistError` and never rejects the already committed result. Use the outbox
for side effects that must survive a process crash. The same failure observer
reports a runtime failure in the internal acknowledgement step; peer
aggregates are still processed, and only successfully acknowledged aggregates
reach `onPersisted`.

If `bus.publish` fails, times out, or is aborted after the commit, `withCommit`
does not reject. The write already succeeded, and returning an error would make
normal callers retry a committed command. It receives whatever remains of the
same post-commit budget after application observers. Wire `onPublishError` to
logs or metrics, and let the outbox deliver the durable copy.

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
await withCommit({ scope, outbox }, async (tx, enrollment) => {
  const orders = makeOrderRepository(tx);
  const order = await orders.getById(orderId);

  order.confirm();
  await orders.save(order);

  return {
    result: order.id,
    commits: [enrollment.enrollSaved(order)],
  };
});
```

For a no-context test scope:

```ts
const scope: TransactionScope<undefined> = {
  transactional: (fn) => fn(undefined),
};

await withCommit({ scope, outbox }, async () => ({
  result: "ok",
  commits: [],
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
  add(events: ReadonlyArray<EventCommitCandidate<Evt>>): Promise<void>;
}
```

`withCommit` calls `add()` inside the same transaction as the aggregate
write. The candidate contains the aggregate source, current aggregate version,
commit sequence, and commit size. The writer owns the durable event-source
head: it links the candidate to the preceding eventful commit and persists the
resulting `CommittedDomainEvent`. That is the delivery and continuity
guarantee. The actual delivery mechanism is a separate decision.

If the kit's dispatcher will poll the outbox, implement the full `Outbox`
port:

```ts
interface OutboxRecord<Evt extends AnyDomainEvent> {
  dispatchId: string;
  event: Evt;
  source: AggregateAddress;
  position: CommitPosition;
  attempts?: number;
}

interface Outbox<Evt extends AnyDomainEvent> extends OutboxWriter<Evt> {
  getPending(
    limit?: number,
    context?: EffectContext,
  ): Promise<ReadonlyArray<OutboxRecord<Evt>>>;
  markDispatched(
    dispatchIds: ReadonlyArray<string>,
    context?: EffectContext,
  ): Promise<void>;
}
```

`getPending` must return records in commit order. In SQL, that means a
monotonic position column and an `ORDER BY`. A bare `SELECT` is not an
ordering guarantee.

`markDispatched` must be idempotent. Re-acking a dispatched id or an unknown
id should be a no-op. This lets the dispatcher recover from partial failures,
including a write that completes after its caller timed out, without turning
duplicates into crashes. The context is optional for source compatibility, but
the bundled dispatcher always supplies it.

`add()` should dedupe on `eventId`. The usual implementation is a unique
constraint plus an idempotent insert, not a unique-constraint exception. The
table therefore needs the event identity and qualified source as routing
columns:

```sql
create table outbox (
  position bigserial primary key,
  event_id text not null unique,
  aggregate_id text not null,
  aggregate_type text not null,
  aggregate_version integer not null,
  commit_sequence integer not null,
  commit_size integer not null,
  previous_eventful_aggregate_version integer,
  event_type text not null,
  payload jsonb not null,
  dispatched_at timestamptz,
  unique (aggregate_type, aggregate_id, aggregate_version, commit_sequence)
);

create table event_source_head (
  aggregate_type text not null,
  aggregate_id text not null,
  last_eventful_aggregate_version integer not null,
  primary key (aggregate_type, aggregate_id)
);
```

That idempotency rule assumes the ID still addresses the same qualified source
and candidate commit position. The same `eventId` arriving for another
`aggregateType`, `aggregateId`, aggregate version, commit sequence, or commit
size is a caller bug, not a redelivery. Do not overwrite the existing row.
Where the retained row makes the mismatch provable, compare the full candidate
receipt and reject loudly; a bare `ON CONFLICT DO NOTHING` prevents duplicate
rows but cannot diagnose this collision without reading the conflicting row.

Persist routing columns, not only the JSON payload. `withCommit` composes every
bare domain event into an `EventCommitCandidate`; the outbox source finalizes
it as a `CommittedDomainEvent` whose `source` identifies the aggregate and
whose `position` carries the full projection cursor.

The envelope fields have a specific meaning:

- `envelope.event.version` is the event payload schema version used for upcasting.
- `envelope.position.aggregateVersion` is the producing aggregate's state version at
  commit time.
- `envelope.position.commitSequence` is the zero-based order of that event within the
  aggregate's commit batch.
- `envelope.position.commitSize` is the total number of events in that commit.
- `envelope.position.previousEventfulAggregateVersion` links to the aggregate
  version of the immediately preceding eventful commit (`null` for the
  source's first eventful commit). State-only saves do not appear in this
  chain.

Genesis is deliberately represented by an explicit `null`, not `undefined`:
the full cursor therefore survives JSON serialization. SQL adapters must map
the nullable predecessor column to JavaScript `null` when hydrating an
envelope; omitting the property produces an invalid legacy cursor.

The predecessor cannot be inferred from `aggregate.persistedVersion`: that is
the OCC baseline and advances on state-only saves. A durable adapter needs a
source-head record keyed by `(aggregate_type, aggregate_id)`. Lock that record,
read its `last_eventful_aggregate_version`, insert every event in the commit
with that predecessor, and advance the head to the candidate's
`aggregateVersion` in the same transaction. A unique commit-position key such
as `(aggregate_type, aggregate_id, aggregate_version, commit_sequence)` keeps
the event identity stable under retries; all rows of that aggregate version
must also agree on `commit_size`. Validate those invariants before advancing
the source head. Creation of the first source-head row also
needs race-safe insert-or-lock semantics: rely on the primary key and retry the
losing transaction; do not let two concurrent "genesis" writers proceed from
separate missing-row reads.

For a projection, the four fields form a gap-proof cursor: the consumer can
reject missing sequences and commits. For general deduplication across all
event sources, use `eventId`.

## InMemoryOutbox

`InMemoryOutbox` is the reference implementation. Use it for tests, examples,
and finite-lifetime demos where process restart losing pending events is
acceptable. It retains one event-source cursor per qualified
aggregate even after dispatch so later eventful commits can be linked. Its
memory therefore grows with distinct aggregate sources, not only with pending
messages. It also retains a bounded, insertion-ordered cache of recently
dispatched receipts -- event ID, qualified source, and candidate commit
position (10,000 by default) -- so an exact post-ack retry remains an idempotent
no-op without touching the source head. Unbounded production
workloads need a durable adapter with an explicit source-head retention policy
and a transactional unique key on `eventId`.

```ts
import { InMemoryOutbox, type DomainEvent } from "@shirudo/ddd-kit";

type OrderCreated = DomainEvent<"OrderCreated", { orderId: string }>;

const outbox = new InMemoryOutbox<OrderCreated>({
  maxDeliveryAttempts: 5,
  maxRecords: 10_000,
  maxSources: 50_000,
  maxRetainedDispatchedEventIds: 10_000,
});
```

`maxRecords` counts pending plus dead-letter records; moving between those
states does not consume another slot, and acknowledgement releases it.
`maxSources` bounds the permanent per-aggregate source cursors. If either limit
would be crossed, the complete `add()` batch rejects before records or cursors
move. Existing retries remain usable at capacity. Omitting either option leaves
that collection unbounded, supported only for finite-lifetime tests and demos.
Neither collection is silently evicted because forgetting it would weaken
delivery or source-order guarantees.

It uses `envelope.event.eventId` as `dispatchId`, preserves insertion order,
dedupes exact pending, dead-lettered, and recently dispatched re-adds by
`eventId`, and implements dispatch tracking. A contradictory source or commit
position rejects instead of being mistaken for a retry. Once a dispatched
receipt is evicted, a candidate behind the current source head fails with
`EventHarvestError` rather than rewinding the head. This is intentionally
fail-safe, not an unbounded idempotency promise; durable outboxes keep the
event-ID receipt in storage.

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
  type OutboxDispatcherObservers,
} from "@shirudo/ddd-kit";

const outboxObservers: OutboxDispatcherObservers<OrderEvent> = {
  onDispatchError: (error, record) =>
    log.warn({ error, eventId: record.event.eventId }, "dispatch failed"),
  onPollError: (error) => log.warn({ error }, "outbox poll failed"),
  onDeadLetter: (record) =>
    alerts.page({ eventId: record.event.eventId }, "outbox dead letter"),
};

const dispatcher = new OutboxDispatcher({
  outbox,
  sink: eventBusSink(bus),
  observers: outboxObservers,
  deliveryTimeoutMs: 10_000,
  storageTimeoutMs: 5_000,
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
- It aborts each sink through its `EffectContext` after `deliveryTimeoutMs`
  (30 seconds by default). A sink that ignores the signal cannot keep the
  dispatcher pending, but its foreign I/O can continue as zombie work.
- It bounds `getPending`, `markDispatched`, and `markFailed` through
  `storageTimeoutMs` (30 seconds by default) and passes the same context to the
  store.
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
  markFailed(
    dispatchId: string,
    error?: unknown,
    context?: EffectContext,
  ): Promise<DeadLetterRecord<Evt> | undefined>;
  deadLetters(): Promise<ReadonlyArray<DeadLetterRecord<Evt>>>;
}
```

On delivery failure, the dispatcher calls `markFailed` if the outbox exposes
both `markFailed` and `deadLetters`. The store counts attempts and moves the
record to a dead-letter set when it reaches the configured ceiling. The
ceiling-crossing call returns that exact record, which lets the dispatcher's
required `onDeadLetter` observer emit a low-latency alarm without scanning the
whole set.

Dead-lettering is a trade-off. Once the poison record leaves the pending set,
later records can flow again, but strict ordering for that aggregate has been
forfeited. That is why `deadLetters()` must be wired to alerting. A growing
dead-letter set is an incident, not background noise. The callback is
best-effort and cannot be the only alarm: a process can stop after the store
commits the transition and before the observer runs. Poll `deadLetters()` from
durable monitoring for reconciliation; use `onDeadLetter` for the immediate
signal. Observer throws and rejected promises are neutralized so monitoring
cannot alter delivery state.

Recovery is explicit:

- Fix the cause and re-add the event. `InMemoryOutbox` requeues a dead-lettered
  event with a fresh attempt budget.
- Deliver the event manually and call `markDispatched` to clear it.

The dispatcher classifies delivery failures before consuming the poison
ceiling:

```ts
const dispatcher = new OutboxDispatcher({
  outbox,
  sink,
  observers: outboxObservers,
  classifyFailure: (error) => {
    if (isTransportOutage(error)) return "transient";
    if (isPermanentDeliveryError(error)) return "permanent";
    return "unknown";
  },
});
```

`transient` failures back off but do not consume the poison-message budget.
`permanent` and safely conservative `unknown` failures do. The shared default
walks the error cause chain: native `TimeoutError` and `retryable: true` are
transient, while `retryable: false` is permanent. Unmapped errors remain
unknown. If a custom classifier throws or returns an invalid value, the
original delivery error remains the primary error, the failure counts as
unknown, and `onDispatchError` receives a third assessment argument containing
`classifierError`.

`countsTowardCeiling` remains as a deprecated migration alias: `false` maps to
transient and `true` to permanent. Prefer `classifyFailure`; when both are
present, it wins.

## Sinks And Brokers

An `OutboxSink` is the adapter from an outbox record to a real delivery
target:

```ts
interface OutboxSink<Evt extends AnyDomainEvent> {
  publish(record: OutboxRecord<Evt>, context: EffectContext): Promise<void>;
}
```

The rule is simple: pass `context.signal` to the transport (or configure a
native timeout no later than `context.deadlineAt`) and resolve
`publish` only after the transport has accepted the message. Await the Kafka
producer ack, RabbitMQ publisher confirm, SQS response, JetStream publish ack,
or HTTP `2xx`. The shell timeout bounds how long the dispatcher waits; it cannot
terminate an arbitrary promise. Ignoring both signal and deadline can overlap a
late publish with its retry and is not a production-safe adapter. If you
fire-and-forget and return early, the dispatcher will
mark the record as dispatched even though the broker may never store it. A
timeout is a transient delivery failure by default and leaves the record
pending without consuming its poison ceiling. Worker shutdown likewise does
not count; records not yet acknowledged stay pending for the next worker.

The same rule applies to poll-store adapters. The dispatcher always passes an
`EffectContext` to `getPending`, `markDispatched`, and `markFailed`; the optional
parameter preserves source compatibility for existing adapters. A storage
timeout means the operation's outcome is unknown. Acknowledgements must be
idempotent: a late acknowledgement may validly complete after the worker
stopped waiting, and a later ack remains safe. A late `markFailed` may count its
original delivery attempt; it must no-op if the record was dispatched in the
meantime. The worker never resubmits the same timed-out store call.

Broker mapping is usually straightforward:

For a `Projector`, all mappings below mean a complete feed per aggregate
address. Partition or group by the aggregate source, but do not filter its
subscription by `event.type`: even a projection-irrelevant envelope occupies a
commit cursor position and must reach `Projection.apply` as an explicit no-op.
Type-filtered topics are suitable only for consumers that do not use the
aggregate commit cursor, unless the router assigns a new projection-specific
contiguous cursor after filtering.

| Broker | Mapping |
| --- | --- |
| Kafka | partition key = `aggregateId`, consumer dedup = `eventId` |
| RabbitMQ | publisher confirms, projector routing key from context / `aggregateType` (not event `type`) |
| SQS FIFO | `MessageGroupId` = `aggregateId`, `MessageDeduplicationId` = `eventId` |
| SNS FIFO | same group and dedup mapping as SQS FIFO |
| Google Pub/Sub | `orderingKey` = `aggregateId`, consumer dedup = `eventId` |
| NATS JetStream | `Nats-Msg-Id` = `eventId`; projector subject from context / `aggregateType` (not event `type`) |
| Redis Streams | stream per context or topic, consumer dedup = `eventId` |

Example SQS FIFO sink:

```ts
import {
  createIntegrationMessage,
  encodeIntegrationMessage,
  type DomainEvent,
  type IntegrationMessageMapper,
  type OutboxSink,
} from "@shirudo/ddd-kit";

type OrderPlaced = DomainEvent<"OrderPlaced", {
  orderId: string;
  placedAt: Date;
  amounts: ReadonlyMap<string, number>;
  tags: ReadonlySet<string>;
}>;

const publishOrderPlaced: IntegrationMessageMapper<
  OrderPlaced,
  "sales.order-placed.v1",
  {
    orderId: string;
    placedAt: string;
    amounts: ReadonlyArray<readonly [string, number]>;
    tags: ReadonlyArray<string>;
  }
> = (event) => ({
  type: "sales.order-placed.v1",
  version: 1,
  payload: {
    orderId: event.payload.orderId,
    placedAt: event.payload.placedAt.toISOString(),
    amounts: [...event.payload.amounts],
    tags: [...event.payload.tags],
  },
  correlationId: event.metadata?.correlationId,
  conversationId: event.metadata?.conversationId,
  causationId: event.metadata?.causationId,
});

const sqsSink: OutboxSink<OrderPlaced> = {
  publish: async (record, context) => {
    const message = createIntegrationMessage(record, publishOrderPlaced);
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: encodeIntegrationMessage(message),
        MessageGroupId: message.source.aggregateId,
        MessageDeduplicationId: message.messageId,
      }),
      { abortSignal: context.signal },
    );
  },
};
```

`CommittedDomainEvent` is an in-process persistence envelope, not a JSON wire
contract: its domain payload and metadata may legally contain `Date`, `Map`, or
`Set`. `createIntegrationMessage` therefore requires an explicit
domain-to-integration mapping. The mapper above chooses the public message
name/schema and converts those values to strings and arrays. The codec rejects
an unmapped special value instead of letting `JSON.stringify` silently turn a
`Map` or `Set` into `{}`. It also preserves and validates the complete source
cursor, including the explicit `null` at genesis.

The public envelope carries optional `correlationId`, `conversationId`, and
`causationId` headers. The boundary mapper explicitly selects which
relationships belong in the public contract. `createIntegrationMessage` never
copies private domain-event metadata implicitly. Custom `metadata` must not
repeat the reserved names, and no header is invented when the relationship is
unknown.

Decode and validate before handing a broker body to a projector:

```ts
import {
  decodeIntegrationMessage,
  integrationMessageToCommittedEvent,
} from "@shirudo/ddd-kit";

const message = decodeIntegrationMessage(sqsRecord.body);
await publishedOrderProjector.project([
  integrationMessageToCommittedEvent(message),
]);
```

The converted event represents the published integration schema; it does not
reconstruct the producer's private domain event or turn ISO strings back into
domain `Date` objects. A receiving bounded context owns any further mapping to
its own commands or model. The three relationship headers are copied into the
minted local event metadata so tracing and process context survive the boundary.

The dispatcher preserves order up to the sink. After that, broker
configuration decides what consumers observe. If the broker cannot preserve
per-aggregate order, projection consumers reject discontinuities through the
full commit cursor; general consumers dedupe with `eventId`.

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
  return { result: undefined, commits: [] };
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

Across aggregates, order is not a domain guarantee. Returning commit tokens
for `[a, b]` creates a deterministic harvest order, but brokers, parallel
dispatchers, and separate processes may reorder events from `a` against events
from `b`.

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
    add: async (candidates) => {
      for (const commit of groupByAggregateCommit(candidates)) {
        // SELECT ... FOR UPDATE, keyed by aggregateType + aggregateId.
        const head = await lockEventSourceHead(tx, commit.source);

        for (const candidate of commit.events) {
          await insertIntoDeliveryOutbox(tx, {
            id: candidate.event.eventId,
            aggregateId: candidate.source.aggregateId,
            aggregateType: candidate.source.aggregateType,
            aggregateVersion: candidate.position.aggregateVersion,
            commitSequence: candidate.position.commitSequence,
            commitSize: candidate.position.commitSize,
            previousEventfulAggregateVersion:
              head.lastEventfulAggregateVersion,
            type: candidate.event.type,
            payload: candidate.event,
          });
        }

        await advanceEventSourceHead(
          tx,
          commit.source,
          commit.aggregateVersion,
        });
      }
    },
  };
}
```

The helper names above are application-specific pseudocode. The hard
requirements are transaction participation and serialized source-head
advancement. The enqueue and head update must join the same transaction as the
aggregate write. If the external API cannot do that, you are back to a dual
write and cannot promise gap-proof projection continuity.

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
  real storage adapter. They prove commit sequence/size finalization, eventful
  predecessor linkage, qualified source-head isolation, and immutable
  source-position identity in addition to delivery behavior. Enable the
  rollback capability to prove that a rolled-back add advances neither rows nor
  the source head.
- Commit-order reads: `getPending` is ordered by a monotonic position.
- Multi-instance claiming: if more than one dispatcher runs, `getPending`
  claims records or uses visibility timeouts.
- Idempotent add and ack: exact retries on `eventId` do not create duplicate
  records, contradictory receipts reject, and repeated `markDispatched` calls
  are safe.
- Dispatch tracking: poison records have bounded retries and dead-lettering.
- Alerting: the required observers expose poll, dispatch, ack, and immediate
  dead-letter transitions; durable monitoring also reconciles
  `deadLetters()` and tracks oldest pending age.
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
