import { describe, expect, it } from "vite-plus/test";
import type {
	AggregatePersistenceWrite,
	RepositoryTracking,
} from "../application/unit-of-work/persistence-contract";
import {
	defineRepository,
	UnitOfWork,
} from "../application/unit-of-work/unit-of-work";
import type { AggregateAddress } from "../domain/aggregate/aggregate-address";
import { EventSourcedAggregate } from "../domain/aggregate/event-sourced-aggregate";
import {
	createDomainEvent,
	type DomainEvent,
	isMintedEvent,
	type UncommittedDomainEventOf,
} from "../domain/event/domain-event";
import type { Id } from "../domain/identity/id";
import {
	ConcurrencyConflictError,
	InfrastructureError,
} from "../errors/kit-errors";
import type {
	CommittedDomainEvent,
	EventCommitCandidate,
	Outbox,
} from "../messaging/ports";
import type { PersistenceModel } from "../persistence/repository/persistence-model";
import type { TransactionScope } from "../persistence/repository/scope";
import {
	createEsRepositoryContractTests,
	type EsContractRepository,
	type EsRepositoryContractHarness,
} from "./es-repository-contract";

/**
 * The in-memory REFERENCE adapter for the event-sourced contract suite:
 * the example consumers copy when wiring their own harness. It follows
 * every documented pattern: identity-mapped reads, bare-instance
 * reconstitution through `loadFromHistory`, explicit add/update intent,
 * exact event batches, and a real expected-version guard on append (the
 * `WHERE stream_version = ?` equivalent) against a store with genuine
 * transactional rollback.
 *
 * It is an EXAMPLE, not a proof: passing the suite in memory proves the
 * reference, not your adapter. SQL-backed event stores must run the
 * same suite against a real database.
 */

type EsOrderId = Id<"EsContractOrderId">;
type EsOrderState = { name: string; items: string[] };
type EsOrderCreated = DomainEvent<"EsOrderCreated", { name: string }>;
type EsOrderRenamed = DomainEvent<"EsOrderRenamed", { name: string }>;
type EsItemAdded = DomainEvent<"EsItemAdded", { item: string }>;
type EsOrderEvent = EsOrderCreated | EsOrderRenamed | EsItemAdded;

const orderStream = (id: EsOrderId): AggregateAddress<EsOrderId> => ({
	aggregateType: "ContractEsOrder",
	aggregateId: id,
});

const streamMapKey = (stream: AggregateAddress): string =>
	JSON.stringify([stream.aggregateType, stream.aggregateId]);

class ContractEsOrder extends EventSourcedAggregate<
	EsOrderState,
	EsOrderEvent,
	EsOrderId
> {
	protected readonly aggregateType = "ContractEsOrder";

	protected constructor(id: EsOrderId) {
		super(id, { name: "", items: [] });
	}

	/** Fresh aggregate: applies exactly ONE creation event (version 1). */
	static create(id: EsOrderId): ContractEsOrder {
		const order = new ContractEsOrder(id);
		order.apply(
			createDomainEvent(
				"EsOrderCreated",
				{
					name: "initial",
				},
				{
					aggregateId: order.id,
					aggregateType: order.aggregateType,
				},
			) as EsOrderCreated,
		);
		return order;
	}

	/** Bare instance for replay: no events applied, version 0. */
	static bare(id: EsOrderId): ContractEsOrder {
		return new ContractEsOrder(id);
	}

	get name(): string {
		return this.state.name;
	}

	get items(): readonly string[] {
		return [...this.state.items];
	}

	rename(name: string): void {
		this.apply(
			createDomainEvent(
				"EsOrderRenamed",
				{ name },
				{
					aggregateId: this.id,
					aggregateType: this.aggregateType,
				},
			) as EsOrderRenamed,
		);
	}

	addItem(item: string): void {
		this.apply(
			createDomainEvent(
				"EsItemAdded",
				{ item },
				{
					aggregateId: this.id,
					aggregateType: this.aggregateType,
				},
			) as EsItemAdded,
		);
	}

	protected readonly handlers = {
		EsOrderCreated: (
			state: EsOrderState,
			event: UncommittedDomainEventOf<EsOrderCreated>,
		): EsOrderState => ({ ...state, name: event.payload.name }),
		EsOrderRenamed: (
			state: EsOrderState,
			event: UncommittedDomainEventOf<EsOrderRenamed>,
		): EsOrderState => ({ ...state, name: event.payload.name }),
		EsItemAdded: (
			state: EsOrderState,
			event: UncommittedDomainEventOf<EsItemAdded>,
		): EsOrderState => ({
			...state,
			items: [...state.items, event.payload.item],
		}),
	};
}

/**
 * In-memory streams + outbox with genuine transactional semantics via
 * snapshot/restore (same pattern as the state-stored reference; events
 * are deeply frozen, so shallow array copies suffice).
 */
class InMemoryEsDb {
	streams = new Map<string, EsOrderEvent[]>();
	outbox: CommittedDomainEvent<EsOrderEvent>[] = [];
	sourceHeads = new Map<string, number>();
	commitPredecessors = new Map<string, number | null>();

	addToOutbox(events: ReadonlyArray<EventCommitCandidate<EsOrderEvent>>): void {
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
		streams: Map<string, EsOrderEvent[]>;
		outbox: CommittedDomainEvent<EsOrderEvent>[];
		sourceHeads: Map<string, number>;
		commitPredecessors: Map<string, number | null>;
	} {
		return {
			streams: new Map(
				[...this.streams].map(([id, events]) => [id, [...events]]),
			),
			outbox: [...this.outbox],
			sourceHeads: new Map(this.sourceHeads),
			commitPredecessors: new Map(this.commitPredecessors),
		};
	}

	restore(snapshot: {
		streams: Map<string, EsOrderEvent[]>;
		outbox: CommittedDomainEvent<EsOrderEvent>[];
		sourceHeads: Map<string, number>;
		commitPredecessors: Map<string, number | null>;
	}): void {
		this.streams = snapshot.streams;
		this.outbox = snapshot.outbox;
		this.sourceHeads = snapshot.sourceHeads;
		this.commitPredecessors = snapshot.commitPredecessors;
	}
}

class InMemoryEsOrderRepository {
	constructor(
		protected readonly db: InMemoryEsDb,
		protected readonly tracking: RepositoryTracking<ContractEsOrder>,
	) {}

	async findById(id: EsOrderId): Promise<ContractEsOrder | undefined> {
		const cached = this.tracking.identityMap.get(ContractEsOrder, id);
		if (cached) return cached;
		if (this.tracking.identityMap.isDeleted(ContractEsOrder, id)) {
			return undefined;
		}

		const history = this.db.streams.get(streamMapKey(orderStream(id)));
		if (!history || history.length === 0) return undefined;
		const order = ContractEsOrder.bare(id);
		const result = order.loadFromHistory(history);
		if (result.isErr()) throw result.error; // corrupt stream
		return this.tracking.trackLoaded(order);
	}
}

type EsOrderReadAdapter = Pick<
	EsContractRepository<ContractEsOrder>,
	"findById"
>;
type EsRepoFactory = (
	db: InMemoryEsDb,
	tracking: RepositoryTracking<ContractEsOrder>,
) => EsOrderReadAdapter;

class ContractEsRepositoryPersistenceError extends InfrastructureError<"CONTRACT_ES_REPOSITORY_PERSISTENCE"> {
	constructor(cause: unknown) {
		super({
			code: "CONTRACT_ES_REPOSITORY_PERSISTENCE",
			message: "The event-stream contract repository failed",
			cause,
		});
	}
}

function mapRepositoryError(error: unknown): InfrastructureError {
	return error instanceof InfrastructureError
		? error
		: new ContractEsRepositoryPersistenceError(error);
}

const esPersistence: PersistenceModel<
	ContractEsOrder,
	number,
	number | undefined
> = {
	capture: (aggregate) => aggregate.version,
	changes: (baseline, aggregate, lifecycle) =>
		lifecycle === "loaded" && baseline === aggregate.version
			? undefined
			: aggregate.version,
	isEmpty: (change) => change === undefined,
};

interface InMemoryEsTransaction {
	readonly snapshot: ReturnType<InMemoryEsDb["snapshot"]>;
	mutated: boolean;
}

type EsFlusher = (
	db: InMemoryEsDb,
	transaction: InMemoryEsTransaction,
	write: AggregatePersistenceWrite<ContractEsOrder, number | undefined>,
) => void | Promise<void>;

/** The harness consumers copy; `repoFactory` only parameterizes mutants. */
function createInMemoryEsHarness(
	repoFactory: EsRepoFactory = (db, session) =>
		new InMemoryEsOrderRepository(db, session),
	flush: EsFlusher = flushEsOrder,
): EsRepositoryContractHarness<ContractEsOrder, EsOrderEvent> {
	let mutationCounter = 0;
	let idCounter = 0;

	return {
		createEnvironment: async () => {
			const db = new InMemoryEsDb();
			let nextOutboxFailure: Error | undefined;
			return {
				run: (work) => {
					let activeTransaction: InMemoryEsTransaction | undefined;
					const scope: TransactionScope<InMemoryEsTransaction> = {
						transactional: async <T>(
							fn: (context: InMemoryEsTransaction) => Promise<T>,
						) => {
							const transaction: InMemoryEsTransaction = {
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
					const outbox: Outbox<EsOrderEvent> = {
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
							orders: defineRepository<EsContractRepository<ContractEsOrder>>()(
								{
									aggregate: ContractEsOrder,
									persistence: esPersistence,
									create: (_tx: InMemoryEsTransaction, tracking) =>
										repoFactory(db, tracking),
									flush: (transaction: InMemoryEsTransaction, write) =>
										flush(db, transaction, write),
									mapError: mapRepositoryError,
								},
							),
						},
					}).run(({ repositories }) =>
						work({ repository: repositories.orders }),
					);
				},
				failNextOutboxWrite: (error) => {
					nextOutboxFailure = error;
				},
				committedOutboxEvents: async () => [...db.outbox],
				// The suite's window into the store: same read-and-slice
				// semantics as EventStore.readStream(options).
				committedStreamEvents: async (stream, options) => {
					const events = db.streams.get(streamMapKey(stream));
					if (events === undefined) {
						return { exists: false, lastVersion: 0, events: [] };
					}
					const fromVersion = options.fromVersion ?? 0;
					const toVersion = options.toVersion;
					const pageEnd = Math.min(
						toVersion ?? events.length,
						fromVersion + options.limit,
					);
					return {
						exists: true,
						lastVersion: events.length,
						events: events.slice(fromVersion, pageEnd),
					};
				},
			};
		},
		streamKeyFor: orderStream,
		createAggregate: () =>
			ContractEsOrder.create(`contract-es-order-${idCounter++}` as EsOrderId),
		createAggregateWithId: (id) => ContractEsOrder.create(id),
		mutate: (order) => order.rename(`renamed-${mutationCounter++}`),
		snapshotState: (order) => ({ name: order.name, items: [...order.items] }),
	};
}

function flushEsOrder(
	db: InMemoryEsDb,
	transaction: InMemoryEsTransaction,
	write: AggregatePersistenceWrite<ContractEsOrder, number | undefined>,
): void {
	const expectedVersion = write.expectedVersion ?? 0;
	const key = streamMapKey(orderStream(write.aggregateId));
	const stream = db.streams.get(key) ?? [];
	if (stream.length !== expectedVersion) {
		throw new ConcurrencyConflictError({
			aggregateType: "ContractEsOrder",
			aggregateId: write.aggregateId,
			expectedVersion,
			actualVersion: stream.length,
		});
	}
	if (!write.events.every(isMintedEvent)) {
		throw new Error("repository received an unrecorded domain event");
	}
	if (write.events.length === 0) return;
	transaction.mutated = true;
	db.streams.set(key, [...stream, ...([...write.events] as EsOrderEvent[])]);
}

describe("event-sourced repository contract test suite (in-memory reference adapter)", () => {
	const tests = createEsRepositoryContractTests(createInMemoryEsHarness());

	it("the full-capability reference harness has no skipped tests", () => {
		expect(tests.filter((t) => t.skipped)).toHaveLength(0);
	});

	it("contains the point-in-time stream-window proof", () => {
		expect(tests.map(({ name }) => name)).toContain(
			"read windows preserve absence, actual head, and point-in-time bounds",
		);
	});

	for (const test of tests) {
		(test.skipped ? it.skip : it)(test.name, test.run);
	}

	it("marks the duplicate-create test as skipped without createAggregateWithId; a naive run() fails loud", async () => {
		const minimal = createInMemoryEsHarness();
		minimal.createAggregateWithId = undefined;

		const minimalTests = createEsRepositoryContractTests(minimal);

		expect(minimalTests).toHaveLength(tests.length);
		const skipped = minimalTests.filter((t) => t.skipped);
		expect(skipped.map((t) => t.skipped?.capability)).toEqual([
			"createAggregateWithId",
		]);
		await expect(skipped[0]?.run()).rejects.toThrow(
			/capability 'createAggregateWithId' is not provided/,
		);
	});

	/** Mutant pinning: the suite must EXPOSE broken adapters. */
	async function expectMutantFails(
		options: {
			repoFactory?: EsRepoFactory;
			flush?: EsFlusher;
		},
		testNamePrefix: string,
		expectedFailure: RegExp,
	): Promise<void> {
		const mutantTest = createEsRepositoryContractTests(
			createInMemoryEsHarness(options.repoFactory, options.flush),
		).find((t) => t.name.startsWith(testNamePrefix));
		expect(mutantTest).toBeDefined();
		expect(mutantTest?.skipped).toBeUndefined();
		await expect(mutantTest?.run()).rejects.toThrow(expectedFailure);
	}

	it("the suite EXPOSES a blind append: no expectedVersion guard fails the mandatory test", async () => {
		await expectMutantFails(
			{
				flush: (db, transaction, write) => {
					const key = streamMapKey(orderStream(write.aggregateId));
					const stream = db.streams.get(key) ?? [];
					transaction.mutated = true;
					db.streams.set(key, [
						...stream,
						...([...write.events] as EsOrderEvent[]),
					]);
				},
			},
			"MANDATORY",
			/stale append must reject/,
		);
	});

	it("the suite EXPOSES a wrong fold order: a reversed read fails the replay-equality test", async () => {
		class ReversedReadRepository extends InMemoryEsOrderRepository {
			override async findById(
				id: EsOrderId,
			): Promise<ContractEsOrder | undefined> {
				const cached = this.tracking.identityMap.get(ContractEsOrder, id);
				if (cached) return cached;
				const history = this.db.streams.get(streamMapKey(orderStream(id)));
				if (!history || history.length === 0) return undefined;
				const order = ContractEsOrder.bare(id);
				// ❌ folds newest-first (a SELECT without ORDER BY, unlucky):
				const result = order.loadFromHistory([...history].reverse());
				if (result.isErr()) throw result.error;
				return this.tracking.trackLoaded(order);
			}
		}

		await expectMutantFails(
			{
				repoFactory: (db, tracking) => new ReversedReadRepository(db, tracking),
			},
			"replay preserves",
			/replay must fold to the same state/,
		);
	});
});
