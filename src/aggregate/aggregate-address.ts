/**
 * Stable value address of one aggregate instance.
 *
 * Aggregate ids are type-scoped, so the raw id alone is not globally unique:
 * `SalesOrder 1` and `FulfillmentOrder 1` are different aggregates. Event
 * streams, snapshots, committed-event sources, and projection checkpoints
 * therefore carry both fields instead of defining boundary-specific variants.
 *
 * `aggregateType` is a stable technical stream category. Renaming it changes
 * persistence keys and orphans checkpoints unless the stored addresses are
 * migrated. When bounded contexts share infrastructure and reuse a domain
 * name, qualify it at the source (`sales.order`, `fulfillment.order`). The kit
 * deliberately adds no separate `boundedContext` field: qualification remains
 * the consumer's naming decision.
 */
export interface AggregateAddress<TAggregateId extends string = string> {
	readonly aggregateType: string;
	readonly aggregateId: TAggregateId;
}

/**
 * Collision-safe map-key encoding shared by the in-memory adapters.
 * Internal: durable adapters key on the two storage columns themselves.
 */
export function encodeAggregateAddress(address: AggregateAddress): string {
	return JSON.stringify([address.aggregateType, address.aggregateId]);
}
