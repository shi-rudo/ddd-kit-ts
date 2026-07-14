import type { Result } from "@shirudo/result";
import { describe, expect, expectTypeOf, it } from "vitest";
import { UnregisteredHandlerError } from "../core/errors";
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

			expect(result.isOk()).toBe(true);
			if (result.isOk()) {
				expect(result.value).toEqual({ id: "order-123", status: "pending" });
			}
		});

		it("throws UnregisteredHandlerError if no handler is registered (wiring bug, not an err)", async () => {
			const bus = new QueryBus();

			await expect(
				bus.execute({ type: "UnknownQuery" }),
			).rejects.toBeInstanceOf(UnregisteredHandlerError);
		});

		it("rethrows a nested dispatch's wiring bug instead of absorbing it into the channel", async () => {
			let mapperCalls = 0;
			const bus = new QueryBus<Record<string, unknown>, unknown>({
				mapExpectedError: (thrown) => {
					mapperCalls += 1;
					return { error: thrown };
				},
			});
			bus.register("Outer", async () => {
				await bus.execute({ type: "TypoedNested" });
				return null;
			});

			await expect(bus.execute({ type: "Outer" })).rejects.toBeInstanceOf(
				UnregisteredHandlerError,
			);
			expect(mapperCalls).toBe(0);
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

			expect(result.isOk()).toBe(true);
			if (result.isOk()) {
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
			expect(singleResult.isOk()).toBe(true);
			if (singleResult.isOk()) {
				expect(singleResult.value).toEqual({ id: "order-123" });
			}

			const listResult = await bus.execute({
				type: "ListOrders",
				customerId: "customer-456",
			});
			expect(listResult.isOk()).toBe(true);
			if (listResult.isOk()) {
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

			expect(result.isOk()).toBe(true);
			if (result.isOk()) {
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

		it("executeUnsafe throws the named UnregisteredHandlerError", async () => {
			const bus = new QueryBus();

			await expect(
				bus.executeUnsafe({ type: "UnknownQuery" }),
			).rejects.toBeInstanceOf(UnregisteredHandlerError);
		});

		it("bypasses mapExpectedError for unregistered types: the wiring bug throws instead of riding the channel", async () => {
			let mapperCalls = 0;
			const bus = new QueryBus<Record<string, unknown>, unknown>({
				mapExpectedError: (thrown) => {
					mapperCalls += 1;
					return { error: thrown };
				},
			});

			const rejection = await bus.execute({ type: "UnknownQuery" }).then(
				() => undefined,
				(error: unknown) => error,
			);

			expect(rejection).toBeInstanceOf(UnregisteredHandlerError);
			const error = rejection as UnregisteredHandlerError;
			expect(error.busKind).toBe("query");
			expect(error.messageType).toBe("UnknownQuery");
			expect(mapperCalls).toBe(0);
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

describe("QueryBus – registration and throw diagnostics", () => {
	it("throws on duplicate registration instead of silently replacing the handler", () => {
		const bus = new QueryBus();

		bus.register("GetOrder", async () => null);

		expect(() => bus.register("GetOrder", async () => null)).toThrow(
			/already registered/,
		);
	});

	it("propagates a structured thrown object unchanged", async () => {
		const bus = new QueryBus();
		const failure = { code: 503, hint: "replica lag" };
		bus.register("GetOrder", async () => {
			throw failure;
		});

		await expect(bus.execute({ type: "GetOrder" })).rejects.toBe(failure);
	});
});
