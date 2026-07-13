# Event Upcasting

`DomainEvent.version` is the schema version of the event payload.

It is not the aggregate version. It does not say where the event sits in the
stream. It answers one narrow question: "Which shape does this event payload
have?"

The kit does not ship a built-in upcaster pipeline. That is intentional.
Different stores and teams choose different migration points: upcast on read,
rewrite stored events, rebuild projections, or use a schema registry. The stable
contract is simpler: aggregate handlers should receive the current event shape.
Adapters decide how old events become that shape.

## When to bump `event.version`

Bump `event.version` when you keep the same event type but change the payload
shape.

Example: `OrderCreated` originally had only `customerId`. Version 2 adds
`currency`.

```ts
type OrderCreatedV1 = DomainEvent<
  "OrderCreated",
  { customerId: string }
>;

type OrderCreated = DomainEvent<
  "OrderCreated",
  { customerId: string; currency: string }
>;
```

New writes must stamp the new version:

```ts
this.apply(
  this.recordEvent(
    "OrderCreated",
    {
      customerId,
      currency,
    },
    { version: 2 },
  ),
);
```

If you forget `{ version: 2 }`, the event is written with the default version
`1`, even though the payload has the new shape. That makes old and new events
ambiguous and forces consumers to infer schema from fields. Do not do that.

## Upcast at the boundary

Upcast after reading from storage and before events reach the aggregate:

```ts
const stored = await eventStore.readStream({
  aggregateType: "Order",
  aggregateId: orderId,
});
if (!stored.exists) return null;

const history = stored.events.map(upcastOrderEvent) as OrderEvent[];

const order = Order.reconstitute(orderId);
const result = order.loadFromHistory(history);
```

The aggregate only handles the current union:

```ts
type OrderEvent = OrderCreated | OrderConfirmed | OrderShipped;
```

It should not contain `OrderCreatedV1` handlers, migration branches, or checks
like `if (event.version === 1)`. That logic belongs at the infrastructure
boundary. Otherwise every aggregate method slowly turns into an archive of old
storage formats.

## A minimal upcaster

An upcaster preserves the event envelope and changes only the schema fields it
owns: usually `version` and `payload`.

Do not call `createDomainEvent(...)` to upcast a stored event. That would create
a new `eventId`, `occurredAt`, and metadata unless you copied every option
perfectly. The event already happened. Preserve its identity.

```ts
import type {
  AnyDomainEvent,
  DomainEvent,
} from "@shirudo/ddd-kit";

type OrderCreatedV1 = DomainEvent<
  "OrderCreated",
  { customerId: string }
>;

type OrderCreatedV2 = DomainEvent<
  "OrderCreated",
  { customerId: string; currency: string }
>;

type UpcastFn = (event: AnyDomainEvent) => AnyDomainEvent;

function convertOrderCreatedV1ToV2(
  event: OrderCreatedV1,
): OrderCreatedV2 {
  return {
    ...event,
    version: 2,
    payload: {
      ...event.payload,
      currency: "EUR",
    },
  };
}

function upcastOrderCreatedV1ToV2(
  event: AnyDomainEvent,
): AnyDomainEvent {
  if (event.type !== "OrderCreated" || event.version !== 1) {
    return event;
  }

  return convertOrderCreatedV1ToV2(event as OrderCreatedV1);
}

function rejectUnknownOrderCreatedVersion(
  event: AnyDomainEvent,
): AnyDomainEvent {
  if (event.type === "OrderCreated" && event.version !== 2) {
    throw new Error(
      `Unsupported OrderCreated version ${event.version}`,
    );
  }

  return event;
}

const upcastOrderEvent: UpcastFn = (event) =>
  rejectUnknownOrderCreatedVersion(
    upcastOrderCreatedV1ToV2(event),
  );
```

Reject unknown future versions. Silently replaying an event with a newer shape
is worse than failing the load, because the aggregate may interpret missing or
renamed fields as valid domain data.

## Chain small steps

For long-lived streams, keep each migration small and explicit.

```ts
type UpcastFn = (event: AnyDomainEvent) => AnyDomainEvent;

function chain(...steps: UpcastFn[]): UpcastFn {
  return (event) =>
    steps.reduce((current, step) => step(current), event);
}

const latestVersions = new Map<string, number>([
  ["OrderCreated", 3],
  ["OrderShipped", 2],
]);

const rejectUnknownOrderEventVersions: UpcastFn = (event) => {
  const latest = latestVersions.get(event.type);
  if (latest !== undefined && event.version !== latest) {
    throw new Error(
      `Unsupported ${event.type} version ${event.version}`,
    );
  }

  return event;
};

const upcastOrderEvent = chain(
  upcastOrderCreatedV1ToV2,
  upcastOrderCreatedV2ToV3,
  upcastOrderShippedV1ToV2,
  rejectUnknownOrderEventVersions,
);
```

Each step should match exactly one `(type, version)` pair and return the event
unchanged when it does not apply. That keeps ordering boring and makes test
fixtures easy to read.

Keep load-path upcasters synchronous and deterministic. They should not call a
database, service, cache, or feature flag provider. Aggregate hydration should
not become a network cascade.

## If migration needs I/O

Some changes cannot be derived from the old event alone. For example, an old
event may need a customer country from another table to choose the right
currency.

Do not do that lookup inside `loadFromHistory(...)`.

Use one of these instead:

| Situation | Better path |
| --- | --- |
| projections need the new shape | rebuild the projection with an async migration job |
| all consumers need the new shape and the data is known | rewrite or backfill events in storage with operational controls |
| only new behavior needs the data | emit a new event type when the new fact becomes known |

The load path should stay fast, local, and predictable.

## When not to upcast

Upcasting is for structural changes:

- added field with a safe default
- renamed field
- split one field into several fields
- normalized a payload representation

Do not upcast when the meaning changed.

If `OrderCreated` used to mean "cart opened" and the business now needs
"order accepted by sales", that is not version 2 of the same fact. Emit a new
event type such as `OrderAccepted`.

Old facts should remain true. Upcasting should make old facts readable by new
code, not rewrite history into a different business event.

## Read-time vs storage-time migration

Read-time upcasting is the usual first choice:

- old events remain unchanged
- the migration is easy to deploy with application code
- rollback is simple
- every read pays the migration cost

Storage-time migration rewrites or backfills events:

- reads become simpler and faster
- the migration needs operational safety, backups, and idempotency
- rollback is harder
- audit rules may forbid rewriting historical records

Both are valid. For most teams, read-time upcasting is the safer default until
the migration cost is measurable.

## Snapshots need a plan too

Snapshots are state derived from events. If a handler change or event migration
would produce different state from a full replay, an old snapshot may no longer
match current code.

Use one of these strategies:

- bump `snapshotSchemaVersion` and discard mismatched snapshots
- implement `migrateSnapshotState(...)` when the old snapshot shape can be
  upgraded safely
- rebuild affected snapshots as part of the migration

Do not update event upcasters and forget snapshots. That creates the classic
bug where fresh replay and snapshot restore produce different aggregates.

## Test with old fixtures

For every historical event version you support, keep at least one fixture:

```ts
const orderCreatedV1: OrderCreatedV1 = {
  eventId: "evt-1",
  type: "OrderCreated",
  aggregateId: "order-1",
  aggregateType: "Order",
  payload: { customerId: "customer-1" },
  occurredAt: new Date("2026-01-01T00:00:00Z"),
  version: 1,
};

expect(upcastOrderEvent(orderCreatedV1)).toMatchObject({
  eventId: "evt-1",
  occurredAt: new Date("2026-01-01T00:00:00Z"),
  version: 2,
  payload: {
    customerId: "customer-1",
    currency: "EUR",
  },
});
```

The test should prove three things:

- old payloads become the current payload shape
- envelope fields such as `eventId`, `occurredAt`, `metadata`,
  `aggregateId`, and `aggregateType` survive
- unknown versions fail loudly

Also run an aggregate replay test with mixed-version history. A unit test for
the upcaster alone is not enough; the real contract is "old streams still load
into a valid current aggregate."

## Why there is no `EventUpcaster` port

An `EventUpcaster` interface would be easy to add and hard to make correct for
everyone.

Some teams upcast on read. Some migrate storage. Some use schema registries.
Some need async rebuild jobs. Some stores expose revision metadata that should
drive the migration. A library-level port would either be too weak to help or
too opinionated for real event stores.

Keep the seam at the adapter boundary. Read old events, turn them into the
current event union, then hand them to the aggregate.
