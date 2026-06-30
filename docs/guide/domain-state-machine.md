# Domain State Machine

`DomainStateMachine` models finite, named domain states with typed context.
It is useful when an aggregate, process manager, or long-running business
workflow has an explicit lifecycle and the allowed transitions should be
visible in one place.

It is deliberately small:

- no nested or parallel states
- no async guards or reducers
- no timers, retries, persistence, or bus integration
- no replacement for aggregate methods or domain events

Keep the public domain API in the ubiquitous language. For example, expose
`saga.advanceToShipping()` and let that method use a machine internally; do
not force application code to speak in generic `dispatch(...)` calls.

## Define a lifecycle

```ts
import {
  DomainStateMachine,
  type DomainMachineDefinition,
} from "@shirudo/ddd-kit";

type CheckoutState =
  | "awaiting-payment"
  | "awaiting-shipping"
  | "completed"
  | "cancelled";

type CheckoutContext = {
  orderId: string;
  paymentId?: string;
  shipmentId?: string;
};

type CheckoutEvent =
  | { type: "PaymentRequested"; paymentId: string }
  | { type: "PaymentReceived" }
  | { type: "ShippingCompleted" }
  | { type: "Cancel"; reason: string };

type CheckoutOutput =
  | { type: "RequestShipping"; orderId: string }
  | { type: "ConfirmOrder"; orderId: string }
  | { type: "CancelOrder"; orderId: string; reason: string };

const checkoutLifecycle: DomainMachineDefinition<
  CheckoutState,
  CheckoutContext,
  CheckoutEvent,
  CheckoutOutput
> = {
  initial: "awaiting-payment",
  initialContext: () => ({ orderId: "order-1" }),
  states: {
    "awaiting-payment": {
      on: {
        PaymentRequested: {
          target: "awaiting-payment",
          reduce: ({ context, event }) => ({
            context: { ...context, paymentId: event.paymentId },
          }),
        },
        PaymentReceived: {
          target: "awaiting-shipping",
          guard: ({ context }) => context.paymentId !== undefined,
          reduce: ({ context }) => ({
            outputs: [{ type: "RequestShipping", orderId: context.orderId }],
          }),
        },
        Cancel: {
          target: "cancelled",
          reduce: ({ context, event }) => ({
            outputs: [
              {
                type: "CancelOrder",
                orderId: context.orderId,
                reason: event.reason,
              },
            ],
          }),
        },
      },
    },
    "awaiting-shipping": {
      on: {
        ShippingCompleted: {
          target: "completed",
          reduce: ({ context }) => ({
            outputs: [{ type: "ConfirmOrder", orderId: context.orderId }],
          }),
        },
        Cancel: { target: "cancelled" },
      },
    },
    completed: { terminal: true },
    cancelled: { terminal: true },
  },
};

const machine = new DomainStateMachine(checkoutLifecycle);
const result = machine.dispatch({
  type: "PaymentRequested",
  paymentId: "payment-1",
});

result.snapshot.state; // "awaiting-payment"
result.snapshot.context.paymentId; // "payment-1"
```

`initialContext` is a factory, not a shared object. Each fresh machine gets
its own context reference.

The stateful wrapper defensively copies its machine definition at construction
time, so later mutation of the caller's definition object cannot change that
machine's behavior. It reuses that validated, frozen definition for subsequent
operations. The functional APIs evaluate each operation against a fresh stable
definition copy, so a callback cannot change the transition currently being
evaluated. Machine contexts are copied into snapshots and deep-frozen so callers
cannot mutate lifecycle data outside a transition. Public context, event,
snapshot, and output types use `DomainMachineReadonly<T>` to express that deep
immutability recursively at compile time. Snapshots and outputs returned by the
API are deep-frozen.

Machine context, events, and outputs are data, not behavior. Use only primitives,
plain arrays, and plain objects. Custom class instances, Array subclasses,
accessor properties, functions, promises, native built-ins, external resources,
and binary buffers are rejected. Native `Date`, `RegExp`, `Map`, and `Set`
instances are deliberately excluded because JavaScript exposes mutable internal
slots that `Object.freeze` cannot reliably protect. Represent dates as ISO
strings or epoch numbers, regular expressions as pattern/flag data, maps as
plain records or entry arrays, and sets as arrays. Plain data from another
JavaScript Realm is accepted and normalized to local `Object.prototype` and
`Array.prototype` values while it is copied. Accessor descriptors are rejected
without invoking their getter or setter, including `Symbol.toStringTag`.

Runtime definition and reducer-result validation is strict. Unknown properties
are rejected instead of ignored, so misspellings such as `gaurd` or `output`
cannot silently remove a business rule or requested output. A reducer must
return `undefined` or a plain object containing only `context` and `outputs`.
Promises returned by accidentally async reducers are rejected. Definition
objects must be plain objects, and state/event entries must be enumerable string
properties, so inherited, symbolic, or hidden behavior cannot disappear during
the stable copy.

Use `validateSnapshot` for invariants that relate a control state to its context.
This closes the reconstitution path as well as the normal transition path:

```ts
const checkoutLifecycle = {
  // ...initial, initialContext, states
  validateSnapshot: ({ state, context }) =>
    state !== "awaiting-shipping" || context.paymentId !== undefined,
};
```

The predicate runs on the copied, deeply frozen snapshot during initial-state
creation, wrapper reconstitution, functional API input validation, and before a
transition result is committed. `false` throws `InvalidDomainMachineSnapshotError`;
a non-boolean result is a broken definition and throws
`InvalidDomainMachineDefinitionError`.
Without `validateSnapshot`, snapshot validation is intentionally structural and
data-only; the machine cannot infer state/context business invariants from erased
TypeScript types.

## Allow and forbid transitions

Model the lifecycle from the current state outward. The `on` block is the list
of transitions that are meaningful from that state.

- If a transition is never allowed from a state, do not define it there.
- If a transition is meaningful but currently depends on state or context, use a
  `guard`.
- If no transition should ever leave a state, mark the state as `terminal` and
  do not declare an `on` block for that state.

```ts
const orderLifecycle = {
  initial: "draft",
  initialContext: () => ({ paid: false, itemCount: 0 }),
  states: {
    draft: {
      on: {
        Submit: {
          target: "submitted",
          guard: ({ context }) => context.itemCount > 0,
        },
        Cancel: { target: "cancelled" },
      },
    },
    submitted: {
      on: {
        Pay: {
          target: "paid",
          reduce: ({ context }) => ({
            context: { ...context, paid: true },
          }),
        },
      },
    },
    paid: {
      on: {
        Ship: { target: "shipped" },
      },
    },
    shipped: { terminal: true },
    cancelled: { terminal: true },
  },
};
```

In this example, `Ship` is not defined from `draft`, so that transition is not a
valid part of the lifecycle. `Submit` is defined from `draft`, but its guard can
reject empty orders. `shipped` and `cancelled` are terminal states, so no event
can transition out of them.

Use `can(event)` when the application needs to ask whether a transition is
currently available. Use `dispatch(event)` or `transitionDomainState(...)` when a
domain method wants to enforce the rule; missing transitions throw
`InvalidDomainTransitionError`, and rejected guards throw
`DomainTransitionGuardRejectedError`.

Guards must return a boolean. A guard that accidentally falls through and returns
`undefined` is treated as broken machine code and throws
`InvalidDomainTransitionGuardResultError`; it is never interpreted as allowed.

## Pure transitions

The stateful wrapper is convenience. The core operation is pure:

```ts
import {
  createInitialDomainMachineSnapshot,
  transitionDomainState,
} from "@shirudo/ddd-kit";

const snapshot = createInitialDomainMachineSnapshot(checkoutLifecycle);

const transitioned = transitionDomainState(checkoutLifecycle, snapshot, {
  type: "Cancel",
  reason: "payment-failed",
});

transitioned.from; // "awaiting-payment"
transitioned.to; // "cancelled"
transitioned.outputs; // [{ type: "CancelOrder", ... }]
```

`transitionDomainState(...)` and `canTransitionDomainState(...)` defensively copy
and freeze the input snapshot and event before running guards or reducers. A
buggy callback cannot mutate caller-owned inputs; if it writes to `context` or
`event`, the frozen copy fails loudly.

Purity also requires callback discipline that JavaScript cannot enforce at
runtime. Guards, reducers, and `validateSnapshot` must be synchronous,
deterministic, and side-effect-free: do not perform I/O, read clocks or
randomness, or mutate captured closure state. In particular, `can(...)` is a
query and must remain side-effect-free. Return requested external work as
`outputs`; execute it outside the machine.

The stateful wrapper also rejects reentrant evaluation. A guard or reducer must
not call `can(...)` or `dispatch(...)` on the same machine instance; the same
rule applies to `validateSnapshot`. Such a call throws
`ReentrantDomainStateMachineEvaluationError`, leaves the current snapshot
unchanged, and releases the evaluation lock even when callback code throws.

This shape is useful inside aggregates and process managers because the domain
method can decide with values first, then commit the new aggregate state:

```ts
import {
  AggregateRoot,
  type DomainMachineSnapshot,
} from "@shirudo/ddd-kit";

type CheckoutSagaState = DomainMachineSnapshot<
  CheckoutState,
  CheckoutContext
>;

class CheckoutSaga extends AggregateRoot<CheckoutSagaState, OrderId> {
  protected readonly aggregateType = "CheckoutSaga";

  cancel(reason: string): readonly CheckoutOutput[] {
    const result = transitionDomainState(checkoutLifecycle, this.state, {
      type: "Cancel",
      reason,
    });

    this.commit(result.snapshot);

    return result.outputs;
  }
}
```

That example stores the whole machine snapshot as aggregate state. If your
aggregate state has additional fields, nest the snapshot under a property and
replace that property when committing:

```ts
cancel(reason: string): readonly CheckoutOutput[] {
  const result = transitionDomainState(checkoutLifecycle, this.state.lifecycle, {
    type: "Cancel",
    reason,
  });

  this.commit({
    ...this.state,
    lifecycle: result.snapshot,
  });

  return result.outputs;
}
```

The returned `outputs` are plain values, not emitted domain events and not
EventBus messages. A process manager can translate them to commands in the
application layer. They go through the same data-only copy/freeze boundary as
context, so later mutation of reducer-owned objects cannot change the returned
result. If an aggregate wants to publish a domain event, keep using the aggregate
path:

```ts
this.commit(
  result.snapshot,
  this.recordEvent("CheckoutCancelled", { orderId: this.id, reason }),
);
```

Keep that mapping explicit; the machine does not publish, persist, retry,
record, or dispatch anything by itself.

## Error semantics

Missing transitions and rejected guards are domain-rule violations:

- `InvalidDomainTransitionError extends DomainError`
- `DomainTransitionGuardRejectedError extends DomainError`

Broken machine definitions and invalid snapshots are programmer or
reconstitution failures. Invalid context values, malformed runtime events, and
malformed reducer results are treated the same way:

- `InvalidDomainMachineDefinitionError extends BaseError`
- `InvalidDomainMachineContextError extends BaseError`
- `InvalidDomainMachineSnapshotError extends BaseError`
- `InvalidDomainMachineEventError extends BaseError`
- `InvalidDomainTransitionGuardResultError extends BaseError`
- `InvalidDomainTransitionResultError extends BaseError`
- `ReentrantDomainStateMachineEvaluationError extends BaseError`

This matches the rest of the kit: domain operations throw `DomainError`, while
invalid wiring fails loudly as a structured `BaseError`.

## State vs context

The machine has finite control states (`TState extends string`) and arbitrary
typed context. That makes it closer to an extended finite state machine than a
mathematical FSM, but the public API keeps the DDD-facing name:
`DomainStateMachine`.

Use it when lifecycle transitions are a real domain concept. For a simple
two-state aggregate method, a direct `if` guard is usually clearer.
