import type { AggregateSnapshot } from "../aggregate/aggregate";
import type { Id } from "../core/id";
import type { SnapshotStore } from "./snapshot-store";

/**
 * In-memory reference implementation of {@link SnapshotStore}: defines
 * the port's semantics and serves tests and demos. Snapshots are
 * deep-copied on save AND load (`structuredClone`; snapshot state is
 * plain data by the `createSnapshot` contract), so neither the caller
 * nor the store can mutate the other's copy.
 */
export class InMemorySnapshotStore<TState = unknown>
	implements SnapshotStore<TState>
{
	private readonly snapshots = new Map<string, AggregateSnapshot<TState>>();

	async load(
		aggregateType: string,
		aggregateId: Id<string>,
	): Promise<AggregateSnapshot<TState> | undefined> {
		const stored = this.snapshots.get(key(aggregateType, aggregateId));
		return stored === undefined ? undefined : structuredClone(stored);
	}

	async save(
		aggregateType: string,
		aggregateId: Id<string>,
		snapshot: AggregateSnapshot<TState>,
	): Promise<void> {
		this.snapshots.set(
			key(aggregateType, aggregateId),
			structuredClone(snapshot),
		);
	}

	async delete(aggregateType: string, aggregateId: Id<string>): Promise<void> {
		this.snapshots.delete(key(aggregateType, aggregateId));
	}
}

/** NUL-separated so no type/id concatenation can collide. */
function key(aggregateType: string, aggregateId: Id<string>): string {
	return `${aggregateType}\u0000${String(aggregateId)}`;
}
