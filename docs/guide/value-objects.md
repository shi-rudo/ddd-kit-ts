# Value Objects

Value Objects are immutable, defined by their attributes rather than identity. Equality is structural: two Money value objects with the same amount, currency, and scale are the same. (For money specifically, use the shipped canonical shape from [`@shirudo/ddd-kit/money`](/guide/money) instead of hand-rolling one; its `moneyEquals` is deliberately strict on all three attributes.)

## Functional: `vo()`

The fastest way to a deeply immutable value object:

```ts
import { vo, voEquals } from "@shirudo/ddd-kit";

const money = vo({ amount: 100, currency: "EUR" });
// money is Readonly<{ amount: number; currency: string }>
// nested writes throw in strict mode

const a = vo({ amount: 100, currency: "EUR" });
const b = vo({ amount: 100, currency: "EUR" });
voEquals(a, b); // true
```

`vo()` deep-clones its input before freezing, so the caller's object graph is **never** mutated as a side-effect. Mutating the original after `vo(input)` does not bleed into the value object. Symbol-keyed properties are preserved, including symbols on arrays and non-enumerable symbols; they participate in `voEquals` like any other key. Accessor properties are rejected without invoking their getters or setters.

Function values and custom class instances (including subclasses of built-ins) are rejected with a `TypeError`. Cloning a class instance without running its constructor can silently discard private fields, non-enumerable state, and built-in internal slots. Pass plain records, arrays, or the explicitly supported built-ins instead; put Value Object behaviour on a class that extends `ValueObject<T>`, not inside its `props` graph. Plain records from another JavaScript Realm are accepted and normalized to the local `Object.prototype`.

Every accepted VO value must be both immutable and compared by value. `Error`,
`ArrayBuffer`, `SharedArrayBuffer`, TypedArrays, and `DataView` are therefore
rejected instead of introducing reference equality or mutable bytes. `Promise`,
`WeakMap`, and `WeakSet` remain rejected as non-value data. Convert binary data
to an immutable representation such as a plain number array or encoded string
before constructing a VO.

Inputs to `vo()` must be trusted and Proxy-free. ECMAScript provides no
portable, side-effect-free way to identify a transparent `Proxy`, so reflective
cloning can execute Proxy traps. `vo()` is an immutable-value constructor, not
a sandbox for hostile in-process objects. Parse untrusted wire data into an
ordinary DTO before passing it to `vo()` or `voWithValidation`.

Date, Map and Set keep internal-slot mutability under `Object.freeze` (`setTime`, `set`, `add`, … succeed on frozen instances), so `deepFreeze` additionally shadows their mutator methods with throwing own properties and freezes Map values recursively, so a mutating consumer gets a `TypeError` instead of silently poisoning shared state. Reads (`get`, `has`, iteration, `getTime`) work unchanged. Map keys and Set members must be primitive values: JavaScript defines their lookup semantics by identity, so cloning object keys or members would make separately constructed Value Objects compare unequal. Use an array when members are structured values. The mutator blocking is deny-by-enumeration: mutators added by future runtimes (e.g. the stage-3 `Map.prototype.getOrInsert` proposal) are not blocked until the list is updated. Treat it as a guard rail, not a security boundary.

The standalone `deepFreeze` utility still documents its JavaScript-level
limitations, but `vo()` and `ValueObject` do not inherit a weaker contract from
it: unsupported mutable values are rejected before freezing.

### Validation at the App boundary

```ts
import { voWithValidation } from "@shirudo/ddd-kit";
import type { Result } from "@shirudo/result";

type Money = { amount: number; currency: string };

const result: Result<Money, string> = voWithValidation(
  { amount: 100, currency: "EUR" },
  (m) => m.amount >= 0 && m.currency.length === 3,
  "Invalid Money",
);

if (result.isOk()) {
  // result.value is the validated, frozen Money
}
```

`voWithValidation` is the **App-boundary parser**: use it when validating untrusted input (HTTP body, queue message, file). For Domain construction, prefer the class-based `ValueObject` so the constructor itself enforces invariants and throws on violation.

### Collecting every violation: `voValidated`

`voWithValidation` fails fast with a single message. When you parse a form and want to report *all* the broken fields at once, `voValidated` collects each violation into one `ValidationError` (from `@shirudo/base-error`):

```ts
import { voValidated } from "@shirudo/ddd-kit";

const result = voValidated(
  { email, age },
  (issues, m) => {
    if (!isEmail(m.email))
      issues.addIssue({ message: "must be a valid email", path: ["email"] });
    if (m.age < 0)
      issues.addIssue({ message: "must not be negative", path: ["age"] });
  },
);

if (result.isErr()) {
  // result.error.publicIssues() → every violation, in order
}
```

The returned `ValidationError` is a **value you destructure, not a throw you catch**: it lives on the Result axis, distinct from the thrown `DomainError` hierarchy. See [Result vs Throw](./result-vs-throw.md#vovalidated-collects-every-violation) for that distinction and for rendering it as RFC 9457 via `@shirudo/ddd-kit/http`.

## Class-based: `ValueObject<T>`

When the value object has methods, or when you want construction to throw rather than return a Result:

```ts
import { ValueObject } from "@shirudo/ddd-kit";

class Money extends ValueObject<{ amount: number; currency: string }> {
  protected validate(props: { amount: number; currency: string }): void {
    if (props.amount < 0) throw new Error("amount must be non-negative");
    if (props.currency.length !== 3) throw new Error("currency must be ISO-4217");
  }

  add(other: Money): Money {
    if (this.props.currency !== other.props.currency) {
      throw new Error("currency mismatch");
    }
    return new Money({
      amount: this.props.amount + other.props.amount,
      currency: this.props.currency,
    });
  }
}

const a = new Money({ amount: 100, currency: "EUR" });
const b = new Money({ amount: 50, currency: "EUR" });
const c = a.add(b); // Money { amount: 150, currency: "EUR" }
a.equals(b); // false (constructor-aware deep equality)
```

`ValueObject` includes:
- `equals(other)`: deep equality plus a constructor check, so `new Money(…)` is never equal to a `new Coupon(…)` with the same shape
- `clone(props?)`: creates a new instance with optional overrides
- `toJSON()`: exposes `props` for serialisation

::: warning Constructor-ordering footgun
`validate(props)` is called from the base constructor *before* the subclass's field initializers run. Treat `validate` as pure with respect to `this`; use only the `props` argument. If your invariants depend on per-instance config, put that config into `props` itself or check it in a static factory method.
:::

## Equality with ignored keys

For value objects that carry metadata (`createdAt`, `updatedAt`, internal ids) you don't want in equality checks:

```ts
import { voEqualsExcept } from "@shirudo/ddd-kit";

voEqualsExcept(a, b, {
  ignoreKeys: ["updatedAt"],
  // OR: ignoreKeyPredicate: (key, path) => path.includes("metadata"),
});
```

`voEqualsExcept` compares deep-omitted copies of both sides. Every value admitted
by the VO constructors has value semantics, so equality never falls back to
identity for valid VOs. The lower-level `deepEqualExcept` utility can still
receive arbitrary JavaScript objects and documents its broader behavior
separately.

## When to reach for `vo()` vs `ValueObject<T>`

| Use case | Reach for |
|---|---|
| Quick immutable record, no methods | `vo()` |
| Methods on the value object (`add`, `subtract`, `convertTo`) | `ValueObject` |
| Construction must throw on invalid input | `ValueObject` |
| Parsing untrusted input at the App boundary | `voWithValidation` |
| Reporting every invalid field at once | `voValidated` |
| Equality ignoring some keys | `voEqualsExcept` |
