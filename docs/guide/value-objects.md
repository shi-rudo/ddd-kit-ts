# Value Objects

Value Objects are immutable, defined by their attributes rather than identity. Equality is structural — two Money value objects with the same amount and currency are the same.

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

`vo()` deep-clones its input via `structuredClone` before freezing, so the caller's object graph is **never** mutated as a side-effect. Mutating the original after `vo(input)` does not bleed into the value object.

`structuredClone` refuses function values, which catches the DDD anti-pattern of putting behaviour onto a Value Object at construction time. Value Objects are data; behaviour belongs on the surrounding aggregate or domain service.

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

`voWithValidation` is the **App-boundary parser** — use it when validating untrusted input (HTTP body, queue message, file). For Domain construction, prefer the class-based `ValueObject` so the constructor itself enforces invariants and throws on violation.

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

The returned `ValidationError` is a **value you destructure, not a throw you catch** — it lives on the Result axis, distinct from the thrown `DomainError` hierarchy. See [Result vs Throw](./result-vs-throw.md#vovalidated-collects-every-violation) for that distinction and for rendering it as RFC 9457 via `@shirudo/ddd-kit/http`.

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
- `equals(other)` — deep equality plus a constructor check, so `new Money(…)` is never equal to a `new Coupon(…)` with the same shape
- `clone(props?)` — creates a new instance with optional overrides
- `toJSON()` — exposes `props` for serialisation

::: warning Constructor-ordering footgun
`validate(props)` is called from the base constructor *before* the subclass's field initializers run. Treat `validate` as pure with respect to `this` — use only the `props` argument. If your invariants depend on per-instance config, put that config into `props` itself or check it in a static factory method.
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

## When to reach for `vo()` vs `ValueObject<T>`

| Use case | Reach for |
|---|---|
| Quick immutable record, no methods | `vo()` |
| Methods on the value object (`add`, `subtract`, `convertTo`) | `ValueObject` |
| Construction must throw on invalid input | `ValueObject` |
| Parsing untrusted input at the App boundary | `voWithValidation` |
| Reporting every invalid field at once | `voValidated` |
| Equality ignoring some keys | `voEqualsExcept` |
