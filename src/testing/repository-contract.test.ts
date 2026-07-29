import { describe, expect, it } from "vite-plus/test";
import type { Version } from "../aggregate/aggregate";
import { AggregateRoot } from "../aggregate/aggregate-root";
import type { DomainEvent } from "../aggregate/domain-event";
import {
	type AggregatePersistenceWrite,
	defineRepository,
	type RepositoryTracking,
	UnitOfWork,
} from "../app/unit-of-work";
import {
	ConcurrencyConflictError,
	DuplicateAggregateError,
} from "../core/errors";
import type { Id } from "../core/id";
import type {
	CommittedDomainEvent,
	EventCommitCandidate,
	Outbox,
} from "../events/ports";
import type { PersistenceModel } from "../repo/persistence-model";
import type { TransactionScope } from "../repo/scope";
import { deepEqual } from "../utils/array/deep-equal";
import {
	type ContractRepository,
	createRepositoryContractTests,
	type RepositoryContractHarness,
} from "./repository-contract";

/**
 * The in-memory REFERENCE adapter: the example consumers copy when
 * wiring their own harness (linked from docs/guide/unit-of-work.md).
 * It follows every documented v3 repository pattern: identity-mapped loads,
 * adapter-owned baselines, explicit add/update/remove registration, exact
 * commit receipts, and real version predicates on update and removal (the
 * affected-rows-zero equivalent). The fake store provides genuine
 * transactional rollback through snapshot/restore of its own state.
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

	get name(): string {
		return this.state.name;
	}

	get items(): readonly string[] {
		return [...this.state.items];
	}

	rename(name: string): void {
		this.commit(
			{ ...this.state, name },
			this.recordEventFromFactory("OrderRenamed", { name }),
		);
	}

	addItem(item: string): void {
		this.commit(
			{ ...this.state, items: [...this.state.items, item] },
			this.recordEventFromFactory("ItemAdded", { item }),
		);
	}

	/** Version-only change: deep-equal state, bumped version, no event. */
	touch(): void {
		this.setState({ ...this.state });
	}
}

type Row = { state: OrderState; version: number };
type RowChange = Readonly<Row> | undefined;

function rowFor(order: ContractOrder): Readonly<Row> {
	return Object.freeze({
		state: { name: order.name, items: [...order.items] },
		version: order.version,
	});
}

const orderPersistence: PersistenceModel<
	ContractOrder,
	Readonly<Row>,
	RowChange
> = {
	capture: rowFor,
	changes: (baseline, aggregate, lifecycle) => {
		const current = rowFor(aggregate);
		return lifecycle === "loaded" && deepEqual(baseline, current)
			? undefined
			: current;
	},
	isEmpty: (change) => change === undefined,
};

/**
 * In-memory storage with genuine transactional semantics via
 * snapshot/restore. NOTE: snapshot() clones the WHOLE store per
 * transaction: O(total rows). Fine for a contract-test store with a
 * handful of rows; do not copy this pattern for large long-lived
 * fakes.
 */
class InMemoryDb {
	rows = new Map<string, Row>();
	outbox: CommittedDomainEvent<OrderEvent>[] = [];
	sourceHeads = new Map<string, number>();
	commitPredecessors = new Map<string, number | null>();

	addToOutbox(events: ReadonlyArray<EventCommitCandidate<OrderEvent>>): void {
		for (const message of events) {
			const sourceKey = JSON.stringify([
				message.source.aggregateType,
				message.source.aggregateId,
			]);
			const commitKey = JSON.stringify([
				message.source.aggregateType,
				message.source.aggregateId,
				message.position.aggregateVersion,
			]);
			let previousEventfulAggregateVersion: number | null;
			if (this.commitPredecessors.has(commitKey)) {
				previousEventfulAggregateVersion =
					this.commitPredecessors.get(commitKey) ?? null;
			} else {
				previousEventfulAggregateVersion =
					this.sourceHeads.get(sourceKey) ?? null;
				this.commitPredecessors.set(
					commitKey,
					previousEventfulAggregateVersion,
				);
				this.sourceHeads.set(sourceKey, message.position.aggregateVersion);
			}
			this.outbox.push({
				...message,
				position: { ...message.position, previousEventfulAggregateVersion },
			});
		}
	}

	snapshot(): {
		rows: Map<string, Row>;
		outbox: CommittedDomainEvent<OrderEvent>[];
		sourceHeads: Map<string, number>;
		commitPredecessors: Map<string, number | null>;
	} {
		return {
			rows: new Map(
				[...this.rows].map(([id, row]) => [
					id,
					{ version: row.version, state: structuredClone(row.state) },
				]),
			),
			outbox: [...this.outbox],
			sourceHeads: new Map(this.sourceHeads),
			commitPredecessors: new Map(this.commitPredecessors),
		};
	}

	restore(snapshot: {
		rows: Map<string, Row>;
		outbox: CommittedDomainEvent<OrderEvent>[];
		sourceHeads: Map<string, number>;
		commitPredecessors: Map<string, number | null>;
	}): void {
		this.rows = snapshot.rows;
		this.outbox = snapshot.outbox;
		this.sourceHeads = snapshot.sourceHeads;
		this.commitPredecessors = snapshot.commitPredecessors;
	}
}

class InMemoryOrderRepository {
	constructor(
		protected readonly db: InMemoryDb,
		protected readonly tracking: RepositoryTracking<ContractOrder>,
	) {}

	async findById(id: OrderId): Promise<ContractOrder | undefined> {
		const cached = this.tracking.identityMap.get(ContractOrder, id);
		if (cached) return cached;
		if (this.tracking.identityMap.isDeleted(ContractOrder, id))
			return undefined;

		const row = this.db.rows.get(id);
		if (!row) return undefined;
		const order = ContractOrder.reconstitute(
			id,
			structuredClone(row.state),
			row.version as Version,
		);
		return this.tracking.trackLoaded(order);
	}
}

type OrderReadAdapter = Pick<ContractRepository<ContractOrder>, "findById">;
type RepoFactory = (
	db: InMemoryDb,
	tracking: RepositoryTracking<ContractOrder>,
) => OrderReadAdapter;
type OrderFlusher = (
	db: InMemoryDb,
	transaction: InMemoryTransaction,
	write: AggregatePersistenceWrite<ContractOrder, RowChange>,
) => void | Promise<void>;

interface InMemoryTransaction {
	readonly snapshot: ReturnType<InMemoryDb["snapshot"]>;
	mutated: boolean;
}

/**
 * The harness consumers copy. `repoFactory` is parameterized only so
 * the mutant test below can swap in a broken repository against the
 * SAME wiring; your harness hard-wires your real adapter.
 */
function createInMemoryHarness(
	repoFactory: RepoFactory = (db, session) =>
		new InMemoryOrderRepository(db, session),
	flush: OrderFlusher = flushOrder,
): RepositoryContractHarness<ContractOrder, OrderEvent> {
	let mutationCounter = 0;
	let idCounter = 0;

	return {
		createEnvironment: async () => {
			const db = new InMemoryDb();
			let nextOutboxFailure: Error | undefined;
			return {
				run: (work) => {
					let activeTransaction: InMemoryTransaction | undefined;
					const scope: TransactionScope<InMemoryTransaction> = {
						transactional: async <T>(
							fn: (context: InMemoryTransaction) => Promise<T>,
						) => {
							const transaction: InMemoryTransaction = {
								snapshot: db.snapshot(),
								mutated: false,
							};
							activeTransaction = transaction;
							try {
								return await fn(transaction);
							} catch (error) {
								if (transaction.mutated) db.restore(transaction.snapshot);
								throw error;
							} finally {
								activeTransaction = undefined;
							}
						},
					};
					const outbox: Outbox<OrderEvent> = {
						add: async (events) => {
							if (!activeTransaction) {
								throw new Error("outbox write outside transaction");
							}
							activeTransaction.mutated = true;
							if (nextOutboxFailure) {
								const failure = nextOutboxFailure;
								nextOutboxFailure = undefined;
								throw failure;
							}
							db.addToOutbox(events);
						},
						getPending: async () => [],
						markDispatched: async () => {},
					};
					return new UnitOfWork({
						scope,
						outbox,
						repositories: {
							orders: defineRepository({
								aggregate: ContractOrder,
								persistence: orderPersistence,
								physicalRemoval: true,
								create: (_tx: InMemoryTransaction, tracking) =>
									repoFactory(db, tracking),
								flush: (transaction: InMemoryTransaction, write) =>
									flush(db, transaction, write),
							}),
						},
					}).run(({ repositories }) =>
						work({ repository: repositories.orders }),
					);
				},
				failNextOutboxWrite: (error) => {
					nextOutboxFailure = error;
				},
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
		snapshotState: (order) => ({ name: order.name, items: [...order.items] }),
		removesAreSupported: true,
		removesAreVersionChecked: true,
		insertsAreDuplicateChecked: true, // explicit; true is also the default
	};
}

function flushOrder(
	db: InMemoryDb,
	transaction: InMemoryTransaction,
	write: AggregatePersistenceWrite<ContractOrder, RowChange>,
): void {
	const row = db.rows.get(write.aggregateId);
	if (write.intent === "add") {
		if (row) {
			throw new DuplicateAggregateError({
				aggregateType: "ContractOrder",
				aggregateId: write.aggregateId,
			});
		}
		const inserted = write.changes.value;
		if (!inserted) throw new Error("add produced an empty change set");
		transaction.mutated = true;
		db.rows.set(write.aggregateId, structuredClone(inserted));
		return;
	}
	if (!row || row.version !== write.expectedVersion) {
		throw new ConcurrencyConflictError({
			aggregateType: "ContractOrder",
			aggregateId: write.aggregateId,
			expectedVersion: write.expectedVersion ?? -1,
			actualVersion: row?.version ?? -1,
		});
	}
	transaction.mutated = true;
	if (write.intent === "remove") {
		db.rows.delete(write.aggregateId);
		return;
	}
	if (!write.changes.empty && write.changes.value) {
		db.rows.set(write.aggregateId, structuredClone(write.changes.value));
	}
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
		minimal.removesAreSupported = false;
		minimal.removesAreVersionChecked = false;

		const minimalTests = createRepositoryContractTests(minimal);

		// Same test COUNT as the full suite - capability gaps shrink
		// nothing silently; they surface as skipped entries.
		expect(minimalTests).toHaveLength(tests.length);
		const skipped = minimalTests.filter((t) => t.skipped);
		expect(skipped.map((t) => t.skipped?.capability).sort()).toEqual([
			"createAggregateWithId",
			"mutateChildCollection",
			"mutateVersionOnly",
			"removesAreSupported",
			"removesAreVersionChecked",
		]);
		// snapshotState widens the MANDATORY test, it does not gate one.

		// A binding that ignores `skipped` must fail loud, never pass as
		// a green no-op.
		await expect(skipped[0]?.run()).rejects.toThrow(
			/capability '.+' is not provided/,
		);
	});

	it("a deliberately upserting adapter opts out of the duplicate-insert test ALONE via insertsAreDuplicateChecked: false", () => {
		const upserting = createInMemoryHarness();
		upserting.insertsAreDuplicateChecked = false;

		const upsertingTests = createRepositoryContractTests(upserting);
		const skipped = upsertingTests.filter((t) => t.skipped);

		// Exactly one skip, named after the semantic capability.
		expect(skipped.map((t) => t.skipped?.capability)).toEqual([
			"insertsAreDuplicateChecked",
		]);
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
		flush: OrderFlusher,
		testNamePrefix: string,
		expectedFailure: RegExp,
	): Promise<void> {
		const mutantTest = createRepositoryContractTests(
			createInMemoryHarness(undefined, flush),
		).find((t) => t.name.startsWith(testNamePrefix));
		expect(mutantTest).toBeDefined();
		expect(mutantTest?.skipped).toBeUndefined();
		await expect(mutantTest?.run()).rejects.toThrow(expectedFailure);
	}

	const lastWriteWins: OrderFlusher = (db, transaction, write) => {
		const change = write.changes.value;
		if (!change) return;
		transaction.mutated = true;
		db.rows.set(write.aggregateId, structuredClone(change));
	};

	it("the suite EXPOSES a broken adapter: a repository without the version predicate fails the mandatory test", async () => {
		await expectMutantFails(
			lastWriteWins,
			"MANDATORY",
			/stale update must reject/,
		);
	});

	it("the suite EXPOSES an unpredicated delete: a stale delete that succeeds fails the stale-delete test", async () => {
		await expectMutantFails(
			(db, transaction, write) => {
				if (write.intent !== "remove") {
					return flushOrder(db, transaction, write);
				}
				transaction.mutated = true;
				db.rows.delete(write.aggregateId);
			},
			"stale remove conflicts",
			/stale remove must reject/,
		);
	});

	it("the suite EXPOSES a missing unique-violation mapping: an upserting insert fails the duplicate-insert test", async () => {
		await expectMutantFails(
			lastWriteWins,
			"duplicate add rejects",
			/duplicate add must reject/,
		);
	});
});
