import { describe, expect, it } from "vitest";
import { AggregateRoot } from "../aggregate/aggregate-root";
import type { Version } from "../aggregate/aggregate";
import type { DomainEvent } from "../aggregate/domain-event";
import {
	ConcurrencyConflictError,
	DuplicateAggregateError,
} from "../core/errors";
import type { Id } from "../core/id";
import type { Outbox } from "../events/ports";
import type { TransactionScope } from "../repo/scope";
import { UnitOfWork, type UnitOfWorkSession } from "../app/unit-of-work";
import {
	type ContractRepository,
	createRepositoryContractTests,
	type RepositoryContractHarness,
} from "./repository-contract";

/**
 * The in-memory REFERENCE adapter: the example consumers copy when
 * wiring their own harness (linked from docs/guide/unit-of-work.md).
 * It follows every documented repository pattern (identity-map read
 * path with the isDeleted probe, hasChanges skip, enroll-before-write,
 * persistedVersion insert/update routing, and REAL version predicates
 * on update AND delete, the affectedRows-0 equivalent) against a
 * store with genuine transactional rollback (snapshot/restore).
 *
 * It is an EXAMPLE, not a proof: passing the suite in memory proves
 * the reference, not your adapter. SQL/ORM adapters must run the same
 * suite against a real database.
 */

type OrderId = Id<"ContractOrderId">;
type OrderState = { name: string; items: string[] };
type OrderEvent =
	| DomainEvent<"OrderRenamed", { name: string }>
	| DomainEvent<"ItemAdded", { item: string }>;

class ContractOrder extends AggregateRoot<OrderState, OrderId, OrderEvent> {
	protected readonly aggregateType = "ContractOrder";

	// Protected on purpose: the reference exercises the kit's aggregate
	// convention (static factories only), including the identity map's
	// protected-constructor support.
	protected constructor(id: OrderId, state: OrderState) {
		super(id, state);
	}

	static create(id: OrderId): ContractOrder {
		return new ContractOrder(id, { name: "initial", items: [] });
	}

	static reconstitute(
		id: OrderId,
		state: OrderState,
		version: Version,
	): ContractOrder {
		const order = new ContractOrder(id, state);
		order.markRestored(version);
		return order;
	}

	rename(name: string): void {
		this.commit(
			{ ...this.state, name },
			this.recordEvent("OrderRenamed", { name }),
		);
	}

	addItem(item: string): void {
		this.commit(
			{ ...this.state, items: [...this.state.items, item] },
			this.recordEvent("ItemAdded", { item }),
		);
	}

	/** Version-only change: deep-equal state, bumped version, no event. */
	touch(): void {
		this.setState({ ...this.state });
	}
}

type Row = { state: OrderState; version: number };

/**
 * In-memory storage with genuine transactional semantics via
 * snapshot/restore. NOTE: snapshot() clones the WHOLE store per
 * transaction: O(total rows). Fine for a contract-test store with a
 * handful of rows; do not copy this pattern for large long-lived
 * fakes.
 */
class InMemoryDb {
	rows = new Map<string, Row>();
	outbox: OrderEvent[] = [];

	snapshot(): { rows: Map<string, Row>; outbox: OrderEvent[] } {
		return {
			rows: new Map(
				[...this.rows].map(([id, row]) => [
					id,
					{ version: row.version, state: structuredClone(row.state) },
				]),
			),
			outbox: [...this.outbox],
		};
	}

	restore(snapshot: { rows: Map<string, Row>; outbox: OrderEvent[] }): void {
		this.rows = snapshot.rows;
		this.outbox = snapshot.outbox;
	}
}

class InMemoryOrderRepository implements ContractRepository<ContractOrder> {
	constructor(
		protected readonly db: InMemoryDb,
		protected readonly session: UnitOfWorkSession<OrderEvent>,
	) {}

	async getById(id: OrderId): Promise<ContractOrder | null> {
		const cached = this.session.identityMap.get(ContractOrder, id);
		if (cached) return cached;
		if (this.session.identityMap.isDeleted(ContractOrder, id)) return null;

		const row = this.db.rows.get(id);
		if (!row) return null;
		const order = ContractOrder.reconstitute(
			id,
			structuredClone(row.state),
			row.version as Version,
		);
		this.session.identityMap.set(ContractOrder, id, order);
		return order;
	}

	async save(order: ContractOrder): Promise<void> {
		if (!order.hasChanges) {
			return; // safe skip: hasChanges covers version delta + events
		}
		// Enroll FIRST: the deleted-gate (AggregateDeletedError) then fires
		// before any row write. Enrollment is idempotent, and a failed
		// write rolls the whole unit of work back anyway.
		this.session.enrollSaved(order);
		if (order.persistedVersion === undefined) {
			// INSERT path: routed on persistedVersion, never on version === 0.
			// The in-memory equivalent of a unique-violation (Postgres 23505,
			// MySQL 1062): a row with this id already exists.
			if (this.db.rows.has(order.id)) {
				throw new DuplicateAggregateError({ aggregateType: "ContractOrder", aggregateId: order.id });
			}
			this.db.rows.set(order.id, {
				state: structuredClone(order.state),
				version: order.version,
			});
		} else {
			// UPDATE path with the REAL OCC predicate: the in-memory
			// equivalent of `WHERE id = ? AND version = ?` affecting 0 rows.
			const row = this.db.rows.get(order.id);
			if (!row || row.version !== order.persistedVersion) {
				throw new ConcurrencyConflictError({
					aggregateType: "ContractOrder",
					aggregateId: order.id,
					expectedVersion: order.persistedVersion,
					actualVersion: row?.version ?? -1,
				});
			}
			this.db.rows.set(order.id, {
				state: structuredClone(order.state),
				version: order.version,
			});
		}
	}

	async delete(order: ContractOrder): Promise<void> {
		// OCC applies to deletes too: the in-memory equivalent of
		// `DELETE FROM orders WHERE id = ? AND version = ?` affecting 0
		// rows. An unpredicated delete would silently destroy a
		// concurrent writer's update (last-write-wins).
		const row = this.db.rows.get(order.id);
		if (
			order.persistedVersion !== undefined &&
			(!row || row.version !== order.persistedVersion)
		) {
			throw new ConcurrencyConflictError({
				aggregateType: "ContractOrder",
				aggregateId: order.id,
				expectedVersion: order.persistedVersion,
				actualVersion: row?.version ?? -1,
			});
		}
		this.db.rows.delete(order.id);
		// ONE call: enrollDeleted tombstones the identity map itself.
		this.session.enrollDeleted(order);
	}
}

type RepoFactory = (
	db: InMemoryDb,
	session: UnitOfWorkSession<OrderEvent>,
) => ContractRepository<ContractOrder>;

/**
 * The harness consumers copy. `repoFactory` is parameterized only so
 * the mutant test below can swap in a broken repository against the
 * SAME wiring; your harness hard-wires your real adapter.
 */
function createInMemoryHarness(
	repoFactory: RepoFactory = (db, session) =>
		new InMemoryOrderRepository(db, session),
): RepositoryContractHarness<ContractOrder, OrderEvent> {
	let mutationCounter = 0;
	let idCounter = 0;

	return {
		createEnvironment: async () => {
			const db = new InMemoryDb();
			const scope: TransactionScope<undefined> = {
				transactional: async <T>(fn: (_ctx: undefined) => Promise<T>) => {
					const snapshot = db.snapshot();
					try {
						return await fn(undefined);
					} catch (error) {
						db.restore(snapshot);
						throw error;
					}
				},
			};
			const outbox: Outbox<OrderEvent> = {
				add: async (events) => {
					db.outbox.push(...events);
				},
				getPending: async () =>
					db.outbox.map((event, i) => ({ dispatchId: String(i), event })),
				markDispatched: async () => {},
			};
			return {
				run: (work) =>
					new UnitOfWork({
						scope,
						outbox,
						repositories: {
							orders: (
								_tx: undefined,
								session: UnitOfWorkSession<OrderEvent>,
							) => repoFactory(db, session),
						},
					}).run(({ repositories }) =>
						work({ repository: repositories.orders }),
					),
				committedOutboxEvents: async () => [...db.outbox],
			};
		},
		createAggregate: () =>
			ContractOrder.create(`contract-order-${idCounter++}` as OrderId),
		createAggregateWithId: (id) => ContractOrder.create(id),
		mutate: (order) => order.rename(`renamed-${mutationCounter++}`),
		mutateVersionOnly: (order) => order.touch(),
		mutateChildCollection: (order) =>
			order.addItem(`item-${mutationCounter++}`),
		snapshotState: (order) => structuredClone(order.state),
		deletesAreVersionChecked: true,
		insertsAreDuplicateChecked: true, // explicit; true is also the default
	};
}

describe("repository contract test suite (in-memory reference adapter)", () => {
	const tests = createRepositoryContractTests(createInMemoryHarness());

	it("the full-capability reference harness has no skipped tests", () => {
		expect(tests.filter((t) => t.skipped)).toHaveLength(0);
	});

	for (const test of tests) {
		(test.skipped ? it.skip : it)(test.name, test.run);
	}

	it("marks capability-gated tests as skipped when the harness lacks the capability - and a naive run() fails loud", async () => {
		const minimal = createInMemoryHarness();
		minimal.mutateVersionOnly = undefined;
		minimal.mutateChildCollection = undefined;
		minimal.createAggregateWithId = undefined;
		minimal.snapshotState = undefined;
		minimal.deletesAreVersionChecked = false;

		const minimalTests = createRepositoryContractTests(minimal);

		// Same test COUNT as the full suite - capability gaps shrink
		// nothing silently; they surface as skipped entries.
		expect(minimalTests).toHaveLength(tests.length);
		const skipped = minimalTests.filter((t) => t.skipped);
		expect(skipped.map((t) => t.skipped?.capability).sort()).toEqual([
			"createAggregateWithId",
			"createAggregateWithId", // deletion-finality AND duplicate-insert
			"deletesAreVersionChecked",
			"mutateChildCollection",
			"mutateVersionOnly",
		]);
		// snapshotState widens the MANDATORY test, it does not gate one.

		// A binding that ignores `skipped` must fail loud, never pass as
		// a green no-op.
		await expect(skipped[0]?.run()).rejects.toThrow(
			/capability 'mutateVersionOnly' is not provided/,
		);
	});

	it("a deliberately upserting adapter opts out of the duplicate-insert test ALONE via insertsAreDuplicateChecked: false", () => {
		const upserting = createInMemoryHarness();
		upserting.insertsAreDuplicateChecked = false;

		const upsertingTests = createRepositoryContractTests(upserting);
		const skipped = upsertingTests.filter((t) => t.skipped);

		// Exactly ONE skip, named after the SEMANTIC capability - and the
		// deletion-finality test (gated on the same mechanical
		// createAggregateWithId) still runs.
		expect(skipped.map((t) => t.skipped?.capability)).toEqual([
			"insertsAreDuplicateChecked",
		]);
		expect(
			upsertingTests.find((t) => t.name.startsWith("deletion is final across"))
				?.skipped,
		).toBeUndefined();
	});

	it("capabilities are captured at suite creation: mutating the harness afterwards does not flip tests", () => {
		const harness = createInMemoryHarness();
		const built = createRepositoryContractTests(harness);
		harness.mutateVersionOnly = undefined; // too late by design

		expect(built.filter((t) => t.skipped)).toHaveLength(0);
	});

	/**
	 * Mutant pinning: build the suite over the SAME wiring with a broken
	 * repository swapped in, and pin that the named test fails on the
	 * SPECIFIC assertion (not for any incidental reason).
	 */
	async function expectMutantFails(
		repoFactory: RepoFactory,
		testNamePrefix: string,
		expectedFailure: RegExp,
	): Promise<void> {
		const mutantTest = createRepositoryContractTests(
			createInMemoryHarness(repoFactory),
		).find((t) => t.name.startsWith(testNamePrefix));
		expect(mutantTest).toBeDefined();
		expect(mutantTest?.skipped).toBeUndefined();
		await expect(mutantTest?.run()).rejects.toThrow(expectedFailure);
	}

	// Mutant adapter: identical to the reference EXCEPT save() has no
	// OCC predicate and no duplicate check (last-write-wins upsert).
	// Enrollment stays enroll-before-write per the contract.
	class LastWriteWinsRepository extends InMemoryOrderRepository {
		override async save(order: ContractOrder): Promise<void> {
			if (!order.hasChanges) return;
			this.session.enrollSaved(order);
			// ❌ no `WHERE version = persistedVersion` equivalent and no
			// unique-violation mapping:
			this.db.rows.set(order.id, {
				state: structuredClone(order.state),
				version: order.version,
			});
		}
	}

	it("the suite EXPOSES a broken adapter: a repository without the version predicate fails the mandatory test", async () => {
		await expectMutantFails(
			(db, session) => new LastWriteWinsRepository(db, session),
			"MANDATORY",
			/the second writer's commit must reject/,
		);
	});

	it("the suite EXPOSES an unpredicated delete: a stale delete that succeeds fails the stale-delete test", async () => {
		class UnpredicatedDeleteRepository extends InMemoryOrderRepository {
			override async delete(order: ContractOrder): Promise<void> {
				// ❌ plain `DELETE FROM orders WHERE id = ?`:
				this.db.rows.delete(order.id);
				this.session.enrollDeleted(order);
			}
		}

		await expectMutantFails(
			(db, session) => new UnpredicatedDeleteRepository(db, session),
			"stale delete conflicts",
			/a stale delete must reject/,
		);
	});

	it("the suite EXPOSES a missing unique-violation mapping: an upserting insert fails the duplicate-insert test", async () => {
		await expectMutantFails(
			(db, session) => new LastWriteWinsRepository(db, session),
			"duplicate insert",
			/must reject with \(or wrap\) DuplicateAggregateError/,
		);
	});
});
