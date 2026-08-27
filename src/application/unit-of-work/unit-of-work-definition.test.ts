import { describe, expect, it, vi } from "vite-plus/test";
import type { Version } from "../../domain/aggregate/aggregate";
import { StateStoredAggregate } from "../../domain/aggregate/state-stored-aggregate";
import type { DomainEvent } from "../../domain/event/domain-event";
import type { Id } from "../../domain/identity/id";
import { InfrastructureError } from "../../errors/kit-errors";
import type { Outbox } from "../../messaging/outbox/ports";
import type { PersistenceModel } from "../../persistence/repository/persistence-model";
import type { TransactionScope } from "../../persistence/repository/scope";
import { RepositoryErrorMappingFailedError } from "./errors";
import type { RepositoryTracking } from "./persistence-contract";
import {
	defineRepository,
	type RepositoryDefinitionOptions,
	UnitOfWork,
} from "./unit-of-work";

type OrderEvent = DomainEvent<"OrderPlaced", { readonly orderId: string }>;
type PaymentEvent = DomainEvent<
	"PaymentCaptured",
	{ readonly paymentId: string }
>;
type OrderId = Id<"OrderId">;

class Order extends StateStoredAggregate<
	Readonly<Record<string, never>>,
	OrderId,
	OrderEvent
> {
	protected readonly aggregateType = "Order";

	constructor(id: OrderId) {
		super(id, {});
	}
}

class Payment extends StateStoredAggregate<
	Readonly<Record<string, never>>,
	OrderId,
	PaymentEvent
> {
	protected readonly aggregateType = "Payment";

	constructor(id: OrderId) {
		super(id, {});
	}
}

interface ForStoringOrders {
	findById(id: OrderId): Promise<Order | null>;
	add(order: Order): void;
	update(order: Order): void;
}

class SqlOrderAdapter {
	constructor(readonly _tracking: RepositoryTracking<Order>) {}

	async findById(_id: OrderId): Promise<Order | null> {
		return null;
	}

	diagnosticConnectionName(): string {
		return "primary";
	}
}

const persistence: PersistenceModel<Order, Version, Version | undefined> = {
	capture: (order) => order.version,
	changes: (baseline, order) =>
		baseline === order.version ? undefined : order.version,
	isEmpty: (change) => change === undefined,
};

const scope: TransactionScope<undefined> = {
	transactional: (work) => work(undefined),
};

function outbox(): Outbox<OrderEvent> {
	return {
		add: async () => {},
		getPending: async () => [],
		markDispatched: async () => {},
	};
}

class OrderStoreUnavailableError extends InfrastructureError<"ORDER_STORE_UNAVAILABLE"> {
	constructor(cause: unknown) {
		super({
			code: "ORDER_STORE_UNAVAILABLE",
			message: "The order store is unavailable",
			cause,
			retryable: true,
		});
	}
}

type OrderErrorMapper = RepositoryDefinitionOptions<
	undefined,
	ForStoringOrders,
	Order,
	Version,
	Version | undefined,
	false
>["mapError"];

function createFailingUnitOfWork(mapError: OrderErrorMapper) {
	const driverError = new Error("connection reset by peer");
	const orders = defineRepository<ForStoringOrders>()({
		aggregate: Order,
		persistence,
		create: (_transaction: undefined, tracking) =>
			new SqlOrderAdapter(tracking),
		flush: async () => {
			throw driverError;
		},
		mapError,
	});
	return {
		driverError,
		unitOfWork: new UnitOfWork({
			scope,
			outbox: outbox(),
			repositories: { orders },
		}),
	};
}

describe("UnitOfWork repository definition", () => {
	it("exposes the application-owned port instead of the concrete adapter", () => {
		const orders = defineRepository<ForStoringOrders>()({
			aggregate: Order,
			persistence,
			create: (_transaction: undefined, tracking) =>
				new SqlOrderAdapter(tracking),
			flush: async () => {},
			mapError: (error) => new OrderStoreUnavailableError(error),
		});
		const unitOfWork = new UnitOfWork({
			scope,
			outbox: outbox(),
			repositories: { orders },
		});
		const applicationPortMustRemainNarrow = (): void => {
			void unitOfWork.run(async ({ repositories }) => {
				await repositories.orders.findById("order-1" as OrderId);
				const port: ForStoringOrders = repositories.orders;
				void port;
				// @ts-expect-error adapter diagnostics are not part of ForStoringOrders
				repositories.orders.diagnosticConnectionName();
			});
		};

		void applicationPortMustRemainNarrow;
	});

	it("requires definitions created with the explicit-port helper", () => {
		const rawDefinition = {
			aggregate: Order,
			persistence,
			create: (_transaction: undefined, tracking: RepositoryTracking<Order>) =>
				new SqlOrderAdapter(tracking),
			flush: async () => {},
		};
		const rawDefinitionsMustFailToCompile = (): void => {
			new UnitOfWork({
				scope,
				outbox: outbox(),
				repositories: {
					// @ts-expect-error repository definitions carry the helper's contract brand
					orders: rawDefinition,
				},
			});
		};

		void rawDefinitionsMustFailToCompile;
	});

	it("rejects an unbranded repository definition at runtime", async () => {
		const rawDefinition = {
			aggregate: Order,
			persistence,
			create: (_transaction: undefined, tracking: RepositoryTracking<Order>) =>
				new SqlOrderAdapter(tracking),
			flush: async () => {},
			mapError: (error: unknown) => new OrderStoreUnavailableError(error),
		};
		const unitOfWork = new UnitOfWork({
			scope,
			outbox: outbox(),
			repositories: { orders: rawDefinition } as never,
		});

		await expect(unitOfWork.run(async () => undefined)).rejects.toMatchObject({
			code: "INVALID_REPOSITORY_DEFINITION",
			category: "WIRING",
			repository: "orders",
		});
	});

	it("requires the definition marker to be an own immutable property", async () => {
		const definition = defineRepository<ForStoringOrders>()({
			aggregate: Order,
			persistence,
			create: (_transaction: undefined, tracking) =>
				new SqlOrderAdapter(tracking),
			flush: async () => {},
			mapError: (error) => new OrderStoreUnavailableError(error),
		});
		const inheritedDefinition = Object.create(definition) as typeof definition;
		const unitOfWork = new UnitOfWork({
			scope,
			outbox: outbox(),
			repositories: { orders: inheritedDefinition },
		});

		await expect(unitOfWork.run(async () => undefined)).rejects.toMatchObject({
			code: "INVALID_REPOSITORY_DEFINITION",
			repository: "orders",
		});
	});

	it("rejects callable ports and incomplete repository wiring", () => {
		interface ForRemovingOrders extends ForStoringOrders {
			remove(order: Order): void;
		}
		const invalidDefinitionsMustFailToCompile = (): void => {
			const buildCallableRepository =
				defineRepository<(required: string) => void>();
			// @ts-expect-error a callable value is not a repository port
			buildCallableRepository({
				aggregate: Order,
				persistence,
				create: () => (_required: string) => undefined,
				flush: async () => {},
				mapError: (error: unknown) => new OrderStoreUnavailableError(error),
			});

			// @ts-expect-error every definition must translate persistence errors
			defineRepository<ForStoringOrders>()({
				aggregate: Order,
				persistence,
				create: (_transaction: undefined, tracking) =>
					new SqlOrderAdapter(tracking),
				flush: async () => {},
			});

			// @ts-expect-error a port without remove cannot enable physical removal
			defineRepository<ForStoringOrders>()({
				aggregate: Order,
				persistence,
				physicalRemoval: true,
				create: (
					_transaction: undefined,
					tracking: RepositoryTracking<Order>,
				) => new SqlOrderAdapter(tracking),
				flush: async () => {},
				mapError: (error: unknown) => new OrderStoreUnavailableError(error),
			});

			// @ts-expect-error a port with remove must enable physical removal
			defineRepository<ForRemovingOrders>()({
				aggregate: Order,
				persistence,
				create: (
					_transaction: undefined,
					tracking: RepositoryTracking<Order>,
				) => new SqlOrderAdapter(tracking),
				flush: async () => {},
				mapError: (error: unknown) => new OrderStoreUnavailableError(error),
			});
		};

		void invalidDefinitionsMustFailToCompile;
	});

	it("rejects repository contexts and event families outside the Unit of Work", () => {
		const connectionOrders = defineRepository<ForStoringOrders>()({
			aggregate: Order,
			persistence,
			create: (_transaction: { readonly connection: string }, tracking) =>
				new SqlOrderAdapter(tracking),
			flush: async (_transaction: { readonly connection: string }) => {},
			mapError: (error) => new OrderStoreUnavailableError(error),
		});
		interface ForStoringPayments {
			findById(id: OrderId): Promise<Payment | null>;
			add(payment: Payment): void;
			update(payment: Payment): void;
		}
		const paymentPersistence: PersistenceModel<
			Payment,
			Version,
			Version | undefined
		> = {
			capture: (payment) => payment.version,
			changes: (baseline, payment) =>
				baseline === payment.version ? undefined : payment.version,
			isEmpty: (change) => change === undefined,
		};
		const payments = defineRepository<ForStoringPayments>()({
			aggregate: Payment,
			persistence: paymentPersistence,
			create: () => ({ findById: async () => null }),
			flush: async (_transaction: undefined) => {},
			mapError: (error) => new OrderStoreUnavailableError(error),
		});
		const incompatibleDefinitionsMustFailToCompile = (): void => {
			new UnitOfWork({
				scope,
				outbox: outbox(),
				repositories: {
					// @ts-expect-error repository context must accept the Unit of Work context
					orders: connectionOrders,
				},
			});
			new UnitOfWork({
				scope,
				outbox: outbox(),
				repositories: {
					// @ts-expect-error repository events must be accepted by the outbox
					payments,
				},
			});
		};

		void incompatibleDefinitionsMustFailToCompile;
	});

	it("maps a flush failure through the repository boundary", async () => {
		const mappedError = new OrderStoreUnavailableError("mapped cause");
		const mapError = vi.fn(() => mappedError);
		const { driverError, unitOfWork } = createFailingUnitOfWork(mapError);
		const order = new Order("order-1" as OrderId);

		const rejection = unitOfWork.run(async ({ repositories }) => {
			repositories.orders.add(order);
		});

		await expect(rejection).rejects.toBe(mappedError);
		expect(mapError).toHaveBeenCalledWith(
			driverError,
			expect.objectContaining({
				aggregateId: "order-1",
				intent: "add",
			}),
		);
	});

	it("preserves the persistence failure when the error mapper throws", async () => {
		const mapperError = new Error("mapping policy crashed");
		const { driverError, unitOfWork } = createFailingUnitOfWork(() => {
			throw mapperError;
		});
		const order = new Order("order-1" as OrderId);

		const rejection = await unitOfWork
			.run(async ({ repositories }) => repositories.orders.add(order))
			.catch((error: unknown) => error);

		expect(rejection).toMatchObject({
			constructor: RepositoryErrorMappingFailedError,
			code: "REPOSITORY_ERROR_MAPPING_FAILED",
			category: "WIRING",
			cause: driverError,
			mapperCause: mapperError,
			aggregateId: "order-1",
			intent: "add",
		});
	});

	it("rejects a mapper that returns a raw driver error", async () => {
		const { driverError, unitOfWork } = createFailingUnitOfWork(
			(error) => error as InfrastructureError,
		);
		const order = new Order("order-1" as OrderId);

		const rejection = await unitOfWork
			.run(async ({ repositories }) => repositories.orders.add(order))
			.catch((error: unknown) => error);

		expect(rejection).toMatchObject({
			constructor: RepositoryErrorMappingFailedError,
			cause: driverError,
			aggregateId: "order-1",
			intent: "add",
		});
		expect(
			(rejection as RepositoryErrorMappingFailedError).mapperCause,
		).toBeInstanceOf(TypeError);
	});
});
