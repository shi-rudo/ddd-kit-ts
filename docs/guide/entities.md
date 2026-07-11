# Entities

An entity is a domain object whose identity matters across time.

If two objects have the same id, they represent the same entity even when their
current state differs. That is the difference from a Value Object: two equal
addresses or two equal money values can be interchangeable; two order items
with the same id are the same line item evolving over time.

The kit has two entity shapes:

- `Entity<TState, TId>` for child entities with state and methods
- `Identifiable<TId>` for plain records that only need an id

Aggregate roots are entities too, but they need versioning, pending events, and
repository lifecycle. Use `AggregateRoot` or `EventSourcedAggregate` for roots.
Use `Entity` or `Identifiable` for children inside an aggregate boundary.

## When an object needs identity

Reach for an entity when the domain needs to track "this same thing" across
state changes.

Good entity candidates:

- an order item that can change quantity but remains the same line item
- a restaurant table that can be reserved, joined, or moved
- a workflow step that can be retried and audited by id

Poor entity candidates:

- a money amount
- an address
- a date range
- a small immutable settings object

Those usually want Value Objects because equality by value is the point.

Inside an aggregate, child entities do not get their own optimistic-concurrency
version. The aggregate root is the consistency boundary, so the root version
moves when the child collection changes. If a child really needs to be loaded,
saved, and versioned independently, you are probably looking at a separate
aggregate.

See [Design Decisions: Version lives on the aggregate boundary](./design-decisions.md#version-lives-on-the-aggregate-boundary-not-on-entities-or-value-objects).

## Class-based child entities

Use `Entity<TState, TId>` when the child has meaningful behavior of its own.
The class owns an id, a frozen state reference, a `validateState` hook, and a
protected `setState(...)` method.

```ts
import {
  DomainError,
  Entity,
  type Id,
} from "@shirudo/ddd-kit";

type ItemId = Id<"ItemId">;

type OrderItemState = {
  productId: string;
  quantity: number;
};

class InvalidOrderItemQuantityError extends DomainError<
  "INVALID_ORDER_ITEM_QUANTITY"
> {
  constructor(quantity: number) {
    super({
      code: "INVALID_ORDER_ITEM_QUANTITY",
      message: `Order item quantity must be positive, got ${quantity}.`,
    });
  }
}

class OrderItem extends Entity<OrderItemState, ItemId> {
  constructor(id: ItemId, productId: string, quantity: number) {
    super(id, { productId, quantity });
  }

  changeQuantity(quantity: number): void {
    this.setState({
      ...this.state,
      quantity,
    });
  }

  get productId(): string {
    return this.state.productId;
  }

  get quantity(): number {
    return this.state.quantity;
  }

  protected override validateState(state: OrderItemState): void {
    if (state.quantity < 1) {
      throw new InvalidOrderItemQuantityError(state.quantity);
    }
  }
}
```

The important details:

- `id` is readonly and cannot be `null` or `undefined`
- `state` is protected; consumers use explicit domain queries
- `setState(...)` validates the next state and only then replaces the old one
- if validation throws, the previous state remains in place
- `validateState(state)` receives the state to check

Prefer `setState(...)` for mutations. `_state` is protected for advanced
subclasses, but direct assignment can skip validation and the configured freeze
mode unless you are careful. If you really need a custom assignment path, pass
the value through `freezeState(...)`.

### Constructor ordering

`validateState` runs from the base `Entity` constructor. In JavaScript and
TypeScript, subclass field initializers have not run yet at that point.

Do not read subclass fields from `validateState`:

```ts
class BadItem extends Entity<{ quantity: number }, ItemId> {
  private readonly minQuantity = 1;

  protected override validateState(state: { quantity: number }): void {
    // Wrong: minQuantity is undefined during the base constructor call.
    if (state.quantity < this.minQuantity) {
      throw new Error("invalid quantity");
    }
  }
}
```

Use the `state` argument as the source of truth. If a rule needs configuration,
put that configuration in state or enforce the additional rule in a named static
factory after construction.

## Plain identifiable records

Use `Identifiable<TId>` when the child only needs an id and data. This is the
cleaner choice for many aggregate child collections.

```ts
import {
  entityIds,
  findEntityById,
  hasEntityId,
  removeEntityById,
  replaceEntityById,
  sameEntity,
  updateEntityById,
  type Id,
  type Identifiable,
} from "@shirudo/ddd-kit";

type ItemId = Id<"ItemId">;

type OrderItem = Identifiable<ItemId> & {
  productId: string;
  quantity: number;
};

const items: readonly OrderItem[] = [
  { id: "item-1" as ItemId, productId: "product-1", quantity: 2 },
  { id: "item-2" as ItemId, productId: "product-2", quantity: 1 },
];

findEntityById(items, "item-1" as ItemId);
hasEntityId(items, "item-1" as ItemId); // true
sameEntity(items[0]!, items[1]!); // false
entityIds(items); // ["item-1", "item-2"]
```

`Identifiable<TId>` is constrained to branded `Id<Tag>` values. A plain string
does not satisfy the type. That keeps a `UserId`, `OrderId`, and `ItemId` from
being mixed accidentally.

All helpers compare by id. They do not compare state:

```ts
sameEntity(
  { id: "item-1" as ItemId, productId: "old", quantity: 1 },
  { id: "item-1" as ItemId, productId: "new", quantity: 99 },
); // true
```

That result is correct. It says "same entity", not "same state".

## Updating child collections

The collection helpers are deliberately small:

| Helper | Behavior |
| --- | --- |
| `findEntityById(items, id)` | returns the matching entity or `undefined` |
| `hasEntityId(items, id)` | returns whether a matching id exists |
| `sameEntity(a, b)` | compares `a.id === b.id` |
| `entityIds(items)` | returns the ids in collection order |
| `removeEntityById(items, id)` | returns a new array without the id, or the original array on a miss |
| `updateEntityById(items, id, fn)` | replaces one entity with `fn(entity)`, or returns the original array when nothing changed |
| `replaceEntityById(items, id, replacement)` | replaces one entity, or returns the original array when nothing changed |

The "original array when nothing changed" behavior is important. The aggregate
dirty tracker uses shallow reference comparison for top-level state keys. A
helper that allocates a new array for a no-op would make repositories write a
child table that did not actually change.

Use the helpers inside aggregate methods, where the domain can decide what a
miss means:

```ts
class OrderItemNotFoundError extends DomainError<"ORDER_ITEM_NOT_FOUND"> {
  constructor(itemId: ItemId) {
    super({
      code: "ORDER_ITEM_NOT_FOUND",
      message: `Order item ${itemId} was not found.`,
    });
  }
}

function changeItemQuantity(
  items: readonly OrderItem[],
  itemId: ItemId,
  quantity: number,
): readonly OrderItem[] {
  let found = false;

  const nextItems = updateEntityById(items, itemId, (item) => {
    found = true;
    if (item.quantity === quantity) return item;
    return { ...item, quantity };
  });

  if (!found) {
    throw new OrderItemNotFoundError(itemId);
  }

  return nextItems;
}
```

Notice the explicit `found` flag. `nextItems === items` can mean "the id was not
found" or "the item was already in the requested state" when the updater returns
the same reference. The aggregate method owns that distinction.

## Class children inside aggregate state

Class-based child entities can be useful, but they need extra care inside an
aggregate.

If a child entity mutates itself and the aggregate state reference does not
change, the root's shallow dirty tracking cannot see the mutation. The helper
contract is reference-based too: an updater that mutates a class instance and
returns that same instance causes `updateEntityById` to return the original
array.

This is not a bug in the helper. It is the price of a cheap, predictable
reference-diff model.

When persistence depends on aggregate dirty tracking, prefer plain
`Identifiable` child records for collections. If you use class-based children,
prefer replacing the child instance by id instead of mutating it in place:

```ts
changeItemQuantity(itemId: ItemId, quantity: number): void {
  const item = findEntityById(this.state.items, itemId);
  if (!item) {
    throw new OrderItemNotFoundError(itemId);
  }

  const replacement = new OrderItem(
    item.id,
    item.productId,
    quantity,
  );

  this.commit({
    ...this.state,
    items: replaceEntityById(this.state.items, itemId, replacement),
  });
}
```

The new array reference tells the root that the child collection changed. The
new child instance avoids another subtle problem: if you mutate the existing
child first and a later aggregate-level validation throws, the child has already
moved. Replacement keeps the old aggregate state intact until `commit(...)`
accepts the new state.

If the aggregate also needs to publish a domain event, pass it to `commit(...)`
in the same call.

The stronger rule is still the DDD rule: outside application code should not
hold and mutate child entity references. The aggregate root is the entry point.

## State encapsulation, freezing, and ownership

`Entity.state` is protected. External code cannot read or mutate the live state
graph; a concrete entity exposes domain queries or a detached read DTO instead.

```ts
class OrderItem extends Entity<OrderItemState, ItemId> {
  get quantity(): number {
    return this.state.quantity;
  }

  changeQuantity(quantity: number): void {
    this.setState({ ...this.state, quantity });
  }
}
```

The internal state is shallowly frozen by default, so direct top-level writes
inside a subclass throw. Nested aliases retained by a constructor caller are not
deeply frozen:

```ts
type BoxState = {
  meta: { label: string };
};

class Box extends Entity<BoxState, ItemId> {
  constructor(id: ItemId, state: BoxState) {
    super(id, state);
  }
}

const meta = { label: "old" };
new Box("item-1" as ItemId, { meta });

meta.label = "new"; // mutates the nested object still owned by the caller
```

For nested data, choose one of these:

- model nested immutable concepts as Value Objects
- replace nested state structurally through `setState(...)`
- enable `deepFreezeState` for plain-data state graphs

```ts
class DeepBox extends Entity<BoxState, ItemId> {
  constructor(id: ItemId, state: BoxState) {
    super(id, state, { deepFreezeState: true });
  }
}
```

Use `deepFreezeState` only for plain data. It walks the whole graph. If your
state contains class-based child entities, those child instances are frozen too
and their mutation methods can start throwing.

The ownership rules are precise:

- plain object and array state is shallow-copied before freezing, so the
  caller's top-level object remains mutable
- nested objects remain shared under the default shallow freeze
- with `deepFreezeState`, nested objects are frozen in place
- class instance state is treated as an ownership transfer and is frozen in
  place because copying it would strip its prototype

The entity constructor and `setState(...)` reject an own `"__proto__"` data key
on plain object, null-prototype object, or array state. Validate and normalize
untrusted JSON at the boundary before it reaches domain objects.

## Choosing the shape

| Use case | Use |
| --- | --- |
| immutable concept compared by value | Value Object |
| child record with id and simple data | `Identifiable<TId>` |
| child object with id, state, and meaningful methods | `Entity<TState, TId>` |
| root of a consistency boundary | `AggregateRoot` |
| root rebuilt from an event stream | `EventSourcedAggregate` |

Review signals:

- If a child entity has its own repository, it may be an aggregate root.
- If a child needs its own version, it may be an aggregate root.
- If two values are interchangeable when their fields match, they are probably
  Value Objects, not entities.
- If code compares entity state to decide identity, it is using the wrong
  equality model.
- If external code mutates child entities directly, the aggregate boundary is
  leaking.
