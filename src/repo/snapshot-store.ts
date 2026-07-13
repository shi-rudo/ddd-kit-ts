import type { AggregateSnapshot } from "../aggregate/aggregate";
import type { AggregateAddress } from "../aggregate/aggregate-address";

/**
 * Driven port for aggregate snapshot persistence: the storage half of
 * the snapshot-plus-recent-events load path for event-sourced
 * aggregates (`createSnapshot` / `restoreFromSnapshotWithEvents` are
 * the aggregate half; `EventStore.readStream`'s `fromVersion` is the
 * catch-up read).
 *
 * **A snapshot is derived data, never authority.** The stream remains
 * the source of truth; a snapshot only shortens replay. That shapes
 * the port:
 *
 * - **Transaction-free by design.** Unlike the outbox or the
 *   idempotency store, saving a snapshot does NOT belong in the write
 *   transaction: write it after the commit, out of band, on whatever
 *   cadence your policy picks. A lost save costs replay time, not
 *   correctness; a stale snapshot is caught up by the event tail.
 * - **Latest only.** One snapshot per `(aggregateType, aggregateId)`;
 *   `save` replaces the previous one. Snapshot history has no reader
 *   in this load path.
 * - **WHEN to snapshot is policy and stays with the consumer** (every
 *   N events after commit is the usual shape); the kit ships the port,
 *   not the policy.
 *
 * Contract for implementations (verified by
 * `createSnapshotStoreContractTests` from `@shirudo/ddd-kit/testing`):
 * the snapshot round-trips verbatim (`state` as plain data,
 * `version`, `snapshotAt` with millisecond fidelity, `schemaVersion`
 * including its absence), loads return detached copies (never live
 * internal state), and keys are isolated per aggregate type AND id
 * (one table may serve every aggregate type).
 *
 * @template TState - The snapshot state shape (the aggregate's
 * `TSnapshotState`); a store shared across aggregate types is a
 * `SnapshotStore<unknown>` with typed views per repository
 */
export interface SnapshotStore<TState = unknown> {
	/**
	 * The latest snapshot for the aggregate, or `undefined` when none
	 * exists. The repository falls back to a full replay then.
	 */
	load(
		address: AggregateAddress,
	): Promise<AggregateSnapshot<TState> | undefined>;

	/**
	 * Persists `snapshot` as the new latest for the aggregate,
	 * replacing any previous one. Called AFTER the write transaction
	 * committed (see the port docs); a single-row upsert is the
	 * standard implementation.
	 */
	save(
		address: AggregateAddress,
		snapshot: AggregateSnapshot<TState>,
	): Promise<void>;

	/**
	 * Removes the aggregate's snapshot; a no-op when none exists. The
	 * two callers: the schema-migration fallback (a
	 * `SnapshotSchemaMismatchError` or a corrupt-snapshot `Err` on
	 * restore discards the snapshot and refolds from the full stream)
	 * and erasure (a snapshot duplicates aggregate state and follows
	 * the same retention rules). When erasing, delete the snapshot
	 * BEFORE the event stream: the reverse order has a crash window in
	 * which a stale snapshot resurrects the erased aggregate on the
	 * snapshot load path; snapshot-first degrades to a full replay.
	 */
	delete(address: AggregateAddress): Promise<void>;
}
