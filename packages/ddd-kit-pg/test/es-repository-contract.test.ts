import {
	type AggregateConfig,
	type AggregateIdentity,
	type CommittedDomainEvent,
	type DomainEvent,
	defineRepository,
	EventSourcedAggregate,
	type Id,
	InfrastructureError,
	type OutboxWriter,
	type PersistenceModel,
	type RepositoryTracking,
	readStreamPages,
	reconstituteAggregateFromStreamPages,
	type TransactionScope,
	UnitOfWork,
	type UnstampedDomainEventOf,
	type Version,
} from "@shirudo/ddd-kit";
import {
	createEsRepositoryContractTests,
	type EsContractRepository,
	type EsRepositoryContractEnvironment,
} from "@shirudo/ddd-kit/testing";
import { describe, expect, it } from "vite-plus/test";
import { PgEventStore } from "../src/pg-event-store";
import { fromPg, type PgQueryExecutor } from "../src/pg-query-executor";
import { PgTransactionScope } from "../src/pg-transaction-scope";
import { openIsolatedSchema } from "./isolated-schema";

type OrderId = Id<"ContractOrderId">;
type OrderState = { readonly name: string };
type OrderRenamed = DomainEvent<"OrderRenamed", { name: string }>;

const orderStream = (id: OrderId): AggregateIdentity<OrderId> => ({
	aggregateType: "ContractOrder",
	aggregateId: id,
});

class ContractOrder extends EventSourcedAggregate<
	OrderState,
	OrderId,
	OrderRenamed
> {
	protected readonly aggregateType = "ContractOrder";

	protected constructor(
		id: OrderId,
		state: OrderState = { name: "" },
		config?: AggregateConfig<OrderState>,
	) {
		super(id, state, config);
	}

	static create(id: OrderId): ContractOrder {
		const order = new ContractOrder(id);
		order.rename("initial");
		return order;
	}

	static bare(id: OrderId): ContractOrder {
		return new ContractOrder(id);
	}

	static fromSnapshot(
		id: OrderId,
		state: OrderState,
		version: Version,
	): ContractOrder {
		const order = new ContractOrder(id, state, { trustInitialState: true });
		order.markReconstituted(version);
		return order;
	}

	get name(): string {
		return this.state.name;
	}

	rename(name: string): void {
		this.apply(this.createEvent("OrderRenamed", { name }));
	}

	protected readonly folds = {
		OrderRenamed: (
			_state: OrderState,
			event: UnstampedDomainEventOf<OrderRenamed>,
		): OrderState => ({ name: event.payload.name }),
	};
}

class ContractPersistenceError extends InfrastructureError<"CONTRACT_PERSISTENCE"> {
	constructor(cause: unknown) {
		super({
			code: "CONTRACT_PERSISTENCE",
			message: "The contract repository failed",
			cause,
		});
	}
}

const persistence: PersistenceModel<ContractOrder, number, number | undefined> =
	{
		capture: (order) => order.version,
		changes: (baseline, order, lifecycle) =>
			lifecycle === "loaded" && baseline === order.version
				? undefined
				: order.version,
		isEmpty: (change) => change === undefined,
	};

type OrderSnapshot = { readonly state: OrderState; readonly version: Version };

class PgOrderReadAdapter {
	constructor(
		private readonly store: PgEventStore<OrderRenamed>,
		private readonly tracking: RepositoryTracking<ContractOrder>,
		private readonly snapshots: Map<string, OrderSnapshot>,
	) {}

	async findById(id: OrderId): Promise<ContractOrder | undefined> {
		const cached = this.tracking.identityMap.get(ContractOrder, id);
		if (cached) return cached;
		const snapshot = this.snapshots.get(id);
		const read = await readStreamPages(this.store, orderStream(id), {
			fromVersion: snapshot?.version,
			limit: 2,
		});
		if (!read.reachable) return undefined;
		const loaded = await reconstituteAggregateFromStreamPages(
			() =>
				snapshot
					? ContractOrder.fromSnapshot(id, snapshot.state, snapshot.version)
					: ContractOrder.bare(id),
			read,
		);
		if (loaded.isErr()) throw loaded.error;
		return this.tracking.trackLoaded(loaded.value);
	}
}

const OUTBOX_DDL = `CREATE TABLE contract_outbox (
	recorded bigserial PRIMARY KEY,
	event_id text NOT NULL,
	aggregate_version integer NOT NULL,
	commit_sequence integer NOT NULL,
	commit_size integer NOT NULL
)`;

type Environment = EsRepositoryContractEnvironment<ContractOrder, OrderRenamed>;

let mutations = 0;
let orders = 0;
const snapshotsByEnvironment = new WeakMap<
	Environment,
	Map<string, OrderSnapshot>
>();

const tests = createEsRepositoryContractTests<ContractOrder, OrderRenamed>({
	createEnvironment: async () => {
		const database = await openIsolatedSchema();
		await database.applySql("event-stream.sql");
		await database.pool.query(OUTBOX_DDL);
		const pgScope: TransactionScope<PgQueryExecutor> = new PgTransactionScope(
			database.pool,
		);
		const snapshots = new Map<string, OrderSnapshot>();
		let nextOutboxFailure: Error | undefined;

		const environment: Environment = {
			run: (work) => {
				const outbox: OutboxWriter<OrderRenamed, PgQueryExecutor> = {
					add: async (candidates, executor) => {
						if (nextOutboxFailure !== undefined) {
							const failure = nextOutboxFailure;
							nextOutboxFailure = undefined;
							throw failure;
						}
						for (const { event, position } of candidates) {
							await executor.query(
								`INSERT INTO contract_outbox
								(event_id, aggregate_version, commit_sequence, commit_size)
								VALUES ($1, $2, $3, $4)`,
								[
									event.eventId,
									position.aggregateVersion,
									position.commitSequence,
									position.commitSize,
								],
							);
						}
					},
					endEventSources: async () => {},
				};
				return new UnitOfWork({
					scope: pgScope,
					outbox,
					repositories: {
						orders: defineRepository<EsContractRepository<ContractOrder>>()({
							aggregate: ContractOrder,
							persistence,
							create: (executor: PgQueryExecutor, tracking) =>
								new PgOrderReadAdapter(
									new PgEventStore<OrderRenamed>(executor),
									tracking,
									snapshots,
								),
							flush: (executor: PgQueryExecutor, write) =>
								new PgEventStore<OrderRenamed>(executor).append(
									write.aggregateIdentity,
									write.events as ReadonlyArray<OrderRenamed>,
									{ expectedVersion: write.expectedVersion ?? 0 },
								),
							mapError: (error) =>
								error instanceof InfrastructureError
									? error
									: new ContractPersistenceError(error),
						}),
					},
				}).run(({ repositories }) => work({ repository: repositories.orders }));
			},
			failNextOutboxWrite: (error) => {
				nextOutboxFailure = error;
			},
			committedOutboxEvents: async () => {
				const { rows } = await database.pool.query(
					"SELECT * FROM contract_outbox ORDER BY recorded",
				);
				return rows.map(
					(row) =>
						({
							event: { eventId: row.event_id },
							position: {
								aggregateVersion: row.aggregate_version,
								commitSequence: row.commit_sequence,
								commitSize: row.commit_size,
							},
						}) as CommittedDomainEvent<OrderRenamed>,
				);
			},
			committedStreamEvents: async (stream, options) => {
				const client = await database.pool.connect();
				try {
					return await new PgEventStore<OrderRenamed>(
						fromPg(client),
					).readStream(stream, options);
				} finally {
					client.release();
				}
			},
			teardown: database.teardown,
		};
		snapshotsByEnvironment.set(environment, snapshots);
		return environment;
	},
	captureSnapshot: async (order, environment) => {
		snapshotsByEnvironment
			.get(environment)
			?.set(order.id, { state: { name: order.name }, version: order.version });
	},
	streamKeyFor: orderStream,
	createAggregate: () => {
		orders += 1;
		return ContractOrder.create(`order-${orders}` as OrderId);
	},
	createAggregateWithId: (id) => ContractOrder.create(id),
	mutate: (order) => {
		mutations += 1;
		order.rename(`renamed-${mutations}`);
	},
	snapshotState: (order) => ({ name: order.name }),
});

describe("PgEventStore behind an event-sourced repository", () => {
	for (const test of tests) {
		(test.skipped ? it.skip : it)(test.name, test.run);
	}

	it("runs with zero skips", () => {
		expect(tests.filter((test) => test.skipped)).toEqual([]);
	});
});
