# Domain State Machine

`DomainStateMachine` is for domain lifecycles that are easier to understand as
named states and allowed transitions.

Use it when the lifecycle itself is part of the model: a checkout waits for
payment, then shipping, then completion; a claim moves through review,
approval, payout, and closure; a process manager reacts to facts over time. Do
not use it just because an object has a boolean flag. A normal aggregate method
with an `if` guard is often clearer for small cases.

The machine is deliberately narrow:

- flat named states
- synchronous guards and reducers
- plain immutable context, inputs, outputs, and snapshots
- no timers, retries, persistence, message bus, or actor runtime
- no automatic domain-event publishing

Keep that boundary in mind. The machine decides whether a transition is valid
and what plain outputs are requested. Application code still persists
snapshots, deduplicates delivered messages, writes outbox rows, sends commands,
and records aggregate events.

Also keep the public domain API in the ubiquitous language. `checkout.cancel()`
or `saga.receivePayment()` is a good aggregate or process-manager method.
`dispatch({ type: "Cancel" })` is an implementation detail unless the caller is
already a low-level workflow component.

## Define a lifecycle

A definition names the initial state, creates the initial context, and lists
the transitions that are meaningful from each state.

```ts
import {
  DomainError,
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
  cancellationReason?: string;
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

class PaymentRequiredBeforeShippingError extends DomainError<
  "PAYMENT_REQUIRED_BEFORE_SHIPPING"
> {
  constructor(orderId: string) {
    super({
      code: "PAYMENT_REQUIRED_BEFORE_SHIPPING",
      message: `Order ${orderId} must have a payment before shipping.`,
    });
  }
}

function createCheckoutLifecycle(
  orderId: string,
): DomainMachineDefinition<
  CheckoutState,
  CheckoutContext,
  CheckoutInput,
  CheckoutOutput
> {
  return {
    initial: "awaiting-payment",
    initialContext: () => ({ orderId }),
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
            guard: ({ context }) =>
              context.paymentId === undefined
                ? new PaymentRequiredBeforeShippingError(context.orderId)
                : true,
            reduce: ({ context }) => ({
              outputs: [
                { type: "RequestShipping", orderId: context.orderId },
              ],
            }),
          },
          Cancel: {
            target: "cancelled",
            reduce: ({ context, input }) => ({
              context: {
                ...context,
                cancellationReason: input.reason,
              },
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
              outputs: [
                { type: "ConfirmOrder", orderId: context.orderId },
              ],
            }),
          },
          Cancel: {
            target: "cancelled",
            reduce: ({ context, input }) => ({
              context: {
                ...context,
                cancellationReason: input.reason,
              },
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
      completed: { terminal: true },
      cancelled: { terminal: true },
    },
  };
}

const machine = new DomainStateMachine(createCheckoutLifecycle("order-1"));

const requested = machine.dispatch({
  type: "PaymentRequested",
  paymentId: "payment-1",
});

requested.snapshot.state; // "awaiting-payment"
requested.snapshot.context.paymentId; // "payment-1"
```

`initialContext` is a factory, not a shared object. Every fresh machine gets its
own context value. If initial context depends on runtime data, wrap the
definition in a small factory as shown above.

Inputs are not automatically domain events. A machine input may be a command
(`Cancel`), an observed fact (`PaymentReceived`), or an internal trigger. Domain
events are still immutable facts recorded by aggregates with `recordEvent` and
committed through the aggregate/outbox path.

Outputs are not domain events either. They are plain requested-work values: send
a command, call an adapter, enqueue an outbox message, or notify another
component. The application layer decides what to do with them after the
snapshot is saved.

## Model transitions from the current state

Read the definition from the current state outward. The `on` block answers one
question: "Which inputs make sense from here?"

- If an input should never be accepted from a state, do not define it there.
- If an input is meaningful but only under some data condition, use a `guard`.
- If no input should ever leave a state, mark it `terminal: true` and do not add
  transitions.

```ts
const orderLifecycle = {
  initial: "draft",
  initialContext: () => ({ itemCount: 0, paid: false }),
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

`Ship` is not defined from `draft`, so shipping a draft order is not part of the
lifecycle. `Submit` is defined from `draft`, but its guard rejects empty orders.
`shipped` and `cancelled` are terminal states, so no transition can leave them.

Use `can(input)` when the application wants to ask whether a transition is
currently available. Use `dispatch(input)` or `transitionDomainState(...)` when
a domain method wants to enforce the rule.

```ts
machine.can({ type: "PaymentReceived" }); // false

machine.dispatch({
  type: "PaymentReceived",
}); // throws PaymentRequiredBeforeShippingError
```

Guards return `true`, `false`, or a concrete `DomainError`:

| Return value | `can(...)` | `dispatch(...)` |
| --- | --- | --- |
| `true` | returns `true` | performs the transition |
| `false` | returns `false` | throws `DomainTransitionGuardRejectedError` |
| `DomainError` | returns `false` | throws that exact error |

Return a domain error as a value. Do not throw it inside the guard. A thrown
callback error propagates from both `can(...)` and `dispatch(...)`, because the
machine cannot know whether arbitrary callback failure is an ordinary business
rejection or broken code.

`can(...)` is not an error-swallowing boundary. It returns `false` for missing
transitions, terminal states, rejected guards, and values without an own string
`type`. Once an input type matches a transition, malformed input payload and
broken guard code still throw structured errors.

## Validate state where the invariant lives

Use a state's `validateContext` when the invariant belongs to that state:

```ts
"awaiting-shipping": {
  validateContext: ({ state, context }) => {
    // state is typed as "awaiting-shipping"
    return context.paymentId !== undefined;
  },
  on: {
    ShippingCompleted: { target: "completed" },
  },
},
```

Use machine-level `validateSnapshot` for a rule that genuinely spans states or
needs to compare the state discriminator with context:

```ts
validateSnapshot: ({ state, context }) =>
  state !== "cancelled" || context.cancellationReason !== undefined,
```

The active state's `validateContext` runs first. `validateSnapshot` runs after
that. Both predicates run against copied, deeply frozen snapshots when the
machine creates an initial snapshot, reconstitutes a persisted snapshot,
validates functional API input, and commits a transition result.

Without validators, snapshot validation is structural only. The machine checks
that the state exists and the context is valid machine data, but it cannot infer
business invariants from erased TypeScript types.

Keep validators synchronous, deterministic, and side-effect-free. They are
domain rules, not hooks for I/O.

## Use the stateful wrapper or the pure functions

`DomainStateMachine` is a stateful convenience wrapper. It stores the current
snapshot and advances it when `dispatch(...)` succeeds:

```ts
const machine = new DomainStateMachine(createCheckoutLifecycle("order-1"));

const outcome = machine.dispatch({
  type: "PaymentRequested",
  paymentId: "payment-1",
});

machine.state; // "awaiting-payment"
machine.context.paymentId; // "payment-1"
outcome.outputs; // []
```

The core operation is also available as pure functions:

```ts
import {
  canTransitionDomainState,
  createInitialDomainMachineSnapshot,
  transitionDomainState,
} from "@shirudo/ddd-kit";

const definition = createCheckoutLifecycle("order-1");
const snapshot = createInitialDomainMachineSnapshot(definition);

canTransitionDomainState(definition, snapshot, {
  type: "Cancel",
  reason: "payment-failed",
}); // true

const transitioned = transitionDomainState(definition, snapshot, {
  type: "Cancel",
  reason: "payment-failed",
});

transitioned.from; // "awaiting-payment"
transitioned.to; // "cancelled"
transitioned.snapshot.state; // "cancelled"
```

Use the wrapper when a single object owns the lifecycle in memory. Use the pure
functions when the snapshot is part of aggregate state, repository data, or a
process-manager record and you want explicit input/output values.

Both paths defensively copy and freeze snapshots and inputs before guards or
reducers run. If a reducer tries to mutate `context` instead of returning a new
context, the frozen copy makes the mistake loud.

Raw definitions are validated and copied on every pure-function call. That is
safe for one-off use, but it is avoidable work on hot paths. Prepare the
definition once when you dispatch repeatedly:

```ts
import { prepareDomainMachineDefinition } from "@shirudo/ddd-kit";

const prepared = prepareDomainMachineDefinition(createCheckoutLifecycle("order-1"));

const outcome = transitionDomainState(prepared, snapshot, input);
```

The prepared handle is a validated, deeply frozen copy. The
`DomainStateMachine` constructor does the same stabilization internally. Inputs
and snapshots are still validated and copied per call because they come from
callers and storage.

The wrapper also rejects reentrant evaluation. A guard, reducer,
`validateContext`, or `validateSnapshot` must not call `can(...)` or
`dispatch(...)` on the same machine instance. That throws
`ReentrantDomainStateMachineEvaluationError`, leaves the current snapshot
unchanged, and releases the evaluation lock even if callback code throws.

## Persist snapshots, not machines

Persist the snapshot value. Do not persist the `DomainStateMachine` instance or
the definition. The definition is executable domain code and should come from
the current application version when the record is loaded.

```ts
import type { DomainMachineSnapshot } from "@shirudo/ddd-kit";

type CheckoutRow = {
  id: string;
  lifecycle: DomainMachineSnapshot<CheckoutState, CheckoutContext>;
};

const row = await checkoutRepository.getById("checkout-1");
const machine = new DomainStateMachine(
  createCheckoutLifecycle(row.id),
  row.lifecycle,
);

const result = machine.dispatch({
  type: "Cancel",
  reason: "payment-timeout",
});

await checkoutRepository.save({
  ...row,
  lifecycle: result.snapshot,
});
```

The constructor validates restored state names, copies and freezes the context,
then runs the active state's `validateContext` and the machine's
`validateSnapshot`. Bad persisted data fails during reconstitution instead of
halfway through a later business operation.

Put a schema version around persisted snapshots. A deployment can rename a
state, add required context, or tighten an invariant. Old records need a
deterministic migration before they reach the current definition.

```ts
type PersistedCheckoutLifecycleV2 = {
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
  stored: PersistedCheckoutLifecycleV1 | PersistedCheckoutLifecycleV2,
): DomainMachineSnapshot<CheckoutState, CheckoutContext> {
  switch (stored.schemaVersion) {
    case 1:
      return migrateCheckoutLifecycleV1(stored.snapshot);
    case 2:
      return stored.snapshot;
  }
}
```

Keep migrations at the repository boundary. Do not put old-schema branches in
guards or reducers. The current machine definition should operate on the
current context schema.

Snapshots are plain data and can be serialized as JSON when the context uses
JSON-compatible values. The runtime can carry values such as `bigint`, `symbol`,
`undefined`, and non-finite numbers in memory, but JSON does not preserve them
faithfully. Encode those explicitly if they belong in persisted context.

## Save outputs atomically with the snapshot

Persistence and delivery are outside the machine, but they still need one
transactional boundary in production.

Process managers commonly receive the same message more than once. Record an
inbox marker, save the new snapshot, and enqueue requested outputs in the same
transaction:

```ts
await transaction.run(async (tx) => {
  if (await inbox.contains(tx, message.id)) return;

  const saga = await checkoutSagaRepository.getById(tx, message.checkoutId);
  const result = transitionDomainState(
    createCheckoutLifecycle(saga.id),
    saga.lifecycle,
    { type: "PaymentReceived" },
  );

  await checkoutSagaRepository.save(
    tx,
    { ...saga, lifecycle: result.snapshot },
    { expectedVersion: saga.version },
  );
  await outbox.enqueueAll(tx, result.outputs);
  await inbox.record(tx, message.id);
});
```

Use optimistic concurrency as well. Inbox deduplication handles the same
message delivered twice; optimistic concurrency handles two different messages
racing for the same process manager.

If repetition is meaningful in the domain, model an explicit idempotent
self-transition in the relevant state. Do not globally swallow
`InvalidDomainTransitionError`; that hides genuinely forbidden transitions.

The outbox values above are requested application work. They are not Domain
Events. If an aggregate wants to publish a domain event, keep using the
aggregate path:

```ts
const result = transitionDomainState(
  createCheckoutLifecycle(this.id),
  this.state.lifecycle,
  {
    type: "Cancel",
    reason,
  },
);

this.commit(
  {
    ...this.state,
    lifecycle: result.snapshot,
  },
  this.recordEvent("CheckoutCancelled", {
    orderId: this.id,
    reason,
  }),
);

return result.outputs;
```

That explicit mapping is intentional. The machine does not publish, persist,
retry, record, or dispatch anything by itself.

## Pass time as input data

The machine does not own a clock or scheduler. Store deadlines as context data,
let infrastructure decide when to wake up, and pass the observed time as input:

```ts
import type { DomainTransition } from "@shirudo/ddd-kit";

type PaymentDeadlineReached = {
  type: "PaymentDeadlineReached";
  observedAtEpochMs: number;
};

type PaymentDeadlineContext = CheckoutContext & {
  paymentDueAtEpochMs: number;
};

const paymentDeadlineTransition: DomainTransition<
  CheckoutState,
  PaymentDeadlineContext,
  PaymentDeadlineReached,
  CheckoutOutput
> = {
  target: "cancelled",
  guard: ({ context, input }) =>
    input.observedAtEpochMs >= context.paymentDueAtEpochMs,
  reduce: ({ context }) => ({
    context: {
      ...context,
      cancellationReason: "timeout",
    },
    outputs: [
      {
        type: "CancelOrder",
        orderId: context.orderId,
        reason: "timeout",
      },
    ],
  }),
};
```

Do not call `Date.now()` inside a guard. Tests can pass exact timestamps, replay
stays deterministic, and retries remain ordinary message-delivery concerns.

## Analyze definitions in tests

Use `analyzeDomainMachineDefinition(...)` in tests or development tooling to
review the declared graph without creating a snapshot or executing domain code:

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

The analyzer never calls `initialContext`, guards, reducers,
`validateContext`, or `validateSnapshot`. Every guarded edge is treated as a
possible edge. A reported missing path is definitive for the static graph, but
a listed reachable state may still be unreachable at runtime when its guards
always reject.

Run the analyzer in CI if the lifecycle is important. It catches structural
mistakes; it does not replace behavioral tests for guard conditions.

## Respect the data boundary

Machine context, inputs, outputs, and snapshots are data. Use primitives, plain
objects, and plain arrays.

Do not put these values in machine data:

- functions, promises, or external resources
- class instances or custom array subclasses
- `Date`, `RegExp`, `Map`, `Set`, typed arrays, or binary buffers
- accessors, hidden behavior, or inherited domain state

Represent dates as ISO strings or epoch numbers, maps as records or entry
arrays, sets as arrays, and regular expressions as pattern/flag data.

The runtime copies and deeply freezes context, inputs, snapshots, and outputs.
Plain objects from another JavaScript Realm are accepted and normalized to local
plain objects while copied. Own accessors are rejected without invoking their
getter or setter.

The data graph is limited to 256 nested object/array levels, 10,000 unique
object nodes, and 100,000 own properties per copy operation. Those limits are
not business rules; they are guardrails against accidental giant object graphs.

Inputs must also be trusted and Proxy-free. JavaScript has no portable,
side-effect-free way to identify a transparent `Proxy`; reflective validation
can execute its traps. Parse untrusted wire input into ordinary DTOs before
constructing machine inputs or snapshots.

Definition validation is strict as well. Unknown properties are rejected, so a
misspelled `gaurd` or `output` fails instead of silently removing a business
rule. Reducers must return `undefined` or a plain object with only `context` and
`outputs`. Accidentally async reducers return promises, and promises are
rejected.

## Error semantics

Missing transitions and rejected guards are domain-rule violations:

- `InvalidDomainTransitionError extends DomainError`
- `DomainTransitionGuardRejectedError extends DomainError`
- a concrete `DomainError` returned by a guard is thrown unchanged

Broken definitions, invalid restored snapshots, malformed inputs, bad reducer
results, and reentrant calls are wiring or reconstitution failures:

- `InvalidDomainMachineDefinitionError extends BaseError`
- `InvalidDomainMachineContextError extends BaseError`
- `InvalidDomainMachineSnapshotError extends BaseError`
- `InvalidDomainMachineInputError extends BaseError`
- `InvalidDomainTransitionGuardResultError extends BaseError`
- `InvalidDomainTransitionResultError extends BaseError`
- `ReentrantDomainStateMachineEvaluationError extends BaseError`

That split is the same one the rest of the kit uses. Domain operations throw
`DomainError` for rejected business moves. Broken code and corrupted data fail
loudly as structured `BaseError` instances.

## DomainStateMachine vs XState

[XState](https://stately.ai/docs/xstate) can model every lifecycle shown in
this guide. The reason to choose `DomainStateMachine` is its narrower DDD
contract, not raw feature count.

`DomainStateMachine` is a synchronous domain decision table. It validates
restored snapshots, rejects non-plain data, freezes returned values, keeps
outputs as requested-work values, and reports transition rejection with
structured domain errors.

XState is the more capable statechart and actor runtime. Use it when the
machine itself needs to coordinate runtime behavior such as nested states,
parallel states, timers, invoked actors, spawned actors, UI tooling, or deep
actor-tree persistence.

| Requirement | `DomainStateMachine` | XState |
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

Choose by required semantics. Use `DomainStateMachine` for synchronous domain
decisions. Use XState when the state machine is also responsible for concurrent
or asynchronous runtime coordination.
