import type { AggregateSnapshot } from "../aggregate/aggregate";
import {
	type AggregateAddress,
	encodeAggregateAddress,
} from "../aggregate/aggregate-address";
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
		address: AggregateAddress,
	): Promise<AggregateSnapshot<TState> | undefined> {
		const stored = this.snapshots.get(encodeAggregateAddress(address));
		return stored === undefined ? undefined : structuredClone(stored);
	}

	async save(
		address: AggregateAddress,
		snapshot: AggregateSnapshot<TState>,
	): Promise<void> {
		this.snapshots.set(
			encodeAggregateAddress(address),
			structuredClone(snapshot),
		);
	}

	async delete(address: AggregateAddress): Promise<void> {
		this.snapshots.delete(encodeAggregateAddress(address));
	}
}
