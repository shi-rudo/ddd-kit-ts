# Process Manager / Saga example

A worked example of orchestrating a multi-step business workflow across three aggregates using `EventBus` + `CommandBus` + a Process-Manager aggregate. It includes state-stored and event-sourced process-state variants. Vernon IDDD §12-13.

::: info Saga vs Process Manager
The two terms are often used interchangeably in modern DDD, but they trace to different sources:

- **Saga** (Garcia-Molina & Salem, 1987): a sequence of local transactions, each with a compensating action. Can be choreographed (each step listens for events independently) or orchestrated.
- **Process Manager** (Hohpe & Woolf, *Enterprise Integration Patterns*; Vernon, *IDDD* §12): specifically a centralised, stateful orchestrator. It owns process state and can reuse aggregate persistence and concurrency mechanics; it does not own participant business invariants.

This example implements a **Process Manager** (centralised state machine in `CheckoutSaga`) but calls it `CheckoutSaga` because that's the term most consumers reach for. If you wanted choreography instead, you'd remove `CheckoutSaga` and put the "what to do next" logic directly into each aggregate's event subscribers, with no central state.
:::

## The flow

```
PlaceOrder ──▶ Order.place ──▶ OrderPlaced ─┐
                                            │
                                            ├─ saga reacts: dispatch RequestPayment
                                            │
                                            ▼
                              Payment.request ──▶ PaymentRequested ─┐
                                                                    │
                              ┌─────────── (external gateway) ─────┤
                              ▼                                    │
                  Payment.receive / Payment.fail                   │
                              │                                    │
                              ├─ PaymentReceived ──▶ saga: dispatch RequestShipping
                              │                                    │
                              └─ PaymentFailed   ──▶ saga: dispatch CancelOrder
                                                                   │
                                            (continues for shipping…)
```

## Files

- **`order.ts`**, **`payment.ts`**, **`shipping.ts`** contain three small
  state-stored aggregates. Their factories record the first event. Their domain
  methods change state and record later events.
- **`checkout-saga.ts`** contains the state-stored Process Manager. It uses
  `DomainMachineDefinition`, `createInitialDomainMachineSnapshot`, and
  `transitionDomainState`. Its `TEvent` type stays at `never`. Application
  subscribers dispatch commands after successful transitions.
- **`event-sourced-checkout-saga.ts`** contains the event-sourced variant. Its
  private process facts are the source of truth. Replay creates no new work.
- **`checkout-participant-commands.ts`** contains the application map from
  private facts to addressed commands. `routeEventsToCommandOutbox` runs this
  map in the process transaction. It does not publish the private facts.
- **`saga.spec.ts`**: wiring + tests. Three scenarios:
  1. The happy path confirms the order after payment and shipping.
  2. Payment failure cancels the order and creates no shipment.
  3. Shipping failure refunds the payment and cancels the order.
- **`event-sourced-checkout-saga.spec.ts`** covers the event-sourced process. It
  covers atomic persistence, rollback, recovery, replay, idempotency, tracing,
  compensation, terminal outcomes, and manual repair.

## Key patterns demonstrated

### The saga reuses aggregate mechanics

Per Vernon §12, a Process Manager has identity, durable state, and a lifecycle,
so aggregate mechanics are a useful implementation shape. Conceptually it
coordinates process invariants rather than owning the immediate business
invariants of `Order`, `Payment`, or `Shipment`. `CheckoutSaga` extends
`AggregateRoot<CheckoutSagaState, OrderId>` and uses the same explicit
aggregate persistence lifecycle as participant aggregates. Its identifier is
the `OrderId` (one saga per order).

Its public methods stay in the ubiquitous language (`advanceToShipping()`,
`cancelOnPaymentFailure()`), while an internal `DomainMachineDefinition` is the
single table of allowed transitions, guards, terminal states, and snapshot
invariants. Each method calls the pure `transitionDomainState(...)` function and
commits the returned snapshot data back into the aggregate state. The executable
test also verifies that an invalid lifecycle step produces the machine's
structured `InvalidDomainTransitionError`.

### The saga's outgoing work is commands

A Process Manager's job is to turn events into commands: it consumes events from
other aggregates and requests the next step in the workflow. The state-stored
example keeps that application orchestration explicit in the EventBus
subscribers. The saga transitions update state and return no machine `outputs`.
After persistence, the subscriber dispatches the corresponding
command.

An alternative is to return command-shaped machine `outputs` from reducers and
let the application layer dispatch them after persistence. Those values are not
domain events and are not published automatically. This example also keeps the
state-stored aggregate's `TEvent = never`, so it records no progress events. If
monitoring or downstream processes need `CheckoutStarted`, `AwaitingPayment`,
or `ProcessCompleted`, declare an aggregate event union. Record those events
via `createEvent` plus application-shell `recordPendingEvents`. Do not
reinterpret machine outputs as domain events.

The event-sourced variant takes the durable form. It records completed process
decisions such as `CheckoutStartedAwaitingPayment` and
`CheckoutAdvancedToShipping`. These are private history, not instructions.
Inside the same transaction, `routeEventsToCommandOutbox` maps each accepted
fact to an exact `RequestPayment`, `RequestShipping`, `ConfirmOrder`,
`RefundPayment`, or `CancelOrder` message. The message names one destination.
The fact never crosses the EventBus.

Each durable command is a versioned, JSON-safe Published Language with `type`,
`version`, and `payload`. The payment
command maps `Money` to `MoneyDto` instead of leaking `bigint` or a domain value
object into storage or transport.

The fact names do not get ahead of the participants. Shipping success records
`CheckoutOrderConfirmationStarted` and leaves the process at
`awaiting-order-confirmation`. Only the later `OrderConfirmed` input records
`CheckoutCompleted`, with no outgoing command. Failure decisions likewise enter
explicit wait states instead of claiming that queued compensation already
finished.

Shipping failure requests only `RefundPayment`. `PaymentRefunded`
advances the process and requests `CancelOrder`. `OrderCancelled` records the
terminal compensated fact. A permanent refund or cancellation failure moves
the process to `manual-repair-required`.

### State-stored or event-sourced?

The two classes make process-state persistence an explicit choice. If the
current process position is authoritative, prefer the state-stored
`CheckoutSaga`. This also applies when ordinary repository tooling is enough
and full historical replay has no business value. It can still publish progress
events or write an audit log.
Those records do not become its source of truth.

If process decisions are the source of truth, prefer
`EventSourcedCheckoutSaga`. Replay then explains or reproduces the process. The
team must own event upcasting, bounded stream reads, stream OCC, and snapshot
policy. An audit requirement by itself is not enough. Snapshots are optional,
rebuildable acceleration. They never replace the stream.

Both variants own only process state and process invariants. Payment, order,
and shipping rules remain with their participant aggregates. Replaying the
event-sourced stream only folds private facts into state. Command creation is a
live commit concern and never runs during replay.

### EventBus subscribers as the saga's reflexes

```ts
eventBus.subscribe("PaymentReceived", async (event) => {
  await uow.run(async ({ repositories }) => {
    const saga = await repositories.sagas.getById(event.payload.orderId);
    saga.advanceToShipping();
    repositories.sagas.update(saga);
  });
  await commandBus.execute({
    type: "RequestShipping",
    orderId: event.payload.orderId,
    shipmentId: shipmentIdGen(),
  });
});
```

Each subscriber: load saga, transition, save, dispatch next command. The chain is linear and per-event; recursion happens through the bus (each command's `withCommit` triggers more events that trigger more subscribers).

### Compensation = additional subscribers, not rollback

The kit has no transaction rollback across aggregate boundaries. The saga
subscribes to failure events such as `PaymentFailed` and `ShippingFailed`. It
then sends compensating commands such as `CancelOrder` and `RefundPayment`.
This is the saga compensation pattern from Garcia-Molina and Salem.
They described this pattern in 1987.

## From demo wiring to production

This example uses a small in-process event path. The explicit
`outboxWriterAcceptingEventLoss()` marks its delivery limit. A process crash can
lose a trigger between publication and the subscriber. The
[sagas guide](../../docs/guide/sagas.md) explains the durable path.

- `OutboxDispatcher` drains the transactional outbox into `eventBusSink`.
  Delivery is at least once. Each reaction must handle duplicates.
- `CommandOutboxWriter` stores outgoing participant commands.
  `routeEventsToCommandOutbox` writes each origin receipt and command in the
  process transaction. `createCommandOutboxContractTests` covers the adapter
  contract. It covers atomic batches, stable order, retry deduplication,
  conflict rejection, empty receipts, and rollback.
- Participant results determine compensation order. The process enqueues
  `CancelOrder` only after it commits the confirmed refund fact.
- `withIdempotentCommit` supplies the participant inbox. A repeated event
  returns the stored outcome. It does not call the domain method again. A
  retried `RefundPayment` does not run `Payment.refund()` again.
- The repository `flush` throws `ConcurrencyConflictError` for a version
  mismatch. `RetryingTransactionScope` or dispatcher redelivery retries the
  losing reaction against the new state.
- A saga timeout is an input. Store the deadline in the same transaction as
  the wait. `DeadlineProcessor` later returns the deadline as an input. The
  state machine can reject a stale deadline after a state change.
- `EventBusImpl.publish` collects subscriber errors and throws after the batch.
  One failed saga step does not stop its peers. The dispatcher uses bounded
  retries and dead-lettering.

## Why the library does not ship a `Saga` abstraction

Sagas vary too much for one abstraction. Some use choreography. Others use a
central state machine. The kit supplies buses, `UnitOfWork`, outbox ports,
idempotency, state machines, deadlines, and repository contracts. The
application owns their composition.

This example contains executable code. The
[sagas guide](../../docs/guide/sagas.md) contains the design guidance.
