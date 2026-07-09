# Value Objects

A value object models a concept by its content, not by identity. Two addresses
with the same street, city, and postal code are the same value. Two entities
with the same display name are not.

Reach for a value object when the value has rules you want to protect, when
equality should be structural, or when passing a raw primitive around would make
the code ambiguous. For money, use the dedicated [Money](./money.md) helpers
instead of inventing another casual two-field shape.

## Which API Should I Use?

| Need | Use |
| --- | --- |
| A deeply immutable plain-data value | `vo()` |
| One fail-fast validation error at the application edge | `voWithValidation()` |
| All validation issues at once | `voValidated()` |
| Domain behavior or throwing invariants | `ValueObject<T>` |
| Equality while ignoring selected metadata | `voEqualsExcept()` |

The split is intentional. Application input parsing is a `Result` flow. Domain
construction is usually a throwing invariant flow. See
[Result vs Throw](./result-vs-throw.md#validation-helpers) for the broader
error-handling model.

## Plain Values With `vo()`

Use `vo()` when the value is plain data and does not need methods:

```ts
import { vo, voEquals } from "@shirudo/ddd-kit";

const input = {
  street: "Main St",
  city: "Berlin",
  coordinates: { lat: 52.5, lng: 13.4 },
};

const address = vo(input);

input.coordinates.lat = 0;
address.coordinates.lat; // 52.5

const sameAddress = vo({
  street: "Main St",
  city: "Berlin",
  coordinates: { lat: 52.5, lng: 13.4 },
});

voEquals(address, sameAddress); // true
```

`vo()` clones first and freezes the clone. That matters more than it sounds:
the caller keeps ownership of the original object, and later mutations to the
original cannot leak into the value object.

Keep the input boring: plain records, arrays, and supported built-ins. Do not
put functions, services, repositories, custom class instances, `Error` objects,
buffers, typed arrays, promises, weak collections, or other behavior-bearing
objects inside a value object. If a value needs methods, make the value object a
class instead of smuggling behavior through `props`.

## Parse Input With Validation Helpers

Use these helpers after you have converted untrusted input into an ordinary DTO.
They are good for HTTP bodies, queue messages, forms, and file imports.

`voWithValidation()` is fail-fast and returns `Result<VO<T>, string>`:

```ts
import { voWithValidation } from "@shirudo/ddd-kit";

type ShippingAddressInput = {
  street: string;
  city: string;
  postalCode: string;
};

const dto: ShippingAddressInput = {
  street: String(body.street ?? ""),
  city: String(body.city ?? ""),
  postalCode: String(body.postalCode ?? ""),
};

const parsed = voWithValidation(
  dto,
  (address) =>
    address.street.trim() !== "" &&
    address.city.trim() !== "" &&
    /^[0-9]{5}$/.test(address.postalCode),
  "Shipping address is invalid",
);

if (parsed.isErr()) {
  return Response.json({ error: parsed.error }, { status: 400 });
}

const address = parsed.value;
```

`voValidated()` collects every issue into one `ValidationError`:

```ts
import { voValidated } from "@shirudo/ddd-kit";

const parsed = voValidated(
  dto,
  (issues, address) => {
    if (address.street.trim() === "") {
      issues.addIssue({
        path: ["street"],
        message: "must not be empty",
      });
    }

    if (!/^[0-9]{5}$/.test(address.postalCode)) {
      issues.addIssue({
        path: ["postalCode"],
        message: "must be a five-digit postal code",
      });
    }
  },
  "Shipping address is invalid",
);

if (parsed.isErr()) {
  return Response.json(
    { issues: parsed.error.publicIssues() },
    { status: 400 },
  );
}
```

Both helpers return validation failures as values. They still call `vo()` on the
success path, so non-data JavaScript values can still throw `TypeError`. That is
deliberate: a function or mutable buffer in a DTO is a programming error, not a
user validation error.

## Add Behavior With `ValueObject<T>`

Use a class when the type owns behavior, when construction should throw, or when
you want to keep raw `props` out of the rest of the domain model.

```ts
import { ValueObject } from "@shirudo/ddd-kit";

type DateRangeProps = {
  from: Date;
  to: Date;
};

class DateRange extends ValueObject<DateRangeProps> {
  protected validate(props: DateRangeProps): void {
    if (props.to.getTime() < props.from.getTime()) {
      throw new Error("DateRange.to must be on or after DateRange.from");
    }
  }

  get from(): Date {
    return this.props.from;
  }

  get to(): Date {
    return this.props.to;
  }

  includes(date: Date): boolean {
    const time = date.getTime();
    return this.from.getTime() <= time && time <= this.to.getTime();
  }

  extendTo(to: Date): DateRange {
    return this.clone({ to });
  }
}

const bookingWindow = new DateRange({
  from: new Date("2026-07-01T00:00:00.000Z"),
  to: new Date("2026-07-31T00:00:00.000Z"),
});

bookingWindow.includes(new Date("2026-07-09T12:00:00.000Z")); // true
```

The base class gives you:

- `props`: deeply immutable cloned props
- `equals(other)`: constructor-aware deep equality
- `clone(props?)`: a new instance with optional overrides
- `toJSON()`: the raw immutable props for serialization

`equals()` checks the constructor as well as the props. A `DateRange` is not
equal to another class with the same `{ from, to }` shape, because the type is
part of the meaning.

::: warning Constructor ordering
`validate(props)` runs from the base constructor before subclass field
initializers run. Treat `validate` as a pure check over the `props` argument. If
an invariant needs configuration, pass that configuration in `props` or enforce
it in a static factory before calling `new`.
:::

## Equality With Ignored Keys

Most value objects should not carry metadata. If you do have metadata, be
explicit about whether it belongs to equality.

```ts
import { voEqualsExcept } from "@shirudo/ddd-kit";

voEqualsExcept(firstAddress, secondAddress, {
  ignoreKeys: ["updatedAt"],
});
```

Use this sparingly. If a field never participates in equality, ask whether it
belongs on the value object at all. Timestamps, database ids, and audit data
usually belong to an entity, a persistence record, or an event envelope.

## Data Rules That Matter

Value objects only work when their content has value semantics. The library is
strict here because loose value objects create subtle bugs.

Plain records and arrays are accepted. Symbol-keyed properties are preserved and
participate in equality. Accessor properties are rejected without calling their
getters or setters.

Dates, Maps, Sets, RegExp values, and primitive wrappers are accepted only when
they can behave like immutable values. Date, Map, and Set mutator methods are
shadowed on the frozen clone so accidental mutation throws. Map keys and Set
members must be primitives, because JavaScript compares object keys and set
members by identity.

Functions and custom class instances are rejected. A class instance can hide
private fields, non-enumerable state, and runtime-owned internal slots. Cloning
it as data would produce a value that looks valid but has lost part of its
meaning.

Buffers, typed arrays, `DataView`, `Error`, promises, `WeakMap`, and `WeakSet`
are rejected. They are mutable, reference-oriented, or process state rather
than stable value data. Convert binary data to an encoded string or a plain
number array before constructing a value object.

Do not pass hostile Proxy objects to `vo()`. JavaScript has no portable,
side-effect-free way to identify a transparent Proxy, so reflective cloning can
trigger traps. Treat `vo()` as an immutable value constructor, not as a sandbox.

The exported `deepFreeze()` helper freezes in place and is used by lower-level
internals. Application code should usually prefer `vo()` or `ValueObject<T>`,
because they clone first and do not freeze caller-owned objects.

## Common Mistakes

Do not use a value object when the concept has a lifecycle. If users can rename
an address book entry, deactivate it, merge it, or refer to the same thing over
time, you probably have an entity.

Do not let persistence shape leak into the value. A database row can have
`id`, `createdAt`, `updatedAt`, and migration fields. The domain value should
contain only the data that gives the concept its meaning.

Do not hide invalid states behind optional fields. If a date range always needs
both dates, model both dates and reject invalid ranges at construction. A value
object should make invalid combinations hard to express.

Do not use `voWithValidation()` for domain invariants that must never be
ignored. The helper is useful at boundaries where callers expect `Result`.
Inside the domain, prefer a constructor or factory that cannot produce an
invalid value.

Do not model money as an ad-hoc value object. Use the Money helpers so scale,
exact minor units, parsing, and serialization stay consistent across the system.
