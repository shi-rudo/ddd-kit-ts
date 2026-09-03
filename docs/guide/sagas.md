# Sagas and Process Managers

Some business processes span several aggregates and take their time doing
it. An order gets placed, a payment gets requested, the payment provider
answers minutes later, shipping follows, and if anything goes wrong along
the way, earlier steps have to be undone: the payment refunded, the order
cancelled. Somebody has to remember where the process stands and decide
what happens next.

The kit's answer may be surprising after all the ports on the neighboring
pages: there is no saga primitive here, and that is a decision, not a gap.
A saga can reuse the regular aggregate lifecycle machinery. Everything it
needs already exists, and this page shows how the pieces fit. If you want the
design procedure itself, which steps are compensatable, how to classify
failures, when a saga is the wrong tool entirely, that lives in the skill's
`saga-design.md`; this page is about wiring, not design.

The runnable version of everything below sits in
[`examples/saga`](https://github.com/shi-rudo/ddd-kit-ts/tree/main/examples/saga):
a checkout process across three aggregates, with compensation, driven
entirely through public kit APIs. Its README also untangles the saga versus
process manager terminology. This page says saga throughout and means the
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

Conceptually, a saga is not an aggregate. A saga does not protect an immediate
business invariant like an `Order` total. It protects process invariants across
durable state and concurrent access.

For example, steps must use a legal order. Each step must run at most once. A
failed process must complete compensation or enter manual repair.

The implementation reuses aggregate machinery for these rules. It uses
identity, optimistic concurrency, a repository, and an event-producing state
core. This reuse does not make the saga a domain aggregate in the Evans sense.
On this page, "aggregate" describes only the implementation shape.

Optimistic concurrency protects the process state. The state-stored variant
uses an `AggregatePersistence` definition and `UnitOfWork`. A
`DomainStateMachine` defines its allowed transitions. Thus, a late timeout has
no transition after the payment arrives.

```ts
class CheckoutSaga extends StateStoredAggregate<CheckoutSagaState, OrderId> {
  // The machine carries the process rules: which inputs are legal in
  // which state. See examples/saga/checkout-saga.ts for the full class.
  advanceToShipping(): void { /* transition stored process state */ }
  cancelOnPaymentFailure(): void { /* transition into compensation */ }
}
```

Concurrency matters more for sagas than for most aggregates. When a payment
event and a timeout race each other, both reactions load the saga, and
optimistic concurrency makes sure only one of them wins; the loser retries
against the new state and finds its transition no longer applies.

## State-stored or event-sourced process state?

The runnable example includes both shapes. `CheckoutSaga` stores the current
process state and uses `DomainStateMachine` for legal transitions.
`EventSourcedCheckoutSaga` extends `EventSourcedAggregate`; its event stream is
the source of truth and folds into the same kind of process position. Neither
choice changes the participant boundaries or makes the process more strongly
consistent.

Choose from the source-of-truth requirement, not from fashion or the mere wish
for an audit log:

| Need | Prefer state-stored | Prefer event-sourced |
| --- | --- | --- |
| Operational question | "What must happen next?" | "Which decisions led here?" is a first-class domain question |
| Source of truth | Current process row or snapshot | Complete process-event stream |
| Historical replay | Not required; optional notifications may support audit | Required to reproduce process state and explain past decisions |
| Schema evolution | Migrate one current-state shape | Upcast immutable event versions and keep old histories replayable |
| Reads and recovery | One bounded state load | Bounded stream replay, usually with optional rebuildable snapshots |
| Tooling and operations | Ordinary repository and row inspection | EventStore adapter, stream OCC, replay tests, upcasters, snapshot policy |

An audit requirement alone does not select event sourcing. A state-stored
process can write append-only audit records or publish progress events while
its row remains authoritative. Choose event sourcing when the complete process
history itself is the authoritative model, replaying that history is valuable
to the business, and the team accepts the event-evolution and operational
cost. Snapshots then remain disposable acceleration data, never a second source
of truth.

The compact event-sourced variant deliberately records completed changes to the
process itself: `CheckoutStartedAwaitingPayment`,
`CheckoutAdvancedToShipping`, and
`CheckoutCompensationStartedAfterShippingFailure`. These names matter. They say
what the coordinator decided and where its own state moved. They do not pretend
that `Payment` or `Shipping` has already done anything.

Those private facts rebuild the process position. They are not collaboration
events and they are not sent to a participant. During the live transaction, an
application mapper creates a separate command. It writes commands such as
`RequestPayment` or `RequestShipping` to a dedicated command outbox. Replay
only calls the process-event handlers, so it
does not run that mapper:

```ts
const saga = EventSourcedCheckoutSaga.reconstitute(orderId);
const replayed = saga.replayHistory(history);
if (replayed.isErr()) throw replayed.error;

// No command was enqueued and no pending fact was created by replay.
```

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
      const deadlines = makeDeadlineStore(tx);

      const saga = CheckoutSaga.start(event.aggregateId as OrderId, event.payload.total);
      await insertSagaForDirectCommit(tx, saga);

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

The event id is part of the fingerprint key. Therefore, a true duplicate always
has the same content. The fingerprint detects a different payload with the same
event id. This result indicates an id collision or an upstream serialization
error. The handler throws `IdempotencyKeyReuseError` instead of returning an
incorrect stored outcome.

Hash the payload to make this test effective. A constant value, such as the
event type, always compares as equal and detects nothing.

The transaction does not contain a second aggregate. The saga is the only
aggregate in its commit. The outbox record, deadline, and inbox claim are
infrastructure.

If a reaction must change the `Order` too, it sends a command through the
outbox. It never calls `orderRepository.update` inside the saga transaction.
The one-aggregate rule applies here without change. A saga calls aggregates
through commands. It never owns them.

## Commands out, through the same door

The saga decisions leave as commands. Examples include request payment,
request shipping, cancel, and refund. The delivery path determines whether the
saga survives a crash.

Direct dispatch from the subscriber creates a crash window. The process can
stop after the saga commits but before command dispatch. The decision then
remains stored without its action. No retry can find the missing command.

Before the wiring, keep three meanings separate:

- A private process fact is history owned by the Process Manager. It answers
  "which decision moved this process here?" and is replayed to rebuild process
  state.
- A collaboration event tells any interested consumer that something happened
  across a bounded-context boundary. It is past tense and can have zero, one, or
  many subscribers.
- A command asks one named receiver to try to do something. It is imperative,
  has one destination, and can be rejected.

Calling a private fact `CheckoutPaymentRequested` and publishing it to exactly
one payment handler blurs all three. It looks like history, but behaves as a
command. This is sometimes called a passive-aggressive event. The failure is
not the past-tense spelling by itself. The failure is hidden point-to-point
intent behind publish/subscribe semantics.

The event-sourced example uses a dedicated command outbox. The aggregate first
accepts a private fact. `recordPendingEvents` gives that fact its recording
identity and trace metadata. Still inside the same transaction,
`routeEventsToCommandOutbox` maps it to the exact addressed command that must
survive the commit:

```ts
const processCommandWriter = routeEventsToCommandOutbox(
  commandOutbox,
  checkoutCommandsFromProcessFact,
);

await withCommit(
  {
    scope,
    outbox: processCommandWriter,
    // Deliberately no bus: these process facts are private history.
  },
  async (tx, enrollment) => {
    saga.advanceToShipping(shipmentId);
    const recorded = recordPendingEvents(saga, () =>
      domainEvents.createStamp({
        metadata: {
          correlationId: paymentReceived.metadata?.correlationId,
          conversationId: paymentReceived.metadata?.conversationId,
          causationId: paymentReceived.eventId,
        },
      }),
    );

    await makeCheckoutEventStore(tx).append(recorded);
    return {
      result: saga.id,
      commits: [enrollment.enrollSaved(saga)],
    };
  },
);
```

The mapper runs before the transaction commits. The command-outbox adapter sees
an origin receipt, not the private event or its payload, and stores the command
with an explicit destination. If that write fails, the process-stream append
rolls back with it. If the process dies immediately after commit, the command is
already waiting for a dispatcher.

The process facts also avoid claiming success too early. Shipping completion
records `CheckoutOrderConfirmationStarted` and enqueues `ConfirmOrder`. The
process stays at `awaiting-order-confirmation`. Only a later `OrderConfirmed`
input records `CheckoutCompleted`, whose command batch is empty. Payment and
shipping failures use the same discipline. A payment failure enters
`awaiting-cancellation-after-payment-failure`.

A shipping failure first enters
`awaiting-refund-after-shipping-failure`. Only `PaymentRefunded` advances it to
`awaiting-cancellation-after-shipping-failure`. Enqueuing a compensating command
is not the same fact as completing the compensation.

Each command receives a stable message id derived from the private event id and
its order in the decision, for example
`checkout-started-1:command:0`. Its `causationId` is the private process fact.
Its `conversationId` follows the long-running checkout. A participant's result
event then names the command message as its direct cause. The chain is
therefore visible rather than inferred:

```text
OrderPlaced
  -> CheckoutStartedAwaitingPayment
  -> RequestPayment
  -> PaymentReceived
```

Commands that leave the process use a versioned Published Language:
`{ type, version, payload }`. The payload is JSON-safe and contains wire DTOs,
not participant-domain objects. The checkout mapper therefore emits
`MoneyDto`, whose minor amount is a decimal string, instead of putting
`Money.amountMinor: bigint` into a durable message. Explicit `traceparent` and
`tracestate` fields carry technical W3C Trace Context without overloading the
business correlation and conversation ids.

Delivery remains at least once. The participant scopes
`withIdempotentCommit` by consumer and command `messageId`. It stores the
business result before acknowledgement. A repeated command returns that stored
result. If a crash occurs after command execution but before acknowledgement,
delivery repeats. The business work does not repeat.

Shipping compensation deliberately does not rely on dispatcher order.
`CheckoutCompensationStartedAfterShippingFailure` requests only
`RefundPayment`. The saga persists that wait state before dispatch. When the
payment participant later reports `PaymentRefunded`, the process records
`CheckoutPaymentRefundConfirmed` and only then requests `CancelOrder`. A later
`OrderCancelled` input records the command-free terminal fact
`CheckoutCompensationCompletedAfterShippingFailure`.

If a refund or cancellation cannot complete automatically, the process records
`CheckoutManualRepairRequired`, including the failed command. It never calls a
queued compensation “complete,” and it never hides an infinite retry behind an
in-progress state.

### Migrating command-shaped process events

Do not rename rows already stored in an event stream and hope replay will sort
it out. Treat old names as an event-schema migration:

1. Teach the stream reader or upcaster to interpret
   `CheckoutPaymentRequested` as `CheckoutStartedAwaitingPayment` and
   `CheckoutShippingRequested` as `CheckoutAdvancedToShipping`. Keep replay
   tests containing the old names.
2. During the rollout, keep the legacy event-to-command route alive long enough
   to drain already committed event-outbox rows. Derive the same stable command
   message id from the old event id so the participant inbox absorbs overlap.
3. Switch new writes to the private process facts and the transactional command
   outbox. Do not also publish those facts on the EventBus.
4. Remove the legacy route only after no old delivery rows remain.
5. If old process streams can still load, keep the upcaster.
6. If you migrate those streams with an audited and reversible procedure,
   remove the upcaster.

This design has more parts than an in-process subscriber. Each part handles a
different failure. The process stream explains and replays decisions. The
command outbox closes the commit-before-send window. The participant inbox
absorbs duplicates after send and before acknowledgement.

## Timeouts are inputs

A waiting saga needs a timeout input. Store the deadline in the transaction
that starts the wait. Cancel it in the reaction that ends the wait. A
`DeadlineProcessor` returns each due deadline as an input. The
[deadlines page](./deadlines.md) explains this process.

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

When a process cannot stop safely, the saga uses business actions to reverse
completed work. This behavior is not infrastructure. Each compensation is a
command. The decision to compensate is a state transition. Step classification
remains a domain design decision.

In the checkout example, `PaymentFailed` requests `CancelOrder` and waits for
`OrderCancelled`. A later shipping failure means payment has already completed,
so the process requests `RefundPayment`, waits for `PaymentRefunded`, then
requests `CancelOrder` and waits again. Each confirmed result advances one
persisted state. A delivery retry can repeat a command, but it cannot skip the
wait or invert the business sequence.

Use these compensation rules:

1. Compensate in reverse order.
2. Compensate only steps that completed.
3. If the first step failed, do not start compensation.
4. If a compensation fails, do not start the next step.
5. Retry the failed compensation through the normal delivery path.
6. If automatic recovery stops, move the process to manual repair.

The original failure stays visible. Incomplete compensation never appears as
success.

Durable-execution engines use a different model. For example, Temporal samples
keep compensations in an in-memory array. The workflow function unwinds this
array in a catch block. After a crash, the engine replays the function and
reconstructs the array.

The event-driven model does not replay the call stack. Persisted saga state
must identify the work that needs compensation. Thus, the state machine owns
the process position instead of a local variable.

## Changing a running process

A process lives longer than a request and longer than a deploy. When a deploy
changes the steps, instances that started under the old steps are still in
flight. Their stored state or event stream encodes the old sequence. Loaded
into the new class, such an instance can sit in a state the new machine does
not know, or receive a reply to a command the new logic never sends.

Never edit the handlers of a running process in place. Two changes preserve
the in-flight instances:

1. **A new `aggregateType` for a new step sequence.** Deploy the changed
   process as a second class with its own `aggregateType`, for example
   `CheckoutSagaV2`. New processes start under the new type. Old instances
   complete under the old class, and the old class leaves the codebase when
   its last instance is done. Subscribe both classes on the bus during that
   time; each one reacts only to its own instances.
2. **A schema bump for a changed shape.** When the steps stay the same and
   only the stored shape changes, keep the class. An event-sourced process
   bumps the `schemaVersion` of the changed process event and upcasts old
   rows at the read boundary, as
   [Migrating command-shaped process events](#migrating-command-shaped-process-events)
   describes. A state-stored process migrates its row like any other table,
   before the new class loads it.

Both changes rest on one rule: the `aggregateType` is a stable stream key.
The event store selects a stream by `{ aggregateType, aggregateId }`, and
every event the process records carries it. A renamed `aggregateType` orphans
every stored stream under the old name. Rename only with a data migration, and
never as a side effect of a class rename.

## What the kit deliberately does not ship

The kit does not supply a `SagaStore`. The state-stored variant uses
`AggregatePersistence` and `UnitOfWork`. The event-sourced variant uses
`EventStore` and an event-sourced repository. A second persistence port
duplicates these roles.

The kit does not supply correlation machinery. Finding a saga is a lookup by a
known identifier. `DeadlineStore` and `DeadlineProcessor` supply the deadline
mechanism.

The kit does not supply a workflow DSL. Step classification belongs in
state-machine transitions. A configuration model for these steps turns the kit
into a workflow engine. Dedicated tools already provide that function.
