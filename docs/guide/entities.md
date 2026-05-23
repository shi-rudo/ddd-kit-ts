# Entities

In DDD, Entities are objects with identity and state. Unlike Value Objects (compared by value), Entities are compared by identity (`id`). The kit ships **two shapes**: a class-based `Entity<TState, TId>` for behaviour-rich child entities and a functional `Identifiable<TId>` interface for simple records.

## Class-based: `Entity<TState, TId>`

Use this for child entities inside an aggregate that have their own state and business methods.

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

- A `readonly id` — null/undefined is rejected at construction
- A `state` getter — **shallowly frozen** (direct property writes throw)
- A `protected setState(newState)` — runs `validateState` then re-freezes
- A `validateState(state)` hook for invariant checks

::: warning Constructor-ordering
`validateState` is called from `Entity`'s constructor before the subclass's field initializers run. Don't reach into `this.someField` from `validateState` — use only the `state` argument. See [Design Decisions](./design-decisions.md#no-deep-clone-on-every-state-read) for the freeze caveats.
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

All helpers compare by **branded id equality** (`a.id === b.id`) — no deep equality. `Identifiable<TId extends Id<string>>` is constrained to branded ids, so plain strings are rejected at compile time (the brand discipline is uniform across `IAggregateRoot`, `IEntity`, and `Identifiable`).

## When to reach for which

| Use case | Reach for |
|---|---|
| Child entity inside an aggregate with methods | `Entity<TState, TId>` |
| Plain record with id, no behaviour | `Identifiable<TId>` |
| Root entity of an aggregate | `AggregateRoot` (see next page) |
| Event-sourced root entity | `EventSourcedAggregate` |
