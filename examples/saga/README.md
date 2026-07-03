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
  const saga = await sagaRepository.getByIdOrFail(event.payload.orderId);
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

## Production caveats

This example uses `EventBus.subscribe` for the saga's reflexes: that's an in-process trigger, lost if the process dies between the bus publish and the subscriber running. For production:

- Replace `EventBus.subscribe` with a durable **outbox-dispatcher** that reads from the outbox table and invokes the same subscriber logic. At-least-once delivery; subscriber must be idempotent.
- The Process Manager state must be loaded under optimistic concurrency control: two events arriving in close succession on the same saga need a real `Repository.save` that throws `ConcurrencyConflictError` on version mismatch, and the dispatcher must retry on conflict.
- **Compensating commands need idempotent domain methods.** If the dispatcher retries `RefundPayment` after a transient failure (e.g. its `markDispatched` didn't land), the second call hits a payment that's already in the `refunded` state. The example's `Payment.refund()` throws `PaymentInWrongStateError` on the second call: fine for in-process tests, broken for at-least-once delivery. In production: either make refund / cancel / similar compensation methods return early when already in the target state (no-op), or wrap the dispatch in an idempotency key that the command handler checks before invoking the domain method. Sam Newman, *Building Microservices* (2nd ed.) §4 walks through both shapes.
- Saga-step timeouts (the typical "payment didn't arrive within 30 minutes") require a scheduler. That's out of scope for this example, but a `setTimeout`-based timer plus a `CheckSagaTimeout` command works for in-process apps; for distributed apps, a cron-driven sweep over saga rows past a threshold is the standard pattern.
- Subscriber error handling: `EventBusImpl.publish` collects subscriber errors into an `AggregateError` thrown after the batch: fine for visibility, but it means a single failing saga step does not stop the publish. Wrap each subscriber in your own try/catch + dead-letter logic if you need different semantics.

## Why the library doesn't ship a `Saga` abstraction

Sagas vary too much. Some are choreographies (each step subscribes independently, no central state). Some are orchestrations (a central state machine like the one here). State machines themselves come in many shapes: explicit machine, table-driven, hand-rolled `switch`. The kit ships the parts (`EventBus`, `CommandBus`, `withCommit`, `IRepository`); the composition is yours. This example is the doc.
