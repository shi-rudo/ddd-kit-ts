import { describe, expect, it } from "vitest";
import type { Query, QueryHandler } from "./query";

describe("Query", () => {
	describe("Query interface", () => {
		it("should allow creating query types", () => {
			type GetOrderQuery = Query & {
				type: "GetOrder";
				orderId: string;
			};

			const query: GetOrderQuery = {
				type: "GetOrder",
				orderId: "order-123",
			};

			expect(query.type).toBe("GetOrder");
			expect(query.orderId).toBe("order-123");
		});

		it("should enforce readonly type property", () => {
			type TestQuery = Query & {
				type: "TestQuery";
				value: string;
			};

			const query: TestQuery = {
				type: "TestQuery",
				value: "test",
			};

			// TypeScript should prevent: query.type = "Other";
			expect(query.type).toBe("TestQuery");
		});
	});

	describe("QueryHandler", () => {
		it("should allow creating query handlers", async () => {
			type GetOrderQuery = Query & {
				type: "GetOrder";
				orderId: string;
			};

			const handler: QueryHandler<GetOrderQuery, { id: string } | null> =
				async (query) => {
					expect(query.type).toBe("GetOrder");
					expect(query.orderId).toBe("order-123");
					return { id: "order-123" };
				};

			const result = await handler({
				type: "GetOrder",
				orderId: "order-123",
			});

			expect(result).toEqual({ id: "order-123" });
		});

		it("should allow returning null for not found queries", async () => {
			type GetOrderQuery = Query & {
				type: "GetOrder";
				orderId: string;
			};

			const handler: QueryHandler<GetOrderQuery, { id: string } | null> =
				async (query) => {
					if (query.orderId === "not-found") {
						return null;
					}
					return { id: query.orderId };
				};

			const found = await handler({
				type: "GetOrder",
				orderId: "order-123",
			});
			expect(found).toEqual({ id: "order-123" });

			const notFound = await handler({
				type: "GetOrder",
				orderId: "not-found",
			});
			expect(notFound).toBeNull();
		});
	});
});

