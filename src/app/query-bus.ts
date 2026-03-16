import { err, ok, type Result } from "../core/result";
import type { Query, QueryHandler } from "./query";

/**
 * Type map for query types to their return types.
 * Used to improve type inference in QueryBus.
 *
 * @example
 * ```typescript
 * type MyQueryMap = {
 *   GetOrder: Order | null;
 *   ListOrders: Order[];
 * };
 *
 * const bus = new QueryBus<MyQueryMap>();
 * const result = await bus.execute({ type: "GetOrder", orderId: "123" });
 * // result: Result<Order | null, string>  ← automatically inferred
 * ```
 */
type QueryTypeMap = Record<string, unknown>;

/**
 * Query Bus interface for dispatching queries to their handlers.
 * Provides a centralized way to execute queries with handler registration.
 *
 * Supports an optional type map (`TMap`) for automatic return type inference.
 * Without a type map, the return type must be specified manually or defaults to `unknown`.
 *
 * @template TMap - Optional mapping from query type strings to return types
 *
 * @example
 * ```typescript
 * // With type map (recommended) – return type is inferred
 * type MyQueries = { GetOrder: Order | null; ListOrders: Order[] };
 * const bus = new QueryBus<MyQueries>();
 * const result = await bus.execute({ type: "GetOrder", orderId: "123" });
 * // result: Result<Order | null, string>
 *
 * // Without type map – works like before
 * const bus = new QueryBus();
 * const result = await bus.execute({ type: "GetOrder", orderId: "123" });
 * // result: Result<unknown, string>
 * ```
 */
export interface IQueryBus<TMap extends QueryTypeMap = QueryTypeMap> {
	/**
	 * Executes a query by dispatching it to the registered handler.
	 * When a type map is provided, the return type is inferred from the query type.
	 *
	 * @param query - The query to execute
	 * @returns Result containing the query result if successful, or an error message
	 */
	execute<Q extends Query & { type: keyof TMap & string }>(
		query: Q,
	): Promise<Result<TMap[Q["type"]], string>>;
	execute<Q extends Query, R>(query: Q): Promise<Result<R, string>>;

	/**
	 * Executes a query by dispatching it to the registered handler.
	 * Throws an error if no handler is registered.
	 *
	 * @param query - The query to execute
	 * @returns The query result
	 * @throws Error if no handler is registered for the query type
	 */
	executeUnsafe<Q extends Query & { type: keyof TMap & string }>(
		query: Q,
	): Promise<TMap[Q["type"]]>;
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
 * Simple in-memory query bus implementation.
 * Handlers are stored in a Map and dispatched based on query type.
 *
 * Supports an optional type map (`TMap`) for automatic return type inference.
 * When `TMap` is provided, `execute()` and `executeUnsafe()` infer the result type from the query type.
 * Without `TMap`, it works like before (return type defaults to `unknown` or can be specified manually).
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
 * @template TMap - Optional mapping from query type strings to return types
 *
 * @example
 * ```typescript
 * // With type map – full inference
 * type Queries = { GetOrder: Order | null; ListOrders: Order[] };
 * const bus = new QueryBus<Queries>();
 * const result = await bus.execute({ type: "GetOrder", orderId: "123" });
 * // result: Result<Order | null, string>
 *
 * // Without type map – same as before
 * const bus = new QueryBus();
 * bus.register("GetOrder", async (query) => repository.getById(query.orderId));
 * const result = await bus.execute({ type: "GetOrder", orderId: "123" });
 * ```
 */
export class QueryBus<TMap extends QueryTypeMap = QueryTypeMap>
	implements IQueryBus<TMap>
{
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private readonly handlers = new Map<string, QueryHandler<any, any>>();

	register<Q extends Query, R>(
		queryType: Q["type"],
		handler: QueryHandler<Q, R>,
	): void {
		this.handlers.set(queryType, handler);
	}

	async execute<Q extends Query & { type: keyof TMap & string }>(
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

	async executeUnsafe<Q extends Query & { type: keyof TMap & string }>(
		query: Q,
	): Promise<TMap[Q["type"]]>;
	async executeUnsafe<Q extends Query, R>(query: Q): Promise<R>;
	async executeUnsafe<Q extends Query, R>(query: Q): Promise<R> {
		const handler = this.handlers.get(query.type);
		if (!handler) {
			throw new Error(`No handler registered for query type: ${query.type}`);
		}
		return handler(query);
	}
}
