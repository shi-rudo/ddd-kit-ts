import type { Result } from "../core/result";
import { err } from "../core/result";
import type { Command, CommandHandler } from "./command";

/**
 * Command Bus interface for dispatching commands to their handlers.
 * Provides a centralized way to execute commands with handler registration.
 *
 * @example
 * ```typescript
 * const bus = new CommandBus();
 * bus.register("CreateOrder", createOrderHandler);
 *
 * const result = await bus.execute({
 *   type: "CreateOrder",
 *   customerId: "123",
 *   items: [...]
 * });
 * ```
 */
export interface ICommandBus {
	/**
	 * Executes a command by dispatching it to the registered handler.
	 *
	 * @param command - The command to execute
	 * @returns Result containing the success value or error message
	 */
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
 * @example
 * ```typescript
 * const bus = new CommandBus();
 * bus.register("CreateOrder", async (cmd) => {
 *   // ... handler logic
 *   return ok(orderId);
 * });
 *
 * const result = await bus.execute({ type: "CreateOrder", ... });
 * ```
 */
export class CommandBus implements ICommandBus {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private readonly handlers = new Map<string, CommandHandler<any, any>>();

	register<C extends Command, R>(
		commandType: C["type"],
		handler: CommandHandler<C, R>,
	): void {
		this.handlers.set(commandType, handler);
	}

	async execute<C extends Command, R>(
		command: C,
	): Promise<Result<R, string>> {
		const handler = this.handlers.get(command.type);
		if (!handler) {
			return err(`No handler registered for command type: ${command.type}`);
		}
		return handler(command);
	}
}

