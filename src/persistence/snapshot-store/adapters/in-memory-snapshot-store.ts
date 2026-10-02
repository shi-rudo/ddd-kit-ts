import type { AggregateSnapshot } from "../../../domain/aggregate/aggregate";
import {
	type AggregateIdentity,
	encodeAggregateIdentity,
} from "../../../domain/aggregate/aggregate-identity";
import { assertPositiveSafeInteger } from "../../../internal/validate";
import type {
	InMemoryTransaction,
	InMemoryTransactionParticipant,
} from "../../repository/in-memory-transaction";
import type { SnapshotStore } from "../snapshot-store";

export interface InMemorySnapshotStoreOptions {
	/** Maximum retained snapshots. The least recently used entry is evicted. */
	readonly maxEntries?: number;
	/** Snapshot lifetime from the most recent save. Loads do not extend it. */
	readonly ttlMs?: number;
	/** Store-local clock used only when `ttlMs` is configured. */
	readonly clock?: () => Date;
}

interface StoredSnapshot<TState> {
	readonly snapshot: AggregateSnapshot<TState>;
	readonly expiresAtMs?: number;
}

/**
 * In-memory reference implementation of {@link SnapshotStore}: defines
 * the port's semantics and serves tests and demos. Snapshots are
 * deep-copied on save AND load (`structuredClone`; snapshot state is
 * serialisable data by the `SnapshotModel` contract), so neither the caller
 * nor the store can mutate the other's copy.
 *
 * Unconfigured retention is intended only for finite-lifetime tests and
 * demos. Unlike event history, receipts, or checkpoints, snapshots are
 * rebuildable derived data, so `maxEntries` may evict the least recently used
 * entry and `ttlMs` may expire it safely. A load updates LRU recency but does
 * not extend TTL; only another save does.
 *
 * The port keeps snapshot writes out of the write transaction, so the store
 * does not roll back on its own. Register it with an
 * `InMemoryTransactionScope` when a test writes snapshots inside a
 * transaction. A rollback then restores the snapshots, their LRU order, and
 * their expiry.
 */
export class InMemorySnapshotStore<TState = unknown>
	implements SnapshotStore<TState>, InMemoryTransactionParticipant
{
	private readonly snapshots = new Map<string, StoredSnapshot<TState>>();
	private readonly maxEntries: number | undefined;
	private readonly ttlMs: number | undefined;
	private readonly clock: () => Date;

	constructor(options: InMemorySnapshotStoreOptions = {}) {
		if (options.maxEntries !== undefined) {
			assertPositiveSafeInteger(
				"InMemorySnapshotStore",
				"maxEntries",
				options.maxEntries,
			);
		}
		if (options.ttlMs !== undefined) {
			assertPositiveSafeInteger(
				"InMemorySnapshotStore",
				"ttlMs",
				options.ttlMs,
			);
		}
		this.maxEntries = options.maxEntries;
		this.ttlMs = options.ttlMs;
		this.clock = options.clock ?? (() => new Date());
	}

	/**
	 * Records the state that a rollback of an `InMemoryTransactionScope`
	 * returns to: every snapshot in LRU order.
	 */
	beginTransaction(): InMemoryTransaction {
		const snapshots = [...this.snapshots];
		return {
			commit: () => {},
			rollback: () => {
				this.snapshots.clear();
				for (const [key, stored] of snapshots) this.snapshots.set(key, stored);
			},
		};
	}

	async load(
		identity: AggregateIdentity,
	): Promise<AggregateSnapshot<TState> | undefined> {
		const key = encodeAggregateIdentity(identity);
		const stored = this.snapshots.get(key);
		if (stored === undefined) return undefined;
		if (
			stored.expiresAtMs !== undefined &&
			this.readClock() >= stored.expiresAtMs
		) {
			this.snapshots.delete(key);
			return undefined;
		}
		// Map order is the LRU order. A read makes this entry most recent but
		// deliberately preserves its original expiry.
		this.snapshots.delete(key);
		this.snapshots.set(key, stored);
		return structuredClone(stored.snapshot);
	}

	async save(
		identity: AggregateIdentity,
		snapshot: AggregateSnapshot<TState>,
	): Promise<void> {
		// Clone before changing retention state: an unsupported snapshot value
		// must not evict a valid entry.
		const ownedSnapshot = structuredClone(snapshot);
		const key = encodeAggregateIdentity(identity);
		let expiresAtMs: number | undefined;
		if (this.ttlMs !== undefined) {
			const nowMs = this.readClock();
			this.deleteExpired(nowMs);
			expiresAtMs = nowMs + this.ttlMs;
		}
		if (this.snapshots.has(key)) {
			this.snapshots.delete(key);
		} else if (
			this.maxEntries !== undefined &&
			this.snapshots.size >= this.maxEntries
		) {
			const oldest = this.snapshots.keys().next();
			if (!oldest.done) this.snapshots.delete(oldest.value);
		}
		this.snapshots.set(key, { snapshot: ownedSnapshot, expiresAtMs });
	}

	async delete(identity: AggregateIdentity): Promise<void> {
		this.snapshots.delete(encodeAggregateIdentity(identity));
	}

	private readClock(): number {
		const now = this.clock();
		if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
			throw new TypeError(
				"InMemorySnapshotStore: clock must return a valid Date",
			);
		}
		return now.getTime();
	}

	private deleteExpired(nowMs: number): void {
		for (const [key, stored] of this.snapshots) {
			if (stored.expiresAtMs !== undefined && nowMs >= stored.expiresAtMs) {
				this.snapshots.delete(key);
			}
		}
	}
}
