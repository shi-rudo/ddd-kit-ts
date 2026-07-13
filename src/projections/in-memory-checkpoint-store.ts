import {
	type AggregateAddress,
	encodeAggregateAddress,
} from "../aggregate/aggregate-address";
import {
	isPositionAfter,
	type ProjectionCheckpoint,
	type ProjectionCheckpointStore,
	type ProjectionPosition,
} from "./ports";

/**
 * In-memory reference implementation of
 * {@link ProjectionCheckpointStore}: defines the port's semantics and
 * serves tests and in-memory read models.
 *
 * Its checkpoint-key locks serialize competing projectors only inside one
 * process and only when they share this store instance. It is **not
 * transaction-aware** (the `ctx` parameter is ignored): a rolled-back
 * projector batch does not roll back its checkpoints. Use it for tests and
 * disposable in-memory read models; production atomicity is the durable
 * adapter's contract, proved with `createProjectionCheckpointStoreContractTests`
 * and its rollback capability.
 *
 * Do not nest `withCheckpointLocks` calls whose key sets overlap. This
 * reference has no async-context tracking for reentrancy: a nested call waits
 * on the key its caller still holds and therefore neither enters nor fails
 * loudly.
 */
export class InMemoryProjectionCheckpointStore
	implements ProjectionCheckpointStore<unknown>
{
	/** projection name -> JSON [aggregateType, aggregateId] -> receipt */
	private readonly checkpoints = new Map<
		string,
		Map<string, ProjectionCheckpoint>
	>();
	/** Full checkpoint key -> tail of the process-local exclusive-access queue. */
	private readonly lockTails = new Map<string, Promise<void>>();

	async withCheckpointLocks<R>(
		_ctx: unknown,
		projection: string,
		addresses: ReadonlyArray<AggregateAddress>,
		work: () => Promise<R>,
	): Promise<R> {
		const keys = [
			...new Set(
				addresses.map((address) =>
					JSON.stringify([
						projection,
						address.aggregateType,
						address.aggregateId,
					]),
				),
			),
		].sort();
		const releases: Array<() => void> = [];

		for (const key of keys) {
			const previous = this.lockTails.get(key) ?? Promise.resolve();
			let releaseCurrent!: () => void;
			const current = new Promise<void>((resolve) => {
				releaseCurrent = resolve;
			});
			const tail = previous.then(() => current);
			this.lockTails.set(key, tail);
			await previous;
			releases.push(() => {
				releaseCurrent();
				if (this.lockTails.get(key) === tail) this.lockTails.delete(key);
			});
		}

		try {
			return await work();
		} finally {
			for (let index = releases.length - 1; index >= 0; index -= 1) {
				releases[index]?.();
			}
		}
	}

	async load(
		_ctx: unknown,
		projection: string,
		address: AggregateAddress,
	): Promise<ProjectionCheckpoint | undefined> {
		const stored = this.checkpoints
			.get(projection)
			?.get(encodeAggregateAddress(address));
		// Detached copy: a caller mutating the loaded receipt must not
		// move the stored watermark.
		return stored === undefined
			? undefined
			: { ...stored, position: { ...stored.position } };
	}

	async save(
		_ctx: unknown,
		projection: string,
		address: AggregateAddress,
		checkpoint: ProjectionCheckpoint,
	): Promise<void> {
		let perAggregate = this.checkpoints.get(projection);
		if (perAggregate === undefined) {
			perAggregate = new Map();
			this.checkpoints.set(projection, perAggregate);
		}
		perAggregate.set(encodeAggregateAddress(address), {
			...checkpoint,
			position: { ...checkpoint.position },
		});
	}

	async hasReached(
		projection: string,
		address: AggregateAddress,
		position: ProjectionPosition,
	): Promise<boolean> {
		const stored = this.checkpoints
			.get(projection)
			?.get(encodeAggregateAddress(address));
		if (stored === undefined) return false;
		return !isPositionAfter(position, stored.position);
	}

	async reset(_ctx: unknown, projection: string): Promise<void> {
		this.checkpoints.delete(projection);
	}
}
