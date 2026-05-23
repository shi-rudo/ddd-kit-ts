# Domain Events

A domain event represents something that has **just happened** in the domain. The kit treats events as facts of the past — immutable, identifiable, and (by convention) recorded after the state change they describe.

## Shape

```ts
interface DomainEvent<T extends string, P = void> {
  eventId: string;                // auto-generated UUID v4 by default
  type: T;                        // discriminator tag
  aggregateId?: string;           // set whenever the producing aggregate is known
  aggregateType?: string;
  payload: P;                     // undefined when P = void
  occurredAt: Date;
  version: number;                // event schema version
  metadata?: EventMetadata;       // correlationId, causationId, userId, source, ...
}
```

## Construction: `createDomainEvent`

```ts
import { createDomainEvent, type DomainEvent } from "@shirudo/ddd-kit";

type OrderConfirmed = DomainEvent<"OrderConfirmed", { orderId: string }>;

const event = createDomainEvent("OrderConfirmed", { orderId: "o-1" }, {
  aggregateId: "o-1",
  aggregateType: "Order",
  metadata: { correlationId: "req-42", userId: "u-7" },
}) as OrderConfirmed;
```

The returned event is **deeply frozen**. Mutating it (or any nested object) throws — a mutating EventBus subscriber cannot poison subsequent handlers.

### Auto-generated fields and override hooks

| Field | Default | Override |
|---|---|---|
| `eventId` | `crypto.randomUUID()` | `options.eventId` (per-call) or `setEventIdFactory(fn)` (global) |
| `occurredAt` | `new Date()` | `options.occurredAt` (per-call) or `setClockFactory(fn)` (global) |
| `version` | `1` | `options.version` |
| `metadata` | `undefined` | `options.metadata` |

#### Deterministic ids and timestamps for tests

```ts
import { setEventIdFactory, setClockFactory, resetEventIdFactory, resetClockFactory } from "@shirudo/ddd-kit";

beforeEach(() => {
  let n = 0;
  setEventIdFactory(() => `evt-${++n}`);
  setClockFactory(() => new Date("2026-01-01T00:00:00Z"));
});

afterEach(() => {
  resetEventIdFactory();
  resetClockFactory();
});
```

::: warning Module-scoped — last setter wins
Both factories live in module-level singletons. In a multi-tenant request flow (e.g. one Worker invocation), **prefer the per-call `options.eventId` / `options.occurredAt`** instead of mutating the global — two libraries / two tenants would race on load order.
:::

#### Custom id formats (ULID, KSUID)

```ts
import { ulid } from "ulid";
setEventIdFactory(() => ulid()); // call once at bootstrap
```

## Metadata

`EventMetadata` is a free-form bag with conventional fields:

```ts
interface EventMetadata {
  correlationId?: string;     // groups related events across services
  causationId?: string;       // the eventId / commandId that produced this event
  userId?: string;
  source?: string;            // producing service/component name
  [key: string]: unknown;     // extensible
}
```

Helpers to keep correlation chains intact:

```ts
import { copyMetadata, mergeMetadata } from "@shirudo/ddd-kit";

const previous = await loadLastEvent();

const next = createDomainEvent("OrderShipped", { trackingNumber: "T-1" }, {
  metadata: copyMetadata(previous, { causationId: previous.eventId }),
});

// Merge multiple metadata layers (later overrides earlier on the same key):
const md = mergeMetadata(
  { correlationId: "corr-1" },
  { userId: "u-7" },
  { source: "order-service" },
);
```

## Convention: record after mutation

A domain event represents something that has **just happened**. The state change must already have committed before the event is recorded.

- `EventSourcedAggregate.apply()` enforces this structurally — state and event commit atomically.
- `AggregateRoot.commit(newState, events)` enforces this via the helper — state mutates first (and throws on validateState), only then are events appended.
- Direct `setState` + `addDomainEvent` is fine but the ordering is convention only — keep them in that order, and never record an event before the state change that justifies it.

Recording before mutation is a footgun: if a subsequent invariant throws, the event has been queued for a fact that never actually happened.
