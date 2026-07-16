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

## Scope ids and clocks explicitly

The default event id is UUID v4 from `crypto.randomUUID()`. It is unique and
portable, but it is not time-ordered. For larger event stores, prefer UUID v7,
ULID, or another sortable id format so indexes stay clustered and ids roughly
sort by creation time.

Create an immutable factory for the scope that owns the policy:

```ts
import { createDomainEventFactory } from "@shirudo/ddd-kit";
import { v7 as uuidv7 } from "uuid";

const domainEvents = createDomainEventFactory({
  eventIdFactory: () => uuidv7(),
  clock: () => new Date(),
});
```

The factory is frozen and has no setter. It may live at module scope when the
policy is genuinely process-wide, or be created inside `fetch()` when the
policy is request- or tenant-specific. In either case, pass that value into the
aggregate or application factory that owns event creation.

ULID is the same shape:

```ts
import { createDomainEventFactory } from "@shirudo/ddd-kit";
import { ulid } from "ulid";

const domainEvents = createDomainEventFactory({
  eventIdFactory: () => ulid(),
});
```

Per-event options remain useful for a single exceptional value:

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

Tests construct their own factory and need no global cleanup:

```ts
it("emits deterministic event ids", () => {
  const domainEvents = createDomainEventFactory({
    eventIdFactory: () => "evt-1",
    clock: () => new Date("2026-01-01T00:00:00.000Z"),
  });
  const order = makeOrder({ domainEventFactory: domainEvents });

  order.confirm();
});
```

The same instance works across `await` boundaries because no module state is
changed. See [Domain Events: Instance-bound factories](./domain-events.md#instance-bound-factories).

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

The request body is still untrusted on the edge. `request.json()` reads the
whole body and returns a value TypeScript cannot validate. The example below
authenticates first, reads at most 64 KiB from the stream, parses into `unknown`,
allow-lists the two body fields, and only then constructs branded ids. The
authenticated actor comes from the verified principal, not from the JSON body.
Your authentication and schema libraries may differ; the order of the boundary
steps should not.

```ts
import { CommandBus, type Command, type Id } from "@shirudo/ddd-kit";
import { err, ok, type Result } from "@shirudo/result";

const MAX_COMMAND_BYTES = 64 * 1024;

type OrderId = Id<"OrderId">;
type ActorId = Id<"ActorId">;

type ConfirmOrder = Command & {
  readonly type: "ConfirmOrder";
  readonly orderId: OrderId;
  readonly requestedBy: ActorId;
};

type AppCommand = ConfirmOrder;
type CommandResults = {
  ConfirmOrder: string;
};

interface Env {
  ORDERS: DurableObjectNamespace;
}

interface AuthenticatedPrincipal {
  readonly actorId: string;
}

type RequestFailure = {
  readonly code: "PAYLOAD_TOO_LARGE" | "INVALID_JSON" | "INVALID_COMMAND";
  readonly status: 400 | 413;
};

declare function authenticateRequest(
  request: Request,
  env: Env,
): Promise<AuthenticatedPrincipal | null>;

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
      return err("ORDER_COMMAND_FAILED");
    }

    return ok(command.orderId);
  });

  return bus;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const principal = await authenticateRequest(request, env);
    if (principal === null) {
      return Response.json({ code: "UNAUTHORIZED" }, { status: 401 });
    }

    const input = await readBoundedJson(request, MAX_COMMAND_BYTES);
    if (input.isErr()) return failureResponse(input.error);

    const command = decodeConfirmOrder(input.value, principal);
    if (command.isErr()) return failureResponse(command.error);

    const result = await createCommandBus(env).execute(command.value);

    if (result.isErr()) {
      return Response.json({ code: result.error }, { status: 400 });
    }

    return Response.json({ id: result.value });
  },
};

async function readBoundedJson(
  request: Request,
  maxBytes: number,
): Promise<Result<unknown, RequestFailure>> {
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength !== null &&
    /^\d+$/.test(declaredLength) &&
    Number(declaredLength) > maxBytes
  ) {
    return err({ code: "PAYLOAD_TOO_LARGE", status: 413 });
  }
  if (request.body === null) {
    return err({ code: "INVALID_JSON", status: 400 });
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel("payload too large").catch(() => undefined);
        return err({ code: "PAYLOAD_TOO_LARGE", status: 413 });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed: unknown = JSON.parse(text);
    return ok(parsed);
  } catch {
    return err({ code: "INVALID_JSON", status: 400 });
  }
}

function decodeConfirmOrder(
  input: unknown,
  principal: AuthenticatedPrincipal,
): Result<AppCommand, RequestFailure> {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  ) {
    return err({ code: "INVALID_COMMAND", status: 400 });
  }

  const body = input as Record<string, unknown>;
  const allowed = new Set(["type", "orderId"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    return err({ code: "INVALID_COMMAND", status: 400 });
  }
  if (body.type !== "ConfirmOrder") {
    return err({ code: "INVALID_COMMAND", status: 400 });
  }

  const orderId = orderIdFromWire(body.orderId);
  if (orderId.isErr()) return err(orderId.error);
  const actorId = actorIdFromPrincipal(principal.actorId);
  if (actorId.isErr()) return err(actorId.error);

  return ok({
    type: "ConfirmOrder",
    orderId: orderId.value,
    requestedBy: actorId.value,
  });
}

function boundedId(value: unknown): Result<string, RequestFailure> {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 80 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    return err({ code: "INVALID_COMMAND", status: 400 });
  }
  return ok(value);
}

function orderIdFromWire(
  value: unknown,
): Result<OrderId, RequestFailure> {
  const id = boundedId(value);
  return id.isErr() ? err(id.error) : ok(id.value as OrderId);
}

function actorIdFromPrincipal(
  value: unknown,
): Result<ActorId, RequestFailure> {
  const id = boundedId(value);
  return id.isErr() ? err(id.error) : ok(id.value as ActorId);
}

function failureResponse(failure: RequestFailure): Response {
  return Response.json({ code: failure.code }, { status: failure.status });
}
```

This example keeps the bus as invocation wiring. The durable state still lives
behind the Durable Object, D1, KV, R2, or whatever persistence adapter your
application owns. A body that exceeds the ceiling receives `413`; malformed
JSON or a schema mismatch receives `400`; neither reaches the command bus.
Those expected boundary failures are `Result` values. An unexpected stream or
runtime failure still throws and reaches the deployable's outer error handler.

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

- immutable `DomainEventFactory` instances with process-wide policy
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

The package CI bundles the built `dist` entry points and executes them inside
both Cloudflare's `workerd` (through Miniflare) and the Vercel Edge Runtime
simulator. The smoke imports the main and `money` entry points, mutates a small
aggregate, records an event, dispatches through `CommandBus`, and performs exact
money arithmetic. It also runs without Node's `process` or `Buffer` globals.
This is a compatibility tripwire for the package runtime, not certification of
a consumer's database, broker, or framework adapters.

In-memory adapters are useful for tests, but they are still memory-only:

- `InMemoryOutbox`
- `InMemoryEventStore`
- `InMemorySnapshotStore`
- `InMemoryIdempotencyStore`
- `InMemoryDeadlineStore`
- `InMemoryProjectionCheckpointStore`

Use them to test behavior and contracts. Do not read their existence as a
production durability story for serverless or edge deployments. Their
unconfigured semantic collections are supported only for finite-lifetime tests
and demos. Optional capacities reject before mutation instead of forgetting
event history, receipts, checkpoints, delivery state, or source cursors.
Snapshots are the exception: they are rebuildable derived data, so their
optional capacity uses LRU eviction and their optional TTL may expire entries.

For request deadlines, pass an `AbortSignal` through APIs that accept it. In
tests, use an instance-bound factory or a per-event `occurredAt` option for
deterministic time.

## Practical checklist

- Keep the immutable default or create a factory for the scope that owns the
  event-id and clock policy.
- Pass request-specific factories into aggregate creation and reconstitution.
- Use per-event options for one exceptional id or timestamp.
- Build edge handlers from invocation dependencies such as `env`.
- Keep aggregates and unit-of-work state inside the operation.
- Use in-process buses only inside one invocation.
- Use an outbox plus durable transport for cross-invocation event delivery.
- Treat in-memory stores as tests, demos, or single-process references.
