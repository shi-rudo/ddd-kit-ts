# @shirudo/ddd-kit

Composable TypeScript toolkit for tactical Domain-Driven Design.

## Badges

![npm version](https://img.shields.io/npm/v/@shirudo/ddd-kit)
![license](https://img.shields.io/npm/l/@shirudo/ddd-kit)

## Features

- **Value Objects** - Immutable objects defined by their attributes, ensuring data integrity
- **Entities** - Optional interface and helpers for entities with identity, useful for nested entities within aggregates
- **Aggregates** - Event-sourced aggregates with versioning for optimistic concurrency control
- **Domain Events** - Type-safe domain events with versioning and metadata for schema evolution and traceability
- **Repositories** - Persistence abstraction layer for aggregates with specification pattern support
- **Specifications** - Reusable query specifications for complex domain queries
- **Unit of Work** - Transaction management for maintaining consistency across operations
- **Result Type** - Functional error handling with `Result<T, E>` type for explicit success/failure states

## Installation

Install the package using npm:

```bash
npm install @shirudo/ddd-kit
```

Or using pnpm:

```bash
pnpm add @shirudo/ddd-kit
```

## Quick Start

Here's a minimal example showing how to create and use a Value Object:

```typescript
import { vo, type ValueObject } from "@shirudo/ddd-kit";

type EmailAddress = ValueObject<{
  value: string;
}>;

function createEmail(value: string): EmailAddress {
  if (!value.includes("@")) {
    throw new Error("Invalid email address");
  }
  return vo({ value });
}

const email = createEmail("user@example.com");
// email.value is readonly and immutable
```

## Core Concepts

### Value Objects

Value Objects are immutable objects that are defined by their attributes rather than identity. They ensure data integrity by preventing modification after creation. Use the `vo()` helper function to create deeply frozen value objects that cannot be mutated, even nested objects and arrays. The library provides `voEquals()` for value-based equality comparison, `voWithValidation()` for creating validated value objects (returns Result), and `voWithValidationUnsafe()` for the exception-throwing variant.

### Entities

In Domain-Driven Design, there are two types of entities:

1. **Aggregate Root Entity**: The parent Entity of an aggregate.
   - Has identity (id) and version for optimistic concurrency control
   - Represents the aggregate externally
   - Loaded/saved through repositories
   - Created by extending `AggregateBase` or `AggregateEventSourced`
   - Implements `AggregateRoot<TId>`

2. **Child Entities**: Entities within an aggregate.
   - Have identity (id), but no own version
   - Exist only within the aggregate boundary
   - Versioned through the Aggregate Root
   - Cannot be referenced directly from outside the aggregate
   - Use the `Entity<TId>` interface for type safety

The `Entity<TId>` interface is used for child entities within aggregates. Helper functions like `sameEntity()`, `findEntityById()`, `hasEntityId()`, `updateEntityById()`, and `removeEntityById()` provide utilities for working with child entity collections.

### Aggregates

Aggregates are clusters of entities and value objects that form a consistency boundary. An aggregate consists of:

- **One Aggregate Root** (Entity with id + version)
- **Optional child entities** (Entities with id, but no own version)
- **Optional value objects** (immutable objects)

The Aggregate Root is an Entity (the parent Entity of the aggregate) that represents the aggregate externally. All changes to child entities are versioned through the Aggregate Root. The version applies to the entire aggregate, including all child entities.

The library provides:

- **`AggregateRoot<TId>`** - Marker interface for Aggregate Root Entities. The Aggregate Root is an Entity with identity (id) and version for optimistic concurrency control. It represents the aggregate externally and is the only object that can be loaded/saved through repositories.

- **`AggregateBase<TState, TId>`** - Base class for creating Aggregate Root Entities without Event Sourcing. Implements `AggregateRoot<TId>`. The aggregate state (`TState`) contains child entities and value objects. Provides ID and version management, state management, and snapshot support. Use this when you don't need Event Sourcing but still want aggregate patterns with versioning and state management.

- **`AggregateEventSourced<TState, TEvent, TId>`** - Base class for Event-Sourced Aggregate Root Entities. Extends `AggregateBase` (and thus implements `AggregateRoot<TId>`). Adds event tracking, event handlers, event validation, and history replay capabilities. Use this when you want full Event Sourcing with event tracking and replay.

Both classes support automatic versioning (configurable), snapshot creation/restoration, and optimistic concurrency control. The version applies to the entire aggregate, including all child entities.

### CQRS (Command Query Responsibility Segregation)

CQRS separates read operations (Queries) from write operations (Commands), providing clear patterns for handling different types of operations. Commands change system state and return `Result` for error handling, while Queries read data and return results directly. The library provides optional Command and Query Buses for centralized handler registration and execution.

### Domain Events

Domain Events represent something meaningful that happened in your domain. They are immutable records with a type, payload, timestamp, optional version for schema evolution, and metadata for traceability. Events support versioning for handling schema changes over time and include metadata fields like `correlationId`, `causationId`, `userId`, and `source` for tracking event flow in distributed systems. Events are automatically tracked by aggregates and can be published to event buses or stored in outboxes for eventual consistency.

### Repositories

Repositories abstract the persistence layer, allowing you to work with aggregates without dealing with database specifics. They support finding aggregates by ID, using specifications for complex queries, and saving/deleting aggregates while maintaining transactional boundaries.

### Specifications

Specifications encapsulate business rules for queries in a reusable, composable way. They provide a domain-centric approach to querying that separates business logic from data access implementation details.

### Result Type

The `Result<T, E>` type provides functional error handling without exceptions. It explicitly represents success (`Ok<T>`) or failure (`Err<E>`) states, making error handling predictable and type-safe throughout your domain logic.

## Usage Examples

### Creating a Value Object

```typescript
import { vo, voEquals, voWithValidation, type ValueObject } from "@shirudo/ddd-kit";

// Simple value object
type Money = ValueObject<{
  amount: number;
  currency: string;
}>;

const price = vo({ amount: 99.99, currency: "USD" });
// price is deeply immutable - nested objects and arrays are also frozen

// Value object with validation (returns Result)
const result = voWithValidation(
  { amount: 100, currency: "USD" },
  (m) => m.amount >= 0 && m.currency.length === 3,
  "Amount must be non-negative and currency must be 3 characters"
);

if (result.ok) {
  const validMoney = result.value;
  // Use validMoney...
} else {
  console.error(result.error);
}

// Or use unsafe variant (throws exception)
const validMoneyUnsafe = voWithValidationUnsafe(
  { amount: 100, currency: "USD" },
  (m) => m.amount >= 0 && m.currency.length === 3,
  "Amount must be non-negative and currency must be 3 characters"
);

// Value object with nested structures (deep freeze)
const address = vo({
  street: "Main St",
  city: "Berlin",
  coordinates: { lat: 52.5, lng: 13.4 }
});
// address.coordinates.lat = 99; // ❌ Error: Cannot assign to read-only property

// Equality comparison
const money1 = vo({ amount: 100, currency: "USD" });
const money2 = vo({ amount: 100, currency: "USD" });
voEquals(money1, money2); // true (value equality, not reference)
```

### Creating an Aggregate WITHOUT Event Sourcing

```typescript
import {
  AggregateBase,
  type AggregateRoot,
  type Id,
} from "@shirudo/ddd-kit";

type OrderId = Id<"OrderId">;

type OrderState = {
  id: OrderId;
  customerId: string;
  items: Array<{ productId: string; quantity: number; price: number }>;
  total: number;
  status: "pending" | "confirmed" | "shipped";
};

class Order extends AggregateBase<OrderState, OrderId> implements AggregateRoot<OrderId> {
  static create(id: OrderId, customerId: string): Order {
    const initialState: OrderState = {
      id,
      customerId,
      items: [],
      total: 0,
      status: "pending",
    };
    return new Order(id, initialState);
  }

  addItem(productId: string, quantity: number, price: number): void {
    if (this._state.status !== "pending") {
      throw new Error("Cannot add items to a non-pending order");
    }

    this._state = {
      ...this._state,
      items: [...this._state.items, { productId, quantity, price }],
      total: this._state.total + quantity * price,
    };
    this.bumpVersion(); // Manual version bump for optimistic concurrency control
  }

  confirm(): void {
    if (this._state.status !== "pending") {
      throw new Error("Only pending orders can be confirmed");
    }
    this._state = { ...this._state, status: "confirmed" };
    this.bumpVersion();
  }

  ship(): void {
    if (this._state.status !== "confirmed") {
      throw new Error("Only confirmed orders can be shipped");
    }
    this._state = { ...this._state, status: "shipped" };
    this.bumpVersion();
  }
}

// Usage
const order = Order.create("order-123" as OrderId, "customer-456");
order.addItem("product-1", 2, 10.0);
order.confirm();
order.ship();

console.log(order.version); // 3 (manually bumped)
console.log(order.state.status); // "shipped"
```

### Creating an Aggregate WITH Event Sourcing

```typescript
import {
  AggregateEventSourced,
  createDomainEvent,
  type AggregateRoot,
  type Id,
  type DomainEvent,
} from "@shirudo/ddd-kit";

type OrderId = Id<"OrderId">;

type OrderState = {
  id: OrderId;
  customerId: string;
  items: string[];
  status: "pending" | "confirmed" | "shipped";
};

type OrderCreated = DomainEvent<"OrderCreated", { customerId: string }>;
type OrderConfirmed = DomainEvent<"OrderConfirmed", {}>;
type OrderShipped = DomainEvent<"OrderShipped", { trackingNumber: string }>;

type OrderEvent = OrderCreated | OrderConfirmed | OrderShipped;

class Order extends AggregateEventSourced<OrderState, OrderEvent, OrderId> implements AggregateRoot<OrderId> {
  static create(id: OrderId, customerId: string): Order {
    const initialState: OrderState = {
      id,
      customerId,
      items: [],
      status: "pending",
    };
    const order = new Order(id, initialState);
    order.apply(
      createDomainEvent("OrderCreated", { customerId }) as OrderCreated
    );
    return order;
  }

  confirm(): void {
    const result = this.apply(
      createDomainEvent("OrderConfirmed", {}) as OrderConfirmed
    );
    if (!result.ok) {
      throw new Error(result.error);
    }
  }

  ship(trackingNumber: string): void {
    const result = this.apply(
      createDomainEvent("OrderShipped", { trackingNumber }) as OrderShipped
    );
    if (!result.ok) {
      throw new Error(result.error);
    }
  }

  // Or use unsafe variant (throws exception directly)
  confirmUnsafe(): void {
    this.applyUnsafe(
      createDomainEvent("OrderConfirmed", {}) as OrderConfirmed
    );
  }

  protected readonly handlers = {
    OrderCreated: (state: OrderState, event: OrderCreated): OrderState => ({
      ...state,
      customerId: event.payload.customerId,
      status: "pending",
    }),
    OrderConfirmed: (state: OrderState): OrderState => ({
      ...state,
      status: "confirmed",
    }),
    OrderShipped: (state: OrderState, event: OrderShipped): OrderState => ({
      ...state,
      status: "shipped",
    }),
  };
}

// Usage
const orderId = "order-123" as OrderId;
const order = Order.create(orderId, "customer-456");
order.confirm();
order.ship("TRACK-789");

// Access pending events
console.log(order.pendingEvents); // Array of events not yet persisted

// Helper methods
console.log(order.hasPendingEvents()); // true
console.log(order.getEventCount()); // 3
console.log(order.getLatestEvent()?.type); // "OrderShipped"
console.log(order.version); // 3 (automatically bumped)
```

### Aggregate Features: Snapshots and Configuration

```typescript
import {
  AggregateBase,
  AggregateEventSourced,
  sameAggregate,
  type Id,
} from "@shirudo/ddd-kit";

type OrderId = Id<"OrderId">;
type OrderState = { id: OrderId; status: "pending" | "confirmed" | "shipped" };

// Snapshots work with both aggregate types
const order = Order.create("order-123" as OrderId, "customer-456");
order.confirm();

const snapshot = order.createSnapshot();
// Save snapshot to database...

// Later: restore from snapshot (without events)
const restoredOrder = Order.create("order-123" as OrderId, "customer-456");
restoredOrder.restoreFromSnapshot(snapshot);

// For Event-Sourced aggregates: restore with events after snapshot
const eventSourcedOrder = EventSourcedOrder.create("order-123" as OrderId, "customer-456");
const eventsAfterSnapshot = [/* events that occurred after snapshot */];
eventSourcedOrder.restoreFromSnapshotWithEvents(snapshot, eventsAfterSnapshot);

// Aggregate equality check
const order1 = await repository.getById(id);
// ... some operations ...
const order2 = await repository.getById(id);
if (!sameAggregate(order1, order2)) {
  throw new Error("Aggregate was modified by another process");
}
```

### Event Validation (Event-Sourced Aggregates Only)

```typescript
import {
  AggregateEventSourced,
  createDomainEvent,
  err,
  ok,
  type AggregateRoot,
  type Id,
  type DomainEvent,
  type Result,
} from "@shirudo/ddd-kit";

type OrderId = Id<"OrderId">;
type OrderState = { id: OrderId; status: "pending" | "confirmed" | "shipped" };
type OrderShipped = DomainEvent<"OrderShipped", { trackingNumber: string }>;
type OrderEvent = OrderShipped;

class Order extends AggregateEventSourced<OrderState, OrderEvent, OrderId> implements AggregateRoot<OrderId> {
  // Event validation
  protected validateEvent(event: OrderEvent): Result<true, string> {
    if (event.type === "OrderShipped" && this.state.status !== "confirmed") {
      return err("Order must be confirmed before shipping");
    }
    return ok(true);
  }

  ship(trackingNumber: string): void {
    this.apply(
      createDomainEvent("OrderShipped", { trackingNumber }) as OrderShipped
    );
  }

  protected readonly handlers = {
    OrderShipped: (state: OrderState, event: OrderShipped): OrderState => ({
      ...state,
      status: "shipped",
    }),
  };
}
```

### Using CQRS: Commands and Queries

#### Commands (Write Operations)

Commands represent write operations that change system state. They return `Result` for explicit error handling.

```typescript
import {
  Command,
  CommandHandler,
  CommandBus,
  ok,
  err,
  type Result,
} from "@shirudo/ddd-kit";

// Define a command
type CreateOrderCommand = Command & {
  type: "CreateOrder";
  customerId: string;
  items: Array<{ productId: string; quantity: number }>;
};

// Create a command handler
const createOrderHandler: CommandHandler<CreateOrderCommand, string> = async (
  cmd
) => {
  // Validate input
  if (cmd.items.length === 0) {
    return err("Order must have at least one item");
  }

  // Perform business logic
  const order = Order.create(cmd.customerId, cmd.items);
  await repository.save(order);

  return ok(order.id);
};

// Use directly
const result = await createOrderHandler({
  type: "CreateOrder",
  customerId: "customer-123",
  items: [{ productId: "product-1", quantity: 2 }],
});

if (result.ok) {
  console.log("Order created:", result.value);
} else {
  console.error("Error:", result.error);
}

// Or use with Command Bus (basic in-memory implementation)
// Note: For production, consider using external buses (RabbitMQ, AWS SQS) with typed handlers
const commandBus = new CommandBus();
commandBus.register("CreateOrder", createOrderHandler);

const busResult = await commandBus.execute({
  type: "CreateOrder",
  customerId: "customer-123",
  items: [{ productId: "product-1", quantity: 2 }],
});
```

#### Queries (Read Operations)

Queries represent read operations that don't change system state. They return data directly.

```typescript
import {
  Query,
  QueryHandler,
  QueryBus,
} from "@shirudo/ddd-kit";

// Define a query
type GetOrderQuery = Query & {
  type: "GetOrder";
  orderId: string;
};

// Create a query handler
const getOrderHandler: QueryHandler<GetOrderQuery, Order | null> = async (
  query
) => {
  return await repository.getById(query.orderId);
};

// Use directly
const order = await getOrderHandler({
  type: "GetOrder",
  orderId: "order-123",
});

// Or use with Query Bus (basic in-memory implementation)
// Note: For production, consider using external buses (RabbitMQ, AWS SQS) with typed handlers
const queryBus = new QueryBus();
queryBus.register("GetOrder", getOrderHandler);

// Safe variant (returns Result)
const result = await queryBus.execute({
  type: "GetOrder",
  orderId: "order-123",
});

if (result.ok) {
  const orderFromBus = result.value;
  // Use orderFromBus...
} else {
  console.error(result.error);
}

// Or use unsafe variant (throws exception)
const orderFromBusUnsafe = await queryBus.executeUnsafe({
  type: "GetOrder",
  orderId: "order-123",
});
```

#### Combining Commands with Transactions

```typescript
import { withCommit } from "@shirudo/ddd-kit";

const createOrderHandler: CommandHandler<CreateOrderCommand, string> = async (
  cmd
) => {
  return await withCommit(
    { outbox, bus, uow },
    async () => {
      const order = Order.create(cmd.customerId, cmd.items);
      await repository.save(order);

      return {
        result: order.id,
        events: order.pendingEvents,
      };
    }
  );
};
```

#### Using Commands/Queries with External Frameworks

The `Command` and `Query` interfaces, along with `CommandHandler` and `QueryHandler` types, can be used as type markers even when using external frameworks like RabbitMQ, AWS SQS, or Kafka. This ensures type safety across different bus implementations.

**Important:** The included `CommandBus` and `QueryBus` are basic in-memory implementations suitable for development and simple use cases. For production environments, use external production-grade message buses (RabbitMQ, AWS SQS, Kafka, etc.) with typed handlers to get features like:
- Middleware/Pipeline support (logging, validation, authorization)
- Error handling and retry logic
- Timeout handling
- Metrics and observability
- Dead letter queues
- Transaction management

```typescript
import {
  Command,
  CommandHandler,
  Query,
  QueryHandler,
  ok,
  type Result,
} from "@shirudo/ddd-kit";

// Define commands/queries using marker interfaces
type CreateOrderCommand = Command & {
  type: "CreateOrder";
  customerId: string;
  items: OrderItem[];
};

type GetOrderQuery = Query & {
  type: "GetOrder";
  orderId: OrderId;
};

// Handler typed with CommandHandler for type safety
const createOrderHandler: CommandHandler<CreateOrderCommand, OrderId> = async (
  cmd
) => {
  const order = Order.create(cmd.customerId, cmd.items);
  await repository.save(order);
  return ok(order.id);
};

// Handler typed with QueryHandler for type safety
const getOrderHandler: QueryHandler<GetOrderQuery, Order | null> = async (
  query
) => {
  return await repository.getById(query.orderId);
};

// Use with RabbitMQ (or any external framework)
import amqp from "amqplib";

const connection = await amqp.connect("amqp://localhost");
const channel = await connection.createChannel();

// Command handler for RabbitMQ
channel.consume("order.commands", async (message) => {
  if (!message) return;

  const command = JSON.parse(message.content.toString()) as CreateOrderCommand;
  const result = await createOrderHandler(command);

  if (result.ok) {
    channel.ack(message);
  } else {
    channel.nack(message, false, true); // Requeue on error
  }
});

// Query handler for RabbitMQ
channel.consume("order.queries", async (message) => {
  if (!message) return;

  const query = JSON.parse(message.content.toString()) as GetOrderQuery;
  const result = await getOrderHandler(query);

  channel.sendToQueue(
    message.properties.replyTo,
    Buffer.from(JSON.stringify(result)),
    { correlationId: message.properties.correlationId }
  );
  channel.ack(message);
});

// Same handlers work with AWS SQS, Kafka, etc.
```

### Using Event Bus for Event Handling

The Event Bus provides a pub/sub pattern for handling domain events. Multiple handlers can subscribe to the same event type.

```typescript
import {
  EventBusImpl,
  createDomainEvent,
  type DomainEvent,
} from "@shirudo/ddd-kit";

type OrderCreated = DomainEvent<"OrderCreated", { orderId: string; customerId: string }>;
type OrderEvent = OrderCreated;

// Create event bus
const eventBus = new EventBusImpl<OrderEvent>();

// Subscribe handlers to events
eventBus.subscribe("OrderCreated", async (event) => {
  await sendEmail(event.payload.customerId);
});

eventBus.subscribe("OrderCreated", async (event) => {
  await logEvent(event);
});

// Unsubscribe if needed
const unsubscribe = eventBus.subscribe("OrderCreated", async (event) => {
  console.log("Order created:", event.payload.orderId);
});
// Later: unsubscribe();

// Publish events (all subscribed handlers will be called)
const orderCreated = createDomainEvent("OrderCreated", {
  orderId: "order-123",
  customerId: "customer-456",
}) as OrderCreated;

await eventBus.publish([orderCreated]);
// Both email and logging handlers will be called
```

### Creating Events with Metadata for Traceability

```typescript
import {
  createDomainEventWithMetadata,
  copyMetadata,
  type EventMetadata,
} from "@shirudo/ddd-kit";

// Create event with metadata for distributed tracing
const orderCreated = createDomainEventWithMetadata(
  "OrderCreated",
  { orderId: "123", customerId: "cust-456" },
  {
    correlationId: "corr-123",      // Trace across services
    causationId: "cmd-456",          // Parent command/event
    userId: "user-789",              // Who triggered it
    source: "order-service",         // Service name
  }
);

// Create follow-up event maintaining correlation chain
const orderShipped = createDomainEventWithMetadata(
  "OrderShipped",
  { orderId: "123", trackingNumber: "TRACK-789" },
  copyMetadata(orderCreated, {
    causationId: orderCreated.type,   // New causation
  })
);

// Events support versioning for schema evolution
const eventV1 = createDomainEvent("OrderCreated", { orderId: "123" }, {
  version: 1,
});

const eventV2 = createDomainEvent(
  "OrderCreated",
  { orderId: "123", customerId: "cust-456" }, // Additional field
  { version: 2 }
);
```

### Working with Child Entities

An Aggregate Root Entity can contain multiple child entities. Child entities have identity (id) but no own version - they are versioned through the Aggregate Root.

```typescript
import {
  AggregateBase,
  Entity,
  findEntityById,
  hasEntityId,
  removeEntityById,
  updateEntityById,
  sameEntity,
  type AggregateRoot,
  type Id,
} from "@shirudo/ddd-kit";

type OrderId = Id<"OrderId">;
type ItemId = Id<"ItemId">;

// Child Entity within the aggregate (has id, but no own version)
type OrderItem = Entity<ItemId> & {
  productId: string;
  quantity: number;
  price: number;
};

// Aggregate state contains child entities
type OrderState = {
  id: OrderId;
  customerId: string;
  items: OrderItem[]; // Child entities
  total: number;
};

// Order is the Aggregate Root (an Entity with id + version)
class Order extends AggregateBase<OrderState, OrderId> 
  implements AggregateRoot<OrderId> {
  static create(id: OrderId, customerId: string): Order {
    const initialState: OrderState = {
      id,
      customerId,
      items: [], // Child entities
      total: 0,
    };
    return new Order(id, initialState);
  }

  // Operations on child entities are versioned through the Aggregate Root
  addItem(productId: string, quantity: number, price: number): ItemId {
    const itemId = `item-${Date.now()}` as ItemId;
    const item: OrderItem = {
      id: itemId,
      productId,
      quantity,
      price,
    };

    this._state = {
      ...this._state,
      items: [...this._state.items, item],
      total: this._state.total + price * quantity,
    };
    this.bumpVersion(); // Versions the entire aggregate (including child entities)
    return itemId;
  }

  updateItemQuantity(itemId: ItemId, newQuantity: number): void {
    const item = findEntityById(this._state.items, itemId);
    if (!item) {
      throw new Error("Item not found");
    }

    this._state = {
      ...this._state,
      items: updateEntityById(
        this._state.items,
        itemId,
        (i) => ({ ...i, quantity: newQuantity })
      ),
      total: this._state.total - item.price * item.quantity + item.price * newQuantity,
    };
    this.bumpVersion(); // Versions the entire aggregate
  }

  removeItem(itemId: ItemId): void {
    const item = findEntityById(this._state.items, itemId);
    if (!item) {
      throw new Error("Item not found");
    }

    this._state = {
      ...this._state,
      items: removeEntityById(this._state.items, itemId),
      total: this._state.total - item.price * item.quantity,
    };
    this.bumpVersion(); // Versions the entire aggregate
  }

  getItem(itemId: ItemId): OrderItem | undefined {
    return findEntityById(this._state.items, itemId);
  }
}

// Usage
const order = Order.create("order-123" as OrderId, "customer-456");
const itemId = order.addItem("product-1", 2, 10.0); // Adds child entity
order.updateItemQuantity(itemId, 3); // Updates child entity
order.removeItem(itemId); // Removes child entity

// All changes version the Aggregate Root (order.version increments)
console.log(order.version); // 3 (one for each operation)
```

### Using Result Type for Error Handling

```typescript
import { ok, err, isOk, isErr, type Result, guard } from "@shirudo/ddd-kit";

type UserId = string;

function validateUserId(id: string): Result<UserId, string> {
  const validation = guard(id.length > 0, "User ID cannot be empty");
  if (isErr(validation)) {
    return err(validation.error);
  }
  return ok(id as UserId);
}

function createUser(id: string): Result<{ id: UserId; name: string }, string> {
  const userIdResult = validateUserId(id);
  if (isErr(userIdResult)) {
    return err(userIdResult.error);
  }

  return ok({
    id: userIdResult.value,
    name: "John Doe",
  });
}

// Usage with type guards (recommended)
const result = createUser("user-123");
if (isOk(result)) {
  console.log("User created:", result.value); // TypeScript knows result is Ok
} else {
  console.error("Error:", result.error); // TypeScript knows result is Err
}

// Usage with ok property (also works)
const result2 = createUser("user-123");
if (result2.ok) {
  console.log("User created:", result2.value);
} else {
  console.error("Error:", result2.error);
}
```

## API Documentation

This package is written in TypeScript and provides full type definitions. All types and functions are exported from the main entry point. You can explore the available APIs through your IDE's autocomplete or by examining the type definitions in `node_modules/@shirudo/ddd-kit/dist/index.d.ts`.

Key exports include:
- `vo()`, `voEquals()`, `voWithValidation()`, `voWithValidationUnsafe()` - Value Object utilities
- `AggregateRoot<TId>` - Marker interface for Aggregate Root Entities
- `AggregateBase<TState, TId>` - Base class for creating Aggregate Root Entities without Event Sourcing (implements `AggregateRoot<TId>`)
- `AggregateEventSourced<TState, TEvent, TId>` - Base class for Event-Sourced Aggregate Root Entities (extends `AggregateBase`, implements `AggregateRoot<TId>`)
- `AggregateConfig`, `AggregateEventSourcedConfig` - Configuration interfaces
- `AggregateSnapshot<TState>` - Snapshot interface for performance optimization
- `sameAggregate()` - Aggregate equality helper
- `Entity<TId>` - Optional interface for entities with identity
- `sameEntity()`, `findEntityById()`, `hasEntityId()`, `removeEntityById()` - Entity helpers
- `Command`, `CommandHandler<C, R>` - Command interface and handler type for CQRS
- `Query`, `QueryHandler<Q, R>` - Query interface and handler type for CQRS
- `CommandBus`, `ICommandBus` - Command bus for centralized command execution
- `QueryBus`, `IQueryBus` - Query bus for centralized query execution (with `execute()` returning Result and `executeUnsafe()` throwing exceptions)
- `withCommit()` - Helper for transactional command execution with events
- `DomainEvent<T, P>`, `EventMetadata` - Domain event interfaces
- `createDomainEvent()`, `createDomainEventWithMetadata()` - Event creation helpers
- `copyMetadata()`, `mergeMetadata()` - Metadata utilities
- `EventBus<Evt>`, `EventBusImpl<Evt>` - Event bus interface and implementation for pub/sub pattern
- `EventHandler<Evt>` - Event handler function type
- `EventBus.subscribe()` - Subscribe handlers to event types
- `EventBus.publish()` - Publish events to all subscribers
- `Result<T, E>`, `ok()`, `err()`, `isOk()`, `isErr()` - Result type and helpers
- `Id<Tag>` - Branded ID type
- `IRepository<TState, TEvent, TAgg, TId>` - Repository interface
- `ISpecification<T>` - Specification interface
- `UnitOfWork` - Unit of Work interface
- `guard()` - Guard/validation helper

## TypeScript Support

This package is built with TypeScript and provides comprehensive type safety. All APIs are fully typed, leveraging TypeScript's type system to ensure correctness at compile time. The package requires TypeScript 5.9.2 or higher and takes advantage of advanced TypeScript features like branded types, conditional types, and mapped types to provide a type-safe DDD experience.

## Contributing

Contributions are welcome! Please read our contributing guidelines in [CONTRIBUTING.md](./CONTRIBUTING.md) before submitting pull requests. For bug reports and feature requests, please use the [GitHub issue tracker](https://github.com/shi-rudo/ddd-kit-ts/issues).

## License

This project is licensed under the MIT License.

## Author

**Shirudo**

- GitHub: [@shi-rudo](https://github.com/shi-rudo)
- Package: [@shirudo/ddd-kit](https://www.npmjs.com/package/@shirudo/ddd-kit)
- Repository: [ddd-kit-ts](https://github.com/shi-rudo/ddd-kit-ts)
