# Domain Events

A domain event is a fact that has just happened in the domain.

Use events for facts other parts of the system may care about: an order was confirmed, a payment was captured, a shipment failed. The event should describe the fact, not the command that requested it. `ConfirmOrder` is a command. `OrderConfirmed` is an event.

The kit treats domain events as plain, immutable data:

- they have a stable `eventId`
- they carry a `type` discriminator
- they are deeply frozen
- they can carry correlation metadata
- aggregate events can be routed by `aggregateId` and `aggregateType`
- `withCommit` can stamp commit-position metadata for outbox and projection consumers

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
  aggregateVersion?: number;
  commitSequence?: number;
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
| `aggregateVersion` | Producing aggregate's version at commit time. |
| `commitSequence` | Event position within one aggregate's commit batch. |
| `metadata` | Correlation, causation, user, source, and custom tracing fields. |

Do not confuse `version` with `aggregateVersion`. `version` says which shape the event payload has. `aggregateVersion` says which aggregate state revision emitted the event.

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

`recordEvent` calls `createDomainEvent` and fills in `aggregateId` and `aggregateType` from the aggregate. That metadata is how outbox dispatchers, projection handlers, audit logs, and process managers know which aggregate produced the event.

Calling `createDomainEvent(...)` directly inside an aggregate is easy to get wrong because you must remember those routing fields by hand. `withCommit` validates harvested aggregate events and throws if the fields are missing, but the better path is to make the wrong event hard to create.

Use `createDomainEvent(...)` directly for events that do not come from an aggregate: system events, integration events, test fixtures, process-manager events, and adapter-level events.

See [Aggregate Roots -> A Small Aggregate](./aggregates.md#state-version-domain-events).

## Auto-Generated Fields

`createDomainEvent` fills in common fields when you omit them:

| Field | Default | Override |
| --- | --- | --- |
| `eventId` | `crypto.randomUUID()` | `options.eventId` or `setEventIdFactory(fn)` |
| `occurredAt` | current clock time | `options.occurredAt` or `setClockFactory(fn)` |
| `version` | `1` | `options.version` |
| `metadata` | `undefined` | `options.metadata` |
| `aggregateVersion` | stamped by `withCommit` when unset | `options.aggregateVersion` |
| `commitSequence` | stamped by `withCommit` when unset | `options.commitSequence` |

The default event id is UUID v4 because it comes from Web Crypto's `crypto.randomUUID()`. That is portable and safe for uniqueness, but it is not time-ordered. For large event stores, prefer UUID v7, ULID, or KSUID so indexes stay clustered and ids sort roughly by creation time.

## Where to bootstrap the factory

`setEventIdFactory` and `setClockFactory` are module-level singletons. Call them once at application bootstrap, not per request.

Node or Bun entry point:

```ts
import { setEventIdFactory } from "@shirudo/ddd-kit";
import { v7 as uuidv7 } from "uuid";

setEventIdFactory(() => uuidv7());

import { startServer } from "./server";

startServer();
```

Cloudflare Workers, Vercel Edge, and similar runtimes:

```ts
import { setEventIdFactory } from "@shirudo/ddd-kit";
import { ulid } from "ulid";

setEventIdFactory(() => ulid());

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Events created during this invocation use the configured factory.
  },
};
```

Module top-level code runs when the isolate boots, not once per request. That is the right scope for a process-wide default.

For tests, prefer reset hooks or scoped helpers:

```ts
import { afterEach, it } from "vitest";
import {
  createDomainEvent,
  resetClockFactory,
  resetEventIdFactory,
  setClockFactory,
  withEventIdFactory,
} from "@shirudo/ddd-kit";

afterEach(() => {
  resetEventIdFactory();
  resetClockFactory();
});

it("emits deterministic ids", () => {
  setClockFactory(() => new Date("2026-01-01T00:00:00Z"));

  withEventIdFactory(() => "evt-1", () => {
    const event = createDomainEvent("OrderConfirmed", { orderId: "o-1" });
    expect(event.eventId).toBe("evt-1");
  });
});
```

`withEventIdFactory` and `withClockFactory` are synchronous scoped helpers. They restore the previous factory in a `finally` block, and they reject async callbacks so the factory cannot be restored before awaited code runs.

For async code, prefer per-call options, constructor-injected factories, or an application-level async context such as Node's `AsyncLocalStorage`.

::: warning Last setter wins
The factories are globals inside the module. If two libraries call `setEventIdFactory` during import, the later import wins. If request code changes the factory per tenant, concurrent requests can affect each other.

Use per-call `eventId` and `occurredAt` options for per-request or per-tenant variation.
:::

## Custom id formats

Swap the default id factory once at bootstrap:

```ts
// UUID v7: time-ordered and standards-track
import { v7 as uuidv7 } from "uuid";
setEventIdFactory(() => uuidv7());

// ULID: compact, URL-safe, time-ordered
import { ulid } from "ulid";
setEventIdFactory(() => ulid());
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

## Commit Stamps

`withCommit` can stamp aggregate events with:

- `aggregateVersion`
- `commitSequence`

All events produced by one aggregate in one commit share the same `aggregateVersion`. `commitSequence` is the zero-based position of the event inside that aggregate's harvest batch.

Together, `(aggregateVersion, commitSequence)` is a compact per-aggregate ordering key. Projection handlers can use it as a watermark when they process kit-harvested events in order.

`eventId` is still the general-purpose deduplication key. Use it when events come from mixed sources, older versions, or hand-rolled orchestration that may not provide commit stamps.

See [Outbox & Transactions](./outbox.md) and [Read-Side Projections](./projections.md).

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
