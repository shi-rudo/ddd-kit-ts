# ❓ Why There Is No `Entity` Interface

This toolkit intentionally does **not** define or require a generic `Entity<T>` interface like:

```ts
interface Entity<T> {
  id: T;
}
````

### 🔍 Reason 1: Aggregates Already Cover Entity Semantics

In DDD, the **aggregate root** is the entry point for modifying an entity.
You always work with aggregates in application code — never directly with nested entities.

Thus, aggregate modeling in this toolkit **already implies identity and versioning**, making a separate `Entity` interface redundant.

---

### 🪓 Reason 2: Avoid Inheritance and Marker Interfaces

Inheritance-based designs like `BaseEntity` or marker interfaces (`interface Entity`) often lead to:

* unnecessary abstraction,
* rigid class hierarchies,
* and tight coupling to infrastructure.

This toolkit prefers **composition and pure functions**, which lead to simpler, more flexible models.

---

### 🧠 Reason 3: Behavior, Not Identity, Is What Matters

A real entity is not defined by the presence of an `id` field — it's defined by:

* **lifespan**, and
* **behavioral rules**

These are better expressed through domain logic than via a generic interface.

```ts
function publishJob(job: Job): Result<Job, string> {
  if (job.state.isPublished) return err("already published");
  // domain event, state transition
}
```

No interface needed — the domain behavior speaks for itself.

---

### 🧪 Reason 4: No Practical Need for Polymorphism

In practice, you rarely need to treat different domain entities polymorphically.

This would only make sense in overly generic utilities like:

```ts
function logEntity<T>(e: Entity<T>) {
  console.log("id:", e.id);
}
```

Such utilities tend to work **against DDD's core principle**: focus on specific, meaningful domain types.

---

### ✅ You Still Can Add One (If You Really Need It)

If your domain requires equality checks or reusable logic across multiple nested entities, you can define a minimal helper yourself:

```ts
export interface Entity<TId> {
  id: TId;
}

export function sameEntity<T>(a: Entity<T>, b: Entity<T>) {
  return a.id === b.id;
}
```

But we do **not** impose that pattern at the core of this toolkit, because it's **not needed in most tactical DDD designs**.

---

### ✅ Summary

| Principle                          | Implementation in this toolkit       |
| ---------------------------------- | ------------------------------------ |
| Entities are defined by identity   | Handled by aggregate state           |
| Identity is domain-specific        | Typed IDs (e.g. `Id<"User">`)        |
| Behavior is more important than ID | Expressed in pure functions          |
| Avoid inheritance in domain models | No `extends Entity`, no base classes |
| Keep code explicit and testable    | Use small, local types and logic     |

In short: **if your aggregate works, you don't need an `Entity` interface**.
