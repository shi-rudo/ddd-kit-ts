import { describe, expect, it } from "vite-plus/test";
import {
	createDomainEvent,
	type DomainEvent,
	defineRepository,
	type Id,
	InfrastructureError,
	InMemoryOutbox,
	type InMemoryTransactionParticipant,
	InMemoryTransactionScope,
	type PersistenceModel,
	type RepositoryTracking,
	RetryingTransactionScope,
	StateStoredAggregate,
	type TransactionScope,
	UnitOfWork,
	type Version,
} from "../../src";

type OrderId = Id<"OrderId">;
type OrderEvent =
	| DomainEvent<"OrderPlaced", { readonly orderId: string }>
	| DomainEvent<"OrderRenamed", { readonly name: string }>;

class Order extends StateStoredAggregate<
	{ readonly name: string },
	OrderId,
	OrderEvent
> {
	protected readonly aggregateType = "Order";

	private constructor(id: OrderId, name: string) {
		super(id, { name });
	}

	static place(id: OrderId): Order {
		const order = new Order(id, "new");
		order.setState(
			order.state,
			createDomainEvent(
				"OrderPlaced",
				{ orderId: id },
				{ aggregateId: id, aggregateType: "Order" },
			),
		);
		return order;
	}

	static reconstitute(id: OrderId, name: string, version: Version): Order {
		const order = new Order(id, name);
		order.markReconstituted(version);
		return order;
	}

	rename(name: string): void {
		this.setState(
			{ name },
			createDomainEvent(
				"OrderRenamed",
				{ name },
				{ aggregateId: this.id, aggregateType: "Order" },
			),
		);
	}

	get name(): string {
		return this.state.name;
	}
}

type OrderRow = { readonly name: string; readonly version: Version };

/** The order table of the test: a participant like any other store. */
class OrderTable implements InMemoryTransactionParticipant {
	readonly rows = new Map<string, OrderRow>();

	beginTransaction() {
		const recorded = [...this.rows];
		return {
			rollback: () => {
				this.rows.clear();
				for (const [id, row] of recorded) this.rows.set(id, row);
			},
		};
	}
}

class OrderStoreUnavailableError extends InfrastructureError<"ORDER_STORE_UNAVAILABLE"> {
	constructor(cause: unknown) {
		super({
			code: "ORDER_STORE_UNAVAILABLE",
			message: "The order store is unavailable",
			cause,
		});
	}
}

interface ForStoringOrders {
	getById(id: OrderId): Promise<Order>;
	add(order: Order): void;
	update(order: Order): void;
	remove(order: Order): void;
}

const persistence: PersistenceModel<Order, OrderRow, OrderRow | undefined> = {
	capture: (order) => ({ name: order.name, version: order.version }),
	changes: (baseline, order) =>
		baseline !== undefined &&
		baseline.name === order.name &&
		baseline.version === order.version
			? undefined
			: { name: order.name, version: order.version },
	isEmpty: (change) => change === undefined,
};

function ordersIn(table: OrderTable) {
	return defineRepository<ForStoringOrders>()({
		aggregate: Order,
		persistence,
		physicalRemoval: true,
		create: (_transaction: undefined, tracking: RepositoryTracking<Order>) => ({
			async getById(id: OrderId): Promise<Order> {
				const row = table.rows.get(id);
				if (!row) throw new Error(`no order ${id}`);
				return tracking.trackLoaded(
					Order.reconstitute(id, row.name, row.version),
				);
			},
		}),
		flush: async (_transaction: undefined, write) => {
			const id = write.aggregateIdentity.aggregateId;
			if (write.intent === "remove") {
				table.rows.delete(id);
				return;
			}
			table.rows.set(id, {
				name: write.changes.value?.name ?? table.rows.get(id)?.name ?? "",
				version: write.version,
			});
		},
		mapError: (error) =>
			error instanceof InfrastructureError
				? error
				: new OrderStoreUnavailableError(error),
	});
}

/** Fails the commit of the first attempt, after its work completed. */
function commitFailsOnce(
	inner: TransactionScope<undefined>,
): TransactionScope<undefined> {
	let failed = false;
	return {
		transactional: (fn, options) =>
			inner.transactional(async (context) => {
				const result = await fn(context);
				if (!failed) {
					failed = true;
					throw Object.assign(new Error("commit failed"), { retryable: true });
				}
				return result;
			}, options),
	};
}

describe("InMemoryTransactionScope with a unit of work", () => {
	it("rolls back a removal whose commit failed, so the retry can change the aggregate", async () => {
		const table = new OrderTable();
		const outbox = new InMemoryOutbox<OrderEvent>();
		const id = "o-1" as OrderId;
		const setup = new UnitOfWork({
			scope: new InMemoryTransactionScope([table, outbox]),
			outbox,
			repositories: { orders: ordersIn(table) },
		});
		await setup.run(async ({ repositories }) => {
			repositories.orders.add(Order.place(id));
		});
		const uow = new UnitOfWork({
			scope: new RetryingTransactionScope(
				commitFailsOnce(new InMemoryTransactionScope([table, outbox])),
				{ sleep: async () => {} },
			),
			outbox,
			repositories: { orders: ordersIn(table) },
		});
		let attempt = 0;

		const result = await uow.run(async ({ repositories }) => {
			attempt += 1;
			const order = await repositories.orders.getById(id);
			if (attempt === 1) {
				repositories.orders.remove(order);
				return "removed";
			}
			order.rename("kept");
			repositories.orders.update(order);
			return "renamed";
		});

		expect(result).toBe("renamed");
		expect(table.rows.get(id)).toEqual({ name: "kept", version: 2 });
		expect((await outbox.getPending()).map(({ event }) => event.type)).toEqual([
			"OrderPlaced",
			"OrderRenamed",
		]);
	});
});
