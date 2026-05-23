# Event Upcasting

`DomainEvent.version` is intentionally a plain integer rather than a library-managed migration chain. Schema evolution is the consumer's responsibility — every event store handles it differently (sync upcasters in the load path, async upcasters in a projection rebuild, schema-registry coupling, etc.), and shipping a port pre-1.0 without concrete usage data would lock everyone into one shape.

The recommended pattern is to wrap your event-store read path with a per-type upcaster function.

## A minimal upcaster

```ts
import { createDomainEvent, type DomainEvent } from "@shirudo/ddd-kit";

// v1 — initial schema
type OrderCreatedV1 = DomainEvent<"OrderCreated", { customerId: string }>;

// v2 — added currency field with a default migration
type OrderCreatedV2 = DomainEvent<
  "OrderCreated",
  { customerId: string; currency: string }
>;

function upcast(event: DomainEvent<string, unknown>): DomainEvent<string, unknown> {
  if (event.type === "OrderCreated" && event.version === 1) {
    return {
      ...event,
      version: 2,
      payload: {
        ...(event.payload as { customerId: string }),
        currency: "EUR", // default fill for v1 events
      },
    };
  }
  return event;
}

const history = await eventStore.read(aggregateId);
const upcasted = history.map(upcast);
aggregate.loadFromHistory(upcasted);
```

The upcaster runs at the **infrastructure boundary** — before events reach the aggregate's `loadFromHistory`. The aggregate's handlers only see the latest schema; they don't have to know about historical versions.

## Chained upcasters (multi-step migrations)

For aggregates that have gone through many migrations:

```ts
type UpcastFn = (
  event: DomainEvent<string, unknown>,
) => DomainEvent<string, unknown>;

function chain(...fns: UpcastFn[]): UpcastFn {
  return (event) => fns.reduce((e, fn) => fn(e), event);
}

const upcast = chain(
  upcastOrderCreatedV1toV2,
  upcastOrderCreatedV2toV3,
  upcastOrderShippedV1toV2,
);
```

Each step bumps `version` by one. Run them in order; the chain stops when no step matches `(type, version)`.

## Async upcasters (rarely needed)

If the upgrade requires data from outside the event itself (a lookup, a join), do the upcasting in a projection-rebuild job, not in the load path. The synchronous `aggregate.loadFromHistory(events)` path expects events to already be in their canonical shape — adding I/O inside it makes load times unpredictable and turns aggregate hydration into a remote-call cascade.

## When *not* to upcast

A common DDD principle: when the event's *meaning* has changed, don't migrate — emit a new event type instead. `OrderCreated` v1 and `OrderRegistered` are different facts; renaming a field is fine, but rebadging an event because the business rule shifted is misleading.

Reserve upcasting for purely structural migrations (added field with default, renamed field, split-payload). Anything that changes what the event represents deserves a new event type and a parallel handler in the aggregate.

## Why no built-in `EventUpcaster` port

The library deliberately ships no `EventUpcaster` interface. Real upcasting strategies vary too much:

- **Sync vs async** — fast load path vs projection-rebuild
- **Chained vs schema-registry** — per-type functions vs centralised registry
- **Load-path vs storage-time** — upcast on read vs migrate-and-rewrite

Committing to one shape pre-1.0 without consumer feedback would create an abstraction tax that doesn't fit anyone's workflow exactly. The library leaves the seam open; the consumer wires it.
