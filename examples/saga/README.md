# Process Manager / Saga example

A worked example of orchestrating a multi-step business workflow across three aggregates using `EventBus` + `CommandBus` + a Process-Manager aggregate. Vernon IDDD §12-13.

::: info Saga vs Process Manager
The two terms are often used interchangeably in modern DDD, but they trace to different sources:

- **Saga** (Garcia-Molina & Salem, 1987): a sequence of local transactions, each with a compensating action. Can be choreographed (each step listens for events independently) or orchestrated.
- **Process Manager** (Hohpe & Woolf, *Enterprise Integration Patterns*; Vernon, *IDDD* §12): specifically a centralised, stateful orchestrator. The Process Manager IS an aggregate.

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

- **`order.ts`**, **`payment.ts`**, **`shipping.ts`**: three small state-stored aggregates (`AggregateRoot`). Each has a `static create` / `static request` factory that records its first event, plus domain methods (`confirm`, `cancel`, `receive`, `fail`, `complete`) that mutate state and record events.
- **`checkout-saga.ts`**: the Process Manager. It is an `AggregateRoot` whose lifecycle is implemented with `DomainMachineDefinition`, `createInitialDomainMachineSnapshot`, and `transitionDomainState` (`awaiting-payment` → `awaiting-shipping` → `completed` / `cancelled-*`). Its aggregate `TEvent` generic stays at `never`: the saga does not publish events of its own; application subscribers dispatch commands after its transition methods succeed.
- **`saga.spec.ts`**: wiring + tests. Three scenarios:
  1. Happy path: order → payment received → shipping completed → order confirmed
  2. Payment-failure compensation: payment fails → saga cancels → order cancelled, no shipment created
  3. Shipping-failure compensation: payment succeeds, shipping fails → saga refunds payment → cancels order

## Key patterns demonstrated

### The saga is an aggregate

Per Vernon §12, a Process Manager has identity, state, and a lifecycle: exactly an aggregate. `CheckoutSaga` extends `AggregateRoot<CheckoutSagaState, OrderId>` and is persisted through `IRepository` just like `Order` / `Payment` / `Shipment`. Saga id = `OrderId` (one saga per order).

Its public methods stay in the ubiquitous language (`advanceToShipping()`,
`cancelOnPaymentFailure()`), while an internal `DomainMachineDefinition` is the
single table of allowed transitions, guards, terminal states, and snapshot
invariants. Each method calls the pure `transitionDomainState(...)` function and
commits the returned snapshot data back into the aggregate state. The executable
test also verifies that an invalid lifecycle step produces the machine's
structured `InvalidDomainTransitionError`.

### The saga's outgoing work is commands

A Process Manager's job is to turn events into commands: it consumes events from
other aggregates and requests the next step in the workflow. This example keeps
that application orchestration explicit in the EventBus subscribers: the saga's
machine transitions update state and return no machine `outputs`; after the saga
is saved, the subscriber dispatches the corresponding command.

An alternative is to return command-shaped machine `outputs` from reducers and
let the application layer dispatch them after persistence. Those values are not
domain events and are not published automatically. This example also keeps the
aggregate's `TEvent = never`, so it records no progress events. If monitoring or
downstream processes need `CheckoutStarted`, `AwaitingPayment`, or
`ProcessCompleted`, declare an aggregate event union and record those events via
`recordEvent`/`commit`; do not reinterpret machine outputs as domain events.

Either way the core principle holds: Process Managers turn events into commands. Whether they *also* turn events into events is a per-app call.

### EventBus subscribers as the saga's reflexes

```ts
eventBus.subscribe("PaymentReceived", async (event) => {
  const saga = await sagaRepository.getById(event.payload.orderId);
  saga.advanceToShipping();
  await sagaRepository.save(saga);
  await commandBus.execute({
    type: "RequestShipping",
    orderId: event.payload.orderId,
    shipmentId: shipmentIdGen(),
  });
});
```

Each subscriber: load saga, transition, save, dispatch next command. The chain is linear and per-event; recursion happens through the bus (each command's `withCommit` triggers more events that trigger more subscribers).

### Compensation = additional subscribers, not rollback

The kit has no transactional rollback across aggregates: that's a database illusion you can't get back once you cross aggregate boundaries. Instead the saga subscribes to *failure* events (`PaymentFailed`, `ShippingFailed`) and dispatches *compensating commands* (`CancelOrder`, `RefundPayment`) that undo the side-effects forward. This is the canonical saga compensation pattern (Garcia-Molina & Salem, 1987; later formalised by Pat Helland and the microservices community).

## From demo wiring to production

This example keeps the wiring as small as the saga logic allows: events reach the subscribers over the in-process bus fast path, and the outbox slot holds the explicit `outboxWriterAcceptingEventLoss()`. That is an honest demo trade-off, an in-process trigger is lost if the process dies between publish and subscriber, and every piece of the durable version now ships in the kit. The [sagas guide](../../docs/guide/sagas.md) walks through that wiring end to end; the short version:

- The durable trigger is the transactional outbox drained by an `OutboxDispatcher` into `eventBusSink`. Delivery becomes at-least-once, so reactions must survive duplicates.
- `withIdempotentCommit` is the inbox that makes them survive: key the reaction on the event id and a redelivered event replays the stored outcome instead of double-firing the step. This also settles the compensation-retry question this README used to hand-wave: a retried `RefundPayment` never reaches `Payment.refund()` a second time, because the inbox absorbs it before the domain method runs. (Making compensation methods no-op on the target state is still good defense in depth; Sam Newman, *Building Microservices* 2nd ed. §4, covers both shapes.)
- Saga state under concurrency needs a real repository whose `save` throws `ConcurrencyConflictError` on version mismatch, with a `RetryingTransactionScope` (or the dispatcher's redelivery) retrying the losing reaction against the new state.
- Saga-step timeouts ("payment didn't arrive within 30 minutes") are inputs, not a scheduler problem: schedule a deadline in the same transaction as the wait via `DeadlineStore`, and let a `DeadlineProcessor` feed it back in. The [deadlines guide](../../docs/guide/deadlines.md) has the details, including why a delivered timeout is a proposal the state machine gets to veto.
- Subscriber error handling stays worth knowing: `EventBusImpl.publish` collects subscriber errors and throws after the batch, so one failing saga step does not stop its peers; through the dispatcher, that surfaces as a delivery failure with bounded retries and dead-lettering.

## Why the library doesn't ship a `Saga` abstraction

Sagas vary too much. Some are choreographies (each step subscribes independently, no central state). Some are orchestrations (a central state machine like the one here). State machines themselves come in many shapes: explicit machine, table-driven, hand-rolled `switch`. The kit ships the parts (`EventBus`, `CommandBus`, `withCommit`, `withIdempotentCommit`, `IRepository`, `DomainStateMachine`, `OutboxDispatcher`, `DeadlineStore`); the composition is yours. This example is the runnable half of that doc, and the [sagas guide](../../docs/guide/sagas.md) is the written half.
