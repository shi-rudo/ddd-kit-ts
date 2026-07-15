# Deadlines

Some processes wait, and waiting needs a wake-up call. A checkout saga gives
the payment provider thirty minutes before it compensates. A reservation hold
expires after fifteen minutes. An offer lapses at the end of the month. In
every one of these, the interesting event is that nothing happened, and
nothing happening does not show up on an event bus by itself.

The kit's answer is the `DeadlineStore`: durable timeout-as-input. Whoever
starts a wait schedules a deadline; a poll loop later delivers it back as a
plain record, and the process that owns the decision treats it like any other
input. The store never runs your code. Firing a deadline means handing you a
record, nothing more.

This page shows the wiring. The port itself is small: `schedule` and `cancel`
on the write side, `due`, `markDelivered`, `markFailed`, and `deadLetters`
on the poll side.

## Scheduling belongs in the write transaction

The address of a deadline is a `(scope, key)` pair, so one table serves every
waiting process in the application. `scope` names the policy, `key` the
instance:

```ts
await withCommit({ scope, outbox }, async (tx, enrollment) => {
  // Both bound to THIS transaction, like every repository in the callback.
  const sagas = makeSagaRepository(tx);
  const deadlines = makeDeadlineStore(tx);

  const saga = await sagas.getById(sagaId);
  saga.awaitPayment(paymentId);
  await sagas.save(saga);

  // Same transaction as the state change. This is the rule that matters:
  // a saga that committed "waiting for payment" without its deadline is a
  // process that never wakes up.
  await deadlines.schedule({
    scope: "checkout-saga",
    key: String(saga.id),
    dueAt: addMinutes(now, 30),
    payload: { kind: "payment-timeout", paymentId },
  });

  return {
    result: saga.id,
    commits: [enrollment.enrollSaved(saga)],
  };
});
```

Use a transaction-bound store instance inside the callback, the same way your
outbox adapter joins the transaction. The reverse case is just as important:
a deadline scheduled in a transaction that rolls back would be a ghost input
for a state change that never happened, which is why the contract suite
proves rollback purity for both `schedule` and `cancel`.

When the awaited input arrives in time, the same write that processes it
cancels the wait:

```ts
saga.paymentReceived(event);
await sagas.save(saga);
await deadlines.cancel("checkout-saga", String(saga.id));
```

There is at most one pending deadline per address. Scheduling an occupied
address replaces it, which is also how you reschedule: no separate operation,
just schedule again with the new due time. Each scheduling is a fresh
incarnation with a fresh `deliveryId`, so an acknowledgement that races a
reschedule cannot accidentally consume the successor.

One race no store can remove: a deadline that was already polled when your
cancel committed still gets delivered. A delivered deadline is therefore a
proposal, not a verdict; the process that owns it checks its current state
and ignores a timeout for a wait that has ended. That check costs one guard
in the handler, and a saga fed through its state machine gets it for free:
the "payment timeout" input simply has no transition out of the "payment
received" state.

## Delivery: the processor runs the loop, you bring the handler

The delivery loop itself looks trivial, and its core is: fetch what is due,
hand each record to a handler, acknowledge or report the failure. What is
not trivial is everything around that core. What happens when `due()` throws
because the database blinked? Who backs off under a persistent fault instead
of spinning hot? How does the loop stop cleanly on deploy? What if two cron
ticks overlap and deliver the same deadlines twice? Those are exactly the
questions the outbox dispatcher answers, so the kit ships the same hardening
for deadlines as `DeadlineProcessor`:

```ts
const processor = new DeadlineProcessor({
  store: deadlines,
  handler: async (deadline) => {
    // Feed it to the owner as an input; check current state first,
    // a delivered deadline is a proposal (see above).
    await commandBus.dispatch(toTimeoutCommand(deadline));
  },
  observers: {
    onDeliveryError: (error, deadline) =>
      log.warn({ error, key: deadline.key }, "deadline delivery failed"),
    onPollError: (error) => log.warn({ error }, "deadline poll failed"),
    onDeadLetter: (deadline) =>
      alerts.page({ key: deadline.key }, "deadline dead letter"),
  },
});

const stop = new AbortController();
void processor.run(stop.signal);
// on shutdown: stop.abort();
```

For cron triggers and serverless runtimes, call `processor.drainOnce()` per
tick instead of the long-running `run`; overlapping ticks are safe, a tick
that fires while a pass is still running joins it instead of starting a
competing poll. One caveat for bounded invocations: a pass loops batch by
batch until nothing is due, which can outlast a serverless deadline after
downtime left a large backlog. Pass a signal wired to your runtime's budget
(`drainOnce(AbortSignal.timeout(remainingMs))`) so the pass ends cleanly;
acknowledged work stays done, the rest waits for the next tick.

The delivery semantics are simpler than the outbox dispatcher's, on purpose.
Deadlines carry no ordering obligation between addresses, so a handler that
throws does not stop the batch: the failing deadline is reported via
`markFailed` (bounded retries, then the dead-letter set) and its neighbors
keep flowing in the same pass, acknowledged together in one `markDelivered`
call. An acknowledgement failure is different: it signals the store's write
path, not a poison record, so it ends the cycle instead of re-running every
remaining handler against a dead write path, and the handled-but-unacked
deadlines redeliver later as the documented duplicates.

Under `run(signal)`, a cycle that contained any failure sleeps a jittered,
growing backoff before the next poll, so a persistent fault degrades to a
slow, observable retry cadence rather than a hot loop. A bare `drainOnce`
returns immediately by design; there the tick cadence is the pacing, so do
not wrap it in a tight `while` loop without your own delay, and let the
`"stopped"` return value tell you the cycle hit a failure.

The clock is injectable (`clock` option, handed to `due` on every poll),
which keeps adapters deterministic and lets tests fire deadlines without
waiting for real time.

Delivery is at-least-once: a crash or a failed acknowledgement after
handling redelivers on a later poll, deliberately without counting toward
the poison ceiling, since the deadline WAS handled. Make the handling
idempotent; the idempotency store with the `deliveryId` as the key is the
ready-made answer, and if the handler feeds a saga, the saga's own inbox
already covers it.

`deadLetters()` is the set to wire into durable alerting. A growing dead-letter
set means processes that stopped waking up. The required `onDeadLetter`
observer gives an immediate signal from the exact ceiling-crossing
`markFailed` call, but it is best-effort: a process can stop after the store
commits the transition and before the callback runs. Reconcile by polling the
store; observer throws and rejected promises are neutralized so monitoring
cannot change delivery state.

Run one logical processor per store unless your adapter's `due` claims
records for competing pollers; the same rule as the outbox dispatcher. And
the port stays open: if your runtime already has a delivery loop, poll
`due`/`markDelivered`/`markFailed` yourself; the processor is convenience,
not a requirement.

## What this deliberately is not

There is no recurrence, no cron abstraction, no execution engine, and no
callback registration. Those belong to scheduler infrastructure, and the kit
stops at the port: durable storage for "wake this process at this time with
this payload" plus the delivery bookkeeping. If you need "every night at
three", use your platform's scheduler to run the poll loop; the deadlines
themselves stay single-shot inputs.

`InMemoryDeadlineStore` is the reference implementation for tests and demos
(not transaction-aware, like every in-memory reference). An adapter proves
itself with `createDeadlineStoreContractTests` from
`@shirudo/ddd-kit/testing`; a Postgres implementation is a single table with
an index on `(due_at)` and the usual `ON CONFLICT` upsert for the
one-per-address rule.

Without `maxRecords`, pending and dead-letter records are unbounded for the
instance lifetime. Long-lived demos may set the option; once pending plus dead
letters reaches it, scheduling a new address throws
`InMemoryCapacityExceededError` before mutation. Rescheduling an existing
pending address remains legal, and cancellation, acknowledgement, or explicit
dead-letter delivery releases capacity. The store never discards a deadline
silently.
