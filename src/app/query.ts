/**
 * Marker interface for Queries.
 * Queries represent read operations that don't change system state.
 * They should be immutable and contain all data needed to perform the read.
 *
 * This interface can be used as a type marker even when using external frameworks
 * (e.g., RabbitMQ, AWS SQS) to ensure type safety across different bus implementations.
 *
 * @example
 * ```typescript
 * type GetOrderQuery = Query & {
 *   type: "GetOrder";
 *   orderId: OrderId;
 * };
 * ```
 *
 * @example Using with external frameworks
 * ```typescript
 * type GetOrderQuery = Query & {
 *   type: "GetOrder";
 *   orderId: OrderId;
 * };
 *
 * // Handler typed with QueryHandler for type safety
 * const handler: QueryHandler<GetOrderQuery, Order | null> = async (query) => {
 *   return await repository.getById(query.orderId);
 * };
 *
 * // Can be used with any external framework
 * rabbitMQChannel.consume("queries", async (message) => {
 *   const query = JSON.parse(message.content) as GetOrderQuery;
 *   const result = await handler(query);
 *   // ... handle result
 * });
 * ```
 */
export interface Query {
	readonly type: string;
}

/**
 * Handler for executing queries.
 * Queries return data directly (no Result type) as read operations
 * are not expected to fail in normal circumstances.
 * Queries should not modify system state and can be cached.
 *
 * This type can be used to mark handlers even when using external frameworks
 * (e.g., RabbitMQ, AWS SQS, Kafka) to ensure type safety and consistency.
 *
 * @template Q - The query type (must extend Query)
 * @template R - The result type
 *
 * @example
 * ```typescript
 * const handler: QueryHandler<GetOrderQuery, Order | null> = async (query) => {
 *   return await repository.getById(query.orderId);
 * };
 * ```
 *
 * @example Using with external frameworks
 * ```typescript
 * // Handler typed with QueryHandler for type safety
 * const getOrderHandler: QueryHandler<GetOrderQuery, Order | null> = async (query) => {
 *   return await repository.getById(query.orderId);
 * };
 *
 * // Can be used with any external bus/framework
 * rabbitMQChannel.consume("queries", async (msg) => {
 *   const query = JSON.parse(msg.content) as GetOrderQuery;
 *   const result = await getOrderHandler(query);
 *   // ... handle result
 * });
 * ```
 */
export type QueryHandler<Q extends Query, R> = (query: Q) => Promise<R>;

