import { AggregateDeletedError } from "../core/errors";
import type { Id } from "../core/id";

/**
 * A class reference used as the type key of the identity map. Keying
 * on the CLASS (not a name string) makes collisions impossible by
 * construction: `Restaurant` and `Booking` are different keys even if
 * someone names two aggregates identically across modules, and there
 * is no string-discipline to maintain.
 *
 * The `Function & { prototype: TAgg }` branch is load-bearing: the
 * kit's aggregate convention is a **protected constructor** plus
 * static factories, and TypeScript rejects assigning a class with a
 * protected constructor to a construct-signature type. The prototype
 * witness accepts those classes while still inferring `TAgg`.
 */
export type AggregateClass<TAgg> =
	// biome-ignore lint/suspicious/noExplicitAny: variance — a class reference is only used as a map key and instance witness here.
	| (abstract new (...args: any[]) => TAgg)
	// biome-ignore lint/complexity/noBannedTypes: Function is deliberate — a construct signature cannot accept protected-constructor classes (the kit's aggregate convention); the prototype witness keeps TAgg inference.
	| (Function & { prototype: TAgg });

/**
 * Per-unit-of-work Identity Map (Fowler, PoEAA): within one operation,
 * one aggregate type+id maps to exactly ONE in-memory instance.
 *
 * This is the shipped implementation of the contract the
 * [Repository guide](../../docs/guide/repository.md) places on
 * `IRepository` implementations: two `getById(id)` calls in the same
 * unit of work MUST return the same instance, because `withCommit`'s
 * aggregate dedupe (and therefore exactly-once event harvest and
 * `markPersisted`) is keyed on JavaScript object identity.
 *
 * Storage is two-level (per-type stores created lazily), so
 * `Restaurant:123` and `Booking:123` can never collide — the type key
 * is the aggregate CLASS, not the id alone and not a name string.
 *
 * Repository read-path contract:
 *
 * ```ts
 * async getById(id: OrderId): Promise<Order | null> {
 *   const cached = this.session.identityMap.get(Order, id);
 *   if (cached) return cached;
 *   // Deleted in this unit of work = gone, even if the physical
 *   // delete is deferred and the row is still visible in the tx.
 *   if (this.session.identityMap.isDeleted(Order, id)) return null;
 *
 *   const row = await this.loadRow(id);
 *   if (!row) return null;
 *   const order = Order.reconstitute(row.id, row.state, row.version);
 *   this.session.identityMap.set(Order, id, order);
 *   return order;
 * }
 * ```
 *
 * Deletion is final within an operation: {@link delete} removes the
 * entry AND records a tombstone, so a later {@link set} of the same
 * type+id throws `AggregateDeletedError` — a second instance of a
 * deleted aggregate can never sneak back into the unit of work, even
 * through a repository whose row delete is deferred.
 *
 * Lifetime is ONE unit of work: the `UnitOfWork` creates a fresh map
 * per `run()` and clears it on close. Never cache across operations;
 * that would silently bypass optimistic concurrency control.
 */
export class IdentityMap {
	private readonly _stores = new Map<
		AggregateClass<unknown>,
		Map<string, unknown>
	>();
	private readonly _deleted = new Map<AggregateClass<unknown>, Set<string>>();

	/** The cached instance for type+id, or `undefined` (also after {@link delete}). */
	public get<TAgg>(
		type: AggregateClass<TAgg>,
		id: Id<string>,
	): TAgg | undefined {
		return this._stores.get(type)?.get(id) as TAgg | undefined;
	}

	/** Whether an instance is registered for type+id (false after {@link delete}). */
	public has<TAgg>(type: AggregateClass<TAgg>, id: Id<string>): boolean {
		return this._stores.get(type)?.has(id) ?? false;
	}

	/**
	 * Whether type+id was {@link delete}d in this unit of work. The
	 * read path checks this BEFORE hydrating and returns `null`, so
	 * "deleted in this operation" reads uniformly as not-found —
	 * regardless of whether the repository's physical delete already
	 * removed the row or is deferred within the transaction. Without
	 * the check, a read-only probe of a deleted aggregate would crash
	 * in {@link set} for deferred-write repositories and return `null`
	 * for immediate-write ones.
	 */
	public isDeleted<TAgg>(type: AggregateClass<TAgg>, id: Id<string>): boolean {
		return this._deleted.get(type)?.has(id) ?? false;
	}

	/**
	 * Registers the hydrated instance for type+id.
	 *
	 * - Re-registering the SAME instance is a no-op (idempotent).
	 * - Registering a DIFFERENT instance for an occupied type+id throws:
	 *   that is precisely the identity-map violation this class exists
	 *   to prevent (the repository hydrated twice instead of checking
	 *   {@link get} first), and letting it pass would double-harvest
	 *   events downstream.
	 * - Registering a type+id that was {@link delete}d in this unit of
	 *   work throws `AggregateDeletedError`: deletion is final within
	 *   the operation.
	 */
	public set<TAgg>(
		type: AggregateClass<TAgg>,
		id: Id<string>,
		aggregate: TAgg,
	): void {
		if (this._deleted.get(type)?.has(id)) {
			throw new AggregateDeletedError(String(id));
		}
		let store = this._stores.get(type);
		if (store === undefined) {
			store = new Map<string, unknown>();
			this._stores.set(type, store);
		}
		const existing = store.get(id);
		if (existing !== undefined && existing !== aggregate) {
			throw new Error(
				`IdentityMap: a different instance is already registered for ` +
					`${type.name}(${String(id)}). Check get() before hydrating - ` +
					`two live instances of one aggregate break the one-instance-per-` +
					`unit-of-work contract that exactly-once event harvest relies on.`,
			);
		}
		store.set(id, aggregate);
	}

	/**
	 * Removes the entry for type+id and records a tombstone: subsequent
	 * {@link get} / {@link has} report absence, and a subsequent
	 * {@link set} of the same type+id throws `AggregateDeletedError`.
	 * Called by a repository's `delete(aggregate)` alongside
	 * `session.enrollDeleted(aggregate)`.
	 */
	public delete<TAgg>(type: AggregateClass<TAgg>, id: Id<string>): void {
		this._stores.get(type)?.delete(id);
		let tombstones = this._deleted.get(type);
		if (tombstones === undefined) {
			tombstones = new Set<string>();
			this._deleted.set(type, tombstones);
		}
		tombstones.add(id);
	}

	/** Empties all stores and tombstones. Called by the unit of work on close. */
	public clear(): void {
		this._stores.clear();
		this._deleted.clear();
	}
}
