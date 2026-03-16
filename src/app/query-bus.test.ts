import { describe, expect, expectTypeOf, it } from "vitest";
import type { Result } from "../core/result";
import type { Query } from "./query";
import { QueryBus } from "./query-bus";

describe("QueryBus", () => {
	describe("register", () => {
		it("should register query handlers", () => {
			const bus = new QueryBus();

			type GetOrderQuery = Query & {
				type: "GetOrder";
				orderId: string;
			};

			const handler = async (query: GetOrderQuery) => {
				return { id: query.orderId };
			};

			bus.register("GetOrder", handler);
			// Should not throw
		});

		it("should allow registering multiple handlers for different query types", () => {
			const bus = new QueryBus();

			type GetOrderQuery = Query & {
				type: "GetOrder";
				orderId: string;
			};

			type ListOrdersQuery = Query & {
				type: "ListOrders";
				customerId: string;
			};

			bus.register("GetOrder", async () => ({ id: "order-1" }));
			bus.register("ListOrders", async () => []);
			// Should not throw
		});
	});

	describe("execute", () => {
		it("should return ok result when handler is registered", async () => {
			const bus = new QueryBus();

			type GetOrderQuery = Query & {
				type: "GetOrder";
				orderId: string;
			};

			bus.register("GetOrder", async (query: GetOrderQuery) => {
				expect(query.orderId).toBe("order-123");
				return { id: "order-123", status: "pending" };
			});

			const result = await bus.execute({
				type: "GetOrder",
				orderId: "order-123",
			});

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value).toEqual({ id: "order-123", status: "pending" });
			}
		});

		it("should return error result if no handler is registered", async () => {
			const bus = new QueryBus();

			type UnknownQuery = Query & {
				type: "UnknownQuery";
			};

			const result = await bus.execute({
				type: "UnknownQuery",
			});

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toContain("No handler registered");
			}
		});

		it("should handle null results from query handlers", async () => {
			const bus = new QueryBus();

			type GetOrderQuery = Query & {
				type: "GetOrder";
				orderId: string;
			};

			bus.register("GetOrder", async () => null);

			const result = await bus.execute({
				type: "GetOrder",
				orderId: "not-found",
			});

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value).toBeNull();
			}
		});

		it("should handle multiple query types", async () => {
			const bus = new QueryBus();

			type GetOrderQuery = Query & {
				type: "GetOrder";
				orderId: string;
			};

			type ListOrdersQuery = Query & {
				type: "ListOrders";
				customerId: string;
			};

			bus.register("GetOrder", async (query: GetOrderQuery) => ({
				id: query.orderId,
			}));
			bus.register("ListOrders", async (query: ListOrdersQuery) => [
				{ id: "order-1", customerId: query.customerId },
				{ id: "order-2", customerId: query.customerId },
			]);

			const singleResult = await bus.execute({
				type: "GetOrder",
				orderId: "order-123",
			});
			expect(singleResult.ok).toBe(true);
			if (singleResult.ok) {
				expect(singleResult.value).toEqual({ id: "order-123" });
			}

			const listResult = await bus.execute({
				type: "ListOrders",
				customerId: "customer-456",
			});
			expect(listResult.ok).toBe(true);
			if (listResult.ok) {
				expect(listResult.value).toHaveLength(2);
			}
		});

		it("should handle array results", async () => {
			const bus = new QueryBus();

			type ListOrdersQuery = Query & {
				type: "ListOrders";
			};

			bus.register("ListOrders", async () => [
				{ id: "order-1" },
				{ id: "order-2" },
			]);

			const result = await bus.execute({
				type: "ListOrders",
			});

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(Array.isArray(result.value)).toBe(true);
				expect(result.value).toHaveLength(2);
			}
		});
	});

	describe("executeUnsafe", () => {
		it("should execute registered query handler", async () => {
			const bus = new QueryBus();

			type GetOrderQuery = Query & {
				type: "GetOrder";
				orderId: string;
			};

			bus.register("GetOrder", async (query: GetOrderQuery) => {
				expect(query.orderId).toBe("order-123");
				return { id: "order-123", status: "pending" };
			});

			const result = await bus.executeUnsafe({
				type: "GetOrder",
				orderId: "order-123",
			});

			expect(result).toEqual({ id: "order-123", status: "pending" });
		});

		it("should throw error if no handler is registered", async () => {
			const bus = new QueryBus();

			type UnknownQuery = Query & {
				type: "UnknownQuery";
			};

			await expect(
				bus.executeUnsafe({
					type: "UnknownQuery",
				}),
			).rejects.toThrow("No handler registered");
		});

		it("should handle null results from query handlers", async () => {
			const bus = new QueryBus();

			type GetOrderQuery = Query & {
				type: "GetOrder";
				orderId: string;
			};

			bus.register("GetOrder", async () => null);

			const result = await bus.executeUnsafe({
				type: "GetOrder",
				orderId: "not-found",
			});

			expect(result).toBeNull();
		});
	});

	describe("type inference with TMap", () => {
		it("should infer return type from type map via execute", async () => {
			type Order = { id: string; status: string };
			type Queries = {
				GetOrder: Order | null;
				ListOrders: Order[];
			};

			const bus = new QueryBus<Queries>();

			bus.register("GetOrder", async () => ({ id: "o-1", status: "open" }));
			bus.register("ListOrders", async () => []);

			const getResult = await bus.execute({
				type: "GetOrder" as const,
				orderId: "o-1",
			});

			expectTypeOf(getResult).toEqualTypeOf<Result<Order | null, string>>();

			const listResult = await bus.execute({
				type: "ListOrders" as const,
			});

			expectTypeOf(listResult).toEqualTypeOf<Result<Order[], string>>();
		});

		it("should infer return type from type map via executeUnsafe", async () => {
			type Order = { id: string };
			type Queries = {
				GetOrder: Order | null;
			};

			const bus = new QueryBus<Queries>();

			bus.register("GetOrder", async () => ({ id: "o-1" }));

			const result = await bus.executeUnsafe({
				type: "GetOrder" as const,
				orderId: "o-1",
			});

			expectTypeOf(result).toEqualTypeOf<Order | null>();
		});

		it("should return Result<unknown, string> without type map", async () => {
			const bus = new QueryBus();

			bus.register("GetOrder", async () => ({ id: "o-1" }));

			const result = await bus.execute({ type: "GetOrder" });

			expectTypeOf(result).toEqualTypeOf<Result<unknown, string>>();
		});
	});
});
