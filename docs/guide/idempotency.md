# Command Idempotency

`withIdempotentCommit` protects a logical command from duplicate execution. It
claims an idempotency key before running the use case, stores the plain-data
result, and replays that result when the same key and fingerprint arrive again.
The aggregate write and outbox still follow the ordinary `withCommit` lifecycle.

## Choose the storage family first

There are two valid adapter families, but they do not provide the same proof.

| Family | Commit boundary | Recovery model | Recommendation |
| --- | --- | --- | --- |
| Transactional | Idempotency row, aggregate write, and outbox commit in one transaction | Database rollback removes failed claims; committed outcomes replay immediately | Production default |
| Leased non-transactional | Idempotency record lives outside the source transaction | Heartbeat, token fencing, and source-of-truth reconciliation | Use only when one transaction is impossible |

The transactional pattern is the only one that makes command effect and
idempotency completion atomic. `confirm`, `abandon`, `renew`, and `reconcile`
are no-ops for that family.

A lease makes a second store recoverable, not atomic. Do not describe it as an
exactly-once boundary across two stores.

## Normal use

```ts
const outcome = await withIdempotentCommit(
  { scope, outbox, idempotency },
  {
    key: request.headers.get("Idempotency-Key")!,
    fingerprint: stableHash(command),
  },
  async (tx, enrollment) => {
    const orders = makeOrderRepository(tx);
    const order = await orders.getById(command.orderId);
    order.confirm();
    await orders.save(order);

    return {
      result: { orderId: order.id },
      commits: [enrollment.enrollSaved(order)],
    };
  },
);
```

The fingerprint is part of the safety contract. Reusing a key for different
content throws `IdempotencyKeyReuseError` instead of replaying the answer to a
different command.

## Leases and fencing

A leased `claim()` returns an `IdempotencyClaimHandle` with an opaque token,
`expiresAt`, and `renewAfterMs`. The wrapper renews that token while the source
transaction is open. If renewal fails, it rejects before commit and abandons
the exact token.

Every mutating store operation compares both key and token:

- `complete` and `renew` reject a lost token with
  `IdempotencyClaimLostError`.
- `confirm` and `abandon` are idempotent no-ops for a stale token. They cannot
  confirm or delete a successor.
- `reconcile` compares the complete expired receipt. A stale reconciler cannot
  settle a newer owner.

An expired pending claim may be replaced under a new token. If the old worker
later reaches `complete`, fencing rejects it before its source transaction can
commit.

The old and new workers can overlap briefly after takeover. Keep irreversible
external side effects out of `fn`: persist an outbox message in the source
transaction and deliver it after commit. Token fencing can reject a stale
database commit; it cannot undo an HTTP request or broker publish that the old
worker already sent.

Use the adapter's own authoritative clock. A database adapter should normally
use database time; a Redis adapter should use server-side time. Do not compare
process clocks from different hosts to decide ownership.

## The staged crash window

For a non-transactional store, `complete` first stages the result. The source
transaction then commits, and `confirm` makes the result replayable. A process
crash between those last two actions leaves a staged result whose effect may or
may not exist.

The safe state machine is:

| Stored state | Before lease expiry | After lease expiry |
| --- | --- | --- |
| Pending | `IdempotencyInFlightError` | Fresh token may take over |
| Staged | `IdempotencyInFlightError` | `reconciliation-required` |
| Confirmed | Replay stored result | Replay stored result |

An expired staged result is never replayed and never released automatically.
The application shell must consult its authoritative write model:

```ts
const outcome = await withIdempotentCommit(
  {
    scope,
    outbox,
    idempotency,
    reconcileIdempotency: async (receipt, tx) => {
      const resolution = await loadCommandResolution(tx, receipt.key);
      if (resolution?.claimToken !== receipt.token) return "unknown";
      if (resolution.status === "committed") return "committed";
      if (resolution.status === "not-committed") return "not-committed";
      return "unknown";
    },
    onIdempotencyError: (error, context) =>
      telemetry.report("idempotency.lifecycle.failed", { error, ...context }),
  },
  request,
  async (tx, enrollment, execution) => {
    const orders = makeOrderRepository(tx);
    const order = await orders.getById(command.orderId);
    order.confirm();
    await orders.save(order);

    // Persist this marker in the SAME transaction as the command effect.
    await saveCommandMarker(tx, {
      key: execution.key,
      claimToken: execution.claimToken,
      status: "committed",
    });

    return {
      result: { orderId: order.id },
      commits: [enrollment.enrollSaved(order)],
    };
  },
);
```

Return `committed` only when the effect is durably visible. Return
`not-committed` only when durable evidence proves that the old attempt cannot
still commit. An absent row is not enough if an old transaction could still be
in flight. Return `unknown` in every ambiguous case. The wrapper then throws
`IdempotencyReconciliationRequiredError` and preserves the staged record.

The inline callback heals a key on its next delivery. A system that also needs
proactive cleanup can scan expired staged rows in its adapter-specific worker
and apply the same three-way decision. Keep that scan bounded and observable;
the generic kit does not invent pagination or ownership rules for your schema.

## Adapter contract

A durable leased record normally persists at least:

- key and fingerprint,
- state (`pending`, `staged`, or `confirmed`),
- unique ownership token,
- lease expiry under the store's clock,
- staged or confirmed plain-data outcome.

Claim, renewal, takeover, completion, and reconciliation must use atomic
compare-and-set operations. A read followed by an unconditional update is not
sufficient.

Run `createIdempotencyStoreContractTests` from `@shirudo/ddd-kit/testing`
against the real adapter. A non-transactional harness supplies deterministic
`expireLease` and `advanceTimeTo` controls. The suite proves lease takeover,
renewal past the old expiry, stale-owner fencing, staged reconciliation, and
the existing replay/fingerprint/rollback laws without wall-clock sleeps.

## In-memory reference

`InMemoryIdempotencyStore` is a reference implementation for tests and
single-process applications:

```ts
const idempotency = new InMemoryIdempotencyStore({
  leaseDurationMs: 30_000,
  renewAfterMs: 10_000,
  clock: () => new Date(),
});
```

It is not durable. A process restart loses confirmed records and can execute a
duplicate again. Production idempotency requires durable storage, regardless
of whether that storage is transactional or leased.
