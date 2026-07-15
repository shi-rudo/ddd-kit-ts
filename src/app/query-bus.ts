import { ok, type Result } from "@shirudo/result";
import {
	type ExpectedErrorMapper,
	handlerOrThrow,
	mapHandlerFailure,
	registerOnce,
} from "./bus-internals";
import type { Query, QueryHandler } from "./query";

/**
 * Internal adapter shape for handlers stored in the map.
 *
 * Registered handlers are typed as `QueryHandler<Q, TMap[K]>` (narrower
 * input, specific return) and cannot be stored directly in a heterogeneous
 * map (function-parameter contravariance). The closure in `register`
 * downcasts `Query` to the handler's expected `Q` based on the
 * dispatch-key invariant (we only call this entry when `query.type` matches
 * the key it was registered under). Result is widened to `unknown` here
 * and narrowed back via the public overloads on `execute` / `executeUnsafe`.
 */
type StoredQueryHandler = (query: Query) => Promise<unknown>;

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
 * Construction options for {@link QueryBus}.
 *
 * @template E - The error channel type of the bus.
 */
export interface QueryBusOptions<E = string> {
	/**
	 * Explicitly recognizes an expected handler failure and maps it into the
	 * bus's error channel. Return `{ error }` only for failures this boundary
	 * owns; return `undefined` to rethrow the exact original value. With no
	 * mapper, every handler throw propagates. Unregistered-handler and nested
	 * bus wiring errors always propagate.
	 */
	mapExpectedError?: (thrown: unknown) => { readonly error: E } | undefined;
}

/**
 * Query Bus interface for dispatching queries to their handlers.
 * Provides a centralized way to execute queries with handler registration.
 *
 * Supports an optional type map (`TMap`) for automatic return type inference.
 * Without a type map, the return type must be specified manually or defaults to `unknown`.
 * With a concrete result map, its entry is the only result type for that
 * query; the loose explicit-result overloads are unavailable.
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
export interface IQueryBus<
	TMap extends QueryTypeMap = QueryTypeMap,
	E = string,
> {
	/**
	 * Executes a query by dispatching it to the registered handler.
	 * When a type map is provided, the return type is inferred from the query type.
	 *
	 * @param query - The query to execute
	 * @returns Result containing the query result if successful, or an error of type `E`
	 * @throws UnregisteredHandlerError when no handler is registered for
	 *   `query.type` (a wiring bug; never delivered through the channel)
	 * @throws The exact handler failure when `mapExpectedError` is absent or
	 *   returns `undefined`
	 * @throws ErrorMapperFailedError when `mapExpectedError` fails
	 */
	execute<Q extends Query & { type: keyof TMap & string }>(
		query: Q,
	): Promise<Result<TMap[Q["type"]], E>>;
	// Manual result typing belongs only to the default untyped map shape.
	execute<Q extends Query, R>(
		query: 0 extends 1 & TMap
			? never
			: string extends keyof TMap
				? Record<string, unknown> extends TMap
					? Q
					: never
				: never,
	): Promise<Result<R, E>>;

	/**
	 * Executes a query by dispatching it to the registered handler.
	 * Throws an error if no handler is registered.
	 *
	 * @param query - The query to execute
	 * @returns The query result
	 * @throws The exact handler failure or UnregisteredHandlerError
	 */
	executeUnsafe<Q extends Query & { type: keyof TMap & string }>(
		query: Q,
	): Promise<TMap[Q["type"]]>;
	executeUnsafe<Q extends Query, R>(
		query: 0 extends 1 & TMap
			? never
			: string extends keyof TMap
				? Record<string, unknown> extends TMap
					? Q
					: never
				: never,
	): Promise<R>;

	/**
	 * Registers a handler for a specific query type.
	 *
	 * When `TMap` is supplied, the `queryType` argument is restricted to its
	 * keys and the handler signature is forced to match `TMap[K]` for the
	 * return value: typos and wrong-typed handlers are compile errors.
	 * Without `TMap` the registration is loose (any string key, any return
	 * type) so the no-config path keeps working.
	 *
	 * @param queryType - The query type to register the handler for
	 * @param handler - The handler function for this query type
	 */
	register<
		K extends keyof TMap & string,
		Q extends Query & { type: K } = Query & { type: K },
	>(queryType: K, handler: QueryHandler<Q, TMap[K]>): void;
}

/**
 * Simple in-memory query bus implementation.
 * Handlers are stored in a Map and dispatched based on query type.
 *
 * Supports an optional type map (`TMap`) for automatic return type inference.
 * When `TMap` is concrete, `execute()` and `executeUnsafe()` infer the result type from the query type.
 * Explicit competing result generics cannot override that map.
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
 * bus.register("GetOrder", async (query) => repository.findById(query.orderId));
 * const result = await bus.execute({ type: "GetOrder", orderId: "123" });
 * ```
 */
export class QueryBus<TMap extends QueryTypeMap = QueryTypeMap, E = string>
	implements IQueryBus<TMap, E>
{
	private readonly handlers = new Map<string, StoredQueryHandler>();
	private readonly mapExpectedError: ExpectedErrorMapper<E> | undefined;

	constructor(options?: QueryBusOptions<E>) {
		this.mapExpectedError = options?.mapExpectedError;
	}

	register<
		K extends keyof TMap & string,
		Q extends Query & { type: K } = Query & { type: K },
	>(queryType: K, handler: QueryHandler<Q, TMap[K]>): void {
		registerOnce(this.handlers, "query", queryType, (query: Query) =>
			handler(query as Q),
		);
	}

	async execute<Q extends Query & { type: keyof TMap & string }>(
		query: Q,
	): Promise<Result<TMap[Q["type"]], E>>;
	// Keep the class surface identical to IQueryBus's untyped fallback.
	async execute<Q extends Query, R>(
		query: 0 extends 1 & TMap
			? never
			: string extends keyof TMap
				? Record<string, unknown> extends TMap
					? Q
					: never
				: never,
	): Promise<Result<R, E>>;
	async execute<Q extends Query, R>(query: Q): Promise<Result<R, E>> {
		const handler = handlerOrThrow(this.handlers, "query", query.type);
		try {
			const result = (await handler(query)) as R;
			return ok(result);
		} catch (error) {
			return mapHandlerFailure(error, this.mapExpectedError, "query");
		}
	}

	async executeUnsafe<Q extends Query & { type: keyof TMap & string }>(
		query: Q,
	): Promise<TMap[Q["type"]]>;
	async executeUnsafe<Q extends Query, R>(
		query: 0 extends 1 & TMap
			? never
			: string extends keyof TMap
				? Record<string, unknown> extends TMap
					? Q
					: never
				: never,
	): Promise<R>;
	async executeUnsafe<Q extends Query, R>(query: Q): Promise<R> {
		// Same no-handler gate as execute: one implementation so the two
		// paths cannot drift.
		const handler = handlerOrThrow(this.handlers, "query", query.type);
		return (await handler(query)) as R;
	}
}
