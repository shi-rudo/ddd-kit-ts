import {
	type AggregateConfig,
	type AggregateIdentity,
	AggregateNotFoundError,
	type DomainEvent,
	defineRepository,
	EventSourcedAggregate,
	type Id,
	InfrastructureError,
	type OutboxWriter,
	type PersistenceModel,
	type Repository,
	type RepositoryTracking,
	readStreamPages,
	reconstituteAggregateFromStreamPages,
	UnitOfWork,
	type UnstampedDomainEventOf,
} from "@shirudo/ddd-kit";
import { describe, expect, it } from "vite-plus/test";
import { PgEventStore } from "../src/pg-event-store";
import type { PgQueryExecutor } from "../src/pg-query-executor";
import { fromPg } from "../src/pg-query-executor";
import { PgTransactionScope } from "../src/pg-transaction-scope";
import { openIsolatedSchema } from "./isolated-schema";

type CustomerId = Id<"CustomerId">;
type CustomerEvent =
	| DomainEvent<"CustomerRegistered", { name: string }>
	| DomainEvent<"CustomerErased", Record<string, never>>;
type CustomerState = { readonly name: string };

const customerStream = (id: CustomerId): AggregateIdentity<CustomerId> => ({
	aggregateType: "Customer",
	aggregateId: id,
});

class Customer extends EventSourcedAggregate<
	CustomerState,
	CustomerId,
	CustomerEvent
> {
	protected readonly aggregateType = "Customer";

	protected constructor(
		id: CustomerId,
		state: CustomerState = { name: "" },
		config?: AggregateConfig<CustomerState>,
	) {
		super(id, state, config);
	}

	static register(id: CustomerId, name: string): Customer {
		const customer = new Customer(id);
		customer.apply(customer.createEvent("CustomerRegistered", { name }));
		return customer;
	}

	static bare(id: CustomerId): Customer {
		return new Customer(id);
	}

	recordErasure(): void {
		this.apply(this.createEvent("CustomerErased", {}));
	}

	protected readonly folds = {
		CustomerRegistered: (
			_state: CustomerState,
			event: UnstampedDomainEventOf<
				Extract<CustomerEvent, { type: "CustomerRegistered" }>
			>,
		): CustomerState => ({ name: event.payload.name }),
		CustomerErased: (): CustomerState => ({ name: "" }),
	};
}

const persistence: PersistenceModel<Customer, number, number | undefined> = {
	capture: (customer) => customer.version,
	changes: (baseline, customer, lifecycle) =>
		lifecycle === "loaded" && baseline === customer.version
			? undefined
			: customer.version,
	isEmpty: (change) => change === undefined,
};

class ErasureTestError extends InfrastructureError<"ERASURE_TEST"> {
	constructor(cause: unknown) {
		super({ code: "ERASURE_TEST", message: "The store failed", cause });
	}
}

class PgCustomerReadAdapter {
	constructor(
		private readonly store: PgEventStore<CustomerEvent>,
		private readonly tracking: RepositoryTracking<Customer>,
	) {}

	async findById(id: CustomerId): Promise<Customer | undefined> {
		const read = await readStreamPages(this.store, customerStream(id), {
			limit: 10,
		});
		if (!read.reachable) return undefined;
		const loaded = await reconstituteAggregateFromStreamPages(
			() => Customer.bare(id),
			read,
		);
		if (loaded.isErr()) throw loaded.error;
		return this.tracking.trackLoaded(loaded.value);
	}

	async getById(id: CustomerId): Promise<Customer> {
		const customer = await this.findById(id);
		if (customer === undefined) {
			throw new AggregateNotFoundError({ identity: customerStream(id) });
		}
		return customer;
	}
}

describe("the erasure of an event-sourced aggregate on PostgreSQL", () => {
	it("deletes the stream, sends the erasure event to the outbox, and ends the source", async () => {
		const database = await openIsolatedSchema();
		await database.applySql("event-stream.sql");
		const added: string[] = [];
		const ended: AggregateIdentity[] = [];
		const outbox: OutboxWriter<CustomerEvent, PgQueryExecutor> = {
			add: async (candidates) => {
				added.push(...candidates.map(({ event }) => event.type));
			},
			endEventSources: async (sources) => {
				ended.push(...sources);
			},
		};
		const unitOfWork = () =>
			new UnitOfWork({
				scope: new PgTransactionScope(database.pool),
				outbox,
				repositories: {
					customers: defineRepository<Repository<Customer, CustomerId>>()({
						aggregate: Customer,
						persistence,
						physicalRemoval: true,
						create: (executor: PgQueryExecutor, tracking) =>
							new PgCustomerReadAdapter(
								new PgEventStore<CustomerEvent>(executor),
								tracking,
							),
						flush: (executor: PgQueryExecutor, write) => {
							const store = new PgEventStore<CustomerEvent>(executor);
							const expectedVersion = write.expectedVersion ?? 0;
							return write.intent === "remove"
								? store.removeStream(write.aggregateIdentity, {
										expectedVersion,
									})
								: store.append(
										write.aggregateIdentity,
										write.events as ReadonlyArray<CustomerEvent>,
										{ expectedVersion },
									);
						},
						mapError: (error) =>
							error instanceof InfrastructureError
								? error
								: new ErasureTestError(error),
					}),
				},
			});
		const id = "customer-1" as CustomerId;
		await unitOfWork().run(async ({ repositories }) => {
			repositories.customers.add(Customer.register(id, "Ada"));
		});

		await unitOfWork().run(async ({ repositories }) => {
			const customer = await repositories.customers.getById(id);
			customer.recordErasure();
			repositories.customers.remove(customer);
		});

		const client = await database.pool.connect();
		const read = await new PgEventStore<CustomerEvent>(
			fromPg(client),
		).readStream(customerStream(id), { limit: 10 });
		client.release();
		expect(read.exists).toBe(false);
		expect(added).toEqual(["CustomerRegistered", "CustomerErased"]);
		expect(ended).toEqual([customerStream(id)]);
		const stored = await database.pool.query(
			"SELECT count(*)::int AS rows FROM ddd_kit_event_stream",
		);
		expect(stored.rows[0].rows).toBe(0);
		await database.teardown();
	});
});
