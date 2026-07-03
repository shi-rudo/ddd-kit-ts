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
  DomainError,
  DomainStateMachine,
  type DomainMachineDefinition,
  type DomainMachineSnapshot,
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

type CheckoutInput =
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
  CheckoutInput,
  CheckoutOutput
> = {
  initial: "awaiting-payment",
  initialContext: () => ({ orderId: "order-1" }),
  states: {
    "awaiting-payment": {
      on: {
        PaymentRequested: {
          target: "awaiting-payment",
          reduce: ({ context, input }) => ({
            context: { ...context, paymentId: input.paymentId },
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
          reduce: ({ context, input }) => ({
            outputs: [
              {
                type: "CancelOrder",
                orderId: context.orderId,
                reason: input.reason,
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

The machine's base type is called `DomainMachineInput` deliberately. A concrete
union such as `CheckoutInput` may contain a command (`Cancel`), an observed fact
(`PaymentReceived`), or an internal trigger. It is not automatically a published
Domain Event. Domain Events remain immutable facts recorded by Aggregates
through `recordEvent`/`commit` and delivered through the outbox/EventBus path.

The stateful wrapper defensively copies its machine definition at construction
time, so later mutation of the caller's definition object cannot change that
machine's behavior. It reuses that validated, frozen definition and its already
validated current snapshot for subsequent operations. A transition that does not
replace the context reuses the same deeply frozen context instead of copying it.
The functional APIs evaluate each operation against fresh stable definition and
snapshot copies, so a callback cannot change the transition currently being
evaluated or mutate caller-owned data. Public context, input, snapshot, and
output types use `DomainMachineReadonly<T>` to express deep immutability
recursively at compile time. Snapshots and outputs returned by the API are
deep-frozen.

Machine context, inputs, and outputs are data, not behavior. Use only primitives,
plain arrays, and plain objects. Custom class instances, Array subclasses,
accessor properties, functions, promises, native built-ins, external resources,
and binary buffers are rejected. Native `Date`, `RegExp`, `Map`, and `Set`
instances are deliberately excluded because JavaScript exposes mutable internal
slots that `Object.freeze` cannot reliably protect. Represent dates as ISO
strings or epoch numbers, regular expressions as pattern/flag data, maps as
plain records or entry arrays, and sets as arrays. Plain data from another
JavaScript Realm is accepted and normalized to local `Object.prototype` and
`Array.prototype` values while it is copied. Own accessor descriptors are
rejected without invoking their getter or setter. `Symbol.toStringTag` accessors
are also rejected when inherited from an otherwise valid object or array
prototype.

The data graph is limited to 256 nested object/array levels, 10,000 unique
object nodes, and 100,000 own properties per copy operation. Inputs must also be
trusted and Proxy-free. ECMAScript has no portable, side-effect-free way to
identify a transparent `Proxy`; reflective validation can execute its traps.
The machine is therefore a domain-consistency component, not a sandbox for
hostile in-process objects. Parse untrusted wire input into ordinary DTOs before
constructing machine inputs or snapshots.

Runtime definition and reducer-result validation is strict. Unknown properties
are rejected instead of ignored, so misspellings such as `gaurd` or `output`
cannot silently remove a business rule or requested output. A reducer must
return `undefined` or a plain object containing only `context` and `outputs`.
Promises returned by accidentally async reducers are rejected. Definition
objects must be plain objects, and state/input entries must be enumerable string
properties, so inherited, symbolic, or hidden behavior cannot disappear during
the stable copy.

Use a state's `validateContext` for an invariant owned by that state. The callback
is typed with the concrete state name, so the rule stays next to the state it
protects:

```ts
"awaiting-shipping": {
  validateContext: ({ state, context }) => {
    // state is typed as "awaiting-shipping"
    return context.paymentId !== undefined;
  },
  on: {
    // ...shipping transitions
  },
},
```

Keep machine-level `validateSnapshot` for a rule that genuinely spans several
states or must compare the state discriminator itself:

```ts
validateSnapshot: ({ state, context }) =>
  !state.startsWith("cancelled-") || context.cancellationReason !== undefined,
```

The active state's `validateContext` runs first, followed by `validateSnapshot`.
Each predicate runs exactly once on the copied, deeply frozen snapshot during
initial-state creation, wrapper reconstitution, functional API input validation,
and before a transition result is committed. The stateful wrapper reuses its
already validated current snapshot, so `can(...)` does not repeatedly validate
unchanged context. `false` throws `InvalidDomainMachineSnapshotError`; a
non-boolean result is a broken definition and throws
`InvalidDomainMachineDefinitionError`.

Without either validator, snapshot validation is intentionally structural and
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
reject empty orders. `shipped` and `cancelled` are terminal states, so no input
can transition out of them.

Use `can(input)` when the application needs to ask whether a transition is
currently available. Use `dispatch(input)` or `transitionDomainState(...)` when a
domain method wants to enforce the rule; missing transitions throw
`InvalidDomainTransitionError`, and rejected guards throw
`DomainTransitionGuardRejectedError`.

Guards return `true`, `false`, or a concrete `DomainError`:

- `true` allows the transition.
- `false` makes `can(input)` return `false`; `dispatch(input)` throws the generic
  `DomainTransitionGuardRejectedError`.
- A `DomainError` also makes `can(input)` return `false`, but `dispatch(input)`
  throws that exact error instance. This keeps rejected business rules in the
  ubiquitous language.

```ts
class PaymentRequiredBeforeShippingError extends DomainError<
  "PaymentRequiredBeforeShippingError"
> {
  constructor(readonly orderId: string) {
    super(`Order ${orderId} must be paid before shipping.`);
  }
}

// Inside the PaymentReceived transition:
guard: ({ context }) =>
  context.paymentId !== undefined
    ? true
    : new PaymentRequiredBeforeShippingError(context.orderId),
```

Return the error as a value; do not throw it inside the guard. A thrown callback
error propagates from both `can(...)` and `dispatch(...)`, because the machine
cannot classify arbitrary callback failures as ordinary domain rejection. A
guard that accidentally falls through and returns `undefined`, returns a plain
`Error`, or returns any other value is broken machine code and throws
`InvalidDomainTransitionGuardResultError`.

`can(...)` is not a general error-swallowing boundary. It returns `false` when a
transition is unavailable, a guard rejects, or the input has no own string
`type`. Once an input type matches a transition, invalid input payload data and
broken guard code throw their structured errors. This keeps “not currently
allowed” separate from malformed input and defective machine code.

## Analyze a definition in tests

Use `analyzeDomainMachineDefinition(...)` in architecture tests or development
tooling to review the declared graph without creating a snapshot or executing
domain code:

```ts
import { analyzeDomainMachineDefinition } from "@shirudo/ddd-kit";

const analysis = analyzeDomainMachineDefinition(orderLifecycle);

expect(analysis.diagnostics).toEqual([]);
console.table(analysis.transitions);
```

The result contains a stable transition matrix with `state`, `inputType`,
`target`, and `guarded`, plus these diagnostics:

| Diagnostic | Statically proven meaning |
| --- | --- |
| `unreachable-state` | No declared path leads from the initial state to this state. |
| `structural-dead-end` | A non-terminal state declares no outgoing transition. |
| `no-terminal-path` | No declared path leads from this state to any terminal state. |

The analyzer never calls `initialContext`, guards, reducers, `validateContext`,
or `validateSnapshot`. Every guarded edge is treated as a possible edge. This is
the key soundness boundary: a reported missing path is definitive, but a state
listed in `structurallyReachableStates` may still be unreachable at runtime when
its guards always reject. Likewise, `statesWithTerminalPath` proves only that a
declared path exists, not that current domain data can traverse it.

Analysis validates the definition's data shape first and returns deeply frozen,
lexically ordered values. Run it in tests and CI; it is not part of transition
execution and does not replace behavioral tests for guard conditions.

## Pure transitions

The stateful wrapper is convenience. The core operation is pure:

```ts
import {
  canTransitionDomainState,
  createInitialDomainMachineSnapshot,
  transitionDomainState,
} from "@shirudo/ddd-kit";

const snapshot = createInitialDomainMachineSnapshot(checkoutLifecycle);

canTransitionDomainState(checkoutLifecycle, snapshot, {
  type: "Cancel",
  reason: "payment-failed",
}); // true

const transitioned = transitionDomainState(checkoutLifecycle, snapshot, {
  type: "Cancel",
  reason: "payment-failed",
});

transitioned.from; // "awaiting-payment"
transitioned.to; // "cancelled"
transitioned.outputs; // [{ type: "CancelOrder", ... }]
```

`transitionDomainState(...)` and `canTransitionDomainState(...)` defensively copy
and freeze the snapshot and machine input before running guards or reducers. A
buggy callback cannot mutate caller-owned inputs; if it writes to `context` or
`input`, the frozen copy fails loudly.

Purity also requires callback discipline that JavaScript cannot enforce at
runtime. Guards, reducers, `validateContext`, and `validateSnapshot` must be
synchronous, deterministic, and side-effect-free: do not perform I/O, read
clocks or randomness, or mutate captured closure state. In particular,
`can(...)` is a query and must remain side-effect-free. Return requested external
work as `outputs`; execute it outside the machine.

The stateful wrapper also rejects reentrant evaluation. A guard or reducer must
not call `can(...)` or `dispatch(...)` on the same machine instance; the same
rule applies to `validateContext` and `validateSnapshot`. Such a call throws
`ReentrantDomainStateMachineEvaluationError`, leaves the current snapshot
unchanged, and releases the evaluation lock even when callback code throws.

## Persist and reconstitute snapshots

Persist the snapshot value, not the `DomainStateMachine` instance or its
definition. Definitions are executable domain code and must be supplied by the
current application version when a snapshot is loaded:

```ts
type CheckoutRow = {
  id: string;
  lifecycle: DomainMachineSnapshot<CheckoutState, CheckoutContext>;
};

const row = await checkoutRepository.getByIdOrFail("checkout-1");
const machine = new DomainStateMachine(checkoutLifecycle, row.lifecycle);

const result = machine.dispatch({
  type: "Cancel",
  reason: "payment-timeout",
});

await checkoutRepository.save({
  ...row,
  lifecycle: result.snapshot,
});
```

The constructor validates the restored state name, copies and freezes its
context, and runs the active state's `validateContext` followed by
`validateSnapshot` before exposing the machine. Invalid or
outdated persisted data therefore fails during reconstitution instead of during
a later business operation. Add an explicit persistence migration when a new
deployment removes states or changes context invariants.

Snapshots contain plain data and can be serialized as JSON when the context uses
JSON-compatible primitives. The machine also accepts `bigint`, `symbol`,
`undefined`, and non-finite numbers as in-memory data, but JSON does not preserve
those values faithfully; encode them explicitly or exclude them from persisted
contexts.

Persistence, optimistic concurrency, and output delivery remain outside the
machine. In production, save the new snapshot and enqueue its requested outputs
atomically, usually through an outbox. Do not execute an external output first
and persist the corresponding snapshot afterward.

### Version persisted snapshots

Version the persistence envelope independently from the machine definition. A
deployment can rename a state, add required context, or tighten an invariant;
the old snapshot must be migrated before it reaches the constructor:

```ts
type PersistedCheckoutLifecycle = {
  schemaVersion: 2;
  snapshot: DomainMachineSnapshot<CheckoutState, CheckoutContext>;
};

type CheckoutStateV1 =
  | "pending-payment"
  | "awaiting-shipping"
  | "completed"
  | "cancelled";

type PersistedCheckoutLifecycleV1 = {
  schemaVersion: 1;
  snapshot: DomainMachineSnapshot<CheckoutStateV1, CheckoutContext>;
};

function migrateCheckoutLifecycleV1(
  snapshot: PersistedCheckoutLifecycleV1["snapshot"],
): DomainMachineSnapshot<CheckoutState, CheckoutContext> {
  return {
    state:
      snapshot.state === "pending-payment"
        ? "awaiting-payment"
        : snapshot.state,
    context: snapshot.context,
  };
}

function loadCheckoutLifecycle(
  stored: PersistedCheckoutLifecycleV1 | PersistedCheckoutLifecycle,
): DomainMachineSnapshot<CheckoutState, CheckoutContext> {
  switch (stored.schemaVersion) {
    case 1:
      return migrateCheckoutLifecycleV1(stored.snapshot);
    case 2:
      return stored.snapshot;
  }
}

const snapshot = loadCheckoutLifecycle(row.lifecycle);
const machine = new DomainStateMachine(checkoutLifecycle, snapshot);
```

Parse the stored envelope as untrusted data at the repository boundary. Keep
each migration deterministic and test it against real old fixtures. Persist the
new schema version in the same transaction as the migrated snapshot. Do not put
migration branches into guards or reducers: the current machine definition
should only operate on the current context schema.

### Deduplicate delivered inputs

Process managers commonly receive the same message more than once. Deduplicate
by message ID in an application-layer inbox before applying the machine input,
and commit the inbox marker, new snapshot, and requested outputs atomically:

```ts
await transaction.run(async (tx) => {
  if (await inbox.contains(tx, message.id)) return;

  const saga = await checkoutSagaRepository.getById(tx, message.checkoutId);
  const result = transitionDomainState(checkoutLifecycle, saga.lifecycle, {
    type: "PaymentReceived",
  });

  await checkoutSagaRepository.save(
    tx,
    { ...saga, lifecycle: result.snapshot },
    { expectedVersion: saga.version },
  );
  await outbox.enqueueAll(tx, result.outputs);
  await inbox.record(tx, message.id);
});
```

Use optimistic concurrency as well, because two different messages can race for
the same process manager. If repetition is meaningful in the domain rather than
delivery duplication, model an explicit idempotent self-transition in the
relevant state. Do not globally swallow `InvalidDomainTransitionError`; that
would hide genuinely forbidden transitions.

The outbox values above are requested application work. They are not Domain
Events. An Aggregate still records a Domain Event explicitly through
`recordEvent(...)` and commits it through the Aggregate path.

### Pass deadlines as input data

The machine does not own a clock or scheduler. Store a deadline as plain context
data, let infrastructure decide when to wake up, and include the observed time
in the input:

```ts
type PaymentDeadlineInput = {
  type: "PaymentDeadlineReached";
  observedAtEpochMs: number;
};

type PaymentDeadlineContext = CheckoutContext & {
  paymentDueAtEpochMs: number;
};

// In the awaiting-payment state:
PaymentDeadlineReached: {
  target: "cancelled",
  guard: ({ context, input }) =>
    input.observedAtEpochMs >= context.paymentDueAtEpochMs,
  reduce: ({ context }) => ({
    outputs: [{ type: "CancelOrder", orderId: context.orderId, reason: "timeout" }],
  }),
},
```

The scheduler reads the clock and dispatches this value. Retries may deliver the
same deadline input again, so combine this pattern with inbox deduplication or a
deliberate idempotent transition. Tests can pass exact timestamps without fake
timers, and replaying the same snapshot plus input remains deterministic.

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
reconstitution failures. Invalid context values, malformed runtime inputs, and
malformed reducer results are treated the same way:

- `InvalidDomainMachineDefinitionError extends BaseError`
- `InvalidDomainMachineContextError extends BaseError`
- `InvalidDomainMachineSnapshotError extends BaseError`
- `InvalidDomainMachineInputError extends BaseError`
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

## DomainStateMachine vs XState

[XState](https://stately.ai/docs/xstate) can model every lifecycle shown in this
guide. The reason to choose `DomainStateMachine` is not a missing XState
capability; it is the narrower, opinionated DDD contract enforced wherever the
runtime permits. Callbacks must be synchronous and pure (invalid return values
and async reducers are rejected, while side-effect freedom remains a coding
discipline); context/inputs/outputs cross a strict plain-data copy-and-freeze
boundary; restored snapshots must satisfy domain invariants; transition failures
use structured domain errors; and outputs remain requested-work values rather
than published domain events. XState is the more capable general-purpose
statechart and actor runtime, but those DDD policies remain application
responsibilities when using it.

| Requirement | `DomainStateMachine` | [XState](https://stately.ai/docs/xstate) |
| --- | --- | --- |
| Flat, named lifecycle states | Best fit | Supported |
| Synchronous pure guards and reducers | Best fit | Supported |
| Aggregate invariants and structured domain errors | Built-in contract | Possible with application mapping |
| Plain, defensively copied snapshots and value outputs | Built-in contract | Different actor/action model |
| No interpreter or actor-runtime dependency | Yes | No |
| Nested or parallel states | Not provided | Built in |
| Delayed transitions and timers | Not provided | Built in |
| Invoked or spawned asynchronous actors | Not provided | Built in |
| UI-framework integration and visual modeling | Not provided | Ecosystem support |
| Deep actor-tree persistence | Not provided | Built in |

> Choose by required semantics, not by the number of states. Use
> `DomainStateMachine` for a synchronous domain decision table; use XState when
> the machine itself must coordinate concurrent or asynchronous runtime behavior.
