# Structural Equality and Copies

Functions that compare and copy a value structure in depth: equality, equality with exclusions, and the copy under the plain-data rule. They work over objects, arrays, Maps, Sets, and TypedArrays.

The root entry exports two of them, because the value objects, the persistence models, and the snapshot models of the kit rely on them, and an adapter can use the same rule as the kit:

```ts
import { copyPlainData, deepEqual } from '@shirudo/ddd-kit';
```

The other modules here are kit-internal: `deepOmit` and `deepEqualExcept` implement `valueObjectEqualsExcept`, and `is-built-in` detects the built-ins that the walks treat as a unit.

## `deepEqual(a, b)`

Performs a deep equality check between two values. This function compares values recursively, handling:

- Primitives (with special handling for NaN)
- Arrays (nested arrays supported)
- Objects (plain objects and class instances; a class instance equals only an instance with the same prototype)
- TypedArrays (Uint8Array, Int32Array, etc.)
- DataView
- Maps and Sets
- Dates and RegExp
- Wrapper objects (Boolean, Number, String)
- Circular references (detected and handled)

```ts
import { deepEqual } from '@shirudo/ddd-kit';

deepEqual([1, 2, 3], [1, 2, 3]); // true
deepEqual({ a: 1, b: [2, 3] }, { a: 1, b: [2, 3] }); // true
deepEqual(NaN, NaN); // true
deepEqual([1, 2], [1, 2, 3]); // false

// Handles nested structures
deepEqual(
  { user: { id: 1, name: "Alice" } },
  { user: { id: 1, name: "Alice" } }
); // true

// Handles Maps and Sets
const map1 = new Map([["key", "value"]]);
const map2 = new Map([["key", "value"]]);
deepEqual(map1, map2); // true (compares keys and values)

// Handles Dates
const date1 = new Date("2024-01-01");
const date2 = new Date("2024-01-01");
deepEqual(date1, date2); // true
```

Map keys and Set members are compared by reference, as JavaScript compares them:

```ts
const k1 = { id: 1 };
const k2 = { id: 1 };
deepEqual(new Map([[k1, "value"]]), new Map([[k2, "value"]])); // false
```

## `copyPlainData(value, options?)`

Returns a copy of `value` under the plain-data rule of the kit (see "One rule for plain data" in the design decisions). One walk builds the copy and checks each value as it copies it. A value outside the rule throws a `TypeError` that names the path. `options.subject` replaces `copyPlainData: value` at the start of every message.

- Kept: `string`, `number`, `boolean`, `bigint`, `undefined`, `null`
- Copied: a record whose prototype is `null` or an `Object.prototype` of any realm, an array (holes stay holes), a `Date` of any realm (also a subclass, such as the `Date` of fake timers), a `Map`, and a `Set`
- Throws: a function, a symbol, a class instance (also a subclass of an array, a `Map`, or a `Set`), a `RegExp`, binary data, an `Error`, a `Promise`, a `WeakMap`, a `WeakSet`, a boxed primitive, an accessor, an enumerable symbol-keyed property, a non-enumerable string-keyed property, an object as a `Map` key or a `Set` member, and an own `__proto__` key (`PrototypePollutionError`)
- Left out: a non-enumerable symbol-keyed property

Cycles and shared references survive the copy. The copy holds objects of the local realm only.

```ts
import { deepFreeze, copyPlainData } from '@shirudo/ddd-kit';

class Order extends StateStoredAggregate<OrderState, OrderId> {
  /** An immutable copy of the state. Never the live graph. */
  get plainState(): Readonly<OrderState> {
    return deepFreeze(copyPlainData(this.state, { subject: 'Order state' }));
  }
}

copyPlainData({ review: new OwnerReview() });
// TypeError: copyPlainData: value.review is a class instance (OwnerReview); map it to plain data
```

The event constructors, the value objects, the snapshot model, and the state machine copy their data with the same function. A state that carries a class-based child entity is mapped to plain data first; the error names the field to map.

## Equality with exclusions

`valueObjectEqualsExcept` compares two value objects after it leaves out the keys that its options name. Internally, `deepOmit` removes the keys from both values, and `deepEqual` compares the results.

```ts
import { valueObject, valueObjectEqualsExcept } from '@shirudo/ddd-kit';

const first = valueObject({ name: "Alice", meta: { updatedAt: "2024-01-01" } });
const second = valueObject({ name: "Alice", meta: { updatedAt: "2024-01-02" } });

valueObjectEqualsExcept(first, second, { ignoreKeys: ["updatedAt"] }); // true
```

`deepOmit` treats a built-in as a unit: it removes keys of objects only, never of `Map`, `Set`, or typed-array contents. It keeps the prototype of a class instance and handles circular references.

## See Also

- [deepEqual tests](./deep-equal.test.ts)
- [deepOmit tests](./deep-omit.test.ts)
- [deepEqualExcept tests](./deep-equal-except.test.ts)
- [copyPlainData tests](./plain-data.test.ts)
