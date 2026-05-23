# Edge Runtimes

The kit is built for modern TypeScript runtimes including Cloudflare Workers, Vercel Edge, Deno Deploy, and Bun. This page covers what works out of the box and what you may want to swap.

## What works out of the box

- **No Node-isms** — no `process`, no `fs`, no `Buffer`. The library reads as plain ESM.
- **`crypto.randomUUID()`** for default event ids — part of Web Crypto, available everywhere the kit runs.
- **`new Date()`** for `occurredAt` — universal.
- **`structuredClone`** for snapshots and `vo()` deep-clones — universal in modern runtimes.
- **`Promise.allSettled`** in the EventBus — universal.
- **`AbortSignal`** support on `EventBus.once({ signal })` — universal.

## What you may want to swap

### Event ids: ULID, KSUID, snowflake

`crypto.randomUUID()` is great for "uniqueness", less great for "sortable" or "compact". Most DDD setups eventually want ULID or KSUID:

```ts
import { setEventIdFactory } from "@shirudo/ddd-kit";
import { ulid } from "ulid";

// Call once at module load / Worker init
setEventIdFactory(() => ulid());
```

The kit's per-call `options.eventId` override always wins, so you can mix strategies (default global factory, per-tenant override at the request boundary).

### Deterministic clocks for testing

```ts
import { setClockFactory, resetClockFactory } from "@shirudo/ddd-kit";

beforeEach(() => {
  setClockFactory(() => new Date("2026-01-01T00:00:00Z"));
});

afterEach(() => {
  resetClockFactory();
});
```

::: warning Module-scoped singletons
Both factories live as module-level variables — "last setter wins". For multi-tenant request isolation in a single Worker invocation, **prefer the per-call `options.eventId` / `options.occurredAt`** rather than mutating the global per request. The factories are for one-time bootstrap (or test setup), not per-request configuration.
:::

## Cloudflare Workers + Durable Objects

A typical write-side wiring looks like:

```ts
// worker.ts
import { CommandBus } from "@shirudo/ddd-kit";

interface Env { ORDERS: DurableObjectNamespace; }

const commandBus = new CommandBus<MyCommands>();
commandBus.register("ConfirmOrder", async (cmd) => {
  // Route to the Durable Object that owns the aggregate
  const id = env.ORDERS.idFromName(cmd.orderId);
  const stub = env.ORDERS.get(id);
  // ... RPC into the Durable Object that holds the order state
});

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const cmd = await req.json() as MyCommand;
    const result = await commandBus.execute(cmd);
    return result.isOk()
      ? new Response(JSON.stringify({ id: result.value }))
      : new Response(result.error, { status: 400 });
  },
};
```

- The `CommandBus` is in-process within the Worker invocation — perfect for single-request orchestration
- Cross-invocation state (the actual aggregate) lives in a Durable Object, KV, or D1
- For the in-process EventBus to be useful you need subscribers in the same Worker invocation — typically logging, metrics, or a post-commit projection update
- For cross-Worker / cross-DO event delivery, use Cloudflare Queues and the `Outbox` port

## Vercel Edge

Same shape as Workers. Vercel's `runtime: "edge"` exposes Web Crypto and `Promise.allSettled`. Persistent storage is whatever you wire up (Postgres via HTTP, Upstash, PlanetScale, Turso, …).

## Deno and Bun

The kit is ESM-only and uses no Node-specific APIs, so Deno and Bun work without any compatibility shims. Bun's faster `crypto.randomUUID()` is automatically picked up.

## Node 18+

Works as expected with `"type": "module"` in `package.json`. Node 18 has Web Crypto behind the global `crypto`. Node 19+ exposes `crypto.randomUUID()` directly.
