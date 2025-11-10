import { err, ok, type Result } from "../core/result";
import type { Query, QueryHandler } from "./query";

/**
 * Query Bus interface for dispatching queries to their handlers.
 * Provides a centralized way to execute queries with handler registration.
 *
 * @example
 * ```typescript
 * const bus = new QueryBus();
 * bus.register("GetOrder", getOrderHandler);
 *
 * const order = await bus.execute({
 *   type: "GetOrder",
 *   orderId: "123"
 * });
 * ```
 */
export interface IQueryBus {
	/**
	 * Executes a query by dispatching it to the registered handler.
	 * Returns a Result type instead of throwing an error.
	 *
	 * @param query - The query to execute
	 * @returns Result containing the query result if successful, or an error message if no handler is registered
	 */
	execute<Q extends Query, R>(query: Q): Promise<Result<R, string>>;

	/**
	 * Executes a query by dispatching it to the registered handler.
	 * Throws an error if no handler is registered.
	 *
	 * @param query - The query to execute
	 * @returns The query result
	 * @throws Error if no handler is registered for the query type
	 */
	executeUnsafe<Q extends Query, R>(query: Q): Promise<R>;

	/**
	 * Registers a handler for a specific query type.
	 *
	 * @param queryType - The query type to register the handler for
	 * @param handler - The handler function for this query type
	 */
	register<Q extends Query, R>(
		queryType: Q["type"],
		handler: QueryHandler<Q, R>,
	): void;
}

/**
 * Type map for query types to their return types.
 * Used to improve type inference in QueryBus.
 */
type QueryTypeMap = Record<string, unknown>;

/**
 * Simple in-memory query bus implementation.
 * Handlers are stored in a Map and dispatched based on query type.
 *
 * **Note:** This is a basic implementation suitable for development and simple use cases.
 * For production environments, consider implementing or using a more feature-rich bus that includes:
 * - Middleware/Pipeline support (logging, caching, rate limiting)
 * - Error handling
 * - Timeout handling
 * - Metrics and observability
 * - Query result caching
 * - Rate limiting
 *
 * The `QueryHandler` type can still be used with external production-grade buses
 * (e.g., RabbitMQ, AWS SQS) while maintaining type safety.
 *
 * @example
 * ```typescript
 * const bus = new QueryBus();
 * bus.register("GetOrder", async (query) => {
 *   return await repository.getById(query.orderId);
 * });
 *
 * const order = await bus.execute({ type: "GetOrder", orderId: "123" });
 * ```
 */
export class QueryBus<TMap extends QueryTypeMap = QueryTypeMap>
	implements IQueryBus
{
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private readonly handlers = new Map<string, QueryHandler<any, any>>();

	register<Q extends Query, R>(
		queryType: Q["type"],
		handler: QueryHandler<Q, R>,
	): void {
		this.handlers.set(queryType, handler);
	}

	async execute<Q extends Query & { type: keyof TMap }>(
		query: Q,
	): Promise<Result<TMap[Q["type"]], string>>;
	async execute<Q extends Query, R>(query: Q): Promise<Result<R, string>>;
	async execute<Q extends Query, R>(query: Q): Promise<Result<R, string>> {
		const handler = this.handlers.get(query.type);
		if (!handler) {
			return err(`No handler registered for query type: ${query.type}`);
		}
		try {
			const result = await handler(query);
			return ok(result);
		} catch (error) {
			return err(
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	async executeUnsafe<Q extends Query, R>(query: Q): Promise<R> {
		const handler = this.handlers.get(query.type);
		if (!handler) {
			throw new Error(`No handler registered for query type: ${query.type}`);
		}
		return handler(query);
	}
}

