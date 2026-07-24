import { describe, expect, it } from "vite-plus/test";
import type { AnyDomainEvent } from "../aggregate/domain-event";
import { DomainError } from "../core/errors";
import { InMemoryOutbox } from "../events/outbox";
import { moneyOfMinor } from "../money";
import type { TransactionScope } from "../repo/scope";
import { InMemoryIdempotencyStore } from "./in-memory-idempotency-store";
import {
	type CustomerId,
	createPlaceOrderHandler,
	EmptyOrderError,
	Order,
	type OrderId,
	type OrderQuantity,
	type PlaceOrderCommand,
	type PlaceOrderHandlerDeps,
	type PlaceOrderItem,
	type ProductId,
} from "./order-placement-example";

const orderId = "order-1" as OrderId;
const customerId = "customer-1" as CustomerId;
const item: PlaceOrderItem = {
	productId: "product-1" as ProductId,
	quantity: 2 as OrderQuantity,
	price: moneyOfMinor(1_500n, "EUR", 2),
};

describe("CQRS order-placement example", () => {
	it("rejects an empty order in the domain factory", () => {
		expect(() => Order.place(orderId, customerId, [])).toThrow(EmptyOrderError);
	});

	it("creates a complete placed order in one domain operation", () => {
		const items = [item];

		const order = Order.place(orderId, customerId, items);
		items.length = 0;

		expect(order.id).toBe(orderId);
		expect(order.customerId).toBe(customerId);
		expect(order.itemCount).toBe(1);
		expect(order.status).toBe("placed");
	});

	it("keeps direct construction unavailable outside the domain model", () => {
		const constructDirectly = () => {
			// @ts-expect-error Order.place is the only public construction path.
			new Order(orderId, {
				customerId,
				items: [],
				status: "placed",
			});
		};

		expect(constructDirectly).toBeTypeOf("function");
	});

	it("orchestrates and persists successful placement", async () => {
		const harness = createHandlerHarness();

		const result = await harness.handler(commandWith([item]));

		expect(result.isErr()).toBe(false);
		if (result.isErr()) throw result.error;
		expect(result.value).toBe(orderId);
		expect(harness.createdIds).toBe(1);
		expect(harness.savedOrders).toHaveLength(1);
		expect(harness.savedOrders[0]?.itemCount).toBe(1);
	});

	it("maps only the expected empty-order rejection", async () => {
		const harness = createHandlerHarness();

		const result = await harness.handler(commandWith([]));

		expect(result.isErr()).toBe(true);
		if (!result.isErr()) throw new Error("Expected EMPTY_ORDER");
		expect(result.error).toBe("EMPTY_ORDER");
		expect(harness.savedOrders).toEqual([]);
	});

	it("does not relabel an unexpected domain failure", async () => {
		class UnexpectedDomainError extends DomainError<"UNEXPECTED_DOMAIN_ERROR"> {
			constructor() {
				super({
					code: "UNEXPECTED_DOMAIN_ERROR",
					message: "unexpected",
				});
			}
		}
		const unexpected = new UnexpectedDomainError();
		const harness = createHandlerHarness({
			newOrderId: () => {
				throw unexpected;
			},
		});

		await expect(harness.handler(commandWith([item]))).rejects.toBe(unexpected);
		expect(harness.savedOrders).toEqual([]);
	});
});

function commandWith(items: ReadonlyArray<PlaceOrderItem>): PlaceOrderCommand {
	return {
		type: "PlaceOrder",
		customerId,
		correlationId: "correlation-1",
		idempotency: {
			key: `place-order-${items.length}`,
			fingerprint: `fingerprint-${items.length}`,
		},
		items,
	};
}

function createHandlerHarness(
	overrides: Partial<PlaceOrderHandlerDeps<undefined>> = {},
) {
	const savedOrders: Order[] = [];
	let createdIds = 0;
	const scope: TransactionScope<undefined> = {
		transactional: <T>(work: (context: undefined) => Promise<T>) =>
			work(undefined),
	};
	const deps: PlaceOrderHandlerDeps<undefined> = {
		scope,
		outbox: new InMemoryOutbox<AnyDomainEvent>(),
		idempotency: new InMemoryIdempotencyStore<undefined>(),
		newOrderId: () => {
			createdIds += 1;
			return orderId;
		},
		makeOrderRepository: () => ({
			save: async (order) => {
				savedOrders.push(order);
			},
		}),
		...overrides,
	};

	return {
		handler: createPlaceOrderHandler(deps),
		savedOrders,
		get createdIds() {
			return createdIds;
		},
	};
}
