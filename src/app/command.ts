import type { Result } from "@shirudo/result";

/**
 * Marker interface for Commands.
 * Commands represent write operations that change system state.
 * They should be immutable and contain all data needed to perform the operation.
 *
 * This interface can be used as a type marker even when using external frameworks
 * (e.g., RabbitMQ, AWS SQS) to ensure type safety across different bus implementations.
 *
 * @example
 * ```typescript
 * type CreateOrderCommand = Command & {
 *   type: "CreateOrder";
 *   customerId: string;
 *   items: OrderItem[];
 * };
 * ```
 *
 * @example Using with external frameworks (RabbitMQ, etc.)
 * ```typescript
 * // Define command using Command marker
 * type CreateOrderCommand = Command & {
 *   type: "CreateOrder";
 *   customerId: string;
 * };
 *
 * // Handler can be typed with CommandHandler even for external frameworks
 * const handler: CommandHandler<CreateOrderCommand, OrderId> = async (cmd) => {
 *   // ... handler logic
 *   return ok(orderId);
 * };
 *
 * // The consumer owns this runtime decoder. It checks byte and collection
 * // ceilings, parses to unknown, allow-lists fields, and constructs domain types.
 * declare function decodeCreateOrderCommand(
 *   body: Uint8Array,
 *   principal: AuthenticatedPrincipal,
 * ): Result<CreateOrderCommand, InvalidCommand>;
 * declare function decodeMessageId(
 *   value: unknown,
 * ): Result<string, InvalidTransportMetadata>;
 * declare function createOrderDeliveryKey(messageId: string): string;
 *
 * // This application service invokes the handler through withIdempotentCommit.
 * // createOrderDeliveryKey scopes the message id by consumer. The service
 * // fingerprints the complete CreateOrder intention and commits that claim,
 * // the aggregate write, outbox entries, and outcome together.
 * declare function executeIdempotentCreateOrder(
 *   deliveryKey: string,
 *   command: CreateOrderCommand,
 * ): Promise<Result<OrderId, string>>;
 *
 * // Register with RabbitMQ or another external bus.
 * rabbitMQChannel.consume("order.commands", async (message) => {
 *   const messageId = decodeMessageId(message.properties.messageId);
 *   if (messageId.isErr()) {
 *     rabbitMQChannel.reject(message, false); // missing identity: dead-letter
 *     return;
 *   }
 *   const deliveryKey = createOrderDeliveryKey(messageId.value);
 *   const principal = authenticateProducer(message.properties.headers);
 *   const decoded = decodeCreateOrderCommand(message.content, principal);
 *   if (decoded.isErr()) {
 *     rabbitMQChannel.reject(message, false); // invalid input: dead-letter, do not retry
 *     return;
 *   }
 *   const outcome = await executeIdempotentCreateOrder(
 *     deliveryKey,
 *     decoded.value,
 *   );
 *   await recordCommandOutcome(deliveryKey, outcome);
 *   rabbitMQChannel.ack(message);
 * });
 * ```
 */
export interface Command {
	readonly type: string;
}

/**
 * Handler for executing commands.
 * Commands return Result for explicit error handling.
 * Commands may modify system state. When a caller can retry or a broker can
 * redeliver, the application service must enforce idempotency; this handler
 * type alone does not provide it.
 *
 * This type can be used to mark handlers even when using external frameworks
 * (e.g., RabbitMQ, AWS SQS, Kafka) to ensure type safety and consistency.
 *
 * @template C - The command type (must extend Command)
 * @template R - The result type
 * @template E - The error channel type. Defaults to `string`; widen it (e.g.
 *   to a `DomainError` union) to carry typed failures through the bus.
 *
 * @example
 * ```typescript
 * const handler: CommandHandler<CreateOrderCommand, OrderId> = async (cmd) => {
 *   const order = Order.create(cmd.customerId, cmd.items);
 *   await repository.save(order);
 *   return ok(order.id);
 * };
 * ```
 *
 * @example Using with external frameworks
 * ```typescript
 * // Handler typed with CommandHandler for type safety
 * const createOrderHandler: CommandHandler<CreateOrderCommand, OrderId> = async (cmd) => {
 *   // ... handler logic
 *   return ok(orderId);
 * };
 *
 * // The broker adapter validates before calling the application handler.
 * rabbitMQChannel.consume("commands", async (msg) => {
 *   const messageId = decodeMessageId(msg.properties.messageId);
 *   if (messageId.isErr()) {
 *     rabbitMQChannel.reject(msg, false);
 *     return;
 *   }
 *   const deliveryKey = createOrderDeliveryKey(messageId.value);
 *   const principal = authenticateProducer(msg.properties.headers);
 *   const decoded = decodeCreateOrderCommand(msg.content, principal);
 *   if (decoded.isErr()) {
 *     rabbitMQChannel.reject(msg, false); // malformed or over limit
 *     return;
 *   }
 *   // executeIdempotentCreateOrder invokes createOrderHandler through the same
 *   // atomic withIdempotentCommit boundary described in the first example.
 *   const outcome = await executeIdempotentCreateOrder(
 *     deliveryKey,
 *     decoded.value,
 *   );
 *   await recordCommandOutcome(deliveryKey, outcome);
 *   rabbitMQChannel.ack(msg);
 * });
 * ```
 */
export type CommandHandler<C extends Command, R, E = string> = (
	cmd: C,
) => Promise<Result<R, E>>;
