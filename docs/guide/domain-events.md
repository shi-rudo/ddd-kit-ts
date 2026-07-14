# Domain Events

A domain event is a fact that has just happened in the domain.

Use events for facts other parts of the system may care about: an order was confirmed, a payment was captured, a shipment failed. The event should describe the fact, not the command that requested it. `ConfirmOrder` is a command. `OrderConfirmed` is an event.

The kit treats domain events as plain, immutable data:

- they have a stable `eventId`
- they carry a `type` discriminator
- they are deeply frozen
- they can carry correlation metadata
- aggregate events can be routed by `aggregateId` and `aggregateType`
- persistence metadata is composed around them instead of written onto them

## Shape

```ts
interface DomainEvent<T extends string, P = void> {
  eventId: string;
  type: T;
  aggregateId?: string;
  aggregateType?: string;
  payload: P;
  occurredAt: Date;
  version: number;
  metadata?: EventMetadata;
}
```

The fields have different jobs:

| Field | Meaning |
| --- | --- |
| `eventId` | Unique id for this event instance. Use it for idempotency and deduplication. |
| `type` | Routing discriminator, such as `"OrderConfirmed"`. |
| `aggregateId` / `aggregateType` | Source aggregate. `recordEvent` fills these in automatically. |
| `payload` | Domain data for the fact that happened. |
| `occurredAt` | Time the event was created. |
| `version` | Event schema version, used for payload evolution and upcasting. |
| `metadata` | Correlation, causation, user, source, and custom tracing fields. |

`version` says which shape the event payload has. It is not an aggregate or
stream position; those values live in `CommittedDomainEvent.position`.

## Creating Events

Outside an aggregate, use `createDomainEvent`:

```ts
import { createDomainEvent, type DomainEvent } from "@shirudo/ddd-kit";

type OrderConfirmed = DomainEvent<
  "OrderConfirmed",
  { orderId: string }
>;

const event = createDomainEvent(
  "OrderConfirmed",
  { orderId: "o-1" },
  {
    aggregateId: "o-1",
    aggregateType: "Order",
    metadata: {
      correlationId: "req-42",
      userId: "u-7",
    },
  },
) as OrderConfirmed;
```

The returned event is deeply frozen. The payload and metadata are cloned before freezing, so the caller's original objects are not frozen and later mutations to them do not change the event.

Events should be plain structured-cloneable data. Functions, promises, `WeakMap`, and `WeakSet` do not belong in event payloads. A class instance may lose its prototype through structured cloning, so model event payloads as plain records.

## Inside Aggregates: Use `recordEvent`

Inside aggregate methods, prefer `this.recordEvent(...)`:

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

`recordEvent` uses the aggregate's `DomainEventFactory` and fills in `aggregateId` and `aggregateType` from the aggregate. That metadata is how outbox dispatchers, projection handlers, audit logs, and process managers know which aggregate produced the event.

Calling `createDomainEvent(...)` directly inside an aggregate is easy to get wrong because you must remember those routing fields by hand. `withCommit` validates harvested aggregate events and throws if the fields are missing, but the better path is to make the wrong event hard to create.

Use `createDomainEvent(...)` directly for events that do not come from an aggregate: system events, integration events, test fixtures, process-manager events, and adapter-level events.

See [Aggregate Roots -> A Small Aggregate](./aggregates.md#state-version-domain-events).

## Auto-Generated Fields

`createDomainEvent` uses the immutable `defaultDomainEventFactory` and fills in
common fields when you omit them:

| Field | Default | Override |
| --- | --- | --- |
| `eventId` | `crypto.randomUUID()` | `options.eventId` or an instance factory |
| `occurredAt` | current clock time | `options.occurredAt` or an instance factory |
| `version` | `1` | `options.version` |
| `metadata` | `undefined` | `options.metadata` |

The default event id is UUID v4 because it comes from Web Crypto's `crypto.randomUUID()`. That is portable and safe for uniqueness, but it is not time-ordered. For large event stores, prefer UUID v7, ULID, or KSUID so indexes stay clustered and ids sort roughly by creation time.

## Instance-bound factories

Create a factory for one application composition, request, tenant, or test when
the immutable default is not the right policy:

```ts
import { createDomainEventFactory } from "@shirudo/ddd-kit";
import { v7 as uuidv7 } from "uuid";

const domainEvents = createDomainEventFactory({
  eventIdFactory: () => uuidv7(),
  clock: () => new Date(),
});

const event = domainEvents.create("OrderConfirmed", { orderId: "o-1" });
```

The returned `DomainEventFactory` is frozen and permanently captures those two
functions. Creating another factory cannot change this one or the
`defaultDomainEventFactory`. This makes the same API safe across overlapping
async requests and parallel tests; no restore hook or async context is needed.
Every clock read is defensively copied and fails immediately with a `TypeError`
if the injected clock does not return a valid `Date`.

Per-event `eventId` and `occurredAt` options still win over the captured
defaults.

## Supplying a factory to an aggregate

Aggregate constructors opt in by forwarding the factory through
`AggregateConfig`:

```ts
import {
  AggregateRoot,
  type DomainEventFactory,
} from "@shirudo/ddd-kit";

class Order extends AggregateRoot<OrderState, OrderId, OrderEvent> {
  protected readonly aggregateType = "Order";

  constructor(
    id: OrderId,
    state: OrderState,
    domainEventFactory: DomainEventFactory,
  ) {
    super(id, state, { domainEventFactory });
  }
}
```

`recordEvent(...)` now uses that aggregate instance's factory. `createSnapshot()`
uses the same captured clock for `snapshotAt`, so event and snapshot timestamps
cannot drift between two dependency scopes. Aggregates that omit the config use
the immutable default and need no constructor change.

At a request boundary, construct or select the factory before constructing or
reconstituting the aggregate:

```ts
export async function handle(request: Request): Promise<Response> {
  const domainEvents = createDomainEventFactory({
    eventIdFactory: requestEventIds(request),
    clock: requestClock(request),
  });
  const order = await loadOrder(orderIdFrom(request), domainEvents);
  order.confirm();
  // persist order
}
```

Repository factories should pass the same `DomainEventFactory` through every
creation and reconstitution path for that operation.

## Deterministic tests

```ts
it("emits deterministic ids and timestamps", () => {
  const domainEvents = createDomainEventFactory({
    eventIdFactory: () => "evt-1",
    clock: () => new Date("2026-01-01T00:00:00.000Z"),
  });
  const order = new Order(orderId, initialState, domainEvents);

  order.confirm();

  expect(order.pendingEvents[0]?.eventId).toBe("evt-1");
});
```

No `afterEach` reset is required because the test owns the factory instance and
never changes module state. Async tests use the same pattern unchanged.

## Custom id formats

Choose the id function when constructing the instance:

```ts
// UUID v7: time-ordered and standards-track
import { v7 as uuidv7 } from "uuid";
const uuidEvents = createDomainEventFactory({
  eventIdFactory: () => uuidv7(),
});

// ULID: compact, URL-safe, time-ordered
import { ulid } from "ulid";
const ulidEvents = createDomainEventFactory({
  eventIdFactory: () => ulid(),
});
```

The kit only requires a string. Choose the id format that fits your storage and interoperability needs.

## Metadata

`EventMetadata` is a plain object with conventional fields:

```ts
interface EventMetadata {
  correlationId?: string;
  causationId?: string;
  userId?: string;
  source?: string;
  [key: string]: unknown;
}
```

Use metadata for tracing and operational context, not for core domain state. If a value is required to understand the event as a domain fact, put it in the payload.

The usual meanings:

- `correlationId` groups work that belongs to one request or workflow.
- `causationId` points to the event or command that caused this event.
- `userId` records the actor when known.
- `source` names the producing component or bounded context.

### Copying Correlation

Use `copyMetadata` when one event causes another:

```ts
import { copyMetadata, createDomainEvent } from "@shirudo/ddd-kit";

const shipped = createDomainEvent(
  "OrderShipped",
  { orderId: "o-1", trackingNumber: "T-1" },
  {
    metadata: copyMetadata(confirmed, {
      causationId: confirmed.eventId,
    }),
  },
);
```

The new event keeps the previous correlation fields and adds or overrides the fields you pass.

Use `mergeMetadata` when you are composing context from several layers:

```ts
import { mergeMetadata } from "@shirudo/ddd-kit";

const metadata = mergeMetadata(
  { correlationId: "corr-1" },
  { userId: "u-7" },
  { source: "orders" },
);
```

Later objects override earlier ones for the same key.

Both helpers reject hostile own `__proto__` metadata keys. That matters for events that were hand-built or deserialized from a message envelope, where metadata did not necessarily come through `createDomainEvent`.

## Commit Envelopes

`withCommit` leaves the domain event untouched and composes an
`EventCommitCandidate` for the outbox. The outbox source atomically links that
candidate to its preceding eventful commit and persists this finalized
envelope:

```ts
interface CommittedDomainEvent<Evt extends AnyDomainEvent> {
  event: Evt;
  source: {
    aggregateType: string;
    aggregateId: string;
  };
  position: {
    aggregateVersion: number;
    commitSequence: number;
    commitSize: number;
    previousEventfulAggregateVersion: number | null;
  };
}
```

All finalized envelopes produced by one aggregate in one commit share
`position.aggregateVersion`, `position.commitSize`, and
`position.previousEventfulAggregateVersion`. `position.commitSequence` is the
zero-based position inside that harvest batch. The predecessor is the aggregate
version of the immediately preceding EVENTFUL commit; state-only saves do not
advance it. Only the event source at the persistence boundary can construct the
complete cursor; neither `createDomainEvent` nor `withCommit` can infer it from
the aggregate's OCC baseline.

Inside a committed envelope, `source` is the authoritative persistence address.
If the bare event also carries optional `aggregateId` or `aggregateType`
stamps, each present value must match `source`; a projector rejects a
contradiction as `ForeignEventError` before applying or checkpointing anything.
An event whose optional address stamps are absent is addressed by the envelope.

Together the four fields form a gap-proof per-aggregate cursor. A projector can
prove that a commit is complete and that the following commit names the
checkpointed version as its predecessor; missing history rejects loudly.

`envelope.event.eventId` is still the general-purpose deduplication key.

See [Outbox & Transactions](./outbox.md) and [Read-Side Projections](./projections.md).

## Integration Messages

Neither `DomainEvent` nor `CommittedDomainEvent` is a public broker schema.
Domain payloads and metadata may contain immutable `Date`, `Map`, and `Set`
values, while JSON cannot represent those types faithfully. Publishing either
shape with a raw `JSON.stringify` can therefore corrupt an otherwise valid
domain event.

At the outbox sink, map the committed event to a separate
`IntegrationMessage` with `createIntegrationMessage(record, mapper)`. The
mapper chooses the public type, schema version, JSON payload, and optional JSON
metadata. `encodeIntegrationMessage` validates the whole graph and rejects
special values, cycles, sparse arrays, non-finite numbers, and properties JSON
would discard. It also rejects hostile own `__proto__` keys before downstream
copy operations can activate them. `decodeIntegrationMessage` performs the
same validation on an untrusted broker body. It accepts RFC 3339 timestamps
with an explicit offset and up to millisecond precision, normalizes them to
canonical UTC `.sssZ`, and returns a deeply frozen message. The producer-side
codec continues to emit and require that canonical representation.

The wire envelope retains `messageId`, an ISO `occurredAt`, the qualified
aggregate source, and the complete commit position. Consumers that feed the
kit's `Projector` can compose the validated message into a minted local event
with `integrationMessageToCommittedEvent`. That event uses the published type
and JSON payload; restoring the producer's private domain types is deliberately
not attempted.

See the complete [SQS FIFO mapping](./outbox.md#sinks-and-brokers).

## Record After Mutation

A domain event says something happened. The state change must succeed before the event is recorded.

The kit gives you safe paths:

- `EventSourcedAggregate.apply(event)` validates and applies the event before recording it as pending.
- `AggregateRoot.commit(newState, events)` validates and assigns state before appending events.

The lower-level `setState` and `addDomainEvent` methods are still available for special cases, but then the ordering is your responsibility:

```ts
this.setState(nextState);
this.addDomainEvent(this.recordEvent("OrderConfirmed", { orderId: this.id }));
```

Do not record first and mutate second. If the mutation throws, the aggregate would carry an event for a fact that never happened.
The mutation must also advance the version before an already-persisted
aggregate is harvested; otherwise two commits would share one projection
position and `withCommit` rejects with `EventHarvestError`.

## Naming Events

Name events in past tense:

- `OrderPlaced`
- `OrderConfirmed`
- `PaymentCaptured`
- `ShipmentFailed`

Avoid command names:

- `PlaceOrder`
- `ConfirmOrder`
- `CapturePayment`

The distinction matters. A command can be rejected. An event says the domain already accepted the change.
