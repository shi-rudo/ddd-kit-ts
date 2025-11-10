import { describe, expect, it } from "vitest";
import { err, ok } from "../core/result";
import type { Command } from "./command";
import { CommandBus } from "./command-bus";

describe("CommandBus", () => {
	describe("register", () => {
		it("should register command handlers", () => {
			const bus = new CommandBus();

			type CreateOrderCommand = Command & {
				type: "CreateOrder";
				customerId: string;
			};

			const handler = async (cmd: CreateOrderCommand) => {
				return ok("order-123");
			};

			bus.register("CreateOrder", handler);
			// Should not throw
		});

		it("should allow registering multiple handlers for different command types", () => {
			const bus = new CommandBus();

			type CreateOrderCommand = Command & {
				type: "CreateOrder";
				customerId: string;
			};

			type CancelOrderCommand = Command & {
				type: "CancelOrder";
				orderId: string;
			};

			bus.register("CreateOrder", async () => ok("order-1"));
			bus.register("CancelOrder", async () => ok("cancelled"));
			// Should not throw
		});
	});

	describe("execute", () => {
		it("should execute registered command handler", async () => {
			const bus = new CommandBus();

			type CreateOrderCommand = Command & {
				type: "CreateOrder";
				customerId: string;
			};

			bus.register("CreateOrder", async (cmd: CreateOrderCommand) => {
				expect(cmd.customerId).toBe("customer-123");
				return ok("order-456");
			});

			const result = await bus.execute({
				type: "CreateOrder",
				customerId: "customer-123",
			});

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value).toBe("order-456");
			}
		});

		it("should return error if no handler is registered", async () => {
			const bus = new CommandBus();

			type UnknownCommand = Command & {
				type: "UnknownCommand";
			};

			const result = await bus.execute({
				type: "UnknownCommand",
			});

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toContain("No handler registered");
			}
		});

		it("should handle errors from command handlers", async () => {
			const bus = new CommandBus();

			type CreateOrderCommand = Command & {
				type: "CreateOrder";
				customerId: string;
			};

			bus.register("CreateOrder", async () => {
				return err("Failed to create order");
			});

			const result = await bus.execute({
				type: "CreateOrder",
				customerId: "customer-123",
			});

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toBe("Failed to create order");
			}
		});

		it("should handle multiple command types", async () => {
			const bus = new CommandBus();

			type CreateOrderCommand = Command & {
				type: "CreateOrder";
				customerId: string;
			};

			type UpdateOrderCommand = Command & {
				type: "UpdateOrder";
				orderId: string;
				status: string;
			};

			bus.register("CreateOrder", async () => ok("order-1"));
			bus.register("UpdateOrder", async (cmd: UpdateOrderCommand) => {
				return ok(`updated-${cmd.orderId}`);
			});

			const createResult = await bus.execute({
				type: "CreateOrder",
				customerId: "customer-123",
			});
			expect(createResult.ok).toBe(true);

			const updateResult = await bus.execute({
				type: "UpdateOrder",
				orderId: "order-1",
				status: "shipped",
			});
			expect(updateResult.ok).toBe(true);
			if (updateResult.ok) {
				expect(updateResult.value).toBe("updated-order-1");
			}
		});
	});
});

