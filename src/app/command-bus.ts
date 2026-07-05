import type { Result } from "@shirudo/result";
import {
	type BusArgs,
	handlerOrThrow,
	mapHandlerFailure,
	registerOnce,
	resolveErrorMapper,
} from "./bus-internals";
import type { Command, CommandHandler } from "./command";

/**
 * Internal adapter shape for handlers stored in the map.
 *
 * Registered handlers are typed as `CommandHandler<C, TMap[K]>` (narrower
 * input, specific return) and cannot be stored directly in a heterogeneous
 * map (function-parameter contravariance). The closure in `register`
 * downcasts `Command` to the handler's expected `C` based on the
 * dispatch-key invariant (we only call this entry when `cmd.type` matches
 * the key it was registered under). Result is widened to `unknown` here
 * and narrowed back via the public overloads on `execute`.
 */
type StoredCommandHandler<E> = (cmd: Command) => Promise<Result<unknown, E>>;

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
 * Construction options for {@link CommandBus}.
 *
 * @template E - The error channel type of the bus.
 */
export interface CommandBusOptions<E = string> {
	/**
	 * Maps a value thrown by a registered handler into the bus's error
	 * channel `E`. Dispatching an unregistered command type is NOT mapped:
	 * that wiring bug throws `UnregisteredHandlerError`. Defaults to
	 * `describeThrown`, which renders any thrown value as a `string`.
	 * base-error's `toStructuredError` fits this slot directly when `E` is a
	 * `StructuredError`.
	 */
	errorMapper?: (thrown: unknown) => E;
}

/**
 * Constructor arguments for {@link CommandBus}. When `E` is the default
 * `string`, options are optional (the built-in `describeThrown` mapper
 * applies). When `E` is widened, an `errorMapper` is required, so a typed
 * channel can never silently fall back to string values. The conditional
 * lives in the shared {@link BusArgs} so the two buses cannot drift.
 */
type CommandBusArgs<E> = BusArgs<E, CommandBusOptions<E>>;

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
export interface ICommandBus<
	TMap extends CommandTypeMap = CommandTypeMap,
	E = string,
> {
	/**
	 * Executes a command by dispatching it to the registered handler.
	 * When a type map is provided, the return type is inferred from the command type.
	 *
	 * @param command - The command to execute
	 * @returns Result containing the success value or an error of type `E`
	 * @throws UnregisteredHandlerError when no handler is registered for
	 *   `command.type` (a wiring bug; never delivered through the channel)
	 */
	execute<C extends Command & { type: keyof TMap & string }>(
		command: C,
	): Promise<Result<TMap[C["type"]], E>>;
	execute<C extends Command, R>(command: C): Promise<Result<R, E>>;

	/**
	 * Registers a handler for a specific command type.
	 *
	 * When `TMap` is supplied, the `commandType` argument is restricted to
	 * its keys and the handler signature is forced to match `TMap[K]` for the
	 * return value: typos and wrong-typed handlers are compile errors.
	 * Without `TMap` the registration is loose (any string key, any return
	 * type) so the no-config path keeps working.
	 *
	 * @param commandType - The command type to register the handler for
	 * @param handler - The handler function for this command type
	 */
	register<
		K extends keyof TMap & string,
		C extends Command & { type: K } = Command & { type: K },
	>(commandType: K, handler: CommandHandler<C, TMap[K], E>): void;
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
export class CommandBus<
	TMap extends CommandTypeMap = CommandTypeMap,
	E = string,
> implements ICommandBus<TMap, E>
{
	private readonly handlers = new Map<string, StoredCommandHandler<E>>();
	private readonly errorMapper: (thrown: unknown) => E;

	constructor(...args: CommandBusArgs<E>) {
		this.errorMapper = resolveErrorMapper(args[0]);
	}

	register<
		K extends keyof TMap & string,
		C extends Command & { type: K } = Command & { type: K },
	>(commandType: K, handler: CommandHandler<C, TMap[K], E>): void {
		registerOnce(this.handlers, "command", commandType, (cmd: Command) =>
			handler(cmd as C),
		);
	}

	async execute<C extends Command & { type: keyof TMap & string }>(
		command: C,
	): Promise<Result<TMap[C["type"]], E>>;
	async execute<C extends Command, R>(command: C): Promise<Result<R, E>>;
	async execute<C extends Command, R>(command: C): Promise<Result<R, E>> {
		// No-handler dispatch is a wiring bug, not a domain failure: thrown,
		// never delivered through the error channel (see handlerOrThrow).
		const handler = handlerOrThrow(this.handlers, "command", command.type);
		try {
			return (await handler(command)) as Result<R, E>;
		} catch (error) {
			return mapHandlerFailure(error, this.errorMapper, "command");
		}
	}
}
