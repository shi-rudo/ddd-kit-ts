# Sagas and Process Managers

Some business processes span several aggregates and take their time doing
it. An order gets placed, a payment gets requested, the payment provider
answers minutes later, shipping follows, and if anything goes wrong along
the way, earlier steps have to be undone: the payment refunded, the order
cancelled. Somebody has to remember where the process stands and decide
what happens next.

The kit's answer may be surprising after all the ports on the neighboring
pages: there is no saga primitive here, and that is a decision, not a gap.
A saga is a regular aggregate. Everything it needs already exists, and this
page shows how the pieces fit. If you want the design procedure itself,
which steps are compensatable, how to classify failures, when a saga is the
wrong tool entirely, that lives in the skill's `saga-design.md`; this page
is about wiring, not design.

The runnable version of everything below sits in
[`examples/saga`](https://github.com/shi-rudo/ddd-kit-ts/tree/main/examples/saga):
a checkout process across three aggregates, with compensation, driven
entirely through public kit APIs. Its README also untangles the saga versus
process manager terminology; here we say saga throughout, meaning the
centralized, stateful orchestrator.

## Is a saga the right tool here?

Before wiring anything, it is worth asking whether the process in front of
you is a saga at all, because the most common saga mistake is building one
where something simpler was owed. The full decision procedure is
`saga-design.md`'s Qualification fork; the short version reads like a
ladder, and you stop at the first rung that holds:

If one aggregate can protect the invariant in one transaction, it is not a
saga, it is an aggregate you have not modeled yet, and reaching for a saga
here usually means hiding a bad boundary. If there is one consequence to
trigger and no state to remember ("when an order confirms, send the mail"),
that is an event and a subscriber, done. If several things happen but
nothing needs to survive a crash and nothing ever needs undoing, plain
choreography through subscribers is enough, and no coordinator earns its
keep. If the process needs durable state and crash recovery but never
compensates, build exactly this page minus the compensation section, and
call it a process manager rather than a saga. Only when several local
transactions commit independently, the process has to remember where it
stands, and partial success needs compensation or forward recovery, have
you arrived at a saga, and the rest of this page applies in full.

Two boundaries are worth naming even then. A saga coordinates; it must not
absorb the participants' business rules, or it quietly becomes the god
object that aggregate boundaries existed to prevent (`saga-design.md` is
blunt about this). And this page's orchestrated shape, one stateful
coordinator, is a choice, not a given: with few steps, autonomous
participants, and little branching, a choreographed flow (each participant
reacting to the previous one's events, no central state) can be the lighter
answer. The example's README weighs the two; choreography stops being
lighter the moment compensation has to run backward across several
participants with no one place to order it, or when two services start
subscribing to each other's events and the flow becomes impossible to
follow. Those are the signals to come back here.

## Implemented as an aggregate

One distinction first, because the skill documents draw it and this page
must not blur it: conceptually, a saga is not an aggregate.
`saga-design.md` says so in as many words; a saga guards no immediate
business invariant the way an `Order` guards its total. What it guards are
process invariants: steps fire in a legal order, each step fires at most
once, a failed process compensates completely or lands in repair. Those
are real invariants over durable state under concurrent access, and that
is precisely the job the aggregate machinery was built for. So the saga
REUSES that machinery, identity, optimistic concurrency, a repository, an
event-emitting state core, without claiming to be a domain aggregate in
Evans's sense. When this page says "aggregate" about the saga from here
on, it means the implementation shape, not the modeling claim.

Concretely: the process state ("payment requested, waiting"; "shipping
requested"; "compensating") lives behind an `IRepository`, is protected by
optimistic concurrency, and its allowed transitions sit well in a
`DomainStateMachine`, which turns "a timeout arrived after the payment was
already received" from a bug you have to remember to handle into a
transition that simply does not exist.

```ts
class CheckoutSaga extends AggregateRoot<CheckoutSagaState, OrderId> {
  // The machine carries the process rules: which inputs are legal in
  // which state. See examples/saga/checkout-saga.ts for the full class.
  paymentReceived(paymentId: PaymentId): void { /* transition + event */ }
  paymentTimedOut(): void { /* transition into compensation + event */ }
}
```

Two properties fall out of this for free, and both matter more for sagas
than for most aggregates. Concurrency: when a payment event and a timeout
race each other, both reactions load the saga, and optimistic concurrency
makes sure only one of them wins; the loser retries against the new state
and finds its transition no longer applies. And auditability: the saga's
own events are the process history. That is an audit trail, not event
sourcing; the saga's state is still stored state, and nothing on this page
requires or implies rebuilding it from events.

## Events in, through the dispatcher

A saga reacts to events. Where do they come from? The durable path is the
one the [outbox guide](./outbox.md) builds: events land in the outbox
atomically with the write that produced them, and an `OutboxDispatcher`
delivers them to the in-process bus via `eventBusSink`. Subscribe the saga
there, either to the specific types it cares about or with `subscribeAll`
plus a filter when the list keeps growing:

```ts
bus.subscribe("OrderPlaced", (event) => reactToOrderPlaced(event));
bus.subscribe("PaymentReceived", (event) => reactToPaymentReceived(event));
bus.subscribe("PaymentFailed", (event) => reactToPaymentFailed(event));
```

Finding the right saga instance is a lookup, not machinery: in the common
case the saga shares its id with the aggregate that anchors the process
(the example keys `CheckoutSaga` by `OrderId`), and events carry
`aggregateId` and `metadata.correlationId` for everything else. If a
process needs to be found by several keys (the payment id and the order
id), that index is a table in your schema, like any other lookup.

## The inbox: react exactly once

The dispatcher is at-least-once, so every reaction must survive receiving
the same event twice. For a saga that would otherwise mean double-firing a
step: two `RequestPayment` commands from one `OrderPlaced`. The idempotency
store is the inbox that prevents it; use the event's id as the key and the
reaction becomes exactly-once in effect:

```ts
async function reactToOrderPlaced(event: OrderPlaced): Promise<void> {
  await withIdempotentCommit(
    { scope, outbox, idempotency },
    // The key scopes the inbox per REACTION, not per event: another
    // consumer of the same event keeps its own inbox entry. The
    // fingerprint is a tripwire (see below); any stable content hash works.
    { key: `checkout-saga:${event.eventId}`, fingerprint: stableHash(event.payload) },
    async (tx, enrollment) => {
      const sagas = makeSagaRepository(tx);
      const deadlines = makeDeadlineStore(tx);

      const saga = CheckoutSaga.start(event.aggregateId as OrderId, event.payload.total);
      await sagas.save(saga);

      // The wait for the payment gets its wake-up call, in the same
      // transaction as the state that started waiting.
      await deadlines.schedule({
        scope: "checkout-saga",
        key: String(saga.id),
        dueAt: addMinutes(now(), 30),
        payload: { kind: "payment-timeout" },
      });

      return {
        result: saga.id,
        commits: [enrollment.enrollSaved(saga)],
      };
    },
  );
}
```

A redelivered `OrderPlaced` hits the completed idempotency record and
replays the stored outcome without running the body again. The saga state,
the outbox records, the deadline, and the inbox claim all commit in one
transaction, which is the entire trick: there is no window in which the
saga believes something the database does not.

A word on that fingerprint. With the event id in the key, a true duplicate
always carries the same content, so the fingerprint can never fire on
honest redelivery; what it catches is the dishonest case, a different
payload arriving under the same event id, which means an id collision or a
serialization bug upstream, surfaced as a loud `IdempotencyKeyReuseError`
instead of a silently replayed wrong outcome. Hash the payload for that
tripwire to mean something; a constant like the event type would compare
equal every time and catch nothing.

Notice also what the transaction does NOT contain: a second aggregate. The
outbox record, the deadline, and the inbox claim are infrastructure riding
along; the saga is the only aggregate in its commit. When a reaction wants
to change the `Order` too, that is a command through the outbox, never an
`orderRepository.save` inside the saga's transaction.
`aggregate-design.md`'s rule, one aggregate instance per transaction,
applies here unchanged, and `saga-design.md` says the same from the other
side: a saga calls aggregates through commands, it never owns them.

## Commands out, through the same door

The saga's decisions leave as commands: request the payment, request the
shipping, cancel, refund. How those commands leave is the single biggest
difference between a saga that works in a demo and one that works in
production, and it is where most hand-rolled implementations quietly have a
hole. The obvious wiring, dispatching the command on the bus right inside
the subscriber (the example does this, to stay readable), has a crash
window: the process dies after the saga's transaction committed and before
the dispatch went out, and now the decision is durably recorded and never
acted on. No retry fixes it, because nothing knows there is anything to
retry.

The durable version closes the window with a move this page has already
made twice: the saga's decision is itself a fact, so it belongs in the
same commit. Record it as an event (`PaymentRequestDemanded`, or simply
let the saga's own transition event carry enough data), let the outbox
deliver it with the same at-least-once guarantee as everything else, and
let a small subscriber convert the delivered event into the command:

```ts
bus.subscribe("CheckoutPaymentRequested", async (event) => {
  await commandBus.execute({
    type: "RequestPayment",
    orderId: event.aggregateId as OrderId,
    paymentId: event.payload.paymentId,
    amount: event.payload.amount,
  });
});
```

If the converter crashes, the event redelivers and the command handler's
own idempotency (or an inbox key, same pattern as above) absorbs the
duplicate. Nothing is lost between the decision and the action, which is
the property the whole outbox machinery exists to provide.

## Timeouts are inputs

A saga that waits needs to hear about nothing happening, and the
[deadlines page](./deadlines.md) covers the mechanics: schedule the
deadline in the same transaction as the state that starts waiting (the
inbox snippet above already does), cancel it in the reaction that ends the
wait, and let a `DeadlineProcessor` feed due deadlines back in as inputs:

```ts
const processor = new DeadlineProcessor({
  store: deadlineStore,
  handler: async (deadline) => {
    if (deadline.scope !== "checkout-saga") return;
    await reactToPaymentTimeout(deadline); // same inbox pattern, key: deliveryId
  },
  observers: {
    onDeliveryError: (error, deadline) =>
      log.error({ error, deadline }, "deadline delivery failed"),
    onPollError: (error) => log.error({ error }, "deadline poll failed"),
    onDeadLetter: (deadline) =>
      alerts.page({ deadline }, "saga deadline dead letter"),
  },
});
```

One discipline carries over from the deadlines page and is worth repeating
because sagas are where it bites: a delivered deadline is a proposal, not a
verdict. The payment may have arrived while the timeout was in flight. A
saga whose transitions live in a state machine gets the guard for free; the
timeout input has no transition out of "payment received", so the stale
proposal dies in the machine instead of cancelling a paid order.

## Compensation is business logic

When the process fails past the point of simply stopping, the saga walks
backward: cancel the order, refund the payment. Nothing about that is
infrastructure. The compensating steps are commands like any others, the
decision to compensate is a transition like any other, and which steps can
be compensated at all is a design question `saga-design.md` walks you
through (its step classification: compensatable, pivot, retryable). The
example's failure path is exactly this: `PaymentFailed` transitions the
saga to compensating, which emits `CancelOrder`, and done.

Three rules of thumb from the wider saga literature carry over directly.
Compensate in reverse order, and only the steps that actually completed;
if the very first step failed, there is nothing to unwind, and a state
machine encodes that for free, since the compensating transitions simply
do not exist in the early states. And when a compensating command itself
fails, do not let it stop the remaining compensations or masquerade as the
process outcome: the original failure stays the reported one, the stuck
compensation retries through the normal delivery machinery, and past its
dead-letter ceiling it becomes a repair case, never a silent success.

One warning for readers arriving from durable-execution engines like
Temporal: their samples accumulate compensations in an in-memory array
inside the workflow function and unwind it in a catch block. That works
there because the engine replays the function deterministically after a
crash, so the array is reconstructed. In the event-driven model on this
page, nothing replays your call stack; what needs compensating must be
derivable from the saga's persisted state, which is one more reason the
state machine, not a local variable, owns the process position.

## What the kit deliberately does not ship

No `SagaStore`: the saga persists through `IRepository` like every
aggregate, and a second persistence port for the same job would be a
duplicate. No correlation machinery: finding a saga is a lookup over ids
you already have. No timeout scheduling beyond the `DeadlineStore`, and no
step or workflow DSL: the moment step classification becomes kit
configuration instead of state-machine transitions, the kit has become a
workflow engine, and there are dedicated tools for that (and a dedicated
warning about them in `saga-design.md`). The pieces above compose; that is
the feature.
