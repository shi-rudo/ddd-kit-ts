# Array Utilities

A collection of utility functions for deep comparison and manipulation of arrays and objects.

## Installation

```ts
import { deepEqual, deepOmit, deepEqualExcept } from '@shirudo/ddd-kit/utils/array';
```

## Functions

### `deepEqual(a, b)`

Performs a deep equality check between two values. This function compares values recursively, handling:

- Primitives (with special handling for NaN)
- Arrays (nested arrays supported)
- Objects (plain objects and class instances)
- TypedArrays (Uint8Array, Int32Array, etc.)
- DataView
- Maps and Sets
- Dates and RegExp
- Wrapper objects (Boolean, Number, String)
- Circular references (detected and handled)

#### Example

```ts
import { deepEqual } from '@shirudo/ddd-kit/utils/array';

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

#### Notes

- Map keys are compared by reference (JavaScript semantics)
- Set elements are compared by reference (JavaScript semantics)
- Circular references are detected and handled correctly

---

### `deepOmit(value, options)`

Creates a deep copy of `value` with certain keys removed according to the provided rules.

This function recursively traverses the object tree and removes keys that match the criteria specified in `options`. Built-in types (Date, Map, Set, TypedArrays, etc.) are treated atomically and not modified.

#### Parameters

- `value`: The value to create a deep copy from
- `options`: Options specifying which keys to ignore
  - `ignoreKeys?: readonly Key[]` - Keys to ignore everywhere in the object tree
  - `ignoreKeyPredicate?: (key: Key, path: PathSegment[]) => boolean` - Fine-grained control based on key and path

#### Example

```ts
import { deepOmit } from '@shirudo/ddd-kit/utils/array';

const obj = {
  id: 1,
  name: "Alice",
  password: "secret",
  metadata: {
    createdAt: "2024-01-01",
    updatedAt: "2024-01-02",
    internal: true
  }
};

// Remove specific keys
const result1 = deepOmit(obj, { ignoreKeys: ['password', 'internal'] });
// Result: { id: 1, name: "Alice", metadata: { createdAt: "2024-01-01", updatedAt: "2024-01-02" } }

// Use predicate for fine-grained control
const result2 = deepOmit(obj, {
  ignoreKeyPredicate: (key, path) => {
    // Remove 'updatedAt' only at the root level
    return key === 'updatedAt' && path.length === 0;
  }
});
```

#### Notes

- Only applies to object properties, not Map/Set/TypedArray contents
- Built-in types are treated atomically (not modified)
- Handles circular references correctly
- Preserves object prototypes

---

### `deepEqualExcept(a, b, options)`

Performs a deep equality comparison between two values after omitting specified keys.

This function first removes the specified keys from both values using `deepOmit`, then performs a deep equality check using `deepEqual`.

#### Example

```ts
import { deepEqualExcept } from '@shirudo/ddd-kit/utils/array';

const obj1 = {
  id: 1,
  name: "Alice",
  updatedAt: "2024-01-01"
};

const obj2 = {
  id: 2,
  name: "Alice",
  updatedAt: "2024-01-02"
};

// Compare ignoring 'id' and 'updatedAt'
deepEqualExcept(obj1, obj2, {
  ignoreKeys: ["id", "updatedAt"]
}); // true (only 'name' is compared)

// Use predicate for conditional ignoring
deepEqualExcept(obj1, obj2, {
  ignoreKeyPredicate: (key, path) => {
    // Ignore timestamps in nested objects
    return key === 'updatedAt' || key === 'createdAt';
  }
});
```

#### Use Cases

- Comparing objects while ignoring metadata (timestamps, IDs)
- Testing: comparing expected vs actual while ignoring non-deterministic fields
- Data validation: comparing user input while ignoring system-generated fields

---

### `isBuiltInObject(obj, tag)`

Checks if an object is a built-in JavaScript type that should be treated atomically.

This function uses a multi-layered detection strategy:

1. TypedArrays: Checks if tag ends with "Array]"
2. ArrayBuffer views: Uses `ArrayBuffer.isView()` (covers DataView and all TypedArrays)
3. Built-in constructors: Checks if constructor exists in global scope
4. Tag-based: Fallback to tag matching for known built-ins

#### Example

```ts
import { isBuiltInObject } from '@shirudo/ddd-kit/utils/array';

isBuiltInObject(new Date(), "[object Date]"); // true
isBuiltInObject(new Map(), "[object Map]"); // true
isBuiltInObject(new Uint8Array(), "[object Uint8Array]"); // true
isBuiltInObject({}, "[object Object]"); // false
```

#### Notes

- Useful for determining if an object should be treated atomically
- Exported for advanced use cases

---

## DDD Use Cases

These utilities are particularly useful in Domain-Driven Design contexts for comparing domain objects while ignoring infrastructure concerns.

### Comparing Value Objects

Value Objects should be compared by their attributes, not identity:

```ts
import { deepEqual } from '@shirudo/ddd-kit/utils/array';
import { vo, type ValueObject } from '@shirudo/ddd-kit';

type Money = ValueObject<{
  amount: number;
  currency: string;
}>;

const price1 = vo({ amount: 100, currency: "USD" });
const price2 = vo({ amount: 100, currency: "USD" });

// Compare value objects by their attributes
deepEqual(price1, price2); // true

// Works with nested value objects
type Address = ValueObject<{
  street: string;
  city: string;
  country: string;
}>;

const address1 = vo({
  street: "123 Main St",
  city: "New York",
  country: "USA"
});

const address2 = vo({
  street: "123 Main St",
  city: "New York",
  country: "USA"
});

deepEqual(address1, address2); // true
```

### Comparing Entities (Ignoring Infrastructure Fields)

When comparing entities or aggregates, you often want to ignore infrastructure fields like IDs, versions, timestamps, and metadata:

```ts
import { deepEqualExcept } from '@shirudo/ddd-kit/utils/array';

// Compare entities ignoring ID and version
const entity1 = {
  id: "entity-1",
  version: 1,
  name: "Product A",
  price: 100,
  metadata: {
    createdAt: "2024-01-01",
    updatedAt: "2024-01-02"
  }
};

const entity2 = {
  id: "entity-2", // Different ID
  version: 2,     // Different version
  name: "Product A",
  price: 100,
  metadata: {
    createdAt: "2024-01-01",
    updatedAt: "2024-01-03" // Different timestamp
  }
};

// Compare domain attributes only
deepEqualExcept(entity1, entity2, {
  ignoreKeys: ["id", "version", "createdAt", "updatedAt"]
}); // true (domain attributes match)
```

### Comparing Aggregates

Aggregates contain entities and value objects. Compare them while ignoring infrastructure concerns:

```ts
import { deepEqualExcept } from '@shirudo/ddd-kit/utils/array';

type OrderState = {
  id: OrderId;
  version: number;
  customerId: CustomerId;
  items: OrderItem[];
  total: Money;
  status: "pending" | "confirmed" | "shipped";
  createdAt: Date;
  updatedAt: Date;
};

const order1: OrderState = {
  id: "order-1",
  version: 1,
  customerId: "customer-123",
  items: [
    { id: "item-1", productId: "prod-1", quantity: 2, price: 50 }
  ],
  total: { amount: 100, currency: "USD" },
  status: "pending",
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01")
};

const order2: OrderState = {
  id: "order-2", // Different ID
  version: 5,    // Different version
  customerId: "customer-123",
  items: [
    { id: "item-2", productId: "prod-1", quantity: 2, price: 50 }
  ],
  total: { amount: 100, currency: "USD" },
  status: "pending",
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-05") // Different timestamp
};

// Compare domain state, ignoring infrastructure fields
deepEqualExcept(order1, order2, {
  ignoreKeys: ["id", "version", "createdAt", "updatedAt"],
  ignoreKeyPredicate: (key, path) => {
    // Ignore IDs in nested entities (items)
    return key === "id" && path.includes("items");
  }
}); // true (domain state matches)
```

### Testing Domain Logic

When testing domain logic, compare expected vs actual results while ignoring non-deterministic fields:

```ts
import { deepEqualExcept } from '@shirudo/ddd-kit/utils/array';
import { describe, it, expect } from 'vitest';

describe("Order aggregate", () => {
  it("should calculate total correctly", () => {
    const order = new Order(orderId, initialState);
    order.addItem(productId, quantity);
    
    const expectedState = {
      items: [...],
      total: { amount: 200, currency: "USD" },
      status: "pending"
    };
    
    const actualState = order.getState();
    
    // Compare domain state, ignoring IDs and timestamps
    expect(
      deepEqualExcept(actualState, expectedState, {
        ignoreKeys: ["id", "version", "createdAt", "updatedAt"],
        ignoreKeyPredicate: (key, path) => {
          return key === "id" && path.includes("items");
        }
      })
    ).toBe(true);
  });
});
```

### Comparing Domain Events

Domain events often have metadata that should be ignored when comparing:

```ts
import { deepEqualExcept } from '@shirudo/ddd-kit/utils/array';

type OrderCreatedEvent = {
  type: "OrderCreated";
  payload: {
    orderId: string;
    customerId: string;
    items: OrderItem[];
  };
  timestamp: Date;
  metadata: {
    correlationId: string;
    causationId: string;
    userId: string;
  };
};

const event1: OrderCreatedEvent = {
  type: "OrderCreated",
  payload: { orderId: "order-1", customerId: "customer-1", items: [...] },
  timestamp: new Date("2024-01-01T10:00:00Z"),
  metadata: {
    correlationId: "corr-1",
    causationId: "cause-1",
    userId: "user-1"
  }
};

const event2: OrderCreatedEvent = {
  type: "OrderCreated",
  payload: { orderId: "order-1", customerId: "customer-1", items: [...] },
  timestamp: new Date("2024-01-01T10:00:01Z"), // Different timestamp
  metadata: {
    correlationId: "corr-2", // Different metadata
    causationId: "cause-2",
    userId: "user-2"
  }
};

// Compare event payloads, ignoring metadata and timestamps
deepEqualExcept(event1, event2, {
  ignoreKeys: ["timestamp"],
  ignoreKeyPredicate: (key, path) => {
    return path.includes("metadata");
  }
}); // true (payloads match)
```

### Repository Tests

When testing repositories, compare aggregates while ignoring persistence metadata:

```ts
import { deepEqualExcept } from '@shirudo/ddd-kit/utils/array';

describe("OrderRepository", () => {
  it("should save and load aggregate correctly", async () => {
    const order = new Order(orderId, initialState);
    order.confirm();
    
    await repository.save(order);
    const loaded = await repository.findById(orderId);
    
    // Compare domain state, ignoring version changes from persistence
    expect(
      deepEqualExcept(order.getState(), loaded.getState(), {
        ignoreKeys: ["version", "updatedAt"]
      })
    ).toBe(true);
  });
});
```

### Snapshot Comparison

When comparing aggregate snapshots, ignore snapshot-specific metadata:

```ts
import { deepEqualExcept } from '@shirudo/ddd-kit/utils/array';

type AggregateSnapshot = {
  aggregateId: string;
  version: number;
  state: OrderState;
  snapshotVersion: number;
  createdAt: Date;
};

const snapshot1: AggregateSnapshot = {
  aggregateId: "order-1",
  version: 10,
  state: { /* ... */ },
  snapshotVersion: 1,
  createdAt: new Date("2024-01-01")
};

const snapshot2: AggregateSnapshot = {
  aggregateId: "order-1",
  version: 10,
  state: { /* ... */ },
  snapshotVersion: 2, // Different snapshot version
  createdAt: new Date("2024-01-02") // Different timestamp
};

// Compare aggregate state, ignoring snapshot metadata
deepEqualExcept(snapshot1, snapshot2, {
  ignoreKeys: ["snapshotVersion", "createdAt"]
}); // true if state matches
```

### Specification Pattern Tests

When testing specifications, compare query results while ignoring order or metadata:

```ts
import { deepEqualExcept } from '@shirudo/ddd-kit/utils/array';

describe("ActiveOrdersSpecification", () => {
  it("should return only active orders", async () => {
    const spec = new ActiveOrdersSpecification();
    const results = await repository.find(spec);
    
    const expected = [
      { id: "order-1", status: "pending", /* ... */ },
      { id: "order-2", status: "confirmed", /* ... */ }
    ];
    
    // Compare results, ignoring IDs and order
    results.forEach((result, index) => {
      expect(
        deepEqualExcept(result.getState(), expected[index], {
          ignoreKeys: ["id", "version", "createdAt", "updatedAt"]
        })
      ).toBe(true);
    });
  });
});
```

---

## Type Definitions

### `Key`

```ts
type Key = string | symbol;
```

### `PathSegment`

```ts
type PathSegment = string | number | symbol;
```

### `DeepOmitOptions`

```ts
interface DeepOmitOptions {
  readonly ignoreKeys?: readonly Key[];
  readonly ignoreKeyPredicate?: (key: Key, path: readonly PathSegment[]) => boolean;
}
```

### `DeepEqualExceptOptions`

```ts
type DeepEqualExceptOptions = DeepOmitOptions;
```

---

## Performance Considerations

- `deepEqual`: O(n) where n is the total number of properties/elements
- `deepOmit`: O(n) where n is the total number of properties/elements
- `deepEqualExcept`: O(n) + O(m) where n is the size of first object and m is the size of second object

All functions handle circular references efficiently using `WeakMap`.

---

## Edge Cases

### Circular References

All functions handle circular references correctly:

```ts
const obj: any = { a: 1 };
obj.self = obj;

deepEqual(obj, obj); // true
deepOmit(obj, { ignoreKeys: ['a'] }); // { self: { self: ... } }
```

### NaN Handling

`deepEqual` treats NaN as equal to NaN:

```ts
deepEqual(NaN, NaN); // true
```

### Map and Set Semantics

- Map keys are compared by reference (JavaScript semantics)
- Set elements are compared by reference (JavaScript semantics)

```ts
const k1 = { id: 1 };
const k2 = { id: 1 };
const map1 = new Map([[k1, "value"]]);
const map2 = new Map([[k2, "value"]]);

deepEqual(map1, map2); // false (different key references)
```

---

## See Also

- [deepEqual tests](./deep-equal.test.ts)
- [deepOmit tests](./deep-omit.test.ts)
- [deepEqualExcept tests](./deep-equal-except.test.ts)

