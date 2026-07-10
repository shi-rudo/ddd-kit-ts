import {
	type AggregateAddress,
	isPositionAfter,
	type ProjectionCheckpointStore,
	type ProjectionPosition,
} from "./ports";

// Unambiguous tuple encoding: JSON escapes every character, so no
// separator inside either half (both are arbitrary JS strings) can
// make two different addresses collide.
function addressKey(address: AggregateAddress): string {
	return JSON.stringify([address.aggregateType, address.aggregateId]);
}

/**
 * In-memory reference implementation of
 * {@link ProjectionCheckpointStore}: defines the port's semantics and
 * serves tests and in-memory read models.
 *
 * **Not transaction-aware** (the `ctx` parameter is ignored), the same
 * documented limitation as the other in-memory references: a
 * rolled-back projector batch does NOT roll back its checkpoints. That
 * is harmless when the read model is in-memory too (both survive or
 * neither matters), but the atomic update+checkpoint guarantee that
 * production needs is the SQL adapter's contract; prove it with
 * `createProjectionCheckpointStoreContractTests` and its rollback
 * capability.
 */
export class InMemoryProjectionCheckpointStore
	implements ProjectionCheckpointStore<unknown>
{
	/** projection name -> JSON [aggregateType, aggregateId] -> watermark */
	private readonly checkpoints = new Map<
		string,
		Map<string, ProjectionPosition>
	>();

	async load(
		_ctx: unknown,
		projection: string,
		address: AggregateAddress,
	): Promise<ProjectionPosition | undefined> {
		const stored = this.checkpoints.get(projection)?.get(addressKey(address));
		// Detached copy: a caller mutating the loaded position must not
		// move the stored watermark.
		return stored === undefined ? undefined : { ...stored };
	}

	async save(
		_ctx: unknown,
		projection: string,
		address: AggregateAddress,
		position: ProjectionPosition,
	): Promise<void> {
		let perAggregate = this.checkpoints.get(projection);
		if (perAggregate === undefined) {
			perAggregate = new Map();
			this.checkpoints.set(projection, perAggregate);
		}
		perAggregate.set(addressKey(address), { ...position });
	}

	async hasReached(
		projection: string,
		address: AggregateAddress,
		position: ProjectionPosition,
	): Promise<boolean> {
		const stored = this.checkpoints.get(projection)?.get(addressKey(address));
		if (stored === undefined) return false;
		return !isPositionAfter(position, stored);
	}

	async reset(_ctx: unknown, projection: string): Promise<void> {
		this.checkpoints.delete(projection);
	}
}
