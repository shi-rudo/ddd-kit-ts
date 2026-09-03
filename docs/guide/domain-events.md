# Domain Events

A domain event is a fact that has just happened in the domain.

Use events for facts other parts of the system may care about: an order was confirmed, a payment was captured, a shipment failed. The event should describe the fact, not the command that requested it. `ConfirmOrder` is a command. `OrderConfirmed` is an event.

The kit represents a newly accepted fact in two deliberately separate forms:

1. The aggregate creates an immutable `UncommittedDomainEvent`. It contains
   only what the domain owns: type, payload, source aggregate, and payload
   schema version.
2. The application shell records that fact as a `DomainEvent` by attaching an
   id, a recording time, and tracing metadata.

A recorded domain event is plain, immutable data:

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
  schemaVersion: number;
  metadata?: EventMetadata;
}
```

The fields have different jobs:

| Field | Meaning |
| --- | --- |
| `eventId` | Unique id for this event instance. Use it for idempotency and deduplication. |
| `type` | Routing discriminator, such as `"OrderConfirmed"`. |
| `aggregateId` / `aggregateType` | Source aggregate. `createEvent` fills these in automatically. |
| `payload` | Domain data for the fact that happened. |
| `occurredAt` | Time the accepted fact was recorded by the application shell. It is not automatically a business timestamp. |
| `schemaVersion` | Event schema version, used for payload evolution and upcasting. |
| `metadata` | Correlation, causation, user, source, and custom tracing fields. |

`schemaVersion` says which shape the event payload has. It is not an aggregate or
stream position; those values live in `CommittedDomainEvent.position`. It is
also not `AggregateSnapshot.schemaVersion`, which versions the stored snapshot
state shape. A payload change and a snapshot state change bump their own field.

### What the payload carries

An event carries the fact, not a pointer to it. A subscriber acts on the
payload without a read of the source aggregate, and a fold rebuilds state from
the payload alone. A thin notification such as `OrderChanged` with only the id
forces every subscriber back to the source. Replay cannot rebuild state from
it, and a later read of the source shows a newer state than the one the event
announced. Put every value that describes the fact in the payload. Leave out
the rest of the aggregate state.

## Creating Events

Outside an aggregate, `createDomainEvent` is the short convenience form:

```ts
import {
  createDomainEvent,
  createDomainEventFromFacts,
  type DomainEvent,
} from "@shirudo/ddd-kit";

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

The kit marks every event its constructors return as minted. The aggregate
recording paths (`apply`, `setState`, `addDomainEvent`) accept only minted
events; a hand-rolled literal throws `UnmintedEventError` (code
`UNMINTED_EVENT`). The mark has two tiers. A module-private tier covers the
events of this loaded copy of the kit. A cooperative `Symbol.for` brand
covers events that a second loaded copy minted (a duplicate dependency, a
dual CJS/ESM load). The brand catches accidents, not adversaries: code in the
same process can fake it. The gate is not a security boundary; validate
untrusted input at the application edge.

Events should be plain structured-cloneable data. Functions, promises, `WeakMap`, and `WeakSet` do not belong in event payloads. A class instance may lose its prototype through structured cloning, so model event payloads as plain records.

`createDomainEvent` reads the platform clock and Web Crypto when `occurredAt`
or `eventId` is omitted. If the caller must provide every nondeterministic
value, use `createDomainEventFromFacts`:

```ts
const event = createDomainEventFromFacts(
  "OrderConfirmed",
  { orderId: "o-1" },
  {
    eventId: command.eventId,
    occurredAt: command.receivedAt,
    aggregateId: "o-1",
    aggregateType: "Order",
  },
);
```

## Inside aggregates: create the fact, not its envelope

An aggregate method speaks the domain language. Event identifiers, tracing
headers, and recording timestamps do not help an order decide whether it can be
confirmed, so they do not belong in `confirm(...)`.

```ts
class Order extends StateStoredAggregate<OrderState, OrderId, OrderEvent> {
  protected readonly aggregateType = "Order";

  confirm(confirmedAt: Date): void {
    this.setState(
      { ...this.state, status: "confirmed" },
      this.createEvent("OrderConfirmed", {
        orderId: this.id,
        confirmedAt: confirmedAt.toISOString(),
      }),
    );
  }
}
```

`createEvent` clones and freezes the payload and fills in `aggregateId` and
`aggregateType`. It does not read a clock, generate an id, or attach tracing
metadata. The optional `schemaVersion` passed to `createEvent` is the payload schema
version and stays next to the code that creates that payload.

`confirmedAt` is present because it has business meaning. If the domain does
not need that time, leave it out of the method and payload. Do not derive a
business timestamp from the technical event stamp by accident.

Use `createDomainEvent(...)` directly for events that do not come from an aggregate: system events, integration events, test fixtures, process-manager events, and adapter-level events.

See [Aggregates -> A Small Aggregate](./aggregates.md#state-version-domain-events).

## Convenience Defaults

`createDomainEvent` uses the immutable `defaultDomainEventFactory` and fills in
common fields when you omit them:

| Field | Default | Override |
| --- | --- | --- |
| `eventId` | `crypto.randomUUID()` | `options.eventId` or an instance factory |
| `occurredAt` | current clock time | `options.occurredAt` or an instance factory |
| `schemaVersion` | `1` | `options.schemaVersion` |
| `metadata` | `undefined` | `options.metadata` |

These defaults are intentionally convenient and nondeterministic. They are
appropriate in an application shell or for a one-off system event. Aggregate
behavior must use `createEvent`. Its result depends only on visible domain
inputs and current aggregate state.

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

order.confirm(confirmedAt);
recordPendingEvents(order, domainEvents, {
  occurredAt: confirmedAt,
  metadata: { correlationId: request.id },
});
```

The third argument holds the stamp options that every decision of the
recording shares. Pass a callback instead of the factory when the stamp
depends on the concrete decision. The callback receives the uncommitted
decision and its position in the batch:

```ts
recordPendingEvents(order, (decision, index) =>
  domainEvents.createStamp({
    metadata: {
      correlationId: request.id,
      source: index === 0 ? "checkout" : `checkout/${decision.type}`,
    },
  }),
);
```

The returned `DomainEventFactory` is frozen and permanently captures those two
functions. Creating another factory cannot change this one or the
`defaultDomainEventFactory`. This makes the same API safe across overlapping
async requests and parallel tests. No restore hook or async context is needed.
Every clock read is defensively copied and fails immediately with a `TypeError`
if the injected clock does not return a valid `Date`.

`createStamp()` is the bridge from an accepted domain decision to its technical
record. It reads the captured dependencies and returns an immutable
`DomainEventStamp`. A stamp contains only `eventId`, `occurredAt`, and optional
metadata. It cannot select the payload schema version. The factory also exposes
`create(...)` for non-aggregate convenience events and `now()` for
infrastructure such as snapshot policies.

## No factory inside the aggregate

The aggregate does not hold a factory, a clock, or an id generator:

```ts
const order = await loadOrder(orderId);
order.confirm(confirmedAt);
recordPendingEvents(order, domainEvents);

await snapshots.save(
  orderAddress,
  captureAggregateSnapshot(orderSnapshots, order, domainEvents.now()),
);
```

This keeps the aggregate's result a function of its visible inputs. Repositories
do not need to forward a clock or id generator through every reconstitution
path. Snapshot clocks and DTO mappings stay outside the aggregate in an
adapter-owned `SnapshotModel`. The payload schema version is the one value
the producer owns: `this.createEvent("NameChanged", payload, { schemaVersion: 2 })`.

## Deterministic tests

```ts
it("keeps the decision deterministic and records it once", () => {
  const domainEvents = createDomainEventFactory({
    eventIdFactory: () => "evt-1",
    clock: () => new Date("2026-01-01T00:00:00.000Z"),
  });
  const order = Order.reconstitute(orderId, initialState);
  order.confirm();
  const events = recordPendingEvents(order, domainEvents);

  expect(events[0]?.eventId).toBe("evt-1");
});
```

No `afterEach` reset is required because the test owns the factory instance and
never changes module state. More importantly, the aggregate itself never sees
that factory: two equal aggregates given the same domain input produce equal
uncommitted facts. Recording policy can be tested separately.

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
  readonly correlationId?: string;
  readonly conversationId?: string;
  readonly causationId?: string;
  readonly userId?: string;
  readonly source?: string;
  readonly traceparent?: string;
  readonly tracestate?: string;
  readonly [key: string]: unknown;
}
```

The readonly surface prevents context changes in a recorded event. Constructors
still make a defensive copy. A caller can change the original input object
without changing the event.

Use metadata for message relationships and operational context, not for core
domain state. If a value is required to understand the event as a domain fact,
put it in the payload.

The application shell attaches the actor on the stamp. `userId` says who caused
the fact and `correlationId` says in which operation. That is the audit record:
it is present on every recorded event, and no fold reads it. When a rule
depends on the actor, for example "only the owner cancels", the method takes
the actor as an argument and the payload records it as a domain value.

The usual meanings:

- `correlationId` groups messages that belong to one business operation.
- `conversationId` remains stable across a longer business interaction that can
  contain several correlations.
- `causationId` points to the event or command that caused this event.
- `userId` records the actor when known.
- `source` names the producing component or bounded context.
- `traceparent` and `tracestate` carry W3C Trace Context between technical
  spans. They complement business correlation. They do not replace it.

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
version of the immediately preceding EVENTFUL commit. State-only saves do not
advance it. Only the event source at the persistence boundary can construct the
complete cursor. Neither `createDomainEvent` nor `withCommit` can infer it from
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
mapper chooses the public type, schema version, JSON payload, explicit
relationship headers, and optional custom JSON metadata. The public envelope
has distinct optional `correlationId`, `conversationId`, and `causationId`
headers. The boundary mapper explicitly chooses every public relationship
header. `createIntegrationMessage` never copies private domain-event metadata
implicitly; map a same-named field deliberately when it belongs in the public
contract. Omitted relationships stay absent rather than receiving a synthetic
value.

Relationship names are reserved at the envelope level. Putting one inside the
free-form `metadata` object rejects as ambiguous. `encodeIntegrationMessage`
validates the whole graph and rejects
special values, cycles, sparse arrays, non-finite numbers, and properties JSON
would discard. It also rejects hostile own `__proto__` keys before downstream
copy operations can activate them. `decodeIntegrationMessage` performs the
same validation on an untrusted broker body. It accepts RFC 3339 timestamps
with an explicit offset and up to millisecond precision, normalizes them to
canonical UTC `.sssZ`, and returns a deeply frozen message. The producer-side
codec continues to emit and require that canonical representation.

The wire envelope retains `messageId`, the three relationship headers when
present, an ISO `occurredAt`, the qualified aggregate source, and the complete
commit position. Consumers that feed the kit's `Projector` can compose the
validated message into a minted local event with
`integrationMessageToCommittedEvent`. The relationship headers become local
event metadata for downstream tracing; the event still uses the published type
and JSON payload, and restoring the producer's private domain types is
deliberately not attempted.

See the complete [SQS FIFO mapping](./outbox.md#sinks-and-brokers).

## Record After Mutation

A domain event says something happened. The state change must succeed before the event is recorded.

The kit gives you safe paths:

- `EventSourcedAggregate.apply(event)` validates and applies the event before recording it as pending.
- `StateStoredAggregate.setState(newState, events)` validates and assigns state, advances the version, and then appends the events.

On an `StateStoredAggregate`, the lower-level `addDomainEvent` method is still available for special cases, but then the ordering is your responsibility:

```ts
this.setState(nextState);
this.addDomainEvent(
  this.createEvent("OrderConfirmed", { orderId: this.id }),
);
```

On an `EventSourcedAggregate` there is no such path: `setState` throws
`DirectStateMutationError`, and `apply(...)` is the only way to change state.

Do not record first and mutate second. If the mutation throws, the aggregate would carry an event for a fact that never happened.
The mutation must also advance the version before an already-persisted
aggregate is harvested; otherwise two commits would share one projection
position and `withCommit` rejects with `EventHarvestError`. An instance that
this package did not construct (a repository DTO, a structural lookalike, or
an aggregate from another package copy) is rejected at enrollment with
`UnmanagedInstanceError` (code `UNMANAGED_INSTANCE`).

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
