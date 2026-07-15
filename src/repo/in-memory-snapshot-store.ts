import type { AggregateSnapshot } from "../aggregate/aggregate";
import {
	type AggregateAddress,
	encodeAggregateAddress,
} from "../aggregate/aggregate-address";
import { assertPositiveSafeInteger } from "../utils/validate";
import type { SnapshotStore } from "./snapshot-store";

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
 * plain data by the `createSnapshot` contract), so neither the caller
 * nor the store can mutate the other's copy.
 *
 * Unconfigured retention is intended only for finite-lifetime tests and
 * demos. Unlike event history, receipts, or checkpoints, snapshots are
 * rebuildable derived data, so `maxEntries` may evict the least recently used
 * entry and `ttlMs` may expire it safely. A load updates LRU recency but does
 * not extend TTL; only another save does.
 */
export class InMemorySnapshotStore<TState = unknown>
	implements SnapshotStore<TState>
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

	async load(
		address: AggregateAddress,
	): Promise<AggregateSnapshot<TState> | undefined> {
		const key = encodeAggregateAddress(address);
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
		address: AggregateAddress,
		snapshot: AggregateSnapshot<TState>,
	): Promise<void> {
		// Clone before changing retention state: an unsupported snapshot value
		// must not evict a valid entry.
		const ownedSnapshot = structuredClone(snapshot);
		const key = encodeAggregateAddress(address);
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

	async delete(address: AggregateAddress): Promise<void> {
		this.snapshots.delete(encodeAggregateAddress(address));
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
