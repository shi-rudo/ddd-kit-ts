# Edge Runtimes

`@shirudo/ddd-kit` is a runtime-light library. It does not require a framework,
a message broker, or Node-only APIs for the domain model to work.

That makes it a good fit for Cloudflare Workers, Vercel Edge, Deno Deploy, Bun,
and modern Node. The important caveat is architectural, not technical: edge
runtimes keep isolates warm and run many requests over time. Module scope is
shared infrastructure, not request state.

Use module scope for immutable configuration, prepared definitions, clients,
and one-time factory setup. Keep aggregates, identity maps, unit-of-work
sessions, transaction handles, correlation ids, and per-request clocks inside
the request or operation.

## Runtime contract

The published package is ESM-only and declares Node `>=22` for Node consumers.
Projects using CommonJS need a bundler or an ESM migration.

The runtime surface is intentionally small:

- no required `process`, `fs`, or `Buffer` usage in the package runtime
- default event ids use Web Crypto's `crypto.randomUUID()`
- event and snapshot timestamps use `new Date()`
- aggregate snapshots and value-object cloning use `structuredClone`
- `EventBus` uses `Promise.allSettled`
- cancellation-aware APIs accept `AbortSignal`

Those are Web-platform APIs in the runtimes this package targets. If your
deployment target lacks one, patch that at the application boundary. Do not
hide a runtime polyfill inside an aggregate or value object.

## Bootstrap ids and clocks once

The default event id is UUID v4 from `crypto.randomUUID()`. It is unique and
portable, but it is not time-ordered. For larger event stores, prefer UUID v7,
ULID, or another sortable id format so indexes stay clustered and ids roughly
sort by creation time.

Configure the default event id factory at module top level:

```ts
// worker.ts, server.ts, or your test setup file
import { setEventIdFactory } from "@shirudo/ddd-kit";
import { v7 as uuidv7 } from "uuid";

setEventIdFactory(() => uuidv7());
```

ULID is the same shape:

```ts
import { setEventIdFactory } from "@shirudo/ddd-kit";
import { ulid } from "ulid";

setEventIdFactory(() => ulid());
```

In Workers and similar runtimes, module top-level code runs when an isolate is
created or reused, not once per request. That is the right scope for a
process-wide default.

Do not call `setEventIdFactory` or `setClockFactory` from request code to model
tenant or user-specific behavior. They are module-level singletons: last setter
wins. In concurrent request handling, one request can affect another.

Use per-event options for request-specific values:

```ts
const event = createDomainEvent(
  "OrderConfirmed",
  { orderId },
  {
    eventId: requestEventId,
    occurredAt: requestTime,
  },
);
```

For tests, reset factories in `afterEach` or use the synchronous scoped helpers:

```ts
import {
  resetClockFactory,
  resetEventIdFactory,
  setClockFactory,
  withEventIdFactory,
} from "@shirudo/ddd-kit";

afterEach(() => {
  resetEventIdFactory();
  resetClockFactory();
});

it("emits deterministic event ids", () => {
  setClockFactory(() => new Date("2026-01-01T00:00:00Z"));

  withEventIdFactory(() => "evt-1", () => {
    order.confirm();
  });
});
```

`withEventIdFactory` and `withClockFactory` are synchronous-only. They restore
the previous factory in a `finally` block and reject async callbacks. For async
request scoping, use per-call event options, dependency injection, or an
application-level async context.

See [Domain Events: Where to bootstrap the factory](./domain-events.md#where-to-bootstrap-the-factory).

## In-process buses stay in-process

`CommandBus`, `QueryBus`, and `EventBus` are useful on the edge because they are
ordinary in-memory dispatchers. That is also their limit.

Use them for work that happens inside one invocation:

- route a parsed HTTP command to an application handler
- run validation, authorization wrappers, and tracing decorators
- publish post-commit events to in-process observers such as logging or metrics
- coordinate tests without a broker

Do not treat them as cross-invocation delivery. They do not persist messages,
retry after isolate shutdown, coordinate across Durable Objects, or deliver to
another worker instance. Use an outbox plus your platform's queue, broker, or
CDC pipeline for that.

## Cloudflare Workers and Durable Objects

On Cloudflare Workers, `env` is provided per invocation. If a handler needs
bindings from `env`, build the bus from `env` inside `fetch` or inside a small
factory. Do not register a module-scope handler that closes over a non-existent
`env`.

```ts
import { CommandBus, type Command } from "@shirudo/ddd-kit";
import { err, ok } from "@shirudo/result";

type ConfirmOrder = Command & {
  type: "ConfirmOrder";
  orderId: string;
};

type AppCommand = ConfirmOrder;
type CommandResults = {
  ConfirmOrder: string;
};

interface Env {
  ORDERS: DurableObjectNamespace;
}

function createCommandBus(env: Env): CommandBus<CommandResults> {
  const bus = new CommandBus<CommandResults>();

  bus.register("ConfirmOrder", async (command: ConfirmOrder) => {
    const id = env.ORDERS.idFromName(command.orderId);
    const stub = env.ORDERS.get(id);

    const response = await stub.fetch("https://orders/commands", {
      method: "POST",
      body: JSON.stringify(command),
    });

    if (!response.ok) {
      return err(`Order command failed with ${response.status}`);
    }

    return ok(command.orderId);
  });

  return bus;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const command = (await request.json()) as AppCommand;
    const result = await createCommandBus(env).execute(command);

    if (result.isErr()) {
      return new Response(result.error, { status: 400 });
    }

    return Response.json({ id: result.value });
  },
};
```

This example keeps the bus as invocation wiring. The durable state still lives
behind the Durable Object, D1, KV, R2, or whatever persistence adapter your
application owns.

For domain events, the same rule applies:

- in-process `EventBus` subscribers are fine for logging, metrics, and local
  reactions after commit
- cross-Worker or cross-Durable-Object delivery needs an outbox and a durable
  transport such as Queues or another broker
- `ctx.waitUntil(...)` is useful for best-effort background work, but it is not
  a substitute for durable event delivery

The safest mental model is simple: an edge invocation may disappear after it
returns. Anything that must survive needs to be written to durable storage or a
durable queue before the response path lets go of it.

## Vercel Edge

Vercel Edge has the same shape: Web APIs are available, Node APIs are not the
default assumption, and module scope can be reused across requests.

Keep database and broker integrations edge-compatible. Many traditional Node
drivers assume TCP sockets or Node globals; edge functions usually need HTTP
drivers, platform storage, or a server-side adapter behind an HTTP boundary.

The kit does not care which storage option you choose. Repositories,
transaction scopes, outboxes, and idempotency stores are ports. The adapter owns
the runtime-specific connection details.

## Deno, Bun, and Node

Deno and Bun work with the ESM package without CommonJS shims. Use the same
rules as edge functions: keep domain state in operation scope, persist durable
state explicitly, and treat in-memory stores as test or demo tools unless the
process lifetime is truly your durability boundary.

Node consumers must run as ESM and satisfy the package's Node `>=22` engine.
Long-lived Node processes make module scope feel safer, but the DDD rules do
not change. A cached database client is fine. A cached aggregate instance is
not.

## What belongs in module scope

Good module-scope values:

- `setEventIdFactory(...)` and `setClockFactory(...)` bootstrap
- immutable lookup tables
- prepared machine definitions that do not capture request state
- shared clients whose SDK is safe to reuse
- handler factories that are pure over their dependencies

Bad module-scope values:

- aggregate instances
- unit-of-work sessions
- identity maps
- transaction handles
- current user, tenant, correlation id, or request clock
- pending domain events or outbox records

The bad list is not about style. It is about correctness under reuse. A warm
isolate or long-lived process can keep those objects alive after one request
and expose them to the next.

## Testing edge-shaped code

In-memory adapters are useful for tests, but they are still memory-only:

- `InMemoryOutbox`
- `InMemoryEventStore`
- `InMemorySnapshotStore`
- `InMemoryIdempotencyStore`

Use them to test behavior and contracts. Do not read their existence as a
production durability story for serverless or edge deployments.

For request deadlines, pass an `AbortSignal` through APIs that accept it. In
tests, prefer deterministic clocks through `setClockFactory` or per-event
`occurredAt` options. Avoid request-wide factory mutation in async tests; it has
the same leakage problem as production request code.

## Practical checklist

- Configure event id and clock defaults once during bootstrap.
- Use per-event options or dependency injection for request-specific ids and
  timestamps.
- Build edge handlers from invocation dependencies such as `env`.
- Keep aggregates and unit-of-work state inside the operation.
- Use in-process buses only inside one invocation.
- Use an outbox plus durable transport for cross-invocation event delivery.
- Treat in-memory stores as tests, demos, or single-process references.
