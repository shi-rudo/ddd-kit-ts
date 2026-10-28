# Command Idempotency

`withIdempotentCommit` protects a logical command from duplicate execution. It
claims an idempotency key before running the use case, stores the plain-data
result, and replays that result when the same key and fingerprint arrive again.
The aggregate write and outbox still follow the ordinary `withCommit` lifecycle.

## Choose the storage family first

There are two adapter families. Each family has its own port, and they do not
provide the same proof.

| Family | Port | Commit boundary | Recovery model | Recommendation |
| --- | --- | --- | --- | --- |
| Transactional | `IdempotencyStore` (`claim`, `complete`) | Idempotency row, aggregate write, and outbox commit in one transaction | Database rollback removes failed claims; committed outcomes replay immediately | Production default |
| Leased | `LeasedIdempotencyStore` (adds `renew`, `confirm`, `abandon`, `reconcile`) | Idempotency record lives outside the source transaction | Heartbeat, token fencing, and source-of-truth reconciliation | Use only when one transaction is impossible |

The transactional pattern is the only one that makes command effect and
idempotency completion atomic. A transactional adapter implements only `claim`
and `complete`. Each port declares its family in a `family` field, and
`withIdempotentCommit` sends the lease operations only to a leased store.

A lease makes a second store recoverable, not atomic. Do not describe it as an
exactly-once boundary across two stores.

## Normal use

```ts
const outcome = await withIdempotentCommit(
  { scope, outbox, idempotency },
  {
    key: qualifiedCommandKey(CONFIRM_ORDER_COMMAND_NAME, actorId, clientKey),
    fingerprint: stableHash(command),
  },
  async (tx, registration) => {
    const loaded = await loadOrderForDirectCommit(tx, command.orderId);
    const order = loaded.aggregate;
    order.confirm();
    await updateOrderForDirectCommit(tx, order, loaded.expectedVersion);

    registration.registerSaved(order);
    return { orderId: order.id };
  },
);
```

`clientKey` is the `Idempotency-Key` header after the boundary validated it.
`actorId` comes from the verified principal, not from the request body. The
kit does not validate or qualify a key. If the raw header is the key, all
clients share one key space. Then a client that knows the key of another
client can replay or block that request. So qualify the client key with the
command name and the authenticated actor. The
[edge runtimes guide](./edge-runtimes.md) defines `qualifiedCommandKey` and
`CONFIRM_ORDER_COMMAND_NAME`, and it shows the complete boundary.

The fingerprint is part of the safety contract. Hash the complete business
intention. Reusing a key for different content throws
`IdempotencyKeyReuseError` instead of replaying the answer to a different
command.

## Leases and fencing

A leased `claim()` returns a `LeasedIdempotencyClaimHandle` with an opaque
token, `expiresAt`, and `renewAfterMs`. The wrapper renews that token while the source
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

For a leased store, `complete` first stages the result. The source
transaction then commits, and `confirm` makes the result replayable. A process
crash between those last two actions leaves a staged result whose effect may or
may not exist.

A failure at commit time leaves the same state. If the scope rejects after the
callback resolved, for example because the connection dropped after `COMMIT`
was sent, the effect can exist. The wrapper does not release the staged
result, so a retry cannot run the command a second time. The wrapper cannot
tell this case from a commit that surely failed, such as a serialization
failure. Both leave the staged result.

**A leased store needs `reconcileIdempotency`.** The dependency type
`WithLeasedIdempotentCommitDeps` requires the callback, so a missing callback
fails at compile time. A staged result that expired stays blocked until the
callback returns `committed` or `not-committed`. While it returns `unknown`,
every retry of the key rejects with `IdempotencyReconciliationRequiredError`.

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
  async (tx, registration, execution) => {
    const loaded = await loadOrderForDirectCommit(tx, command.orderId);
    const order = loaded.aggregate;
    order.confirm();
    await updateOrderForDirectCommit(tx, order, loaded.expectedVersion);

    // Persist this marker in the SAME transaction as the command effect.
    await saveCommandMarker(tx, {
      key: execution.key,
      claimToken: execution.claimToken,
      status: "committed",
    });

    registration.registerSaved(order);
    return { orderId: order.id };
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

Both suites come from `@shirudo/ddd-kit/testing`. Run them against the real
adapter:

- `createIdempotencyStoreContractTests` for a transactional adapter. Its
  environment supplies `run` and `runRolledBack`. The suite proves replay of a
  committed outcome, the fingerprint check, and the release of a rolled-back
  claim. Run it against a real database: the rollback test is the core proof.
- `createLeasedIdempotencyStoreContractTests` for a leased adapter. Its
  environment supplies deterministic `expireLease` and `advanceTimeTo`
  controls. The suite proves lease takeover, renewal past the old expiry,
  stale-owner fencing, staged reconciliation, and the replay and fingerprint
  laws without wall-clock sleeps.

## In-memory references

The kit ships one in-memory reference per family, for finite-lifetime tests
and demos. Neither store is durable. A process restart loses completed records
and can execute a duplicate again. Production idempotency requires durable
storage, regardless of the family.

Without `maxEntries`, a store keeps every record for its lifetime. At the
limit, existing keys still replay normally, but a new key fails before
mutation with `InMemoryCapacityExceededError`. A store never evicts a completed
decision, because that would weaken idempotency.

### `InMemoryIdempotencyStore` (transactional)

```ts
const idempotency = new InMemoryIdempotencyStore({ maxEntries: 10_000 });
const outbox = new InMemoryOutbox();
const scope = new InMemoryTransactionScope([idempotency, outbox]);

await withIdempotentCommit({ scope, outbox, idempotency }, request, work);
```

The store needs the rollback of an `InMemoryTransactionScope`; see
[In-memory transactions](./unit-of-work.md#in-memory-transactions). A
rollback releases the claim, and the commit makes the outcome replayable. If
`claim` or `complete` runs outside a transaction of that scope, the store
throws a `TypeError`: without a rollback, a failed attempt would block its key.

The scope runs one transaction at a time. A duplicate request therefore waits
for the first execution and then replays its outcome.

### `InMemoryLeasedIdempotencyStore` (leased)

```ts
const idempotency = new InMemoryLeasedIdempotencyStore({
  leaseDurationMs: 30_000,
  renewAfterMs: 10_000,
  maxEntries: 10_000,
  clock: () => new Date(),
});
```

The store cannot see commits or rollbacks, so it works without a scope. At
the limit of `maxEntries`, existing keys still renew, reconcile, or release
normally.

Register it with an `InMemoryTransactionScope` for a test that rolls back or
retries. A rollback then undoes `claim` and `complete`, which the port runs
inside the transaction: it returns each key that they wrote to its earlier
entry. The lease operations `renew`, `confirm`, `abandon`, and `reconcile`
stay out of band, so a rollback keeps their writes on every other key. A
confirmation that `withIdempotentCommit` makes after the commit therefore
survives the rollback of the next transaction.

The scope can begin the next transaction before that confirmation. A
duplicate request that the scope queues behind the first one can therefore
still find the first outcome staged. It then gets `IdempotencyInFlightError`,
which is retryable. Wrap the scope in a `RetryingTransactionScope` to get the
replay.
