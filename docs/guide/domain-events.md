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
| `eventId` | `crypto.randomUUID()` (UUID **v4**) | `options.eventId` (per-call) or `setEventIdFactory(fn)` (global) |
| `occurredAt` | `new Date()` | `options.occurredAt` (per-call) or `setClockFactory(fn)` (global) |
| `version` | `1` | `options.version` |
| `metadata` | `undefined` | `options.metadata` |

::: tip Prefer time-ordered ids in production
`crypto.randomUUID()` is always **UUID v4** — purely random, no time component. Fine for tests and small workloads, but it scatters across B-tree indexes and amplifies writes once the event store grows. For production, swap in UUID v7 (RFC 9562), ULID, or KSUID via `setEventIdFactory` — all three are time-ordered, so `ORDER BY eventId ASC` matches creation order and indexes stay clustered. See [Edge Runtimes → Event ids](./edge-runtimes.md#event-ids-ulid-ksuid-snowflake) for the drop-ins.
:::

#### Where to bootstrap the factory

Both `setEventIdFactory` and `setClockFactory` are **process-wide singletons** — call them **once, at your app's entry point**, before any code constructs a domain event. Subsequent calls overwrite the previous factory (last setter wins), so a per-request `setEventIdFactory(...)` is almost always a bug. For per-request / per-tenant variance, use the per-call `options.eventId` / `options.occurredAt` overrides on `createDomainEvent` instead.

The right place depends on your runtime:

**Node / Bun entry point** — at the top of your main module, before any handler or use case imports a domain event:

```ts
// src/main.ts  (or index.ts, server.ts — your process entry)
import { setEventIdFactory } from "@shirudo/ddd-kit";
import { v7 as uuidv7 } from "uuid";

setEventIdFactory(() => uuidv7());

// ... then the rest of the bootstrap (express server, fastify, etc.)
import { startServer } from "./server";
startServer();
```

**Cloudflare Workers / Vercel Edge** — at module top level in the worker file. Module top-level code runs **once per isolate boot**, not per request, so the factory is set once and lives for the lifetime of that isolate:

```ts
// worker.ts
import { setEventIdFactory } from "@shirudo/ddd-kit";
import { v7 as uuidv7 } from "uuid";

// Runs once when the isolate boots. Don't put this inside fetch().
setEventIdFactory(() => uuidv7());

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // ... domain events created here use the v7 factory ...
  },
};
```

**Test setup file** — once per test file, or globally via your test runner's setup config. The reset helpers exist so each test sees the default again unless it opts in:

```ts
// vitest.setup.ts  (referenced from vitest.config.ts `setupFiles`)
import { afterEach } from "vitest";
import { resetEventIdFactory, resetClockFactory } from "@shirudo/ddd-kit";

afterEach(() => {
  resetEventIdFactory();
  resetClockFactory();
});
```

```ts
// A single test that needs determinism opts in:
import { setEventIdFactory, setClockFactory } from "@shirudo/ddd-kit";

it("emits a deterministic event", () => {
  let n = 0;
  setEventIdFactory(() => `evt-${++n}`);
  setClockFactory(() => new Date("2026-01-01T00:00:00Z"));

  // ... assertions on event.eventId === "evt-1", event.occurredAt fixed ...
});
```

::: warning Module-scoped — last setter wins
Both factories live in module-level singletons. In a multi-tenant request flow (e.g. one Worker invocation serving multiple tenants, two libraries that both call `setEventIdFactory` at import time), **don't mutate the global per request** — that's a race waiting to happen. Use the per-call `options.eventId` / `options.occurredAt` on `createDomainEvent` instead; it always wins over the factory.
:::

#### Custom id formats (UUID v7, ULID, KSUID)

```ts
// UUID v7 — RFC 9562 standards-track, time-ordered
import { v7 as uuidv7 } from "uuid";
setEventIdFactory(() => uuidv7());

// ULID — 26-char Crockford base32, time-ordered, URL-safe
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
