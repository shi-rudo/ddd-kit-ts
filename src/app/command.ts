import type { Result } from "../core/result";

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
 * // Register with RabbitMQ or other external bus
 * rabbitMQChannel.consume("order.commands", async (message) => {
 *   const command = JSON.parse(message.content) as CreateOrderCommand;
 *   const result = await handler(command);
 *   // ... handle result
 * });
 * ```
 */
export interface Command {
	readonly type: string;
}

/**
 * Handler for executing commands.
 * Commands return Result for explicit error handling.
 * Commands may modify system state and should be idempotent when possible.
 *
 * This type can be used to mark handlers even when using external frameworks
 * (e.g., RabbitMQ, AWS SQS, Kafka) to ensure type safety and consistency.
 *
 * @template C - The command type (must extend Command)
 * @template R - The result type
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
 * // Can be used with any external bus/framework
 * // RabbitMQ example:
 * rabbitMQChannel.consume("commands", async (msg) => {
 *   const command = JSON.parse(msg.content) as CreateOrderCommand;
 *   const result = await createOrderHandler(command);
 *   // ... handle result
 * });
 *
 * // AWS SQS example:
 * sqs.receiveMessage({ QueueUrl: "..." }, async (err, data) => {
 *   const command = JSON.parse(data.Messages[0].Body) as CreateOrderCommand;
 *   const result = await createOrderHandler(command);
 *   // ... handle result
 * });
 * ```
 */
export type CommandHandler<C extends Command, R> = (
	cmd: C,
) => Promise<Result<R, string>>;

