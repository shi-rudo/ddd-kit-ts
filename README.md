# @shirudo/ddd-kit

Composable TypeScript toolkit for tactical Domain-Driven Design.

> **Release Candidate**
>
> This library is in Release Candidate phase. The API is considered stable and ready for production evaluation. Please report any issues before the final 1.0.0 release.

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
- **Result Type** - Functional error handling with `Result<T, E>` type for explicit success/failure states. For advanced error handling with typed error hierarchies, see [`@shirudo/base-error`](https://www.npmjs.com/package/@shirudo/base-error)

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
import { vo, type VO } from "@shirudo/ddd-kit";

type EmailAddress = VO<{
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

Value Objects are immutable objects that are defined by their attributes rather than identity. They ensure data integrity by preventing modification after creation. Use the `vo()` helper function to create deeply frozen value objects that cannot be mutated, even nested objects and arrays. The library provides `voEquals()` for value-based equality comparison, `voEqualsExcept()` for comparing while ignoring specified keys (useful for metadata), `voWithValidation()` for creating validated value objects (returns Result), and `voWithValidationUnsafe()` for the exception-throwing variant.

### Entities

In Domain-Driven Design, Entities are objects with identity and state. Unlike Value Objects (compared by value), Entities are compared by identity (id). There are two types of entities:

1. **Aggregate Root Entity**: The parent Entity of an aggregate.
   - Has identity (id), state, and version for optimistic concurrency control
   - Represents the aggregate externally
   - Loaded/saved through repositories
   - Created by extending `AggregateRoot` (state-based) or `EventSourcedAggregate` (event-sourced)
   - Implements `IAggregateRoot<TId>`

2. **Child Entities**: Entities within an aggregate.
   - Have identity (id) and state, but no own version
   - Can have business logic (methods) specific to the entity
   - Exist only within the aggregate boundary
   - Versioned through the Aggregate Root
   - Cannot be referenced directly from outside the aggregate
   - **Two approaches**:
     - **Class-based** (recommended for entities with logic): Extend `Entity<TState, TId>`
     - **Functional-style** (for simple data): Use `Identifiable<TId> & TProps`

The library provides:
- **`Entity<TState, TId>`** - Base class for entities with state and business logic
- **`Entity<TId>`** - Simple class for entities without state management
- **`Identifiable<TId>`** - Minimal interface for objects with id
- Helper functions like `sameEntity()`, `findEntityById()`, `hasEntityId()`, `updateEntityById()`, and `removeEntityById()` for working with entity collections

### Aggregates

Aggregates are clusters of entities and value objects that form a consistency boundary. An aggregate consists of:

- **One Aggregate Root** (Entity with id + version)
- **Optional child entities** (Entities with id, but no own version)
- **Optional value objects** (immutable objects)

The Aggregate Root is an Entity (the parent Entity of the aggregate) that represents the aggregate externally. All changes to child entities are versioned through the Aggregate Root. The version applies to the entire aggregate, including all child entities.

The library provides:

- **`IAggregateRoot<TId>`** - Marker interface for Aggregate Root Entities. The Aggregate Root is an Entity with identity (id) and version for optimistic concurrency control. It represents the aggregate externally and is the only object that can be loaded/saved through repositories.

- **`AggregateRoot<TState, TId, TEvent?>`** - Base class for creating Aggregate Root Entities without Event Sourcing. Implements `IAggregateRoot<TId>`. The optional `TEvent` parameter (defaults to `unknown`) enables type-safe domain events — only aggregates that specify it get compile-time event validation. Provides ID and version management, state management, domain event tracking, and snapshot support. Use this when you don't need Event Sourcing but still want aggregate patterns with versioning and state management.

- **`EventSourcedAggregate<TState, TEvent, TId>`** - Base class for Event-Sourced Aggregate Roots. Extends `Entity` directly (not `AggregateRoot`) so that state changes can only happen through event handlers via `apply()`. Provides event tracking, event validation, history replay, and snapshot support.

Both classes support automatic versioning (configurable), snapshot creation/restoration, and optimistic concurrency control. The version applies to the entire aggregate, including all child entities.

### CQRS (Command Query Responsibility Segregation)

CQRS separates read operations (Queries) from write operations (Commands), providing clear patterns for handling different types of operations. Commands change system state and return `Result` for error handling, while Queries read data and return results directly. The library provides optional Command and Query Buses for centralized handler registration and execution.

### Domain Events

Domain Events represent something meaningful that happened in your domain. They are immutable records with a type, payload, timestamp, version for schema evolution, and optional metadata for traceability. Events support versioning for handling schema changes over time and include metadata fields like `correlationId`, `causationId`, `userId`, and `source` for tracking event flow in distributed systems. Events are automatically tracked by aggregates and can be published to event buses or stored in outboxes for eventual consistency.

### Repositories

Repositories abstract the persistence layer, allowing you to work with aggregates without dealing with database specifics. They support finding aggregates by ID, using specifications for complex queries, and saving/deleting aggregates while maintaining transactional boundaries.

### Specifications

Specifications encapsulate business rules for queries in a reusable, composable way. They provide a domain-centric approach to querying that separates business logic from data access implementation details.

### Result Type

The `Result<T, E>` type provides functional error handling without exceptions. It explicitly represents success (`Ok<T>`) or failure (`Err<E>`) states, making error handling predictable and type-safe throughout your domain logic.

## Usage Examples

### Creating a Value Object

```typescript
import { vo, voEquals, voEqualsExcept, voWithValidation, type VO } from "@shirudo/ddd-kit";

// Simple value object (Functional Style)
type Money = VO<{
  amount: number;
  currency: string;
}>;

const price = vo({ amount: 99.99, currency: "USD" });
// price is deeply immutable - nested objects and arrays are also frozen

// Class-based Value Object (OOP Style)
import { ValueObject } from "@shirudo/ddd-kit";

class Address extends ValueObject<{ street: string; city: string }> {
  constructor(props: { street: string; city: string }) {
    super(props);
  }

  get street(): string {
    return this.props.street;
  }
}

const address = new Address({ street: "Main St", city: "New York" });
// address.props is immutable

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

// Equality comparison ignoring metadata
const address1 = vo({
  street: "Main St",
  city: "Berlin",
  metadata: { updatedAt: "2024-01-02" }
});
const address2 = vo({
  street: "Main St",
  city: "Berlin",
  metadata: { updatedAt: "2024-01-03" }
});
voEquals(address1, address2); // false (different metadata)
voEqualsExcept(address1, address2, {
  ignoreKeyPredicate: (key, path) => path.includes("metadata")
}); // true (metadata ignored)
```

### Creating an Aggregate WITHOUT Event Sourcing

```typescript
import {
  AggregateRoot,
  type IAggregateRoot,
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

// Without typed events (TEvent defaults to unknown)
class Order extends AggregateRoot<OrderState, OrderId> {
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
    if (this.state.status !== "pending") {
      throw new Error("Cannot add items to a non-pending order");
    }

    this.setState({
      ...this.state,
      items: [...this.state.items, { productId, quantity, price }],
      total: this.state.total + quantity * price,
    }, true); // true = bump version for optimistic concurrency control
  }

  confirm(): void {
    if (this.state.status !== "pending") {
      throw new Error("Only pending orders can be confirmed");
    }
    this.setState({ ...this.state, status: "confirmed" }, true);
  }

  ship(): void {
    if (this.state.status !== "confirmed") {
      throw new Error("Only confirmed orders can be shipped");
    }
    this.setState({ ...this.state, status: "shipped" }, true);
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

#### With Typed Domain Events

Use the optional third type parameter to get compile-time event validation:

```typescript
type OrderDomainEvent =
  | { type: "OrderConfirmed" }
  | { type: "OrderShipped"; trackingNumber: string };

class Order extends AggregateRoot<OrderState, OrderId, OrderDomainEvent> {
  confirm(): void {
    this.setState({ ...this.state, status: "confirmed" }, true);
    this.addDomainEvent({ type: "OrderConfirmed" }); // type-safe
  }

  ship(trackingNumber: string): void {
    this.setState({ ...this.state, status: "shipped" }, true);
    this.addDomainEvent({ type: "OrderShipped", trackingNumber }); // type-safe
  }
}

// order.domainEvents is ReadonlyArray<OrderDomainEvent> — no cast needed
// order.addDomainEvent({ type: "WrongEvent" }) → compile error
```

### Creating an Aggregate WITH Event Sourcing

```typescript
import {
  EventSourcedAggregate,
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
type OrderConfirmed = DomainEvent<"OrderConfirmed">;
type OrderShipped = DomainEvent<"OrderShipped", { trackingNumber: string }>;

type OrderEvent = OrderCreated | OrderConfirmed | OrderShipped;

class Order extends EventSourcedAggregate<OrderState, OrderEvent, OrderId> {
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
      createDomainEvent("OrderConfirmed") as OrderConfirmed
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
      createDomainEvent("OrderConfirmed") as OrderConfirmed
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
  AggregateRoot,
  EventSourcedAggregate,
  sameVersion,
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

// Optimistic concurrency check
const order1 = await repository.getById(id);
// ... some operations ...
const order2 = await repository.getById(id);
if (!sameVersion(order1, order2)) {
  throw new Error("Aggregate was modified by another process");
}
```

### Event Validation (Event-Sourced Aggregates Only)

```typescript
import {
  EventSourcedAggregate,
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

class Order extends EventSourcedAggregate<OrderState, OrderEvent, OrderId> {
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
  items: Array<{ productId: string; quantity: number; price: number }>;
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
  const orderId = `order-${Date.now()}` as OrderId;
  const order = Order.create(orderId, cmd.customerId);

  // Add items to the order
  for (const item of cmd.items) {
    order.addItem(item.productId, item.quantity, item.price);
  }

  await repository.save(order);

  return ok(order.id);
};

// Use directly
const result = await createOrderHandler({
  type: "CreateOrder",
  customerId: "customer-123",
  items: [{ productId: "product-1", quantity: 2, price: 10.0 }],
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
  items: [{ productId: "product-1", quantity: 2, price: 10.0 }],
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
      const orderId = `order-${Date.now()}` as OrderId;
      const order = Order.create(orderId, cmd.customerId);

      // Add items to the order
      for (const item of cmd.items) {
        order.addItem(item.productId, item.quantity, item.price);
      }

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
  items: Array<{ productId: string; quantity: number; price: number }>;
};

type GetOrderQuery = Query & {
  type: "GetOrder";
  orderId: OrderId;
};

// Handler typed with CommandHandler for type safety
const createOrderHandler: CommandHandler<CreateOrderCommand, OrderId> = async (
  cmd
) => {
  const orderId = `order-${Date.now()}` as OrderId;
  const order = Order.create(orderId, cmd.customerId);

  // Add items to the order
  for (const item of cmd.items) {
    order.addItem(item.productId, item.quantity, item.price);
  }

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

// Wait for the next event of a given type (useful for tests and workflows)
const event = await eventBus.once<OrderCreated>("OrderCreated");
console.log("Order created:", event.payload.orderId);
// Automatically unsubscribes after the first event
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

An Aggregate Root Entity can contain multiple child entities. Child entities have identity (id) and state, but no own version - they are versioned through the Aggregate Root.

#### Approach 1: Functional-Style Child Entities (Simple Data)

For simple child entities without business logic, use the functional approach with intersection types:

```typescript
import {
  AggregateRoot,
  Identifiable,
  findEntityById,
  updateEntityById,
  type IAggregateRoot,
  type Id,
} from "@shirudo/ddd-kit";

type OrderId = Id<"OrderId">;
type ItemId = Id<"ItemId">;

// Functional-style child entity (simple data, no logic)
type OrderItem = Identifiable<ItemId> & {
  productId: string;
  quantity: number;
  price: number;
};

// Aggregate state contains child entities
type OrderState = {
  id: OrderId;
  customerId: string;
  items: OrderItem[];
  total: number;
};

// Order is the Aggregate Root (an Entity with id + version)
class Order extends AggregateRoot<OrderState, OrderId>
  implements IAggregateRoot<OrderId> {
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

    this.setState({
      ...this.state,
      items: [...this.state.items, item],
      total: this.state.total + price * quantity,
    }, true); // true = bump version (versions the entire aggregate including child entities)
    return itemId;
  }

  updateItemQuantity(itemId: ItemId, newQuantity: number): void {
    const item = findEntityById(this.state.items, itemId);
    if (!item) {
      throw new Error("Item not found");
    }

    this.setState({
      ...this.state,
      items: updateEntityById(this.state.items, itemId, (i) => ({ ...i, quantity: newQuantity })),
      total: this.state.total - item.price * item.quantity + item.price * newQuantity,
    }, true);
  }

  removeItem(itemId: ItemId): void {
    const item = findEntityById(this.state.items, itemId);
    if (!item) {
      throw new Error("Item not found");
    }

    this.setState({
      ...this.state,
      items: removeEntityById(this.state.items, itemId),
      total: this.state.total - item.price * item.quantity,
    }, true);
  }

  getItem(itemId: ItemId): OrderItem | undefined {
    return findEntityById(this.state.items, itemId);
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

#### Approach 2: Class-Based Child Entities (With Business Logic)

For child entities that need business logic, extend `Entity<TState, TId>`:

```typescript
import {
  AggregateRoot,
  Entity,
  findEntityById,
  type IAggregateRoot,
  type Id,
} from "@shirudo/ddd-kit";

type OrderId = Id<"OrderId">;
type ItemId = Id<"ItemId">;

// State of OrderItem
type OrderItemState = {
  productId: string;
  quantity: number;
  price: number;
};

// Class-based child entity with business logic
class OrderItem extends Entity<OrderItemState, ItemId> {
  constructor(id: ItemId, productId: string, quantity: number, price: number) {
    const initialState: OrderItemState = { productId, quantity, price };
    super(id, initialState);
  }

  // Entity-specific business logic
  updateQuantity(newQuantity: number): void {
    if (newQuantity <= 0) {
      throw new Error("Quantity must be greater than 0");
    }
    this.setState({ ...this.state, quantity: newQuantity });
  }

  calculateSubtotal(): number {
    return this.state.price * this.state.quantity;
  }

  isForProduct(productId: string): boolean {
    return this.state.productId === productId;
  }

  protected validateState(state: OrderItemState): void {
    if (state.quantity <= 0) throw new Error("Quantity must be greater than 0");
    if (state.price < 0) throw new Error("Price cannot be negative");
    if (!state.productId) throw new Error("Product ID is required");
  }
}

// Aggregate state contains child entity instances
type OrderState = {
  id: OrderId;
  customerId: string;
  items: OrderItem[]; // Child entities with logic
  status: "pending" | "confirmed";
};

// Aggregate Root
class Order extends AggregateRoot<OrderState, OrderId>
  implements IAggregateRoot<OrderId> {
  private itemCounter = 0;

  static create(id: OrderId, customerId: string): Order {
    const initialState: OrderState = {
      id,
      customerId,
      items: [],
      status: "pending",
    };
    return new Order(id, initialState);
  }

  addItem(productId: string, quantity: number, price: number): ItemId {
    const itemId = `item-${++this.itemCounter}` as ItemId;
    const item = new OrderItem(itemId, productId, quantity, price);

    this.setState({
      ...this.state,
      items: [...this.state.items, item],
    }, true);
    return itemId;
  }

  // Delegate to entity's business logic
  updateItemQuantity(itemId: ItemId, newQuantity: number): void {
    const item = findEntityById(this.state.items, itemId);
    if (!item) throw new Error("Item not found");

    item.updateQuantity(newQuantity); // Uses entity's logic
    this.bumpVersion();
  }

  // Use entity's business logic
  calculateTotal(): number {
    return this.state.items.reduce(
      (total, item) => total + item.calculateSubtotal(),
      0
    );
  }

  confirm(): void {
    if (this.state.items.length === 0) {
      throw new Error("Cannot confirm an order without items");
    }
    this.setState({ ...this.state, status: "confirmed" }, true);
  }
}

// Usage
const order = Order.create("order-1" as OrderId, "customer-1");
const itemId = order.addItem("product-1", 2, 10.0);
order.updateItemQuantity(itemId, 3); // Uses entity's validation
const total = order.calculateTotal(); // Uses entity's calculateSubtotal()
console.log(total); // 30.0
```

### Using Result Type for Error Handling

The `Result<T, E>` type provides composition utilities to avoid repetitive `if (isErr)` checks:

**Import Result utilities from the dedicated export path:**

```typescript
import { 
  ok, 
  err, 
  isOk, 
  isErr, 
  andThen, 
  map, 
  mapErr, 
  unwrapOr, 
  unwrapOrElse, 
  match,
  matchAsync,
  pipe,
  tryCatch,
  tryCatchAsync,
  type Result,
  Outcome,
  Success,
  Erroneous
} from "@shirudo/ddd-kit/result";

type UserId = string;

function validateUserId(id: string): Result<UserId, string> {
  return id.length > 0 ? ok(id as UserId) : err("User ID cannot be empty");
}

function validateEmail(email: string): Result<string, string> {
  return email.includes("@") ? ok(email) : err("Invalid email");
}

// Chaining operations with andThen (avoids if-checks)
function createUser(id: string, email: string): Result<{ id: UserId; email: string }, string> {
  return andThen(validateUserId(id), (userId) =>
    map(validateEmail(email), (email) => ({
      id: userId,
      email,
    }))
  );
}

// Using map for transformations
const result = ok(5);
const doubled = map(result, x => x * 2); // Ok<10>

// Using mapErr to transform errors
const errorResult = err("not found");
const mappedError = mapErr(errorResult, e => `Error: ${e}`); // Err<"Error: not found">

// Using unwrapOr for defaults
const userId = unwrapOr(validateUserId(""), "default-id");

// Using unwrapOrElse for computed defaults
const userId2 = unwrapOrElse(validateUserId(""), err => `fallback-${Date.now()}`);

// Using match for pattern matching
const message = match(createUser("user-123", "test@example.com"),
  user => `User created: ${user.id}`,
  error => `Error: ${error}`
);

// Usage with type guards (still works)
const result2 = createUser("user-123", "test@example.com");
if (isOk(result2)) {
  console.log("User created:", result2.value);
} else {
  console.error("Error:", result2.error);
}

// Using tryCatch to wrap functions that throw exceptions
function riskyOperation(): string {
  if (Math.random() > 0.5) {
    throw new Error("Something went wrong");
  }
  return "success";
}

const result3 = tryCatch(() => riskyOperation());
if (result3.ok) {
  console.log(result3.value); // "success"
} else {
  console.error(result3.error.message); // "Something went wrong"
}

// Using tryCatchAsync for async operations
async function riskyAsyncOperation(): Promise<string> {
  if (Math.random() > 0.5) {
    throw new Error("Async error");
  }
  return "async success";
}

const result4 = await tryCatchAsync(() => riskyAsyncOperation());
match(result4,
  (value) => console.log("Success:", value),
  (error) => console.error("Error:", error.message)
);
```

**Available Composition Utilities:**
- `andThen<T, E, U>(result, fn)` - Chains Result operations (flatMap/bind). If Ok, applies function; if Err, returns error unchanged.
- `map<T, E, U>(result, fn)` - Transforms Ok value. If Err, returns error unchanged.
- `mapErr<T, E, F>(result, fn)` - Transforms Err value. If Ok, returns value unchanged.
- `unwrapOr<T, E>(result, defaultValue)` - Returns value if Ok, otherwise returns default.
- `unwrapOrElse<T, E>(result, fn)` - Returns value if Ok, otherwise computes default from error.
- `match<T, E, R>(result, onOk, onErr)` - Pattern matching. Applies one function if Ok, another if Err. Supports both function and object syntax.
- `matchAsync<T, E, R>(result, onOk, onErr)` - Asynchronous pattern matching. Applies async functions for Ok/Err cases. Supports both function and object syntax.
- `pipe<T, E>(initial, ...fns)` - Pipes a Result through multiple operations. Stops on first error. Cleaner alternative to nested `andThen` calls.
- `tryCatch<T, E>(fn, errorMapper?)` - Wraps a function that may throw exceptions into a Result type. Catches exceptions and converts them to Err results.
- `tryCatchAsync<T, E>(fn, errorMapper?)` - Wraps an async function that may throw exceptions into a Promise<Result>. Catches exceptions and Promise rejections.

**Class-based API (for method chaining):**
- `Outcome<T, E>` - Wrapper class for Result with method chaining support
- `Success<T>` - Class representing successful results (created via `Ok()` factory)
- `Erroneous<E>` - Class representing error results (created via `Err()` factory)

## API Documentation

This package is written in TypeScript and provides full type definitions. All types and functions are exported from the main entry point. You can explore the available APIs through your IDE's autocomplete or by examining the type definitions in `node_modules/@shirudo/ddd-kit/dist/index.d.ts`.

Key exports include:
- `vo()`, `voEquals()`, `voEqualsExcept()`, `voWithValidation()`, `voWithValidationUnsafe()` - Value Object utilities
- `IAggregateRoot<TId>` - Marker interface for Aggregate Root Entities
- `AggregateRoot<TState, TId, TEvent?>` - Base class for creating Aggregate Root Entities without Event Sourcing (extends `Entity`, implements `IAggregateRoot<TId>`). Optional `TEvent` parameter enables type-safe domain events
- `EventSourcedAggregate<TState, TEvent, TId>` - Base class for Event-Sourced Aggregate Roots (extends `Entity`, implements `IEventSourcedAggregate<TId, TEvent>`)
- `AggregateConfig`, `EventSourcedAggregateConfig` - Configuration interfaces
- `AggregateSnapshot<TState>` - Snapshot interface for performance optimization
- `sameVersion()` - Optimistic concurrency check (same ID and version)
- `Entity<TState, TId>` - Base class for entities with state and business logic
- `IEntity<TId, TState>` - Entity interface
- `Identifiable<TId>` - Minimal interface for objects with id
- `sameEntity()`, `findEntityById()`, `hasEntityId()`, `removeEntityById()`, `updateEntityById()`, `replaceEntityById()`, `entityIds()` - Entity helper functions
- `Command`, `CommandHandler<C, R>` - Command interface and handler type for CQRS
- `Query`, `QueryHandler<Q, R>` - Query interface and handler type for CQRS
- `CommandBus`, `ICommandBus` - Command bus for centralized command execution
- `QueryBus`, `IQueryBus` - Query bus for centralized query execution (with `execute()` returning Result and `executeUnsafe()` throwing exceptions)
- `withCommit()` - Helper for transactional command execution with events
- `DomainEvent<T, P?>` - Domain event interface (`P` defaults to `void` for payload-less events)
- `EventMetadata` - Event metadata interface for traceability
- `createDomainEvent()` - Event creation helper (payload is optional for payload-less events)
- `createDomainEventWithMetadata()` - Event creation with metadata
- `copyMetadata()`, `mergeMetadata()` - Metadata utilities
- `EventBus<Evt>`, `EventBusImpl<Evt>` - Event bus interface and implementation for pub/sub pattern
- `EventHandler<Evt>` - Event handler function type
- `EventBus.subscribe()` - Subscribe handlers to event types
- `EventBus.publish()` - Publish events to all subscribers (uses `Promise.allSettled` — all handlers run even if one fails)
- `EventBus.once()` - Wait for the next event of a given type (returns Promise, auto-unsubscribes)
- `Result<T, E>`, `ok()`, `err()`, `isOk()`, `isErr()` - Result type and type guards
- `andThen()`, `map()`, `mapErr()` - Result composition utilities
- `unwrapOr()`, `unwrapOrElse()`, `match()` - Result unwrapping and pattern matching
- `Id<Tag>` - Branded ID type
- `IRepository<TAgg, TId>` - Repository interface
- `ISpecification<T>` - Specification interface
- `UnitOfWork` - Unit of Work interface
- `guard()` - Guard/validation helper

## Concurrency & Thread Safety

### Understanding "Operations" in Different Contexts

When we talk about **operations** or **executions**, we mean:

1. **HTTP Request** - In a web API: One incoming HTTP request (GET, POST, etc.)
2. **Command Execution** - In CQRS: Execution of a single command (CreateOrder, UpdateQuantity, etc.)
3. **Query Execution** - In CQRS: Execution of a single query (GetOrder, ListOrders, etc.)
4. **Background Job** - Asynchronous task processing (email sending, report generation, etc.)
5. **Event Handler** - Processing of a single domain event

**Key principle**: Each operation should load fresh aggregate instances, make changes, and save them. Never share aggregate instances across operations.

### The Problem: Race Conditions with Shared State

JavaScript is single-threaded, but `async/await` creates concurrency risks:

```typescript
// ❌ DANGEROUS - Race Condition!
class OrderService {
  private cachedOrder: Order; // NEVER cache aggregates!

  async updateQuantity(itemId: ItemId, quantity: number) {
    // Request 1 reads quantity = 5
    const item = this.cachedOrder.getItem(itemId);
    const oldQty = item.state.quantity; // 5

    await someAsyncOperation(); // ⚠️ Context switch here!

    // Request 2 updates quantity to 10 while we wait
    // Request 1 continues with stale data
    item.updateQuantity(oldQty + 1); // Writes 6, should be 11!
  }
}
```

**Why this happens:**
- `await` yields control to event loop
- Other async operations can run
- Your aggregate instance has stale data
- Last write wins (data loss!)

### ✅ Solution 1: Operation-Scoped Aggregates (Recommended)

**Pattern**: Each operation gets its own aggregate instance. Load → Mutate → Save → Discard.

This works the **SAME** for both function handlers and class-based handlers!

#### Approach A: Function-Based Handlers (Simple)

```typescript
// ✅ SAFE - Fresh instance per operation
async function updateOrderQuantity(
  orderId: OrderId,
  itemId: ItemId,
  quantity: number
) {
  // 1. Load fresh from database
  const order = await repository.getById(orderId);

  // 2. Make ALL changes synchronously (no await!)
  const item = order.getItem(itemId);
  item.updateQuantity(quantity);
  order.recalculateTotal();

  // 3. Save with optimistic locking
  await repository.save(order); // Throws if version mismatch

  // 4. Instance is garbage collected (no shared state)
}

// ✅ SAFE - Command Handler function
async function createOrderHandler(cmd: CreateOrderCommand) {
  const orderId = generateId() as OrderId;
  const order = Order.create(orderId, cmd.customerId);

  // All mutations synchronous
  for (const item of cmd.items) {
    order.addItem(item.productId, item.quantity, item.price);
  }
  order.confirm();

  await repository.save(order);
  return order.id;
}
```

#### Approach B: Class-Based Handlers (MUST be Stateless!)

The key difference with classes: **Dependencies in constructor, aggregates in methods**.

```typescript
// ✅ SAFE - Stateless handler class
class CreateOrderHandler implements CommandHandler<CreateOrderCommand, OrderId> {
  constructor(
    private readonly repository: OrderRepository,
    private readonly eventBus: EventBus
  ) {
    // ✅ Only infrastructure dependencies here!
    // ❌ NEVER store aggregates here!
  }

  async execute(cmd: CreateOrderCommand): Promise<Result<OrderId, string>> {
    // 1. Aggregate is LOCAL to this method call
    const orderId = generateId() as OrderId;
    const order = Order.create(orderId, cmd.customerId);

    // 2. All mutations synchronous
    for (const item of cmd.items) {
      order.addItem(item.productId, item.quantity, item.price);
    }
    order.confirm();

    // 3. Save
    await this.repository.save(order);
    await this.eventBus.publish(order.domainEvents);

    return ok(order.id);
    // 4. Aggregate is garbage collected when method returns
  }
}

// ✅ SAFE - Another handler instance
class UpdateOrderQuantityHandler {
  constructor(private readonly repository: OrderRepository) {}

  async execute(cmd: UpdateQuantityCommand): Promise<Result<void, string>> {
    // Fresh load per call
    const order = await this.repository.getById(cmd.orderId);

    order.updateItemQuantity(cmd.itemId, cmd.quantity);

    await this.repository.save(order);
    return ok(undefined);
  }
}

// Usage - Handler instances are singletons, but aggregates are not!
const handler = new CreateOrderHandler(repository, eventBus);

// Each call gets fresh aggregate
await handler.execute(cmd1); // order1 created and discarded
await handler.execute(cmd2); // order2 created and discarded
await handler.execute(cmd3); // order3 created and discarded
```

#### ❌ DANGEROUS: Stateful Handler Class

```typescript
// ❌ DANGEROUS - Storing aggregates in class fields!
class OrderService {
  private currentOrder: Order; // NEVER DO THIS!
  private orderCache = new Map<OrderId, Order>(); // NEVER!

  constructor(private readonly repository: OrderRepository) {}

  async loadOrder(orderId: OrderId) {
    this.currentOrder = await this.repository.getById(orderId);
    // ❌ Stored in instance field - shared across operations!
  }

  async updateQuantity(itemId: ItemId, quantity: number) {
    // ❌ Using shared state from previous operation
    this.currentOrder.updateItemQuantity(itemId, quantity);
    // Race condition if another request called loadOrder()!
  }
}
```

#### The Key Difference

| | Function Handlers | Class Handlers |
|---|---|---|
| **Handler Instance** | Created per call | Singleton (DI container) |
| **Aggregate Instance** | Local variable | MUST be local variable in method |
| **Dependencies** | Parameters | Constructor injection |
| **Risk** | Low (naturally scoped) | Medium (tempting to store in fields) |

**Important**:
- ✅ Handler **class** can be singleton
- ❌ Aggregate **instance** must NEVER be stored in handler class
- ✅ Aggregates are **always** local to method execution

**Rules for safe aggregate usage (applies to BOTH):**
1. ✅ Load aggregate at start of operation (method call)
2. ✅ All mutations synchronous (no `await` between state changes)
3. ✅ Save at end of operation
4. ✅ Let garbage collector clean up
5. ❌ Never store aggregates in class fields (if using classes)
6. ❌ Never cache aggregates between operations
7. ❌ Never pass aggregates between operations

### ✅ Solution 2: Optimistic Locking (Already Built-in!)

Your `AggregateRoot` includes a `version` field for Optimistic Concurrency Control:

```typescript
// Repository implementation with optimistic locking
class OrderRepository {
  async save(order: Order): Promise<void> {
    const current = await db.orders.findOne({ id: order.id });

    // Check if someone else modified it
    if (current && current.version !== order.version) {
      throw new ConcurrencyError(
        `Order ${order.id} was modified by another operation. ` +
        `Expected version ${order.version}, but found ${current.version}`
      );
    }

    // Save with incremented version
    await db.orders.update({
      id: order.id,
      ...order.state,
      version: order.version + 1 // Increment version
    });
  }
}

// Usage - retry on conflict
async function updateOrderWithRetry(orderId: OrderId, itemId: ItemId, qty: number) {
  const maxRetries = 3;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const order = await repository.getById(orderId);
      order.updateItemQuantity(itemId, qty);
      await repository.save(order);
      return; // Success!
    } catch (error) {
      if (error instanceof ConcurrencyError && attempt < maxRetries - 1) {
        // Retry with fresh data
        continue;
      }
      throw error;
    }
  }
}
```

### ✅ Solution 3: Unit of Work Pattern

Use transactions to ensure consistency:

```typescript
import { withCommit } from "@shirudo/ddd-kit";

async function createOrderCommand(cmd: CreateOrderCommand) {
  return await withCommit({ uow, eventBus, outbox }, async () => {
    const orderId = generateId() as OrderId;
    const order = Order.create(orderId, cmd.customerId);

    // All synchronous mutations within transaction
    for (const item of cmd.items) {
      order.addItem(item.productId, item.quantity, item.price);
    }

    await repository.save(order);

    return {
      result: order.id,
      events: order.pendingEvents // Published atomically
    };
  }); // Commits or rollbacks everything
}
```

### Safe Async Patterns

```typescript
// ✅ SAFE - Async I/O BEFORE mutations
async function processOrder(orderId: OrderId) {
  // 1. Do all async I/O first
  const order = await repository.getById(orderId);
  const pricing = await pricingService.getPrices(order.state.items);
  const inventory = await inventoryService.check(order.state.items);

  // 2. Then do all mutations synchronously
  if (inventory.available) {
    order.confirm();
    for (const [itemId, price] of pricing) {
      order.updateItemPrice(itemId, price);
    }
  } else {
    order.cancel();
  }

  // 3. Single save at end
  await repository.save(order);
}

// ❌ DANGEROUS - Interleaved async/mutations
async function processOrderWrong(orderId: OrderId) {
  const order = await repository.getById(orderId);

  order.confirm(); // Mutation
  await inventoryService.reserve(order.id); // ⚠️ Yield point!
  order.addItem(...); // Another operation might have modified order!

  await repository.save(order);
}
```

### Stateless Services Pattern

```typescript
// ✅ SAFE - Stateless service, aggregates are local
class OrderService {
  constructor(
    private readonly repository: OrderRepository,
    private readonly eventBus: EventBus
  ) {}

  async createOrder(cmd: CreateOrderCommand): Promise<Result<OrderId, string>> {
    // Fresh instance per call
    const order = Order.create(generateId(), cmd.customerId);

    for (const item of cmd.items) {
      order.addItem(item.productId, item.quantity, item.price);
    }

    await this.repository.save(order);
    await this.eventBus.publish(order.domainEvents);

    return ok(order.id);
    // order is garbage collected here
  }
}

// ❌ DANGEROUS - Stateful service
class OrderServiceBad {
  private orders = new Map<OrderId, Order>(); // NEVER!

  async updateOrder(orderId: OrderId) {
    const order = this.orders.get(orderId); // Shared mutable state!
    // Race conditions everywhere!
  }
}
```

### Multi-Tenant Considerations

Even in single-threaded JavaScript, concurrent operations are real:

```typescript
// Scenario: Two users updating same order simultaneously
// Time  | Request A (User 1)           | Request B (User 2)
// ------|------------------------------|---------------------------
// T1    | order = load(id) v=1         |
// T2    |                              | order = load(id) v=1
// T3    | order.addItem(...)           |
// T4    |                              | order.updateQty(...)
// T5    | save(order) → v=2 ✅         |
// T6    |                              | save(order) → v=1 ❌ Error!

// With optimistic locking:
// Request B fails with ConcurrencyError
// Client retries with fresh data
```

### Summary: Concurrency Best Practices

| ✅ DO | ❌ DON'T |
|-------|----------|
| Load aggregate per operation | Cache aggregates in memory |
| All mutations synchronous | Mix async I/O with mutations |
| Use optimistic locking | Assume single-threaded = safe |
| Operation-scoped instances | Share instances across operations |
| Stateless services | Stateful services with aggregates |
| Retry on concurrency errors | Ignore version conflicts |

**Remember**: JavaScript's single thread doesn't mean you're safe from race conditions. `async/await` creates concurrency, and multiple operations can be "in flight" simultaneously. Always treat aggregates as operation-scoped, use optimistic locking, and keep mutations synchronous.

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
