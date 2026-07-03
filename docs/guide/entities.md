# Entities

In DDD, Entities are objects with identity and state. Unlike Value Objects (compared by value), Entities are compared by identity (`id`). The kit ships **two shapes**: a class-based `Entity<TState, TId>` for behaviour-rich child entities and a functional `Identifiable<TId>` interface for simple records.

## Class-based: `Entity<TState, TId>`

Use this for child entities inside an aggregate that have their own state and business methods. An `Entity` has identity and state but **no own `version`**: optimistic-concurrency versioning lives on the aggregate root; see [Version lives on the aggregate boundary](./design-decisions.md#version-lives-on-the-aggregate-boundary-not-on-entities-or-value-objects) for why, and what to do if you think you need a versioned child.

```ts
import { Entity, type Id } from "@shirudo/ddd-kit";

type ItemId = Id<"ItemId">;

type OrderItemState = {
  productId: string;
  quantity: number;
  unitPriceCents: number;
};

class OrderItem extends Entity<OrderItemState, ItemId> {
  constructor(id: ItemId, productId: string, quantity: number, unitPriceCents: number) {
    super(id, { productId, quantity, unitPriceCents });
  }

  protected validateState(state: OrderItemState): void {
    if (state.quantity <= 0) throw new Error("quantity must be > 0");
    if (state.unitPriceCents < 0) throw new Error("price must be non-negative");
  }

  updateQuantity(qty: number): void {
    this.setState({ ...this.state, quantity: qty });
  }

  subtotalCents(): number {
    return this.state.quantity * this.state.unitPriceCents;
  }
}
```

`Entity` gives you:

- A `readonly id`, with null/undefined rejected at construction
- A `state` getter that is **shallowly frozen** by default (direct property writes throw; nested writes bypass the freeze)
- An opt-in **deep freeze** via `super(id, state, { deepFreezeState: true })`, so nested outside writes throw too; only for plain-data states (class-based child entities would be frozen along with the graph), and nested objects passed in become frozen in place (ownership transfer)
- A `protected setState(newState)` that runs `validateState` then re-freezes
- A `validateState(state)` hook for invariant checks

::: warning Constructor-ordering
`validateState` is called from `Entity`'s constructor before the subclass's field initializers run. Don't reach into `this.someField` from `validateState`; use only the `state` argument. See [Design Decisions](./design-decisions.md#no-deep-clone-on-every-state-read) for the freeze caveats.
:::

## Functional: `Identifiable<TId>`

For simple records that only need an id:

```ts
import type { Identifiable, Id } from "@shirudo/ddd-kit";
import {
  sameEntity,
  findEntityById,
  hasEntityId,
  removeEntityById,
  updateEntityById,
  replaceEntityById,
  entityIds,
} from "@shirudo/ddd-kit";

type ItemId = Id<"ItemId">;

type OrderItem = Identifiable<ItemId> & {
  productId: string;
  quantity: number;
};

const items: OrderItem[] = [
  { id: "i-1" as ItemId, productId: "p-1", quantity: 2 },
  { id: "i-2" as ItemId, productId: "p-2", quantity: 1 },
];

findEntityById(items, "i-1" as ItemId); // ...
hasEntityId(items, "i-1" as ItemId);    // true
sameEntity(items[0]!, items[1]!);       // false (compared by id)
```

All helpers compare by **branded id equality** (`a.id === b.id`), never deep equality. `Identifiable<TId extends Id<string>>` is constrained to branded ids, so plain strings are rejected at compile time (the brand discipline is uniform across `IAggregateRoot`, `IEntity`, and `Identifiable`).

## When to reach for which

| Use case | Reach for |
|---|---|
| Child entity inside an aggregate with methods | `Entity<TState, TId>` |
| Plain record with id, no behaviour | `Identifiable<TId>` |
| Root entity of an aggregate | `AggregateRoot` (see next page) |
| Event-sourced root entity | `EventSourcedAggregate` |
