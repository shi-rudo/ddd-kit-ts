import type { Result } from "../core/result";
import { err } from "../core/result";
import type { Command, CommandHandler } from "./command";

/**
 * Type map for command types to their return types.
 * Used to improve type inference in CommandBus.
 *
 * @example
 * ```typescript
 * type MyCommandMap = {
 *   CreateOrder: OrderId;
 *   CancelOrder: void;
 * };
 *
 * const bus = new CommandBus<MyCommandMap>();
 * const result = await bus.execute({ type: "CreateOrder", ... });
 * // result: Result<OrderId, string>  ← automatically inferred
 * ```
 */
type CommandTypeMap = Record<string, unknown>;

/**
 * Command Bus interface for dispatching commands to their handlers.
 * Provides a centralized way to execute commands with handler registration.
 *
 * Supports an optional type map (`TMap`) for automatic return type inference.
 * Without a type map, the return type must be specified manually or defaults to `unknown`.
 *
 * @template TMap - Optional mapping from command type strings to return types
 *
 * @example
 * ```typescript
 * // With type map (recommended) – return type is inferred
 * type MyCommands = { CreateOrder: OrderId; CancelOrder: void };
 * const bus = new CommandBus<MyCommands>();
 * const result = await bus.execute({ type: "CreateOrder", ... });
 * // result: Result<OrderId, string>
 *
 * // Without type map – works like before
 * const bus = new CommandBus();
 * bus.register("CreateOrder", createOrderHandler);
 * const result = await bus.execute({ type: "CreateOrder", ... });
 * // result: Result<unknown, string>
 * ```
 */
export interface ICommandBus<TMap extends CommandTypeMap = CommandTypeMap> {
	/**
	 * Executes a command by dispatching it to the registered handler.
	 * When a type map is provided, the return type is inferred from the command type.
	 *
	 * @param command - The command to execute
	 * @returns Result containing the success value or error message
	 */
	execute<C extends Command & { type: keyof TMap & string }>(
		command: C,
	): Promise<Result<TMap[C["type"]], string>>;
	execute<C extends Command, R>(command: C): Promise<Result<R, string>>;

	/**
	 * Registers a handler for a specific command type.
	 *
	 * @param commandType - The command type to register the handler for
	 * @param handler - The handler function for this command type
	 */
	register<C extends Command, R>(
		commandType: C["type"],
		handler: CommandHandler<C, R>,
	): void;
}

/**
 * Simple in-memory command bus implementation.
 * Handlers are stored in a Map and dispatched based on command type.
 *
 * Supports an optional type map (`TMap`) for automatic return type inference.
 * When `TMap` is provided, `execute()` infers the result type from the command type.
 * Without `TMap`, it works like before (return type defaults to `unknown` or can be specified manually).
 *
 * **Note:** This is a basic implementation suitable for development and simple use cases.
 * For production environments, consider implementing or using a more feature-rich bus that includes:
 * - Middleware/Pipeline support (logging, validation, authorization)
 * - Error handling and retry logic
 * - Timeout handling
 * - Metrics and observability
 * - Transaction management
 * - Dead letter queue support
 *
 * The `CommandHandler` type can still be used with external production-grade buses
 * (e.g., RabbitMQ, AWS SQS) while maintaining type safety.
 *
 * @template TMap - Optional mapping from command type strings to return types
 *
 * @example
 * ```typescript
 * // With type map – full inference
 * type Commands = { CreateOrder: OrderId; CancelOrder: void };
 * const bus = new CommandBus<Commands>();
 * const result = await bus.execute({ type: "CreateOrder", ... });
 * // result: Result<OrderId, string>
 *
 * // Without type map – same as before
 * const bus = new CommandBus();
 * bus.register("CreateOrder", async (cmd) => ok(orderId));
 * const result = await bus.execute({ type: "CreateOrder", ... });
 * ```
 */
export class CommandBus<TMap extends CommandTypeMap = CommandTypeMap>
	implements ICommandBus<TMap>
{
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private readonly handlers = new Map<string, CommandHandler<any, any>>();

	register<C extends Command, R>(
		commandType: C["type"],
		handler: CommandHandler<C, R>,
	): void {
		this.handlers.set(commandType, handler);
	}

	async execute<C extends Command & { type: keyof TMap & string }>(
		command: C,
	): Promise<Result<TMap[C["type"]], string>>;
	async execute<C extends Command, R>(
		command: C,
	): Promise<Result<R, string>>;
	async execute<C extends Command, R>(
		command: C,
	): Promise<Result<R, string>> {
		const handler = this.handlers.get(command.type);
		if (!handler) {
			return err(`No handler registered for command type: ${command.type}`);
		}
		try {
			return await handler(command);
		} catch (error) {
			return err(
				error instanceof Error ? error.message : String(error),
			);
		}
	}
}
